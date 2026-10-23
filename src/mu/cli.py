from pathlib import Path
import shlex

import typer

from mu.spec import SpecError, repair_spec, validate_spec
from mu.pipelines import PipelineBuildError, build_pipelines, run_input_before
from mu.tasks import Scheduler, TaskGraphError, pipelines_to_tasks
from mu.executor import execute_tasks
from mu.hardware import detect_devices, linux_integrated_gpu_names

app = typer.Typer(no_args_is_help=True)
spec_app = typer.Typer(no_args_is_help=True)
app.add_typer(spec_app, name="spec")


def _print_run_report(pipeline: str, tasks: list[dict], input_results: list[dict]) -> None:
    typer.echo(f"\nRun report: {pipeline}")
    typer.echo("Inputs")
    if not input_results:
        typer.echo("  No requests were selected.")
    for item in input_results:
        state = item["status"]
        color = "green" if state == "completed" else "yellow" if state == "blocked" else "red"
        label = typer.style(state.upper(), fg=color, bold=True)
        typer.echo(
            f"  {label}  {item['request'] or '(unnamed)'} "
            f"[{item['succeeded']} succeeded, {item['failed']} failed, {item['blocked']} blocked]"
        )

    typer.echo("Tasks")
    if not tasks:
        typer.echo("  No processor tasks were created.")
    for task in tasks:
        state = task["status"]
        marker, color = {
            "succeeded": ("OK", "green"),
            "failed": ("FAIL", "red"),
            "skipped": ("BLOCKED", "yellow"),
        }.get(state, (state.upper(), "white"))
        label = typer.style(f"[{marker}]", fg=color, bold=True)
        device = task.get("device", "not assigned")
        details = f"{task['id']}  {task['name']} → {task['processor']}  on {device}  ({task['units']} units)"
        if task["waiting_for"]:
            details += f"  after {', '.join(task['waiting_for'])}"
        typer.echo(f"  {label} {details}")
        if task.get("error"):
            typer.echo(f"       Error: {task['error']}")

    succeeded = sum(task["status"] == "succeeded" for task in tasks)
    failed = sum(task["status"] == "failed" for task in tasks)
    blocked = sum(task["status"] == "skipped" for task in tasks)
    completed_inputs = sum(item["status"] == "completed" for item in input_results)
    typer.echo(
        f"Summary: {completed_inputs}/{len(input_results)} inputs completed; "
        f"{succeeded} tasks succeeded, {failed} failed, {blocked} blocked."
    )


def _validation_context(cache_dir: Path) -> dict[str, str]:
    return {
        "cache_dir": str(cache_dir.expanduser().resolve()),
        "working_dir": str(Path.cwd()),
    }


def _print_plan_report(
    pipeline: str,
    tasks: list[dict],
    validations: list,
    devices: list,
    max_units: float | None,
) -> None:
    typer.echo(f"\nExecution plan: {pipeline}")
    typer.echo("Repair validation (read-only)")
    if not validations:
        typer.echo("  No repair validation checks are declared.")
    for result in validations:
        label = typer.style("PASS" if result.passed else "FAIL", fg="green" if result.passed else "red", bold=True)
        typer.echo(f"  {label}  {result.message}")
    typer.echo("  Run will execute repair actions before processing tasks.")

    typer.echo("Hardware")
    if devices:
        for device in devices:
            typer.echo(f"  GPU {device.index}: {device.name}, {device.vram_gib:.1f} GiB ({device.capacity_units:.2f} units)")
    else:
        typer.echo("  No supported GPU detected; GPU tasks will require CPU fallback confirmation in run.")

    scheduler = Scheduler(tasks, max_units=max_units)
    ready_ids = {task["id"] for task in scheduler.ready_tasks()}
    typer.echo("Planned tasks")
    for task in tasks:
        if float(task["units"]) == 0:
            placement = "CPU (0 VRAM units)"
        else:
            candidates = [device.index for device in devices if device.capacity_units >= float(task["units"])]
            placement = f"GPU candidates: {', '.join(candidates)}" if candidates else "no GPU fits; CPU fallback confirmation needed"
        if task["id"] in ready_ids:
            state, color = "READY", "green"
        elif max_units is not None and float(task["units"]) > max_units:
            state, color = "OVER LIMIT", "red"
        else:
            state, color = "WAITING", "yellow"
        label = typer.style(state, fg=color, bold=True)
        request_name = task["request"].get("name", "(unnamed)")
        dependencies = f"; after {', '.join(task['waiting_for'])}" if task["waiting_for"] else ""
        typer.echo(
            f"  {label} {task['id']}  {request_name} / {task['name']} → {task['processor']} "
            f"[{task['units']} units; {placement}{dependencies}]"
        )
        config = task.get("processor_config", {})
        target = config.get("target")
        params = config.get("params", [])
        device_args = config.get("device_args", [])
        if isinstance(target, str) and isinstance(params, list):
            command = [target, *(str(arg) for arg in params)]
            if isinstance(device_args, list):
                command.extend(str(arg) for arg in device_args)
            typer.echo(f"       command: {shlex.join(command)}")

    failures = sum(not result.passed for result in validations)
    typer.echo(
        f"Plan summary: {len(tasks)} tasks; "
        f"repair checks {len(validations) - failures} passed, {failures} need attention."
    )


