"""Runtime for the workload/pipeline spec format."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import signal
import threading
import time
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from copy import deepcopy
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import yaml

from mu.hardware import ComputeDevice
from mu.pipelines import _render


class RuntimeError(ValueError):
    pass


_processes: set[subprocess.Popen] = set()
_process_lock = threading.RLock()
_cancelled = threading.Event()


def terminate_processes() -> None:
    _cancelled.set()
    with _process_lock:
        processes = list(_processes)
    for process in processes:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def reset_interruption() -> None:
    _cancelled.clear()


def _run_process(command, **kwargs):
    """Track process groups so interruption can stop worker-thread children too."""
    check = kwargs.pop("check", False)
    with _process_lock:
        if _cancelled.is_set():
            raise RuntimeError("flow interrupted")
        process = subprocess.Popen(command, start_new_session=True, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, **kwargs)
        _processes.add(process)
    try:
        stdout, stderr = process.communicate()
        result = subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
        if check and result.returncode:
            raise subprocess.CalledProcessError(result.returncode, command, stdout, stderr)
        return result
    except BaseException:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
        raise
    finally:
        with _process_lock:
            _processes.discard(process)


def read_data(path: Path) -> Any:
    try:
        raw = path.read_text(encoding="utf-8")
        value = json.loads(raw) if path.suffix.lower() == ".json" else yaml.safe_load(raw)
    except (OSError, yaml.YAMLError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"cannot read {path}: {exc}") from exc
    return value


def params_for(schema: dict[str, Any], supplied: dict[str, Any], context: dict[str, Any], label: str) -> dict[str, Any]:
    result = {}
    for name, declaration in schema.items():
        declaration = declaration if isinstance(declaration, dict) else {}
        if name in supplied:
            value = supplied[name]
        elif "default" in declaration:
            value = declaration["default"]
        else:
            raise RuntimeError(f"{label} requires parameter {name!r}")
        if declaration.get("type") == "string" and not isinstance(value, str):
            raise RuntimeError(f"{label}.{name} must be a string")
        if declaration.get("type") == "number" and (not isinstance(value, (int, float)) or isinstance(value, bool)):
            raise RuntimeError(f"{label}.{name} must be a number")
        result[name] = value
    unknown = set(supplied) - set(schema)
    if unknown:
        raise RuntimeError(f"{label} has unknown parameter(s): {', '.join(sorted(unknown))}")
    return _render(result, {**context, "params": result})


def condition(spec: Any, context: dict[str, Any], states: dict[str, str]) -> bool:
    if spec is None:
        return True
    if not isinstance(spec, dict) or not isinstance(spec.get("operator"), str):
        raise RuntimeError("condition must be a mapping with operator")
    op = spec["operator"]
    expected = spec.get("expected", True)
    if op in {"and", "or"}:
        props = spec.get("props", [])
        if not isinstance(props, list): raise RuntimeError(f"{op}.props must be a list")
        value = all(condition(x, context, states) for x in props) if op == "and" else any(condition(x, context, states) for x in props)
    elif op in {"file_exists", "folder_exists", "path_exists"}:
        path = Path(str(_render(spec.get("path", ""), context))).expanduser()
        if not path.is_absolute(): path = Path(context["session"]["working_dir"]) / path
        value = path.is_file() if op == "file_exists" else path.is_dir() if op == "folder_exists" else path.exists()
    elif op == "exit_code":
        target = _render(spec.get("target"), context)
        if not isinstance(target, list) or not target:
            raise RuntimeError("exit_code.target must be a non-empty command list")
        expected = spec.get("expected", 0)
        if not isinstance(expected, int) or isinstance(expected, bool):
            raise RuntimeError("exit_code.expected must be an integer")
        try:
            result = _run_process(list(map(str, target)), cwd=context["session"]["working_dir"], text=True)
            value = result.returncode
        except OSError:
            value = None
    elif op in {"action_state", "node_state"}:
        if "expected" not in spec:
            raise RuntimeError(f"{op}.expected is required")
        target = _render(spec.get("target"), context)
        if not isinstance(target, list) or not target or not all(isinstance(key, str) and key for key in target):
            raise RuntimeError(f"{op}.target must be a non-empty list of non-empty string keys")
        value = context.get("actions" if op == "action_state" else "node", {})
        for key in target:
            if not isinstance(value, dict) or key not in value:
                return False
            value = value[key]
    elif op == "node_status":
        value = states.get(str(spec.get("node", context.get("node", {}).get("name", ""))))
        expected = spec.get("expected", "success")
        if expected == "succeeded": expected = "success"
    else:
        raise RuntimeError(f"unknown condition operator {op!r}")
    return value == expected


def _apply_context(target: dict[str, Any], values: Any) -> None:
    if values:
        if not isinstance(values, dict): raise RuntimeError("context must be a mapping")
        target.update(values)


def run_action(
    action: dict[str, Any], context: dict[str, Any], states: dict[str, str], workdir: Path,
    *, label: str = "action",
) -> None:
    typ = action.get("type")
    if "action" in action:
        raise RuntimeError(f"{label}: use type, not action")
    if not isinstance(typ, str) or typ not in {"execute_command", "create_dir", "write_json", "send_http_request"}:
        raise RuntimeError(f"{label}: unknown action type {typ!r}; use snake_case names")
    if "save_response_to_context" in action:
        raise RuntimeError(f"{label}: save_response_to_context was removed; use save_state")
    if "save_state" in action and typ not in {"execute_command", "send_http_request"}:
        raise RuntimeError(f"{label}: save_state is only supported by execute_command and send_http_request")
    _apply_context(context, _render(action.get("context", {}), context))
    if action.get("skip_if") and condition(action["skip_if"], context, states):
        print(f"[SKIP] {label} ({typ}): skip_if matched", flush=True)
        return
    if not condition(action.get("precondition"), context, states):
        print(f"[SKIP] {label} ({typ}): precondition did not match", flush=True)
        return
    values = _render(action, context)
    key = values.get("save_state")
    if "save_state" in values:
        if not isinstance(key, str) or not key.strip():
            raise RuntimeError(f"{label}.save_state must be a non-empty string")
        if "actions" in context and not isinstance(context["actions"], dict):
            raise RuntimeError(f"{label}: context.actions must be a mapping")
    result = {"success": False, "error": None}
    if typ == "execute_command":
        result.update(returncode=None, stdout="", stderr="")
    elif typ == "send_http_request":
        result.update(status_code=None, headers={}, body=None)
    started = time.perf_counter()
    print(f"[ACTION] {label}: {typ} started", flush=True)
    try:
        if typ == "execute_command":
            target = values.get("target")
            args = values.get("args", [])
            if not target or not isinstance(args, list):
                raise RuntimeError("execute_command requires target and args")
            completed = _run_process(
                [str(target), *map(str, args)], cwd=workdir,
                env={**os.environ, **values.get("env", {})}, check=False,
                text=True, errors="replace",
            )
            result.update(returncode=completed.returncode, stdout=completed.stdout, stderr=completed.stderr)
            if completed.returncode:
                raise subprocess.CalledProcessError(completed.returncode, completed.args, completed.stdout, completed.stderr)
        elif typ == "create_dir":
            Path(values["path"]).expanduser().mkdir(parents=True, exist_ok=True)
        elif typ == "write_json":
            path = Path(values["path"]).expanduser(); path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(values.get("content", {}), ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
        elif typ == "send_http_request":
            data = values.get("body")
            payload = json.dumps(data).encode() if data is not None else None
            req = Request(values["url"], data=payload, headers=values.get("header", {}), method=str(values.get("method", "get")).upper())
            http_error = None
            try:
                response = urlopen(req, timeout=30)
            except HTTPError as exc:
                response = exc
                http_error = exc
            with response:
                result.update(status_code=response.code, headers={k.lower(): v for k, v in response.headers.items()})
                raw = response.read()
                if raw:
                    text = raw.decode(response.headers.get_content_charset() or "utf-8", errors="replace")
                    try:
                        result["body"] = json.loads(text)
                    except ValueError:
                        result["body"] = text
            if http_error is not None:
                raise http_error
        result["success"] = True
        if key is not None:
            context.setdefault("actions", {})[key] = result
        if action.get("postcondition"):
            if not condition(action["postcondition"], context, states):
                raise RuntimeError("postcondition failed")
            print(f"[CHECK] {label}: postcondition passed", flush=True)
    except Exception as exc:
        result.update(success=False, error={"type": type(exc).__name__, "message": str(exc)})
        if key is not None:
            context.setdefault("actions", {})[key] = result
        if action.get("ignore_error"):
            print(f"[WARN] {label}: ignored action error: {exc}", flush=True)
            return
        raise RuntimeError(f"{label} ({typ}) failed: {exc}") from exc
    elapsed = time.perf_counter() - started
    print(f"[ACTION] {label}: {typ} completed in {elapsed:.1f}s", flush=True)


def execute_workload(spec: dict[str, Any], name: str, supplied: dict[str, Any], context: dict[str, Any], device: ComputeDevice | None, workdir: Path) -> None:
    declaration = spec.get("workloads", {}).get(name)
    if not isinstance(declaration, dict): raise RuntimeError(f"workload {name!r} is not defined")
    workload_context = dict(context)
    workload_context["params"] = params_for(declaration.get("params", {}), supplied, context, f"workload {name}")
    target = _render(declaration.get("target", ""), workload_context)
    args = _render(declaration.get("args", []), workload_context)
    if not isinstance(args, list): raise RuntimeError(f"workload {name!r}.args must be a list")
    command = [str(target), *map(str, args)]
    if device:
        family = {"nvidia": "cuda", "rocm": "rocm"}.get(device.backend, device.backend)
        workload_context["schedule"] = {"device_family": family, "device_index": device.index}
        command += list(map(str, _render(declaration.get("device_args", []), workload_context)))
    env = {**os.environ, **_render(declaration.get("env", {}), workload_context)}
    units = declaration.get("units", 0)
    placement = f"{device.backend}:{device.index}" if device else "cpu"
    print(f"[WORKLOAD] {name}: starting {target} ({units} units; device {placement})", flush=True)
    started = time.perf_counter()
    result = _run_process(command, cwd=workdir, env=env, text=True)
    if result.returncode:
        detail = result.stderr.strip() or result.stdout.strip()
        raise RuntimeError(f"{target} exited with status {result.returncode}" + (f": {detail}" if detail else ""))
    print(f"[WORKLOAD] {name}: completed in {time.perf_counter() - started:.1f}s", flush=True)


def _node_result(node: dict[str, Any], state: str, error: str | None, label: str) -> tuple[str, str | None]:
    if state == "failed" and node.get("ignore_error") is True:
        print(f"[WARN] {label}: ignored node error: {error or 'node failed'}", flush=True)
        return "success", None
    return state, error


def _execute_node(
    spec: dict[str, Any], pipeline_name: str, node: dict[str, Any], context: dict[str, Any],
    states: dict[str, str], device: ComputeDevice | None, workdir: Path,
) -> tuple[str, str | None]:
    name = node["name"]
    node_context = deepcopy(context)
    node_context["node"] = {"name": name, "status": "running", "total_units": 0}
    _apply_context(node_context, _render(node.get("context", {}), node_context))
    state, error = "success", None
    started = time.perf_counter()
    print(f"[NODE] {pipeline_name}/{name}: starting", flush=True)
    try:
        if node.get("skip_if") and condition(node["skip_if"], node_context, states):
            print(f"[SKIP] {pipeline_name}/{name}: skip_if matched", flush=True)
            if node.get("postcondition") and not condition(node["postcondition"], node_context, states):
                raise RuntimeError(f"node {name!r} postcondition failed after skip")
        else:
            if node.get("precondition"):
                if not condition(node["precondition"], node_context, states):
                    print(f"[CHECK] {pipeline_name}/{name}: precondition failed", flush=True)
                    raise RuntimeError(f"node {name!r} precondition failed")
                print(f"[CHECK] {pipeline_name}/{name}: precondition passed", flush=True)
            for index, action in enumerate(node.get("before_run", []), start=1):
                run_action(action, node_context, states, workdir, label=f"{pipeline_name}/{name} before_run[{index}]")
            run = node.get("run")
            if isinstance(run, dict):
                workload = run.get("workload")
                config = spec.get("workloads", {}).get(workload, {})
                node_context["node"]["total_units"] = config.get("units", 0)
                execute_workload(spec, workload, _render(run.get("args", {}), node_context), node_context, device, workdir)
            for index, action in enumerate(node.get("after_run", []), start=1):
                run_action(action, node_context, states, workdir, label=f"{pipeline_name}/{name} after_run[{index}]")
            if node.get("postcondition"):
                if not condition(node["postcondition"], node_context, states):
                    raise RuntimeError(f"node {name!r} postcondition failed")
                print(f"[CHECK] {pipeline_name}/{name}: postcondition passed", flush=True)
    except Exception as exc:
        state, error = "failed", str(exc)
    final_states = {**states, name: state}
    for index, action in enumerate(node.get("finally", []), start=1):
        node_context["node"]["status"] = state
        try:
            run_action(action, node_context, final_states, workdir, label=f"{pipeline_name}/{name} finally[{index}]")
        except Exception as exc:
            state, error = "failed", str(exc)
            final_states[name] = state
    state, error = _node_result(node, state, error, f"{pipeline_name}/{name}")
    elapsed = time.perf_counter() - started
    if state == "failed": print(f"[FAIL] {pipeline_name}/{name} after {elapsed:.1f}s: {error}", flush=True)
    else: print(f"[OK] {pipeline_name}/{name} {state} in {elapsed:.1f}s", flush=True)
    return state, error


def validate_pipeline(definition: dict, pipeline_name: str) -> list[dict]:
    nodes = definition.get("nodes", [])
    if not isinstance(nodes, list): raise RuntimeError(f"pipeline {pipeline_name!r}.nodes must be a list")
    for node in nodes:
        if not isinstance(node, dict):
            raise RuntimeError(f"pipeline {pipeline_name!r}.nodes must contain mappings")
        if not isinstance(node.get("ignore_error", False), bool):
            raise RuntimeError(f"node {node.get('name')!r}.ignore_error must be a boolean")
    names = [node.get("name") for node in nodes]
    if any(not isinstance(name, str) or not name for name in names) or len(set(names)) != len(names):
        raise RuntimeError(f"pipeline {pipeline_name!r} node names must be unique non-empty strings")
    for node in nodes:
        dependencies = node.get("depends_on", [])
        if not isinstance(dependencies, list) or not all(isinstance(name, str) and name for name in dependencies):
            raise RuntimeError(f"node {node['name']!r}.depends_on must be a list of non-empty node name strings")
        for dependency in dependencies:
            if dependency not in names:
                raise RuntimeError(f"node {node['name']!r} depends on unknown node {dependency!r}")
    edges = {node["name"]: node.get("depends_on", []) for node in nodes}
    visiting, visited = set(), set()
    def visit(name):
        if name in visiting:
            raise RuntimeError(f"pipeline {pipeline_name!r}: dependency cycle at {name!r}")
        if name in visited:
            return
        visiting.add(name)
        for dependency in edges[name]:
            visit(dependency)
        visiting.remove(name)
        visited.add(name)
    for name in edges:
        visit(name)
    return nodes


def execute_pipelines(
    spec: dict[str, Any], requests: list[tuple[str, dict[str, Any]]], base: dict[str, Any],
    devices: list[ComputeDevice], workdir: Path,
    *, request_contexts: list[dict[str, Any]] | None = None,
) -> list[dict[str, str]]:
    """Schedule ready nodes across all requests, respecting dependencies and GPU units."""
    jobs: dict[str, dict[str, Any]] = {}
    results: list[dict[str, str]] = []
    job_by_request_name: dict[tuple[int, str], str] = {}
    order: list[str] = []
    for request_index, (pipeline_name, request) in enumerate(requests):
        definition = spec.get("pipeline", {}).get(pipeline_name)
        if not isinstance(definition, dict): raise RuntimeError(f"pipeline {pipeline_name!r} is not defined")
        context = deepcopy(request_contexts[request_index] if request_contexts is not None else base)
        if request_contexts is None:
            _apply_context(context, _render(definition.get("context", {}), context))
        context["params"] = params_for(definition.get("params", {}), request, context, f"pipeline {pipeline_name}")
        nodes = validate_pipeline(definition, pipeline_name)
        print(f"[PIPELINE] {pipeline_name} request {request_index + 1}: queued ({len(nodes)} nodes)", flush=True)
        results.append({})
        for node in nodes:
            job_id = f"p{request_index}:{node['name']}"
            job_by_request_name[(request_index, node["name"])] = job_id
            order.append(job_id)
            jobs[job_id] = {
                "request_index": request_index, "pipeline": pipeline_name,
                "context": context, "node": node, "status": "pending",
            }

    device_free = {device.index: float(device.capacity_units) for device in devices}
    futures: dict[Future[tuple[str, str | None]], tuple[str, ComputeDevice | None, float]] = {}
    max_workers = max(1, min(32, len(jobs)))
    with ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="mu-node") as pool:
        while any(job["status"] in {"pending", "running"} for job in jobs.values()):
            launched = False
            for job_id in order:
                job = jobs[job_id]
                if job["status"] != "pending": continue
                request_index = job["request_index"]
                node = job["node"]
                dependencies = node.get("depends_on", [])
                dependency_jobs = [jobs[job_by_request_name[(request_index, name)]] for name in dependencies]
                if any(dependency["status"] in {"pending", "running"} for dependency in dependency_jobs):
                    continue
                pipeline_states = results[request_index]
                failed_dependency = next((dependency for dependency in dependency_jobs if dependency["status"] != "success"), None)
                if failed_dependency is not None:
                    dependency_name = failed_dependency["node"]["name"]
                    detail = f"dependency {dependency_name} failed"
                    print(f"[BLOCKED] {job['pipeline']}/{node['name']}: {detail}", flush=True)
                    state, _ = _node_result(node, "failed", detail, f"{job['pipeline']}/{node['name']}")
                    job["status"] = state
                    pipeline_states[node["name"]] = state
                    continue

                run = node.get("run")
                workload = run.get("workload") if isinstance(run, dict) else None
                units = float(spec.get("workloads", {}).get(workload, {}).get("units", 0)) if workload else 0.0
                device: ComputeDevice | None = None
                if units > 0:
                    fitting = [candidate for candidate in devices if candidate.capacity_units >= units]
                    if fitting:
                        available = [candidate for candidate in fitting if device_free[candidate.index] >= units]
                        if not available: continue
                        device = min(available, key=lambda candidate: device_free[candidate.index] - units)
                    else:
                        print(f"[SCHEDULE] {job['pipeline']}/{node['name']}: no GPU fits {units:g} units; using CPU", flush=True)
                if len(futures) >= max_workers: continue
                job["status"] = "running"
                if device:
                    device_free[device.index] -= units
                print(f"[SCHEDULE] {job['pipeline']}/{node['name']}: dispatched ({units:g} units; {device.backend + ':' + device.index if device else 'cpu'})", flush=True)
                future = pool.submit(
                    _execute_node, spec, job["pipeline"], node, job["context"],
                    dict(pipeline_states), device, workdir,
                )
                futures[future] = (job_id, device, units)
                launched = True

            if not futures:
                if any(job["status"] == "pending" for job in jobs.values()):
                    raise RuntimeError("scheduler deadlock: pending nodes cannot be assigned")
                break
            if not launched or len(futures) >= max_workers:
                completed, _ = wait(futures, return_when=FIRST_COMPLETED)
            else:
                continue
            for future in completed:
                job_id, device, units = futures.pop(future)
                if device: device_free[device.index] += units
                try:
                    state, error = future.result()
                except Exception as exc:
                    state, error = "failed", f"unexpected node runner error: {exc}"
                job = jobs[job_id]
                state, error = _node_result(job["node"], state, error, f"{job['pipeline']}/{job['node']['name']}")
                job["status"] = state
                results[job["request_index"]][job["node"]["name"]] = state
                if state == "failed" and error:
                    print(f"[NODE-ERROR] {job['pipeline']}/{job['node']['name']}: {error}", flush=True)

    for index, (pipeline_name, _) in enumerate(requests):
        states = results[index]
        succeeded = sum(value == "success" for value in states.values())
        failed = sum(value == "failed" for value in states.values())
        print(f"[PIPELINE] {pipeline_name} request {index + 1}: finished ({succeeded} succeeded, {failed} failed)", flush=True)
    return results


def execute_pipeline(spec: dict[str, Any], pipeline_name: str, request: dict[str, Any], base: dict[str, Any], devices: list[ComputeDevice], workdir: Path) -> dict[str, str]:
    """Compatibility wrapper for scheduling one pipeline request."""
    return execute_pipelines(spec, [(pipeline_name, request)], base, devices, workdir)[0]


class Flow:
    """One entry invocation; preparation caches never survive into another flow."""

    def __init__(self, spec: dict, entry: str, base: dict, devices: list[ComputeDevice], workdir: Path):
        if "prepare" in spec:
            raise RuntimeError("spec.prepare was removed; move actions to pipeline.<name>.prepare or entries.<entry>.initialization")
        if "master-flow" in spec:
            raise RuntimeError("spec.master-flow was removed; use entries.master_flow and server request claiming")
        entries = spec.get("entries", {})
        if not isinstance(entries, dict):
            raise RuntimeError("entries must be a mapping")
        for name, value in entries.items():
            if name not in {"direct_flow", "master_flow"} or not isinstance(value, dict):
                raise RuntimeError(f"entries.{name}: expected direct_flow/master_flow mapping")
            for phase in ("initialization", "finalization"):
                self.validate_actions(value.get(phase, []), f"entries.{name}.{phase}")
        pipelines = spec.get("pipeline", {})
        if not isinstance(pipelines, dict):
            raise RuntimeError("pipeline must be a mapping")
        for name, value in pipelines.items():
            if not isinstance(value, dict):
                raise RuntimeError(f"pipeline.{name} must be a mapping")
            self.validate_actions(value.get("prepare", []), f"pipeline.{name}.prepare")
        self.spec, self.devices, self.workdir = spec, devices, workdir
        self.context = deepcopy(base)
        self.context["entry"] = {"name": entry, "status": "running"}
        self.lifecycle = entries.get(entry, {})
        self.prepared: dict[str, dict] = {}
        self.prepare_errors: dict[str, Exception] = {}

    @staticmethod
    def validate_actions(actions: Any, label: str) -> None:
        if not isinstance(actions, list) or not all(isinstance(a, dict) for a in actions):
            raise RuntimeError(f"{label} must be a list of action mappings")

    def initialize(self) -> None:
        for index, action in enumerate(self.lifecycle.get("initialization", [])):
            run_action(action, self.context, {}, self.workdir, label=f"entry initialization[{index}]")

    def finalize(self, failed: bool) -> None:
        self.context["entry"]["status"] = "failed" if failed else "success"
        errors = []
        for index, action in enumerate(self.lifecycle.get("finalization", [])):
            try:
                run_action(action, self.context, {}, self.workdir, label=f"entry finalization[{index}]")
            except Exception as exc:
                errors.append(str(exc))
                self.context["entry"]["status"] = "failed"
        if errors:
            raise RuntimeError("entry finalization: " + "; ".join(errors))

    def execute(self, requests: list[tuple[str, dict, dict]], report=None) -> bool:
        terminal = set()
        def tracked_report(request, status):
            report(request, status)
            if status in {"succeeded", "process_failed"}:
                terminal.add(request.get("requestId"))
        try:
            return self._execute(requests, tracked_report if report else None)
        except KeyboardInterrupt:
            if report:
                for _, _, request in requests:
                    if request.get("requestId") not in terminal:
                        try:
                            tracked_report(request, "process_failed")
                        except Exception as exc:
                            print(f"[REPORT] interrupted request: {exc}", flush=True)
            raise

    def _execute(self, requests: list[tuple[str, dict, dict]], report=None) -> bool:
        queued, contexts, metadata = [], [], []
        report_errors = []
        def send(request, status):
            if report:
                try:
                    report(request, status)
                except Exception as exc:
                    report_errors.append(str(exc))
        failed = False
        for name, payload, request in requests:
            try:
                definition = self.spec.get("pipeline", {}).get(name)
                if not isinstance(definition, dict):
                    raise RuntimeError(f"pipeline {name!r} is not defined")
                if not isinstance(payload, dict):
                    raise RuntimeError(f"pipeline {name!r}: request payload must be a mapping")
                validate_pipeline(definition, name)
                context = deepcopy(self.prepared.get(name, self.context))
                if name not in self.prepared:
                    _apply_context(context, _render(definition.get("context", {}), context))
                params_for(definition.get("params", {}), payload, context, f"pipeline {name}")
                if name in self.prepare_errors:
                    raise self.prepare_errors[name]
                if name not in self.prepared:
                    try:
                        for index, action in enumerate(definition.get("prepare", [])):
                            run_action(action, context, {}, self.workdir, label=f"pipeline {name} prepare[{index}]")
                        from mu.pipelines import _discover_models
                        context["sys"]["models"] = _discover_models(Path(context["sys"]["cache_dir"]))
                        self.prepared[name] = context
                    except Exception as exc:
                        self.prepare_errors[name] = exc
                        raise
                context = deepcopy(self.prepared[name])
                if request:
                    context["request"] = deepcopy(request)
                if report:
                    send(request, "processing")
                queued.append((name, payload))
                contexts.append(context)
                metadata.append(request)
            except Exception as exc:
                print(f"[REQUEST] {name}: failed: {exc}", flush=True)
                failed = True
                if report:
                    send(request, "process_failed")
        if queued:
            try:
                outcomes = execute_pipelines(self.spec, queued, self.context, self.devices, self.workdir, request_contexts=contexts)
            except BaseException:
                if report:
                    for request in metadata:
                        send(request, "process_failed")
                raise
            for request, states in zip(metadata, outcomes):
                error = any(value == "failed" for value in states.values())
                failed |= error
                if report:
                    send(request, "process_failed" if error else "succeeded")
        if report_errors:
            raise RuntimeError("request reporting failed: " + "; ".join(report_errors))
        return failed
