"""Build fully expanded pipeline descriptions from a spec and input file."""

from copy import deepcopy
from pathlib import Path
import re
import subprocess
from typing import Any

import yaml

from mu.actions import ActionError, run_action


class PipelineBuildError(ValueError):
    """The spec or input cannot be expanded into pipelines."""


MODEL_SUFFIXES = {".gguf", ".safetensor", ".safetensors"}


def list_model_files(cache_dir: Path) -> list[Path]:
    """List supported model files under the cache models directory."""
    models_dir = cache_dir / "models"
    if not models_dir.is_dir():
        return []
    return sorted(
        (path.resolve() for path in models_dir.rglob("*")
         if path.is_file() and path.suffix.lower() in MODEL_SUFFIXES),
        key=str,
    )


def _discover_models(cache_dir: Path) -> dict[str, str]:
    """Index supported models by relative path and unambiguous filename aliases."""
    files = list_model_files(cache_dir)
    models_dir = (cache_dir / "models").expanduser().resolve()
    models: dict[str, str] = {}
    by_name: dict[str, list[Path]] = {}
    by_stem: dict[str, list[Path]] = {}
    for path in files:
        relative = path.relative_to(models_dir)
        relative_key = relative.as_posix()
        models[relative_key] = str(path)
        models[relative.with_suffix("").as_posix()] = str(path)
        by_name.setdefault(path.name, []).append(path)
        by_stem.setdefault(path.stem, []).append(path)
    for name, matches in by_name.items():
        if len(matches) == 1:
            models[name] = str(matches[0])
    for stem, matches in by_stem.items():
        if len(matches) == 1:
            models[stem] = str(matches[0])
    return models


def _read_yaml(path: Path, label: str) -> dict[str, Any]:
    try:
        with path.open(encoding="utf-8") as stream:
            value = yaml.safe_load(stream)
    except (OSError, yaml.YAMLError) as exc:
        raise PipelineBuildError(f"cannot read {label} {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise PipelineBuildError(f"{label} root must be a YAML mapping")
    return value


def run_input_before(
    input_path: Path,
    *,
    cache_dir: Path,
    output_dir: Path,
) -> dict[str, Any]:
    """Run input-level preparation actions and return the parsed input context."""
    input_data = _read_yaml(input_path, "input")
    actions = input_data.get("before", [])
    if not isinstance(actions, list):
        raise PipelineBuildError("input 'before' must be a list")
    resolved_cache = cache_dir.expanduser().resolve()
    context = {
        **input_data,
        "cache_dir": str(resolved_cache),
        "temp_dir": str(resolved_cache),
        "output_dir": str(output_dir.expanduser().resolve()),
        "working_dir": str(Path.cwd()),
    }
    for index, action in enumerate(actions):
        if not isinstance(action, dict):
            raise PipelineBuildError(f"input before[{index}] must be a mapping")
        try:
            run_action(action, context)
        except (ActionError, OSError, subprocess.CalledProcessError) as exc:
            raise PipelineBuildError(f"input before[{index}] failed: {exc}") from exc
    return input_data


def _lookup(expression: str, context: dict[str, Any]) -> tuple[bool, Any]:
    match = re.fullmatch(r"([A-Za-z_][\w]*)(?:\[([^\]]+)\])?", expression)
    if not match:
        return False, None
    value: Any = context.get(match.group(1))
    if match.group(2) is not None:
        if not isinstance(value, dict) or match.group(2) not in value:
            return False, None
        value = value[match.group(2)]
    elif match.group(1) not in context:
        return False, None
    return True, value


def _render(value: Any, context: dict[str, Any]) -> Any:
    if isinstance(value, dict):
        return {key: _render(item, context) for key, item in value.items()}
    if isinstance(value, list):
        return [_render(item, context) for item in value]
    if not isinstance(value, str):
        return value

    rendered = value
    for _ in range(8):
        def replace(match: re.Match[str]) -> str:
            found, replacement = _lookup(match.group(1), context)
            return str(replacement) if found else match.group(0)

        updated = re.sub(r"\{([^{}]+)\}", replace, rendered)
        if updated == rendered:
            break
        rendered = updated
    return rendered


def build_pipelines(
    spec_path: Path,
    input_path: Path,
    pipeline_names: list[str],
    *,
    cache_dir: Path,
    output_dir: Path,
    input_data: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Expand each selected pipeline once for every request in the input."""
    spec = _read_yaml(spec_path, "spec")
    if input_data is None:
        input_data = _read_yaml(input_path, "input")
    processors = spec.get("processors", {})
    definitions = spec.get("pipelines", {})
    requests = input_data.get("requests", [])
    if not isinstance(processors, dict):
        raise PipelineBuildError("spec 'processors' must be a mapping")
    if not isinstance(definitions, dict):
        raise PipelineBuildError("spec 'pipelines' must be a mapping")
    if not isinstance(requests, list):
        raise PipelineBuildError("input 'requests' must be a list")

    result: list[dict[str, Any]] = []
    resolved_cache_dir = cache_dir.expanduser().resolve()
    common = {
        "cache_dir": str(resolved_cache_dir),
        "output_dir": str(output_dir.expanduser().resolve()),
        "working_dir": str(Path.cwd()),
        "temp_dir": str(resolved_cache_dir),
        "models": _discover_models(resolved_cache_dir),
    }
    for pipeline_name in pipeline_names:
        definition = definitions.get(pipeline_name)
        if not isinstance(definition, dict):
            raise PipelineBuildError(f"pipeline {pipeline_name!r} is not defined")
        steps = definition.get("steps", [])
        if not isinstance(steps, list):
            raise PipelineBuildError(f"pipeline {pipeline_name!r}.steps must be a list")
        for request_index, request in enumerate(requests):
            if not isinstance(request, dict):
                raise PipelineBuildError(f"input requests[{request_index}] must be a mapping")
            context = {**common, "request": request}
            resolved_request = _render(deepcopy(request), context)
            context["request"] = resolved_request
            expanded_steps: list[dict[str, Any]] = []
            for step_index, raw_step in enumerate(steps):
                if not isinstance(raw_step, dict):
                    raise PipelineBuildError(f"pipeline {pipeline_name!r}.steps[{step_index}] must be a mapping")
                processor_name = raw_step.get("processor")
                if not isinstance(processor_name, str):
                    raise PipelineBuildError(f"pipeline {pipeline_name!r}.steps[{step_index}].processor is required")
                processor = processors.get(processor_name)
                if not isinstance(processor, dict):
                    raise PipelineBuildError(f"processor {processor_name!r} is not defined")
                processor_values = _render(deepcopy(processor), context)
                step_values = _render(deepcopy(raw_step), context)
                expanded_steps.append({
                    **processor_values,
                    **step_values,
                    "processor": processor_name,
                    "processor_config": processor_values,
                    "validation_context": {**common, "request": resolved_request},
                })
            result.append({
                "pipeline": pipeline_name,
                "request": resolved_request,
                "steps": expanded_steps,
            })
    return result