@spec_app.command("validate")
def spec_validate(
    spec: Path = typer.Argument(..., exists=True, dir_okay=False, readable=True),
    cache_dir: Path = typer.Option(Path.home() / ".cache", "--cache_dir", help="Cache directory used by spec templates."),
) -> None:
    """Validate the checks declared in a spec file."""
    try:
        results = validate_spec(spec, context={"cache_dir": str(cache_dir.expanduser().resolve()), "working_dir": str(Path.cwd())})
    except SpecError as exc:
        typer.echo(f"Spec error: {exc}", err=True)
        raise typer.Exit(code=2) from exc

    for result in results:
        typer.echo(f"{'PASS' if result.passed else 'FAIL'} {result.message}")
    failures = sum(not result.passed for result in results)
    if failures:
        typer.echo(f"Validation failed ({failures} check(s)).", err=True)
        raise typer.Exit(code=1)
    typer.echo(f"Validation passed ({len(results)} check(s)).")


@spec_app.command("repair")
def spec_repair(
    spec: Path = typer.Argument(..., exists=True, dir_okay=False, readable=True),
    force_validates: bool = typer.Option(False, "--force-validates", help="Run a final validation pass after all repair actions."),
    cache_dir: Path = typer.Option(Path.home() / ".cache", "--cache_dir", help="Cache directory available to action templates."),
) -> None:
    """Run repair actions declared in a spec file."""
    try:
        results = repair_spec(spec, cache_dir=cache_dir, force_validates=force_validates)
    except SpecError as exc:
        typer.echo(f"Repair failed: {exc}", err=True)
        raise typer.Exit(code=1) from exc

    for result in results:
        typer.echo(f"{'PASS' if result.passed else 'FAIL'} {result.message}")
    failures = sum(not result.passed for result in results)
    if failures:
        typer.echo(f"Repair validation failed ({failures} check(s)).", err=True)
        raise typer.Exit(code=1)
    typer.echo(f"Repair completed ({len(results)} check(s)).")


@app.command()
def plan(
    pipeline: str = typer.Argument(..., help="Pipeline name from the spec."),
    input_path: Path = typer.Argument(..., exists=True, dir_okay=False, readable=True),
    cache_dir: Path = typer.Option(Path.home() / ".cache", "--cache_dir", help="Cache directory."),
    output_dir: Path = typer.Option(Path.cwd() / "output", "--output_dir", help="Output directory."),
    spec: Path = typer.Option(Path.cwd() / "spec.yaml", "--spec", exists=True, dir_okay=False, readable=True),
    max_units: float | None = typer.Option(None, "--max-units", min=0.01, help="Optional aggregate processor unit capacity."),
) -> None:
    """Validate repair prerequisites and preview task scheduling without running actions."""
    try:
        validations = validate_spec(spec, context=_validation_context(cache_dir))
        pipelines = build_pipelines(spec, input_path, [pipeline], cache_dir=cache_dir, output_dir=output_dir)
        tasks = pipelines_to_tasks(pipelines)
    except (SpecError, PipelineBuildError, TaskGraphError) as exc:
        typer.echo(f"Plan failed: {exc}", err=True)
        raise typer.Exit(code=2) from exc
    _print_plan_report(pipeline, tasks, validations, detect_devices(), max_units)


