# 01. Overall structure and spec lifecycle

## Root template

```yaml
master-flow:
  requests: []

prepare:
  - type: execute_command
    target: ...
    args: []

workloads:
  <workload-name>:
    params: {}
    env: {}
    target: ...
    args: []
    device_args: []
    units: 0

pipeline:
  <pipeline-name>:
    params: {}
    context: {}
    nodes: []
```

All sections are optional during parsing, but a spec that omits the section needed by a command cannot execute that command.

| Section | Purpose | When it runs |
|---|---|---|
| `master-flow` | Describes request URLs and matching pipelines | Only with `mu master-flow run` |
| `prepare` | Prepares shared resources | Once before the pipelines in a `run` invocation |
| `workloads` | Declares reusable executables/subprocesses | When a node calls one with `run.workload` |
| `pipeline` | Defines a node workflow | When selected by `--request` or master-flow |

## `prepare`

`prepare` is an action list:

```yaml
prepare:
  - type: execute_command
    target: python
    args: [--version]
  - type: execute_command
    target: hf
    args: [download, organization/model, file.gguf]
    skip_if:
      operator: file_exists
      path: "{sys[cache_dir]}/models/file.gguf"
    postcondition:
      operator: file_exists
      path: "{sys[cache_dir]}/models/file.gguf"
```

Prepare actions receive the base context:

```text
sys -> cache_dir, models
session -> working_dir, unit_name, output_dir, cache_dir
```

There are no pipeline `params` or `node` values here.

## `workloads`

`workloads` is a mapping, not a list:

```yaml
workloads:
  yue2:
    target: ...
  qwen-image:
    target: ...
```

The outer key is the workload's unique name within the spec. A node references that name in `run.workload`. Its properties are described in [Workloads](03-workloads.md).

## `pipeline`

`pipeline` is also a mapping. A pipeline name is an outer key:

```yaml
pipeline:
  song-with-cover:
    params: {}
    context: {}
    nodes: []
```

A pipeline does not run directly. The CLI accepts a request and combines `(pipeline_name, request_params)` into an executable job.

## Runtime pipeline structure

For one request:

```text
base context
  + pipeline.context
  + parameters from pipeline.params
  -> shared pipeline context

shared pipeline context
  -> create one deep copy per node

node
  + node.context
  + node:{name,status,total_units}
  -> node context

node
  -> workload/action context
```

Every request creates its own pipeline context. Changes made inside a node do not affect the pipeline context of another request.

## Node execution order

When dependencies have succeeded:

```text
1. Create node context by deep-copying and merging node.context
2. Set node status to running
3. Check skip_if
4. If skip_if matches:
   - check postcondition, if present
   - run finally
   - end with status success
5. Check precondition, if present
6. Run each action in before_run
7. Run run.workload
8. Run each action in after_run
9. Check postcondition, if present
10. Run each action in finally
```

If any required step raises an error:

```text
status = failed
immediately jump to finally
```

`finally` runs after success, a skip, or failure.

## Example with two prepare actions and a node

```yaml
prepare:
  - type: create_dir
    path: "{session[working_dir]}/cache/models"

workloads:
  copy:
    params:
      source: {type: string}
      destination: {type: string}
    target: cp
    args: ["{params[source]}", "{params[destination]}"]

pipeline:
  demo:
    params:
      source: {type: string}
      destination: {type: string}
    nodes:
      - name: copy-file
        run:
          workload: copy
          args:
            source: "{params[source]}"
            destination: "{params[destination]}"
        finally:
          - type: execute_command
            target: python
            args: [-c, "print('done')"]
```

The example contains a syntax error: the final workload `args` entry must close both quoted strings and the array. The corrected form is:

```yaml
args:
  - "{params[source]}"
  - "{params[destination]}"
```

## How spec-level validation differs from a node postcondition

- `prepare` has no `validate` schema in the current runtime.
- `prepare` uses `skip_if` and `postcondition` in the same way as actions.
- Nodes use `skip_if`, `precondition`, `postcondition`, and `finally`.
- `node_status` evaluates the results of dependencies belonging to the same pipeline request.

The repository can contain two formats in different code paths (the older processor format and the newer workload format). The primary format documented here is the `workloads` + `pipeline` + `nodes` structure in `runtime.py`.
