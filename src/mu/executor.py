"""Run processor tasks while respecting dependencies and per-GPU VRAM units."""

from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
import os
import re
import subprocess
from typing import Any

from mu.hardware import ComputeDevice
from mu.tasks import Scheduler, TaskGraphError


def execute_tasks(
    tasks: list[dict[str, Any]],
    devices: list[ComputeDevice],
    *,
    force_cpu: set[str] | None = None,
    working_dir: str | None = None,
    max_units: float | None = None,
) -> list[dict[str, Any]]:
    """Execute ready tasks concurrently, launching dependents after success."""
    force_cpu = force_cpu or set()
    if max_units is not None:
        too_large = [task for task in tasks if float(task["units"]) > max_units]
        if too_large:
            names = ", ".join(task["id"] for task in too_large)
            raise TaskGraphError(f"max_units is below the requirement of task(s): {names}")
    scheduler = Scheduler(tasks)
    free_units = {device.index: device.capacity_units for device in devices}
    futures: dict[Future[str | None], tuple[str, ComputeDevice | None]] = {}
    running_units = 0.0
    max_workers = max(1, min(32, len(tasks)))

    with ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="mu-task") as pool:
        while True:
            launched = False
            for task in scheduler.ready_tasks():
                task_id = task["id"]
                units = float(task["units"])
                if max_units is not None and running_units + units > max_units:
                    continue
                device = None if units == 0 or task_id in force_cpu or not devices else _choose_device(task, devices, free_units)
                if units > 0 and devices and task_id not in force_cpu and device is None:
                    continue
                scheduler.start(task_id)
                task["device"] = device.index if device is not None else "cpu"
                running_units += units
                if device is not None:
                    free_units[device.index] -= units
                future = pool.submit(_run_one, task, device, working_dir)
                futures[future] = (task_id, device)
                launched = True

            if not futures:
                if all(task["status"] in {"succeeded", "failed", "skipped"} for task in scheduler.snapshot()):
                    break
                if not launched:
                    raise TaskGraphError("scheduler deadlock: pending tasks cannot be assigned to available devices")
                continue

            if not launched or len(futures) >= max_workers:
                completed, _ = wait(futures, return_when=FIRST_COMPLETED)
            else:
                # Refill available capacity before blocking for a result.
                continue
            for future in completed:
                task_id, device = futures.pop(future)
                if device is not None:
                    free_units[device.index] += float(scheduler.tasks[task_id]["units"])
                running_units -= float(scheduler.tasks[task_id]["units"])
                try:
                    error = future.result()
                except Exception as exc:
                    error = f"unexpected task runner error: {exc}"
                if error is None:
                    scheduler.succeed(task_id)
                else:
                    scheduler.fail(task_id, error)

    return scheduler.snapshot()


def _choose_device(
    task: dict[str, Any], devices: list[ComputeDevice], free_units: dict[str, float]
) -> ComputeDevice | None:
    fitting = [device for device in devices if free_units[device.index] >= float(task["units"])]
    if not fitting:
        return None
    # Pack onto the fullest fitting card and keep other devices available for larger tasks.
    return min(fitting, key=lambda device: free_units[device.index] - float(task["units"]))


def _run_one(task: dict[str, Any], device: ComputeDevice | None, working_dir: str | None) -> str | None:
    config = task.get("processor_config", {})
    target = config.get("target")
    params = config.get("params", [])
    if not isinstance(target, str) or not target:
        return f"processor {task.get('processor')!r} has no command target"
    if not isinstance(params, list) or not all(isinstance(arg, (str, int, float)) for arg in params):
        return f"processor {task.get('processor')!r} params must be a list of command arguments"
    command = [target, *(str(arg) for arg in params)]
    environment = os.environ.copy()

    if device is not None:
        device_args = config.get("device_args", [])
        if not isinstance(device_args, list) or not all(isinstance(arg, str) for arg in device_args):
            return f"processor {task.get('processor')!r} device_args must be a list of strings"
        has_index_placeholder = any(re.search(r"\{device_index\}", arg) for arg in device_args)
        device_context = {"device_index": device.index}
        try:
            command.extend(arg.format_map(device_context) for arg in device_args)
        except (KeyError, ValueError) as exc:
            return f"processor {task.get('processor')!r} has invalid device_args template: {exc}"
        # If args do not carry the physical index, mask the selected GPU so it appears as cuda:0.
        if not has_index_placeholder:
            visibility = "CUDA_VISIBLE_DEVICES" if device.backend == "nvidia" else "HIP_VISIBLE_DEVICES"
            environment[visibility] = device.index
            if device.backend == "rocm":
                environment["ROCR_VISIBLE_DEVICES"] = device.index
    else:
        # A confirmed CPU fallback should not let a CUDA/ROCm runtime silently select a GPU.
        environment["CUDA_VISIBLE_DEVICES"] = ""
        environment["HIP_VISIBLE_DEVICES"] = ""
        environment["ROCR_VISIBLE_DEVICES"] = ""

    try:
        result = subprocess.run(command, cwd=working_dir, env=environment, check=False)
    except OSError as exc:
        return f"could not start {target}: {exc}"
    if result.returncode:
        return f"{target} exited with status {result.returncode}"
    return None
