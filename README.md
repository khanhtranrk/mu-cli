# Mu

Mu is a Python 3.13+ CLI for executing parameterized pipelines described by YAML or JSON specs. Specs define reusable workloads (subprocesses), pipeline parameters and nodes, actions, and conditions.

## Commands

```sh
# Run one or more input objects (YAML or JSON files)
uv run mu run --spec ./spec.yaml --working_dir ./work \
  --request song-with-cover,./song.yaml

# Repeat --request to run multiple pipeline inputs
uv run mu run --request song-with-cover,./song-a.yaml \
  --request song-with-cover,./song-b.json

# Fetch a remote spec.json/YAML and run its master-flow requests
uv run mu master-flow run https://example.invalid/spec.json \
  --working_dir ./work --unit_name worker-1

# Specify available devices as family,index,max-units; repeat as needed
uv run mu run --device cuda,0,4 --device cuda,1,2 \
  --request song-with-cover,./song.yaml

uv run mu --help
```

`--working_dir` defaults to the current directory. Mu creates `output/` and `cache/` there. `--sys_cache_dir` defaults to `~/.cache`. Unless `--device` is supplied, Mu detects supported NVIDIA/AMD GPUs. Workload `units` defaults to zero (CPU-only); each unit represents 4 GiB of VRAM.

Mu schedules nodes from all supplied requests together. Nodes whose dependencies have completed can run concurrently; a node starts only when one GPU has enough free units for its workload. A node releases its allocation after its actions and workload finish, so newly ready nodes can use that capacity.

## Spec format

A spec can contain `master-flow`, `prepare`, `workloads`, and `pipeline` sections. Workloads declare their parameter schema, environment, executable target, argument vector, optional device arguments, and scheduler units. Pipelines define their parameter schema, context, and named nodes. Nodes can define conditions, actions, a workload call, and dependencies.

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

Input files can be a mapping or a list of mappings containing pipeline parameter values. YAML and JSON are accepted. Each `--request` pairs a pipeline name with one such file; a list runs one pipeline instance per object. Unknown or missing parameters are reported before execution.

Templates use bracket paths such as `{params[name]}`, `{session[output_dir]}`, `{sys[cache_dir]}`, `{node[status]}`, and `{schedule[device_index]}`. `session` includes `working_dir`, `unit_name`, `output_dir`, and `cache_dir`; `sys` includes the system cache and discovered model index. Pipeline and node `context` mappings are merged into the runtime context.

Actions use `type` and support `execute-command`, `execute-commands`, `send_http_request`, `write-json`, and `create-dir`. Conditions use an `operator`, including `and`, `or`, `file-exists`, `folder-exists`, `path-exists`, and `node_status`. `depends_on` entries name a node and may include a condition. A node's `finally` actions run after success, skip, or failure.

`master-flow.requests` contains `{url, pipeline, refresh_after_done}` entries. Mu downloads each resource as JSON or YAML and uses it as that pipeline's params. It runs `prepare` once, processes the fetched requests, and polls entries with `refresh_after_done: true` until their endpoint returns HTTP 404 or no request data. The remote spec itself may be JSON or YAML.

See [`examples/song-with-cover/spec.yaml`](examples/song-with-cover/spec.yaml) and [`examples/song-with-cover/input.yaml`](examples/song-with-cover/input.yaml) for the new structure.

## Development

```sh
uv sync
uv run mu --help
```
