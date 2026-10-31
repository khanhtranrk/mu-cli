"""Scheduler-owned worker reports; all subprocess/GPU operations are mocked."""
from copy import deepcopy
from pathlib import Path
import threading
import unittest
from unittest.mock import patch

from mu.hardware import ComputeDevice
from mu.runtime import execute_pipelines, Flow


class NodeReportingTests(unittest.TestCase):
    def test_gpu_wait_cpu_progress_and_reporting_after_finally(self):
        events = []; cpu_done = threading.Event(); first_started = threading.Event(); finalized = threading.Event()
        spec = {'workloads': {'gpu': {'target': 'fake', 'units': 4}}, 'pipeline': {'p': {'nodes': [
            {'name': 'a', 'run': [{'type': 'execute_workload', 'workload': 'gpu'}], 'finally': [{'type': 'write_json', 'path': 'unused'}]},
            {'name': 'b', 'run': [{'type': 'execute_workload', 'workload': 'gpu'}]},
            {'name': 'cpu', 'run': [{'type': 'execute_command', 'target': 'unused'}]},
        ]}}}
        def action(a, context, *args, **kwargs):
            name = context['node']['name']
            if name == 'a' and a['type'] == 'execute_workload':
                first_started.set(); self.assertTrue(cpu_done.wait(2))
            elif name == 'a': finalized.set()
            elif name == 'b': self.assertTrue(finalized.is_set())
            elif name == 'cpu': self.assertTrue(first_started.wait(2)); cpu_done.set()
        def node_report(i, name, update):
            events.append((name, deepcopy(update)))
            if name == 'a' and update['status'] == 'succeeded': self.assertTrue(finalized.is_set())
        with patch('mu.runtime.run_action', side_effect=action):
            results = execute_pipelines(spec, [('p', {})], {}, [ComputeDevice('0', 'fake', 16, 'nvidia')], Path('/tmp'), on_node_state=node_report)
        self.assertEqual(results, [{'a': 'success', 'b': 'success', 'cpu': 'success'}])
        self.assertIn(('b', {'status': 'queue', 'reason': 'Waiting for GPU resources'}), events)
        a_finished = next(i for i, (n, u) in enumerate(events) if n == 'a' and u['status'] == 'succeeded')
        b_started = next(i for i, (n, u) in enumerate(events) if n == 'b' and u['status'] == 'running')
        self.assertLess(a_finished, b_started)
        for name in ['a', 'b', 'cpu']:
            states = [u['status'] for n, u in events if n == name]
            self.assertEqual(states[0], 'queue'); self.assertEqual(states[-2:], ['running', 'succeeded'])

    def test_failure_and_blocked_node_are_reported_without_spec_hooks(self):
        spec = {'pipeline': {'p': {'nodes': [
            {'name': 'broken', 'run': [{'type': 'execute_command', 'target': 'unused'}]},
            {'name': 'blocked', 'depends_on': ['broken']},
        ]}}}
        reports = []; statuses = []
        with patch('mu.runtime.run_action', side_effect=ValueError('upload failed')):
            self.assertTrue(Flow(spec, 'master_flow', {'sys': {'cache_dir': '/tmp/mu-missing-models'}}, [], Path('/tmp')).execute(
                [('p', {}, {'requestId': 'r'})], lambda r, s: statuses.append(s),
                lambda r, name, u: reports.append((name, deepcopy(u)))))
        self.assertEqual(statuses, ['processing', 'process_failed'])
        self.assertEqual(reports[-1], ('blocked', {'status': 'failed', 'reason': 'Blocked: dependency broken failed'}))
        self.assertTrue(any(n == 'broken' and u['status'] == 'failed' and 'upload failed' in u['reason'] for n, u in reports))
        self.assertFalse(any(n == 'blocked' and u['status'] == 'running' for n, u in reports))

    def test_each_request_finishes_before_other_batch_requests(self):
        done = threading.Event(); request_reports = []
        spec = {'pipeline': {'p': {'params': {'id': {'type': 'number'}}, 'nodes': [{'name': 'n'}]}}}
        def execute(spec, pipeline, node, context, *args):
            if context['params']['id'] == 2: self.assertTrue(done.wait(2), 'request 1 terminal report waited for entire batch')
            return 'success', None
        def report(index, status):
            request_reports.append((index, status))
            if index == 0 and status == 'succeeded': done.set()
        with patch('mu.runtime._execute_node', side_effect=execute):
            execute_pipelines(spec, [('p', {'id': 1}), ('p', {'id': 2})], {}, [], Path('/tmp'), on_request_state=report)
        self.assertEqual(request_reports.count((0, 'processing')), 1)
        self.assertEqual(request_reports.count((1, 'succeeded')), 1)

    def test_pre_node_context_failure_and_ignored_error_terminal_state(self):
        events = []
        spec = {'pipeline': {'p': {'nodes': [{'name': 'n', 'context': ['invalid']} ]}}}
        execute_pipelines(spec, [('p', {})], {}, [], Path('/tmp'), on_node_state=lambda i,n,u: events.append(u))
        self.assertEqual(events[-1]['status'], 'failed')
        spec['pipeline']['p']['nodes'][0]['ignore_error'] = True
        events.clear()
        execute_pipelines(spec, [('p', {})], {}, [], Path('/tmp'), on_node_state=lambda i,n,u: events.append(u))
        self.assertEqual(events[-1]['status'], 'succeeded')

    def test_postcondition_finally_and_skip_terminal_reports(self):
        for mode, expected in [('postcondition', 'failed'), ('finally', 'failed'), ('skip', 'succeeded')]:
            with self.subTest(mode=mode):
                events = []
                node = {'name': 'n', 'finally': [{'type': 'write_json', 'path': 'unused'}]}
                if mode == 'postcondition': node['postcondition'] = {'operator': 'file_exists', 'path': 'unused'}
                if mode == 'skip': node['skip_if'] = {'operator': 'file_exists', 'path': 'unused'}
                def action(*args, **kwargs):
                    events.append('finally')
                    if mode == 'finally': raise ValueError('cleanup failed')
                with patch('mu.runtime.condition', return_value=mode == 'skip'), patch('mu.runtime.run_action', side_effect=action):
                    execute_pipelines({'pipeline': {'p': {'nodes': [node]}}}, [('p', {})], {}, [], Path('/tmp'),
                                      on_node_state=lambda i,n,u: events.append(u['status']))
                self.assertEqual(events[-2:], ['finally', expected])

    def test_interrupt_reports_pending_and_running_nodes_failed(self):
        spec = {'pipeline': {'p': {'nodes': [{'name': 'n'}, {'name': 'waiting'}]}}}
        statuses = []; nodes = []
        def scheduler(*args, **kwargs):
            kwargs['on_node_state'](0, 'n', {'status': 'running'})
            kwargs['on_node_state'](0, 'waiting', {'status': 'queue'})
            raise KeyboardInterrupt()
        with patch('mu.runtime.execute_pipelines', side_effect=scheduler):
            flow = Flow(spec, 'master_flow', {'sys': {'cache_dir': '/tmp/mu-missing-models'}}, [], Path('/tmp'))
            with self.assertRaises(KeyboardInterrupt):
                flow.execute([('p', {}, {'requestId': 'r'})], lambda r,s: statuses.append(s),
                             lambda r,n,u: nodes.append((n, u['status'])))
        self.assertEqual(statuses, ['process_failed'])
        self.assertEqual(nodes[-2:], [('n', 'failed'), ('waiting', 'failed')])
