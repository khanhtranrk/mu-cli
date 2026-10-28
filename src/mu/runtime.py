"""Runtime for the workload/pipeline spec format."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
from typing import Any
from urllib.request import Request, urlopen

import yaml

from mu.hardware import ComputeDevice
from mu.pipelines import _render


class RuntimeError(ValueError):
    pass


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
    elif op in {"file-exists", "folder-exists", "path-exists"}:
        path = Path(str(_render(spec.get("path", ""), context))).expanduser()
        if not path.is_absolute(): path = Path(context["session"]["working_dir"]) / path
        value = path.is_file() if op == "file-exists" else path.is_dir() if op == "folder-exists" else path.exists()
    elif op == "exit-code":
        target = _render(spec.get("target"), context)
        if not isinstance(target, list) or not target:
            raise RuntimeError("exit-code.target must be a non-empty command list")
        expected = spec.get("expected", 0)
        if not isinstance(expected, int) or isinstance(expected, bool):
            raise RuntimeError("exit-code.expected must be an integer")
        try:
            result = subprocess.run(list(map(str, target)), cwd=context["session"]["working_dir"], capture_output=True, text=True)
            value = result.returncode == expected
        except OSError:
            value = False
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


def run_action(action: dict[str, Any], context: dict[str, Any], states: dict[str, str], workdir: Path) -> None:
    _apply_context(context, _render(action.get("context", {}), context))
    if action.get("skip_if") and condition(action["skip_if"], context, states): return
    if not condition(action.get("precondition"), context, states): return
    typ = action.get("type", action.get("action"))
    values = _render(action, context)
    try:
        if typ in {"execute-command", "execute-commands"}:
            commands = values.get("commands", []) if typ == "execute-commands" else [values]
            for item in commands:
                target = item.get("target")
                args = item.get("args", [])
                if not target or not isinstance(args, list): raise RuntimeError("execute-command requires target and args")
                subprocess.run([str(target), *map(str, args)], cwd=workdir, env={**os.environ, **item.get("env", {})}, check=True, capture_output=True, text=True)
        elif typ == "create-dir":
            Path(values["path"]).expanduser().mkdir(parents=True, exist_ok=True)
        elif typ == "write-json":
            path = Path(values["path"]).expanduser(); path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(values.get("content", {}), ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
        elif typ in {"send_http_request", "send-http-request"}:
            data = values.get("body")
            payload = json.dumps(data).encode() if data is not None else None
            req = Request(values["url"], data=payload, headers=values.get("header", {}), method=str(values.get("method", "get")).upper())
            with urlopen(req, timeout=30) as response:
                response_data = response.read()
            key = values.get("save_response_to_context")
            if key: context[key] = json.loads(response_data) if response_data else None
        else:
            raise RuntimeError(f"unknown action type {typ!r}")
    except Exception as exc:
        if action.get("ignore_error"): return
        raise RuntimeError(f"action {typ!r} failed: {exc}") from exc
    if action.get("postcondition") and not condition(action["postcondition"], context, states):
        if not action.get("ignore_error"): raise RuntimeError(f"action {typ!r} postcondition failed")


def execute_workload(spec: dict[str, Any], name: str, supplied: dict[str, Any], context: dict[str, Any], device: ComputeDevice | None, workdir: Path) -> None:
    declaration = spec.get("workloads", {}).get(name)
    if not isinstance(declaration, dict): raise RuntimeError(f"workload {name!r} is not defined")
    context["params"] = params_for(declaration.get("params", {}), supplied, context, f"workload {name}")
    target = _render(declaration.get("target", ""), context)
    args = _render(declaration.get("args", []), context)
    if not isinstance(args, list): raise RuntimeError(f"workload {name!r}.args must be a list")
    command = [str(target), *map(str, args)]
    if device:
        context["schedule"] = {"device_family": device.backend, "device_index": device.index}
        command += list(map(str, _render(declaration.get("device_args", []), context)))
    env = {**os.environ, **_render(declaration.get("env", {}), context)}
    result = subprocess.run(command, cwd=workdir, env=env, check=False, capture_output=True, text=True)
    if result.returncode:
        detail = result.stderr.strip() or result.stdout.strip()
        raise RuntimeError(f"{target} exited with status {result.returncode}" + (f": {detail}" if detail else ""))


def execute_pipeline(spec: dict[str, Any], pipeline_name: str, request: dict[str, Any], base: dict[str, Any], devices: list[ComputeDevice], workdir: Path) -> dict[str, str]:
    definition = spec.get("pipeline", {}).get(pipeline_name)
    if not isinstance(definition, dict): raise RuntimeError(f"pipeline {pipeline_name!r} is not defined")
    context = dict(base)
    _apply_context(context, _render(definition.get("context", {}), context))
    context["params"] = params_for(definition.get("params", {}), request, context, f"pipeline {pipeline_name}")
    nodes = definition.get("nodes", [])
    if not isinstance(nodes, list): raise RuntimeError("pipeline.nodes must be a list")
    by_name = {node.get("name"): node for node in nodes}
    if len(by_name) != len(nodes) or None in by_name: raise RuntimeError("node names must be unique")
    states: dict[str, str] = {}; pending = list(nodes)
    while pending:
        progressed = False
        for node in list(pending):
            deps = node.get("depends_on", [])
            if any(d.get("node", d.get("name")) not in states for d in deps): continue
            if any(not condition(d.get("condition"), {**context, "node": {"name": d.get("node", d.get("name"))}}, states) for d in deps):
                states[node.get("name")] = "failed"
                pending.remove(node); progressed = True
                continue
            name = node["name"]; node_context = dict(context)
            node_context["node"] = {"name": name, "status": "running", "total_units": 0}
            _apply_context(node_context, _render(node.get("context", {}), node_context))
            state = "success"
            try:
                if node.get("skip_if") and condition(node["skip_if"], node_context, states):
                    state = "success"
                    if node.get("postcondition") and not condition(node["postcondition"], node_context, states):
                        raise RuntimeError(f"node {name!r} postcondition failed after skip")
                elif not condition(node.get("precondition"), node_context, states):
                    raise RuntimeError(f"node {name!r} precondition failed")
                else:
                    for action in node.get("before_run", []): run_action(action, node_context, states, workdir)
                    run = node.get("run")
                    if isinstance(run, dict):
                        workload = run.get("workload")
                        config = spec.get("workloads", {}).get(workload, {})
                        units = config.get("units", 0); node_context["node"]["total_units"] = units
                        device = next((d for d in devices if d.capacity_units >= units), None) if units else None
                        execute_workload(spec, workload, run.get("args", {}), node_context, device, workdir)
                    for action in node.get("after_run", []): run_action(action, node_context, states, workdir)
                    if node.get("postcondition") and not condition(node["postcondition"], node_context, states): raise RuntimeError(f"node {name!r} postcondition failed")
            except Exception as exc:
                state = "failed"; error = str(exc)
            states[name] = state
            for action in node.get("finally", []):
                node_context["node"]["status"] = state
                try: run_action(action, node_context, states, workdir)
                except Exception as exc: state = "failed"; error = str(exc)
            states[name] = state
            if state == "failed": print(f"[FAIL] {pipeline_name}/{name}: {error}")
            else: print(f"[OK] {pipeline_name}/{name} {state}")
            pending.remove(node); progressed = True
        if not progressed: raise RuntimeError("pipeline dependencies are cyclic or reference unknown nodes")
    return states
