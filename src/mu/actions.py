"""Pluggable action handlers used by repair, input prep, and processor steps."""

from pathlib import Path
import json
import subprocess
from typing import Any, Callable


class ActionError(ValueError):
    """An action declaration is invalid or failed while running."""


ActionHandler = Callable[[dict[str, Any], dict[str, Any]], None]
ACTION_HANDLERS: dict[str, ActionHandler] = {}


def register_action(name: str) -> Callable[[ActionHandler], ActionHandler]:
    """Register an action implementation with action-specific parameters."""
    def decorator(handler: ActionHandler) -> ActionHandler:
        ACTION_HANDLERS[name] = handler
        return handler
    return decorator


def run_action(action: dict[str, Any], context: dict[str, Any] | None = None) -> None:
    name = action.get("action")
    if not isinstance(name, str) or name not in ACTION_HANDLERS:
        raise ActionError(f"unknown action {name!r}")
    ACTION_HANDLERS[name](action, context or {})


@register_action("command")
def command_action(action: dict[str, Any], context: dict[str, Any]) -> None:
    steps = action.get("steps", [])
    if not isinstance(steps, list):
        raise ActionError("command.steps must be a list of argument lists")
    for index, command in enumerate(steps):
        if not isinstance(command, list) or not command or not all(isinstance(arg, str) for arg in command):
            raise ActionError(f"command.steps[{index}] must be a non-empty list of strings")
        rendered = [_render(arg, context) for arg in command]
        working_dir = context.get("action_dir", context.get("working_dir"))
        completed = subprocess.run(rendered, check=False, cwd=working_dir, capture_output=True, text=True)
        if completed.returncode:
            detail = completed.stderr.strip() or completed.stdout.strip()
            suffix = f": {detail}" if detail else ""
            raise ActionError(
                f"command.steps[{index}] exited with status {completed.returncode}{suffix}"
            )


@register_action("create-dir")
def create_dir_action(action: dict[str, Any], context: dict[str, Any]) -> None:
    """Create a directory path, including any missing parent directories."""
    raw_path = action.get("path")
    if not isinstance(raw_path, str) or not raw_path:
        raise ActionError("create-dir.path must be a non-empty path string")
    path = Path(_render(raw_path, context)).expanduser()
    if not path.is_absolute():
        path = Path(context.get("working_dir", Path.cwd())) / path
    try:
        path.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise ActionError(f"create-dir could not create {path}: {exc}") from exc


@register_action("write-jsons-from-context")
def write_jsons_from_context(action: dict[str, Any], context: dict[str, Any]) -> None:
    """Write one JSON document per item under context[action.target]."""
    target = action.get("target")
    output = action.get("output")
    content = action.get("content")
    if not isinstance(target, str) or not isinstance(output, str) or not isinstance(content, dict):
        raise ActionError("write-jsons-from-context requires string target/output and mapping content")
    items = context.get(target)
    if not isinstance(items, list):
        raise ActionError(f"context[{target!r}] must be a list")
    for item in items:
        if not isinstance(item, dict):
            raise ActionError("write-jsons-from-context items must be mappings")
        values = {**context, "request": item}
        directory = Path(_render(output, values)).expanduser()
        directory.mkdir(parents=True, exist_ok=True)
        rendered = {key: _render(value, values) for key, value in content.items()}
        (directory / f"{item.get('name', 'item')}.json").write_text(
            json.dumps(rendered, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )


@register_action("write-json-from-context")
def write_json_from_context(action: dict[str, Any], context: dict[str, Any]) -> None:
    """Write one JSON document from the current (usually request) context."""
    output = action.get("output")
    content = action.get("content")
    if not isinstance(output, str) or not output:
        raise ActionError("write-json-from-context.output must be a non-empty path string")
    if not isinstance(content, dict):
        raise ActionError("write-json-from-context.content must be a mapping")
    path = Path(_render(output, context)).expanduser()
    if not path.is_absolute():
        path = Path(context.get("working_dir", Path.cwd())) / path
    rendered = _render(content, context)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(rendered, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except OSError as exc:
        raise ActionError(f"write-json-from-context could not write {path}: {exc}") from exc


def _render(value: Any, context: dict[str, Any]) -> Any:
    """Resolve the simple {name} and {request[field]} placeholders in strings."""
    if isinstance(value, dict):
        return {key: _render(item, context) for key, item in value.items()}
    if isinstance(value, list):
        return [_render(item, context) for item in value]
    if not isinstance(value, str):
        return value
    import re

    def lookup(expression: str) -> tuple[bool, Any]:
        if "[" in expression and expression.endswith("]"):
            root, key = expression[:-1].split("[", 1)
            current = context.get(root)
            if isinstance(current, dict) and key in current:
                return True, current[key]
            return False, None
        return (True, context[expression]) if expression in context else (False, None)

    exact = re.fullmatch(r"\{([^{}]+)\}", value)
    if exact:
        found, resolved = lookup(exact.group(1))
        if found:
            return resolved

    def replace(match: re.Match[str]) -> str:
        expression = match.group(1)
        found, resolved = lookup(expression)
        return str(resolved) if found else match.group(0)

    rendered = value
    for _ in range(8):
        updated = re.sub(r"\{([^{}]+)\}", replace, rendered)
        if updated == rendered:
            break
        rendered = updated
    return rendered


# Accept the older descriptive alias used in prose/config examples as well.
ACTION_HANDLERS["write-jsons-from-text"] = write_jsons_from_context
# Accept the common typo used in early configuration examples.
ACTION_HANDLERS["write-json-form-context"] = write_json_from_context
