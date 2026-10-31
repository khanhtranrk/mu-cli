"""Scheduler behavior without integrated MasterFlow status reporting."""
from pathlib import Path
import threading
import unittest
from unittest.mock import patch

from mu.hardware import ComputeDevice
from mu.runtime import execute_pipelines, Flow


class SchedulerTests(unittest.TestCase):
    def test_gpu_capacity_is_reserved_through_finally_while_cpu_progresses(self):
        cpu_done = threading.Event()
        first_started = threading.Event()
        finalized = threading.Event()
        second_started = threading.Event()
        spec = {
            "workloads": {"gpu": {"target": "fake", "units": 4}},
            "pipeline": {"p": {"nodes": [
                {"name": "a", "run": [{"type": "execute_workload", "workload": "gpu"}],
                 "finally": [{"type": "write_json", "path": "unused"}]},
                {"name": "b", "run": [{"type": "execute_workload", "workload": "gpu"}]},
                {"name": "cpu", "run": [{"type": "execute_command", "target": "unused"}]},
            ]}},
        }

        def action(action_spec, context, *args, **kwargs):
            name = context["node"]["name"]
            if name == "a" and action_spec["type"] == "execute_workload":
                first_started.set()
                self.assertTrue(cpu_done.wait(2))
            elif name == "a":
                finalized.set()
            elif name == "b":
                self.assertTrue(finalized.is_set())
                second_started.set()
            elif name == "cpu":
                self.assertTrue(first_started.wait(2))
                cpu_done.set()

        with patch("mu.runtime.run_action", side_effect=action):
            results = execute_pipelines(
                spec, [("p", {})], {}, [ComputeDevice("0", "fake", 16, "nvidia")], Path("/tmp"),
            )
        self.assertEqual(results, [{"a": "success", "b": "success", "cpu": "success"}])
        self.assertTrue(second_started.is_set())

    def test_failed_dependency_blocks_node_and_request_fails(self):
        spec = {"pipeline": {"p": {"nodes": [
            {"name": "broken", "run": [{"type": "execute_command", "target": "unused"}]},
            {"name": "blocked", "depends_on": ["broken"],
             "run": [{"type": "write_json", "path": "must-not-run"}]},
        ]}}}
        actions = []

        def action(action_spec, context, *args, **kwargs):
            actions.append(context["node"]["name"])
            raise ValueError("workload failed")

        with patch("mu.runtime.run_action", side_effect=action):
            flow = Flow(spec, "master_flow", {"sys": {"cache_dir": "/tmp/mu-missing-models"}}, [], Path("/tmp"))
            self.assertTrue(flow.execute([("p", {}, {"requestId": "r"})]))
        self.assertEqual(actions, ["broken"])

    def test_context_failure_and_ignored_error_results(self):
        spec = {"pipeline": {"p": {"nodes": [{"name": "n", "context": ["invalid"]}]}}}
        results = execute_pipelines(spec, [("p", {})], {}, [], Path("/tmp"))
        self.assertEqual(results, [{"n": "failed"}])
        spec["pipeline"]["p"]["nodes"][0]["ignore_error"] = True
        results = execute_pipelines(spec, [("p", {})], {}, [], Path("/tmp"))
        self.assertEqual(results, [{"n": "success"}])

    def test_finally_runs_for_postcondition_failure_and_successful_skip(self):
        for mode, expected in [("postcondition", "failed"), ("skip", "success")]:
            with self.subTest(mode=mode):
                node = {"name": "n", "finally": [{"type": "write_json", "path": "unused"}]}
                if mode == "postcondition":
                    node["postcondition"] = {"operator": "file_exists", "path": "unused"}
                else:
                    node["skip_if"] = {"operator": "file_exists", "path": "unused"}
                events = []

                def action(*args, **kwargs):
                    events.append("finally")

                with patch("mu.runtime.condition", return_value=mode == "skip"), \
                        patch("mu.runtime.run_action", side_effect=action):
                    results = execute_pipelines(
                        {"pipeline": {"p": {"nodes": [node]}}}, [("p", {})], {}, [], Path("/tmp"),
                    )
                self.assertEqual(results, [{"n": expected}])
                self.assertEqual(events, ["finally"])

    def test_interrupt_propagates_without_status_reporting_callbacks(self):
        spec = {"pipeline": {"p": {"nodes": [{"name": "n"}]}}}
        with patch("mu.runtime.execute_pipelines", side_effect=KeyboardInterrupt):
            flow = Flow(spec, "master_flow", {"sys": {"cache_dir": "/tmp/mu-missing-models"}}, [], Path("/tmp"))
            with self.assertRaises(KeyboardInterrupt):
                flow.execute([("p", {}, {"requestId": "r"})])


if __name__ == "__main__":
    unittest.main()
