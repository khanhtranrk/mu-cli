# Mu

Mu is a command-line tool for validating setup requirements and planning or running configurable media-processing pipelines. A spec describes repair actions, processors, and pipeline steps; an input file provides the requests that become individual pipeline runs.

## Requirements

- Python 3.13 or newer
- [uv](https://docs.astral.sh/uv/)
- The external programs and models declared by the spec you use

Run Mu from this checkout with `uv run mu ...`. To install the project into the current environment, use `uv sync`.

## Commands

```sh
# Check the validation conditions in a spec without running repair actions.
uv run mu spec validate examples/song-with-cover/spec.yaml --cache_dir /tmp

# Run repair actions declared in the spec.
uv run mu spec repair examples/song-with-cover/spec.yaml --cache_dir /tmp

# Expand requests into processor tasks and preview repair checks and scheduling.
uv run mu plan song-with-cover examples/song-with-cover/input.yaml \
  --spec examples/song-with-cover/spec.yaml --cache_dir /tmp

# Repair prerequisites, prepare the input, and execute the pipeline.
uv run mu run song-with-cover examples/song-with-cover/input.yaml \
  --spec examples/song-with-cover/spec.yaml --cache_dir /tmp \
  --output_dir ./output
```

`plan` is a preview: it checks repair validations and builds the task list without running repair actions or processors. `run` executes repair actions first, prepares the input's `before` actions, then schedules processor tasks. Tasks with failed dependencies are skipped, and the run report summarizes each request and task.

The spec and input paths default to `./spec.yaml` and the input path must be supplied. Cache defaults to `~/.cache`; output defaults to `./output`. CLI options use underscores, for example `--cache_dir` and `--output_dir`.

## Specs and inputs

See [`examples/song-with-cover/spec.yaml`](examples/song-with-cover/spec.yaml) and [`examples/song-with-cover/input.yaml`](examples/song-with-cover/input.yaml) for a complete example with twelve English song requests.

A spec declares:

- `repair`: setup actions and their validation checks.
- `processors`: executable targets, arguments, optional `device_args`, and VRAM `units`.
- `pipelines`: ordered processor steps and `waiting-for` dependencies.

An input declares optional `before` actions and a `requests` list. Each request is expanded into its own pipeline context. Templates can reference `request`, `cache_dir`, `output_dir`, `working_dir`, and discovered `models`. Model keys are paths relative to `{cache_dir}/models`; supported model files include `.gguf` and `.safetensors`.

Repair actions and validations are extensible registries. Current action types include `command` and `write-jsons-from-context`; current validation conditions include `file-existed` and `exit-zero`. See the corresponding modules under `src/mu/` for their schemas.

## Scheduling

Processor `units` express approximate GPU memory use. One unit represents about 4 GiB of VRAM; a processor requesting 2 units needs about 8 GiB on one GPU. A processor with `units: 0` is CPU-only. When a processor needs a GPU, Mu detects available NVIDIA or AMD compute devices and passes the selected device index through that processor's `device_args` template. For example:

```yaml
device_args: ["--device", "cuda:{device_index}"]
```

If no supported GPU is detected, or no GPU has enough VRAM for a task, `run` asks before falling back to CPU. `plan` displays detected hardware and possible placements without executing tasks.

## Development

```sh
uv sync
uv run mu --help
```

The source is organized by responsibility: CLI commands in `cli.py`, spec parsing and repair in `spec.py`, action handlers in `actions.py`, validation handlers in `validators.py`, input expansion in `pipelines.py`, dependency graph construction and scheduling in `tasks.py`, execution in `executor.py`, and hardware detection in `hardware.py`.
