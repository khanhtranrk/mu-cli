# Instructions for coding agents

## Project overview

Mu is a Python 3.13+ CLI for validating setup prerequisites, expanding YAML inputs into pipeline tasks, planning resource placement, and running processor commands. Use `uv` for project commands and dependency management.

## Architecture

- `src/mu/cli.py`: Typer CLI (`spec validate`, `spec repair`, `models`, `plan`, `run`) and human-readable reports.
- `src/mu/spec.py`: spec loading, repair orchestration, and spec errors.
- `src/mu/validators.py`: validation condition registry and validation handlers.
- `src/mu/actions.py`: action registry and action handlers. Action types have their own schemas and behavior; do not assume every action shares the same arguments.
- `src/mu/pipelines.py`: input/spec expansion, template context, model discovery, and input `before` actions.
- `src/mu/tasks.py`: pipeline-to-task conversion, `waiting-for` dependency validation, and scheduler readiness.
- `src/mu/executor.py`: processor execution and dependency failure propagation.
- `src/mu/hardware.py`: best-effort NVIDIA/AMD compute device and VRAM detection.

Keep new validation and action types behind their registries so adding a type does not require a large conditional block in the CLI. Keep YAML parsing and schema errors actionable for users.

## Behavior to preserve

- `mu spec validate` evaluates declared checks without running repair actions.
- `mu spec repair` runs repair actions; `--force-validates` requests a validation pass afterward.
- `mu plan` is a preview. It may inspect validations and hardware, but must not run repair actions, input `before` actions, or processors.
- `mu run` validates the spec first, runs repair actions when checks need repair, prepares input `before` actions, validates step outputs, then executes remaining pipeline tasks.
- A step's `before` actions run immediately before its processor command. Keep action dispatch in the shared registry and provide each handler its declared context.
- A step with declared output validations whose checks all pass is already complete and must be skipped unless `--force-validate` was requested. Mark it successful in the task graph so dependent steps can proceed.
- Keep successful child process stdout/stderr out of normal CLI output. Emit task progress and show captured process details only on failure.
- `mu models` lists supported model files under the selected cache directory's `models` folder.
- Each request creates its own pipeline context. Preserve request-specific values while expanding templates.
- A `waiting-for` dependency blocks a task until its prerequisites succeed; a failed prerequisite must prevent dependent tasks from running.
- Each processor's `units` field estimates VRAM demand in GiB; the scheduler rounds positive amounts up to 4 GiB blocks (1–4→1 unit, 5–8→2, etc.). GPU capacity rounds down to complete 4 GiB blocks. `units: 0` means CPU-only. Device command syntax belongs to each processor's `device_args` template; the scheduler provides `device_index` rather than imposing one CLI convention.
- Keep reports understandable at both request and task level, including failures and blocked work.

## Safe development workflow

- Read the relevant module and example YAML before changing schemas or runtime behavior.
- Use `uv run ...` for project commands. `uv run mu --help` is a safe CLI smoke check.
- Do not invoke `mu run` or `mu spec repair` against the media example as a routine check: it may download large models, install tools, use GPUs, and write generated media. Prefer small temporary specs and inputs when exercising side effects.
- Keep generated output, caches, virtual environments, downloaded models, credentials, and machine-specific paths out of commits.
- Do not add tests or run a broad test suite unless the user asks for verification; when asked, describe exactly what was run and its result.
- Update `README.md` and the example YAML when user-facing commands or schemas change.
