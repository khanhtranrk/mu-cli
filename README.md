# Mu

Mu is a Python 3.13+ CLI that executes declarative, GPU-aware pipelines from YAML or JSON specs. It combines reusable subprocess workloads, per-request parameters, dependency-aware nodes, context templates, pre/post conditions, actions, and remote master flows.

## Features

- **Reusable workloads:** declare executables, environment variables, arguments, GPU arguments, and VRAM units once.
- **Dependency-aware execution:** schedule nodes across every request, with prerequisites listed by name in `depends_on`.
- **GPU placement:** detect NVIDIA and AMD devices or declare them manually; reserve 4 GiB units without embedding a device CLI convention.
- **Context templates:** reference system, session, pipeline parameters, node state, and scheduled device values in spec fields.
- **Actions and conditions:** prepare directories, write JSON, call HTTP endpoints, run commands, and verify files or process exit codes.
- **Master flows:** fetch remote specs and request resources, then run and optionally refresh them to completion.
- **YAML or JSON:** use the same spec structure with either format.

## Requirements

- Python 3.13 or newer
- [uv](https://docs.astral.sh/uv/) for dependency and command management
- Optional NVIDIA or AMD tools for GPU detection: `nvidia-smi` or `rocm-smi`

## Install

```sh
git clone https://github.com/khanhtranrk/mu.git
cd mu
uv sync
uv run mu --help
```

## Quick start

The repository includes a complete media workflow in [`examples/song-with-cover/spec.yaml`](examples/song-with-cover/spec.yaml). Its input is [`examples/song-with-cover/input.yaml`](examples/song-with-cover/input.yaml).

Run a local spec with a pipeline and request file:

```sh
uv run mu run --spec ./spec.yaml --working_dir ./work \
  --pipeline song-with-cover,./examples/song-with-cover/input.yaml
```

Run more than one request by repeating `--pipeline`. Each file may contain one mapping or a list of mappings:

```sh
uv run mu run \
  --pipeline song-with-cover,./request-a.yaml \
  --pipeline song-with-cover,./request-b.json
```

Run a remote spec through a master flow:

```sh
uv run mu master-flow run song-generation \
  --working_dir ./work --unit-id worker-1
```

Override hardware detection with an explicit family, index, and maximum-unit capacity:

```sh
uv run mu run --device cuda,0,4 --device cuda,1,2 \
  --pipeline song-with-cover,./request.yaml
```

## Minimal spec

```yaml
workloads:
  transcode:
    params:
      source: {type: string}
      destination: {type: string}
    target: ffmpeg
    args: [-i, "{params[source]}", "{params[destination]}"]
    units: 0

pipeline:
  convert:
    params:
      source: {type: string}
      destination: {type: string}
    nodes:
      - name: convert
        run:
          workload: transcode
          args:
            source: "{params[source]}"
            destination: "{params[destination]}"
```

A request file supplies pipeline parameters:

```yaml
source: input.mp4
destination: output.mp4
```

Mu validates declared parameters before execution. A list of mappings creates multiple independent pipeline requests, while nodes across those requests share the global scheduler.

## How execution works

1. Load and validate the spec.
2. Create the working, cache, output, system-cache, and model contexts.
3. Run entry initialization, then prepare each selected pipeline once on demand.
4. Merge each request's parameters into an isolated pipeline context.
5. Build named nodes and resolve `depends_on` dependencies.
6. Schedule ready nodes concurrently and assign GPU units where required.
7. Run `before_run`, the workload, `after_run`, and output conditions for each node.
8. Run node `finally` actions, then entry finalization when the flow exits.

Nodes use `depends_on: [node_a, node_b]` and run only after every prerequisite reports `success`. Failed prerequisites block dependent execution, including `finally`. A node with `ignore_error: true` reports success so dependents can continue. A workload with `units: 0` runs on the CPU. GPU workloads do not run on an undersized device.

## Spec structure

A spec can contain:

- `entries`: direct/master flow initialization and finalization actions.
- `workloads`: reusable subprocess declarations.
- `pipeline`: parameter schemas, shared context, and dependency graphs.
- `pipeline.<name>.prepare`: lazy preparation shared by that pipeline’s requests.

Nodes may set `ignore_error: true` to report failure as success after `finally`,
allowing the pipeline to continue. See [node error handling](docs/spec-format/06-pipelines-and-nodes.md#node-ignore_error).

Workloads declare `params`, `target`, `args`, optional `env`, `device_args`, and `units`. Nodes declare `context`, conditions, actions, `run`, and `depends_on`.

Templates use bracket lookup syntax such as `{params[name]}`, `{session[output_dir]}`, `{sys[cache_dir]}`, `{node[status]}`, and `{schedule[device_index]}`. The full model is documented in the [spec format guide](docs/spec-format/README.md), including a quick reference and a complete working example:

- [Overview](docs/spec-format/01-overview.md)
- [Context and templates](docs/spec-format/02-context-and-templates.md)
- [Workloads](docs/spec-format/03-workloads.md)
- [Actions](docs/spec-format/04-actions.md)
- [Conditions](docs/spec-format/05-conditions.md)
- [Pipelines and nodes](docs/spec-format/06-pipelines-and-nodes.md)
- [Master flow and CLI](docs/spec-format/07-master-flow-and-cli.md)
- [Complete example](docs/spec-format/08-complete-example.md)
- [Quick reference](docs/spec-format/quick-reference.md)

Action names use `snake_case` and the `type` key, without aliases.
`execute_command` and `send_http_request` support `save_state: name`, saving
success or failure details at `actions[name]` in the containing context. See
[Actions](docs/spec-format/04-actions.md#saved-action-results) for the result schemas.

Conditions also use `snake_case` operator names. Use `action_state` with
`target: [name, returncode]` and a required `expected` value to check saved
action results. Use `node_state` with `target: [status]` to check the current
node, including in `finally`. Dependencies require success automatically. See
[Conditions](docs/spec-format/05-conditions.md).

## CLI reference

```sh
uv run mu run --help
uv run mu master-flow run --help
```

### `mu run`

| Option | Default | Description |
|---|---|---|
| `--pipeline PIPELINE,FILE` | required, repeatable | Pipeline name plus a YAML or JSON request file |
| `--spec PATH` | `./spec.yaml` | Local spec path |
| `--working_dir PATH` | current directory | Creates `output/` and `cache/` |
| `--sys_cache_dir PATH` | `~/.cache` | System cache and `models/` lookup |
| `--unit_name TEXT` | `unknown` | Session and reporting label |
| `--device FAMILY,INDEX,MAX_UNITS` | detected | Explicit GPU capacity; repeatable |

### `mu master-flow run`

Use `mu master-flow run SPEC_SLUG --unit-id WORKER` with
`MU_MASTER_FLOW_SERVER` (Convex HTTP site URL) and `MU_MASTER_FLOW_TOKEN`.
`--server` and `--token` override these values. `--batch-size` defaults to 1
(maximum 100). Repeat `--by-pipeline` / `--by-status` to filter; status defaults
to `waiting`. `--by-unit-id` filters previous assignment. `--refresh-loop` drains
batches until none remain. See [full lifecycle and CLI](docs/spec-format/07-master-flow-and-cli.md).

## Scheduling units

Mu counts GPU capacity in bands of 4 GiB:

| Device VRAM | Capacity units |
|---:|---:|
| 1–4 GiB | 1 |
| 5–8 GiB | 2 |
| 9–12 GiB | 3 |
| 13–16 GiB | 4 |

A workload declares exactly how many units it requires. `units: 0` means CPU-only and does not receive `device_args` or a `schedule` context.

## Development

```sh
uv sync
uv run mu --help
```

Before submitting changes, run the narrowest relevant tests or a small temporary spec. There is currently no committed test suite or configured linter, so report exactly which smoke checks or focused validations you used.

Run a narrow test selection while changing runtime behavior. Full tests are appropriate after a broad or cross-module change. Do not run the media example's heavy workload during routine development: it can download large models and use GPUs or substantial disk space.
