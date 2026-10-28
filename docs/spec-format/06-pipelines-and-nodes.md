# 06. Pipelines and nodes

## Pipeline

```yaml
pipeline:
  transcribe:
    params:
      input: {type: string}
      output: {type: string}
    context:
      work: "{session[cache_dir]}/transcribe"
    nodes:
      - name: prepare
        run:
          workload: mkdir
          args:
            path: "{params[output]}"
```

### `params`

The schema for pipeline requests. It uses the same `type` and `default` fields as workload params.

### `context`

A context mapping that is rendered and merged before `params`. Because params are not constructed at this stage, pipeline context must not depend on `params[...]`.

### `nodes`

A list of nodes. Every node in a pipeline request must have a unique, non-empty `name`.

## Node

```yaml
- name: generate-song
  context:
    label: "{params[name]}"
  skip_if: {...}
  precondition: {...}
  before_run: [...]
  run:
    workload: yue2
    args: {...}
  after_run: [...]
  postcondition: {...}
  finally: [...]
  depends_on: [...]
```

### `name`

A unique identifier within the pipeline:

```yaml
- name: prepare
- name: generate
```

The name is used in:

- logs;
- `depends_on.node`;
- `node_status`;
- the request state map.

### `context`

Merged into the node's private context:

```yaml
context:
  stage: generation
```

A node receives `deepcopy(context)` from the pipeline, so action/node changes do not propagate to other nodes.

### `skip_if`

If the condition is true:

1. The node does not run precondition/before/run/after/postcondition.
2. If a postcondition is present, it is still checked.
3. The node changes state to `success`.
4. Finally actions run.

This mechanism skips work whose result already exists. If the postcondition fails after skipping, the node fails.

### `precondition`

If the condition is false:

- The node does not run before or after actions or the workload.
- The node changes state to `failed`.
- Finally actions run.

This is an important distinction from `skip_if`: a failed precondition is a node error.

### `before_run`

A list of actions that run immediately before the workload:

```yaml
before_run:
  - type: create-dir
    path: "{params[output_dir]}"
  - type: write-json
    path: "{params[request]}"
    content:
      prompt: "{params[prompt]}"
```

If an action fails and its error is not ignored:

- the workload does not run;
- the node fails;
- finally actions run.

### `run`

The node invokes a workload through a mapping:

```yaml
run:
  workload: transcribe
  args:
    input: "{params[input]}"
    output: "{params[output]}"
```

Rules:

- `run.workload` is the key name in `workloads`.
- `run.args` is a mapping that supplies workload params.
- Args are rendered using the node context.
- Omitting `run` makes the node an action-only node.
- `run` cannot be a list of actions in the current runtime.

### `after_run`

A list of actions that runs after the workload succeeds:

```yaml
after_run:
  - type: send_http_request
    url: "https://example.invalid/events"
    method: post
    body:
      status: completed
```

If the workload fails, `after_run` does not execute. Use `finally` for cleanup or failure notifications.

### `postcondition`

The condition must be true after the main section runs:

```yaml
postcondition:
  operator: and
  props:
    - operator: file-exists
      path: output.mp4
    - operator: file-exists
      path: metadata.json
```

If `postcondition` is omitted, successful completion requires:

- a workload exit code of 0, if a workload is present;
- success of every required action;
- no other errors.

### `finally`

Actions that must run last:

```yaml
finally:
  - type: send_http_request
    precondition:
      operator: node_status
      expected: failed
    ignore_error: true
    url: https://example.invalid/status
    method: post
    body:
      status: failed
```

`finally` runs after:

- success;
- skipping;
- failure;
- a failed precondition;
- an action failure;
- a workload failure;
- a failed postcondition.

Mu sets `node.status` to the final state before the first finally action. A finally action can change the node's final state to failed; at the end of the pipeline, the runtime may return the failed state.

### `depends_on`

```yaml
depends_on:
  - node: prepare
    condition:
      operator: node_status
      expected: success
  - node: validate
```

Each item contains:

| Field | Required | Meaning |
|---|---:|---|
| `node` | Yes | Dependency name. The runtime also accepts the `name` alias. |
| `condition` | No | Condition used to test the dependency. If omitted, it evaluates to true. |

By default, a dependency must have success status. To depend only on a dependency having ended, without distinguishing status, use `node_status` with the appropriate expected state. There is no dependency condition that requires success; if `condition` is absent, the runtime compares `condition=None` and obtains true.

Dependencies in another pipeline or request are not allowed. The runtime joins nodes only by `(request_index, node_name)`.

## Node scheduler

The scheduler scans every pending node in declaration order and:

- skips a node whose dependencies have not finished;
- marks the node failed if a dependency condition is false;
- skips a node if enough GPU units are unavailable;
- runs at most 32 nodes concurrently;
- releases GPU units when a node finishes.

Mu does not rely on `wait_timeout` or YAML order to run nodes concurrently. Dependencies provide guaranteed ordering.

## Dependencies and error propagation

```text
prepare success
  -> generate success
  -> transcribe success

prepare failed
  -> generate BLOCKED/failed
  -> transcribe BLOCKED/failed
```

If a dependency is not successful, dependent nodes do not run. They enter the `failed` state, causing more distant nodes to become blocked as well.

## Complete pipeline example

```yaml
pipeline:
  image-job:
    params:
      name: {type: string}
      prompt: {type: string}
      width: {type: number, default: 1024}
      height: {type: number, default: 1024}
    context:
      work: "{session[output_dir]}/{params[name]}"
    nodes:
      - name: output-dir
        run:
          workload: mkdir
          args:
            path: "{session[output_dir]}/{params[name]}"

      - name: render
        depends_on:
          - node: output-dir
            condition:
              operator: node_status
              expected: success
        skip_if:
          operator: file-exists
          path: "{session[output_dir]}/{params[name]}/cover.png"
        before_run:
          - type: write-json
            path: "{session[cache_dir]}/{params[name]}.json"
            content:
              prompt: "{params[prompt]}"
        run:
          workload: render-image
          args:
            request: "{session[cache_dir]}/{params[name]}.json"
            output: "{session[output_dir]}/{params[name]}/cover.png"
            width: "{params[width]}"
            height: "{params[height]}"
        postcondition:
          operator: file-exists
          path: "{session[output_dir]}/{params[name]}/cover.png"
        finally:
          - type: send_http_request
            ignore_error: true
            url: "https://example.invalid/status"
            method: post
            header: {}
            body:
              status: "{node[status]}"
```
