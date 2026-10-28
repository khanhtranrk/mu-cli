# 07. Master flow and CLI

## `mu run`

```bash
uv run mu run \
  --spec ./spec.yaml \
  --request song-with-cover,./input.yaml \
  --request copy-file,./copy.json \
  --working_dir ./work \
  --sys_cache_dir ~/.cache \
  --unit_name worker-1
```

### Options

| Option | Default | Meaning |
|---|---|---|
| `--request PIPELINE,FILE` | required; repeatable | Load one request file; the file contains a mapping or a list of mappings |
| `--spec PATH` | `./spec.yaml` | Local spec |
| `--working_dir PATH` | current directory | Create `output/` and `cache/` here |
| `--sys_cache_dir PATH` | `~/.cache` | System cache; models are stored under `models/` |
| `--unit_name TEXT` | `unknown` | Worker label shown in the session context |
| `--device FAMILY,INDEX,CAPACITY` | auto-detect | Add a GPU with unit capacity; repeatable |

Missing `--request` is an exit-code 2 error. A pipeline request that does not exist in the spec or a request file with the wrong root structure is an error.

### Request file

A mapping:

```yaml
name: demo
prompt: hello
```

Or a list of mappings:

```yaml
- name: demo-a
  prompt: alpha
- name: demo-b
  prompt: beta
```

A list creates multiple instances of the same pipeline. Each item receives a separate params context.

### Preparation

Before execution:

1. Mu loads the spec.
2. It creates the session directory.
3. It runs `prepare` once.
4. It loads the request params.
5. It schedules all nodes.

`prepare` does not receive request params. Use the session/system context, or pipeline/node actions for work that depends on params.

### Manual GPU configuration

```bash
--device cuda,0,4 --device cuda,1,2
```

Syntax:

```text
family,index,max-units
```

Whether the user supplies `cuda`, `rocm`, or another family, the scheduler uses only capacity and index. The workload's `device_args` determines the CLI syntax.

## `mu master-flow run`

```bash
uv run mu master-flow run https://example.invalid/spec.yaml \
  --working_dir ./work \
  --sys_cache_dir ~/.cache \
  --unit_name worker-1
```

### Options

| Option | Default | Meaning |
|---|---|---|
| `spec_url` | required | JSON or YAML URL |
| `--working_dir` | current directory | Same as `mu run` |
| `--sys_cache_dir` | `~/.cache` | System cache |
| `--unit_name` | `unknown` | Worker label |
| `--device FAMILY,INDEX,CAPACITY` | auto-detect | Add a manual GPU |

Master flow loads a remote JSON/YAML spec. It does not invoke local `mu run`.

## `master-flow.requests`

```yaml
master-flow:
  requests:
    - url: https://api.example.invalid/jobs/1
      header:
        Authorization: ******
      pipeline: song-with-cover
      refresh_after_done: false
    - url: https://api.example.invalid/jobs/2
      pipeline: song-with-cover
      refresh_after_done: true
```

The master-flow runtime reads these keys:

- `url`: required; loads a JSON/YAML mapping;
- `pipeline`: pipeline name;
- `header`: runtime loads the headers (note that the actual key is singular, `header`, not `headers`);
- `refresh_after_done`: boolean; default is false.

The response must be a mapping. If the mapping represents a single request item, it is passed directly to the pipeline.

Master flow does not support a list-of-mappings response URL in the current loop.

## Master-flow lifecycle

```text
fetch remote spec
create base context
run prepare once
for each master-flow request:
  fetch request URL
  queue (pipeline, response mapping)
execute all queued pipelines
for requests refresh_after_done=true:
  fetch again
  if HTTP 404 or empty/non-mapping -> stop
  continue execution
```

A request with `refresh_after_done: true` is fetched again after each cycle. Polling stops on HTTP 404 or when the payload is not a mapping.

Mu runs the complete new cycle, then polls again.

## HTTP in master flow

Spec and request downloads use `urllib` with a 30-second timeout. JSON parsing happens first; if JSON parsing fails, YAML parsing is attempted. HTTP headers may contain tokens or API keys.

Do not commit secrets to the spec. Prefer injecting headers through environment variables or a temporary file that is not committed.

## Complete master-flow example

```yaml
master-flow:
  requests:
    - url: https://api.example.invalid/next-song
      header:
        X-Worker: "{unit_name}"
      pipeline: song-with-cover
      refresh_after_done: true

prepare:
  - type: execute-commands
    commands:
      - target: hf
        args:
          - download
          - organization/model
          - model.gguf
          - --local-dir
          - "{sys[cache_dir]}/models"

workloads:
  generate:
    params:
      name:
        type: string
      output:
        type: string
    target: generator
    args:
      - --name
      - "{params[name]}"
      - --output
      - "{params[output]}"

pipeline:
  song-with-cover:
    params:
      name:
        type: string
      output:
        type: string
    nodes:
      - name: generate
        run:
          workload: generate
          args:
            name: "{params[name]}"
            output: "{params[output]}"
```

The `{unit_name}` header template in this example is outside the available context because context includes only `sys/session/params/node/schedule`. Use `{session[unit_name]}` instead.

## Scheduling and device units

Compute devices are detected when `--device` is not provided:

- NVIDIA via `nvidia-smi`;
- AMD via `rocm-smi`;
- capacity units = ceil(VRAM GiB / 4).

Example: 10 GiB requires 3 units.

A CPU workload with `units: 0` consumes no units. A GPU node reserves one device for its entire lifetime, including actions in `before` and `finally`.

## CLI debugging patterns

```bash
uv run mu run --help
uv run mu master-flow run --help
uv run mu run --spec ./spec.yaml --request demo,./request.yaml --working_dir ./tmp
```

When a node fails:

- Look for `[NODE-ERROR]` for details;
- Look for `[BLOCKED]` to identify failed dependencies;
- Look for `[SCHEDULE]` for device-unit decisions;
- Look for `[ACTION]` to see which action is running;
- Look for `[WORKLOAD]` to identify the executable.

A workload with an exit code other than zero causes the node to fail. Dependent nodes will not run afterward.
