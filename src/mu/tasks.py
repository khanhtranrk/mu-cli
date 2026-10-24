"""Convert expanded pipelines into dependency-aware processor tasks."""

from copy import deepcopy
from typing import Any

class TaskGraphError(ValueError):
    """A pipeline's task dependencies are invalid."""


TERMINAL = {"succeeded", "failed", "skipped"}


def pipelines_to_tasks(pipelines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Create one task per processor step and resolve waiting-for step names."""
    tasks: list[dict[str, Any]] = []
    for pipeline_index, pipeline in enumerate(pipelines, start=1):
        steps = pipeline.get("steps")
        if not isinstance(steps, list):
            raise TaskGraphError(f"pipeline {pipeline.get('pipeline')!r} has no steps list")
        names: list[str] = []
        for step_index, step in enumerate(steps, start=1):
            if not isinstance(step, dict) or not isinstance(step.get("processor"), str):
                raise TaskGraphError(f"pipeline step {step_index} has no processor")
            name = step.get("name", step["processor"])
            if not isinstance(name, str) or name in names:
                raise TaskGraphError(f"pipeline step names must be unique strings (got {name!r})")
            names.append(name)

        id_by_name = {name: f"p{pipeline_index}-t{step_index}" for step_index, name in enumerate(names, start=1)}
        pipeline_tasks: list[dict[str, Any]] = []
        for step_index, (name, step) in enumerate(zip(names, steps), start=1):
            waiting_for = step.get("waiting-for", [])
            if waiting_for is None:
                waiting_for = []
            if not isinstance(waiting_for, list) or not all(isinstance(item, str) for item in waiting_for):
                raise TaskGraphError(f"step {name!r} waiting-for must be a list of step names")
            unknown = [item for item in waiting_for if item not in id_by_name]
            if unknown:
                raise TaskGraphError(f"step {name!r} waits for unknown step(s): {', '.join(unknown)}")
            if name in waiting_for:
                raise TaskGraphError(f"step {name!r} cannot wait for itself")
            processor_config = step.get("processor_config", {})
            if not isinstance(processor_config, dict):
                raise TaskGraphError(f"step {name!r} processor configuration must be a mapping")
            units = processor_config.get("units", step.get("units", 1))
            if not isinstance(units, (int, float)) or isinstance(units, bool) or units < 0:
                raise TaskGraphError(f"step {name!r} units must be a non-negative number")
            pipeline_tasks.append({
                "id": id_by_name[name],
                "pipeline": pipeline.get("pipeline"),
                "pipeline_run_id": f"p{pipeline_index}",
                "request": deepcopy(pipeline.get("request", {})),
                "item": deepcopy(pipeline.get("item", pipeline.get("request", {}))),
                "collection": pipeline.get("collection"),
                "item_alias": pipeline.get("item_alias", "request"),
                "name": name,
                "processor": step["processor"],
                "processor_config": deepcopy(processor_config),
                "step_config": deepcopy(step),
                "validation_context": deepcopy(step.get("validation_context", {})),
                "units": units,
                "waiting_for": [id_by_name[item] for item in waiting_for],
                "status": "pending",
                "error": None,
            })
        _check_acyclic(pipeline_tasks)
        tasks.extend(pipeline_tasks)
    return tasks


def _check_acyclic(tasks: list[dict[str, Any]]) -> None:
    dependencies = {task["id"]: set(task["waiting_for"]) for task in tasks}
    visited: set[str] = set()
    active: set[str] = set()

    def visit(task_id: str) -> None:
        if task_id in active:
            raise TaskGraphError(f"task dependencies contain a cycle at {task_id}")
        if task_id in visited:
            return
        active.add(task_id)
        for dependency in dependencies[task_id]:
            visit(dependency)
        active.remove(task_id)
        visited.add(task_id)

    for task_id in dependencies:
        visit(task_id)


class Scheduler:
    """Track task state and expose tasks whose dependencies are satisfied."""

    def __init__(self, tasks: list[dict[str, Any]], *, max_units: float | None = None) -> None:
        self.tasks = {task["id"]: task for task in tasks}
        if len(self.tasks) != len(tasks):
            raise TaskGraphError("task IDs must be unique")
        self.max_units = max_units
        self._validate_dependencies()

    def _validate_dependencies(self) -> None:
        for task in self.tasks.values():
            for dependency in task["waiting_for"]:
                if dependency not in self.tasks:
                    raise TaskGraphError(f"task {task['id']} has unknown dependency {dependency}")

    def _skip_failed_dependents(self) -> None:
        changed = True
        while changed:
            changed = False
            for task in self.tasks.values():
                if task["status"] != "pending":
                    continue
                dependencies = [self.tasks[dep] for dep in task["waiting_for"]]
                if any(dep["status"] in {"failed", "skipped"} for dep in dependencies):
                    task["status"] = "skipped"
                    task["error"] = "a dependency failed"
                    changed = True

    def ready_tasks(self) -> list[dict[str, Any]]:
        """Return pending tasks whose dependencies succeeded and fit available units."""
        self._skip_failed_dependents()
        used_units = sum(task["units"] for task in self.tasks.values() if task["status"] == "running")
        ready: list[dict[str, Any]] = []
        reserved = used_units
        for task in self.tasks.values():
            if task["status"] != "pending":
                continue
            if not all(self.tasks[dep]["status"] == "succeeded" for dep in task["waiting_for"]):
                continue
            if self.max_units is not None and reserved + task["units"] > self.max_units:
                continue
            ready.append(task)
            reserved += task["units"]
        return ready

    def start(self, task_id: str) -> None:
        ready_ids = {task["id"] for task in self.ready_tasks()}
        if task_id not in ready_ids:
            raise TaskGraphError(f"task {task_id!r} is not ready")
        self.tasks[task_id]["status"] = "running"

    def succeed(self, task_id: str) -> None:
        self._finish(task_id, "succeeded", None)

    def fail(self, task_id: str, error: str) -> None:
        self._finish(task_id, "failed", error)
        self._skip_failed_dependents()

    def _finish(self, task_id: str, status: str, error: str | None) -> None:
        if task_id not in self.tasks or self.tasks[task_id]["status"] != "running":
            raise TaskGraphError(f"task {task_id!r} is not running")
        self.tasks[task_id]["status"] = status
        self.tasks[task_id]["error"] = error

    def snapshot(self) -> list[dict[str, Any]]:
        return list(self.tasks.values())