@app.command()
def run(
    pipeline: str = typer.Argument(..., help="Pipeline name from the spec."),
    input_path: Path = typer.Argument(..., exists=True, dir_okay=False, readable=True),
    cache_dir: Path = typer.Option(Path.home() / ".cache", "--cache_dir", help="Cache directory."),
    output_dir: Path = typer.Option(Path.cwd() / "output", "--output_dir", help="Output directory."),
    spec: Path = typer.Option(Path.cwd() / "spec.yaml", "--spec", exists=True, dir_okay=False, readable=True),
    max_units: float | None = typer.Option(None, "--max-units", min=0.01, help="Optional aggregate processor unit capacity."),
) -> None:
    """Repair prerequisites, prepare the input, and execute processor tasks."""
    try:
        pipelines = build_pipelines(
            spec, input_path, [pipeline], cache_dir=cache_dir, output_dir=output_dir,
        )
        tasks = pipelines_to_tasks(pipelines)
    except (PipelineBuildError, TaskGraphError) as exc:
        typer.echo(f"Pipeline build failed: {exc}", err=True)
        raise typer.Exit(code=2) from exc

    if max_units is not None:
        over_limit = [task for task in tasks if float(task["units"]) > max_units]
        if over_limit:
            labels = ", ".join(f"{task['id']} needs {task['units']}" for task in over_limit)
            typer.echo(f"Scheduler capacity is too small: {labels} units (limit {max_units}).", err=True)
            raise typer.Exit(code=2)

    devices = detect_devices()
    for device in devices:
        typer.echo(f"GPU {device.index}: {device.name}, {device.vram_gib:.1f} GiB VRAM ({device.capacity_units:.2f} units)")

    force_cpu: set[str] = set()
    gpu_tasks = [task for task in tasks if float(task["units"]) > 0]
    if gpu_tasks and not devices:
        displays = linux_integrated_gpu_names()
        detail = f" Display adapters found: {', '.join(displays)}." if displays else ""
        typer.echo(f"Warning: no supported compute GPU with readable VRAM was detected.{detail}", err=True)
        if not typer.confirm("Continue and run processor tasks on CPU?", default=False):
            raise typer.Exit(code=1)
        force_cpu = {task["id"] for task in gpu_tasks}
    elif gpu_tasks:
        insufficient = [
            task for task in gpu_tasks
            if not any(device.capacity_units >= float(task["units"]) for device in devices)
        ]
        if insufficient:
            labels = ", ".join(f"{task['id']} ({task['processor']}, {task['units']} units)" for task in insufficient)
            typer.echo(f"Warning: no single GPU has enough VRAM for: {labels}.", err=True)
            if not typer.confirm("Continue by running those tasks on CPU?", default=False):
                raise typer.Exit(code=1)
            force_cpu = {task["id"] for task in insufficient}

    try:
        repair_results = repair_spec(spec, cache_dir=cache_dir)
        typer.echo(f"Repair completed: {len(repair_results)} validation check(s) passed.")
        prepared_input = run_input_before(input_path, cache_dir=cache_dir, output_dir=output_dir)
        pipelines = build_pipelines(
            spec, input_path, [pipeline], cache_dir=cache_dir,
            output_dir=output_dir, input_data=prepared_input,
        )
        tasks = pipelines_to_tasks(pipelines)
    except (SpecError, PipelineBuildError, TaskGraphError) as exc:
        typer.echo(f"Preparation failed: {exc}", err=True)
        raise typer.Exit(code=1) from exc

    try:
        tasks = execute_tasks(
            tasks, devices, force_cpu=force_cpu,
            working_dir=str(Path.cwd()), max_units=max_units,
        )
    except TaskGraphError as exc:
        typer.echo(f"Scheduler failed: {exc}", err=True)
        raise typer.Exit(code=2) from exc

    runs: dict[str, list[dict]] = {}
    for task in tasks:
        runs.setdefault(task["pipeline_run_id"], []).append(task)
    input_results = []
    for run_tasks in runs.values():
        first = run_tasks[0]
        failed = sum(task["status"] == "failed" for task in run_tasks)
        blocked = sum(task["status"] == "skipped" for task in run_tasks)
        succeeded = sum(task["status"] == "succeeded" for task in run_tasks)
        status = "failed" if failed else "blocked" if blocked else "completed"
        input_results.append({
            "pipeline": first["pipeline"],
            "request": first["request"].get("name"),
            "status": status,
            "succeeded": succeeded,
            "failed": failed,
            "blocked": blocked,
        })
    _print_run_report(pipeline, tasks, input_results)
    if any(task["status"] != "succeeded" for task in tasks):
        raise typer.Exit(code=1)


if __name__ == "__main__":
    app()
