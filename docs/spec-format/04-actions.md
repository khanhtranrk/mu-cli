# 04. Actions

An action is a side-effecting operation: running a process, creating a directory, writing JSON, or sending HTTP.

## Common properties

```yaml
- type: execute-command
  context: {}
  skip_if: {...}
  precondition: {...}
  postcondition: {...}
  ignore_error: false
```

| Property | Required | Meaning |
|---|---:|---|
| `type` | Yes | Action type. The canonical name; the runtime also accepts `action` as an alias. |
| `context` | No | Additional context mapping that is rendered and merged before the action. |
| `skip_if` | No | If the condition is true, skip the action. |
| `precondition` | No | Run only when the condition is true. If false, skip the action without failure. |
| `postcondition` | No | Check after the action. A false result fails the action unless `ignore_error` is true. |
| `ignore_error` | No | Defaults to `false`. If `true`, execution, subprocess, HTTP, or postcondition errors do not fail the node chain. |

`skip_if` differs from `precondition`:

- `skip_if=true`: the action does not run and no error is logged.
- `precondition=false`: the action is skipped like an action that cannot run, and it does not fail.
- An action that raises an execution error activates `ignore_error`.

With `ignore_error: true`, a false postcondition still prints a warning and execution continues.

## `execute-command`

Runs one subprocess:

```yaml
- type: execute-command
  target: python
  args: [-m, pip, --version]
  env:
    PYTHONUTF8: "1"
  skip_if:
    operator: exit-code
    target: [python, -m, pip, --version]
```


| Field | Meaning |
|---|---|
| `target` | First executable |
| `args` | Argument list; defaults to `[]` |
| `env` | Mapping of additional environment variables |

Mu runs with `check=True` and overlays `env` on the current environment. Arguments and environment values may contain templates.

**Do not use a shell:** `target: "echo hello"` is incorrect; use `target: echo`, `args: [hello]`.


## `execute-commands`

Runs several commands in order within one action:


```yaml
- type: execute-commands
  commands:
    - target: mkdir
      args: [-p, "{session[cache_dir]}/models"]
    - target: hf
      args:
        - download
        - organization/model
        - model.gguf
        - --local-dir
        - "{session[cache_dir]}/models"
      env:
        HF_HUB_DISABLE_TELEMETRY: "1"
```


If the second command fails, the third command does not run and the action fails. `ignore_error` can suppress the entire error.

A real example from the current spec:

```yaml
prepare:
  - type: execute-commands
    skip_if:
      operator: and
      props:
        - operator: file-exists
          path: "{sys[cache_dir]}/models/file.gguf"
    commands:
      - target: hf
        args: [download, organization/model, file.gguf,
               --local-dir, "{sys[cache_dir]}/models"]
    postcondition:
      operator: file-exists
      path: "{sys[cache_dir]}/models/file.gguf"
```


## `send_http_request`

Sends an HTTP request:

```yaml
- type: send_http_request
  url: "https://example.invalid/jobs"
  method: post
  header:
    Authorization: "******"
    Content-Type: application/json
  body:
    status: running
    name: "{params[name]}"
  save_response_to_context: running
  ignore_error: true
```

| Field | Default | Meaning |
|---|---|---|
| `url` | required | HTTP/HTTPS URL |
| `method` | `get` | Mu uppercases it; `post`, `POST`, and `post` are all equivalent. |
| `header` | `{}` | Headers passed to urllib |
| `body` | none | If present, Mu encodes it as JSON with `json.dumps`. |
| `save_response_to_context` | none | Context key used to store the JSON response. |

If the response is empty, the stored value is `null`/`None`. If it is not valid JSON, the action can fail. The HTTP timeout is 30 seconds.

The runtime accepts `send-http-request` as an alias.


## `write-json`

Writes a JSON document:

```yaml
- type: write-json
  path: "{session[cache_dir]}/requests/{params[name]}.json"
  content:
    name: "{params[name]}"
    style: "{params[style]}"
    lyrics: "{params[lyrics]}"
    nested:
      enabled: true
```

Mu creates parent directories automatically. JSON is indented by two spaces, written with `ensure_ascii=False`, and ends with a newline.

If `content` is a mapping, it is rendered against the context before writing. A string template can render to a number or boolean and preserve that resolved type.

## `create-dir`

Creates a directory and any required parents:

```yaml
- type: create-dir
  path: "{session[output_dir]}/{params[name]}"
```

Mu does not create a file. The action succeeds if the path already exists as a directory. If a file exists at the path, `mkdir` fails.


## Action locations

An action can appear in:

- `prepare`;
- `node.before_run`;
- `node.after_run`;
- `node.finally`;
- a node's `run`. In the newer runtime, `run` must be a workload, not an action.

### Actions in `prepare`

The base context contains only `sys` and `session`.

### Actions in a node

The node context contains `params`, `node`, and `schedule` when a GPU-backed workload is used. Actions are rendered with that same context.

### Actions in `finally`

The node state is updated before `finally` runs:

```yaml
finally:
  - type: send_http_request
    precondition:
      operator: node_status
      node: current-node
      expected: success
```

When referring to the current node, `node` does not need to be declared; the runtime defaults to `context.node.name`.


## Action execution sequence

```text
render action.context
if skip_if matches: return
if precondition is false: return
render action
start
execute action
if postcondition is declared: evaluate it
if an error or postcondition is false:
  ignore if ignore_error is true
  otherwise throw
```

## Before/after node template

```yaml
before_run:
  - type: create-dir
    path: "{session[cache_dir]}/requests/{params[name]}"
  - type: write-json
    path: "{session[cache_dir]}/requests/{params[name]}/request.json"
    content:
      name: "{params[name]}"
      style: "{params[style]}"
run:
  workload: yue2
  args:
    request: "{session[cache_dir]}/requests/{params[name]}/request.json"
after_run:
  - type: send_http_request
    url: "https://example.invalid/notify"
    method: post
    body: {status: completed}
finally:
  - type: send_http_request
    ignore_error: true
    precondition:
      operator: node_status
      expected: failed
    url: "https://example.invalid/notify"
    method: post
    body: {status: failed}
```

If `before_run` fails, the workload does not run. If `after_run` fails, the node fails. If the workload fails, `after_run` is normally skipped because control flow jumps to `finally`; place cleanup in `finally` instead of `after_run`.
