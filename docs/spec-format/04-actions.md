# 04. Actions

An action is a side-effecting operation: running a process, creating a directory, writing JSON, or sending HTTP.

## Common properties

```yaml
- type: execute_command
  context: {}
  skip_if: {...}
  precondition: {...}
  postcondition: {...}
  ignore_error: false
```

| Property | Required | Meaning |
|---|---:|---|
| `type` | Yes | Action type. The only action declaration key. Action names use snake_case; aliases are rejected. |
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

## `execute_command`

Runs one subprocess:

```yaml
- type: execute_command
  target: python
  args: [-m, pip, --version]
  env:
    PYTHONUTF8: "1"
  skip_if:
    operator: exit_code
    target: [python, -m, pip, --version]
```


| Field | Meaning |
|---|---|
| `target` | First executable |
| `args` | Argument list; defaults to `[]` |
| `env` | Mapping of additional environment variables |

Mu captures stdout/stderr, treats a nonzero exit code as failure, and overlays `env` on the current environment. Arguments and environment values may contain templates.

**Do not use a shell:** `target: "echo hello"` is incorrect; use `target: echo`, `args: [hello]`.


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
  save_state: running
  ignore_error: true
```

| Field | Default | Meaning |
|---|---|---|
| `url` | required | HTTP/HTTPS URL |
| `method` | `get` | Mu uppercases it; `post`, `POST`, and `post` are all equivalent. |
| `header` | `{}` | Headers passed to urllib |
| `body` | none | If present, Mu encodes it as JSON with `json.dumps`. |
| `save_state` | none | Non-empty name storing the result in `context["actions"][name]`. |

The HTTP timeout is 30 seconds. See the saved-result contract below.

Action names and declaration keys have no aliases.


## `write_json`

Writes a JSON document:

```yaml
- type: write_json
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

## `create_dir`

Creates a directory and any required parents:

```yaml
- type: create_dir
  path: "{session[output_dir]}/{params[name]}"
```

Mu does not create a file. The action succeeds if the path already exists as a directory. If a file exists at the path, `mkdir` fails.


## Action locations

An action can appear in:

- `entries.<entry>.initialization` and `.finalization`;
- `pipeline.<name>.prepare`;
- `node.before_run`;
- `node.after_run`;
- `node.finally`;
- a node's `run`. In the newer runtime, `run` must be a workload, not an action.

### Actions in `prepare`

Prepare receives the entry context plus pipeline context, without request params.

### Actions in a node

The node context contains `params`, `node`, and `schedule` when a GPU-backed workload is used. Actions are rendered with that same context.

### Actions in `finally`

The node state is updated before `finally` runs:

```yaml
finally:
  - type: send_http_request
    precondition:
      operator: node_state
      target: [status]
      expected: success
```

Use `node_state` with `target: [status]` to inspect the current node directly.


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
  - type: create_dir
    path: "{session[cache_dir]}/requests/{params[name]}"
  - type: write_json
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
      operator: node_state
      target: [status]
      expected: failed
    url: "https://example.invalid/notify"
    method: post
    body: {status: failed}
```

If `before_run` fails, the workload does not run. If `after_run` fails, the node fails. If the workload fails, `after_run` is normally skipped because control flow jumps to `finally`; place cleanup in `finally` instead of `after_run`.

## Saved action results

Only `execute_command` and `send_http_request` accept `save_state: name`.
The name must be a non-empty string. Results are stored in the containing
context at `actions[name]`; repeated names overwrite earlier results.
`context.actions`, if present, must be a mapping.

```yaml
- type: execute_command
  target: python
  args: [--version]
  save_state: python_version
- type: write_json
  path: version.json
  content:
    stdout: "{actions[python_version][stdout]}"
```

Command result:

```json
{"success": true, "error": null, "returncode": 0, "stdout": "Python 3.13\n", "stderr": ""}
```

`stdout` and `stderr` retain whitespace and are not parsed as JSON. A nonzero
return code fails the action (negative codes can indicate POSIX signals).
Failure to start stores `returncode: null` and empty output strings.

HTTP result:

```json
{"success": true, "error": null, "status_code": 201, "headers": {"content-type": "application/json"}, "body": {"id": "job-123"}}
```

Response header names are lowercase. Body is parsed as JSON when valid,
otherwise decoded as text using the declared charset or UTF-8, replacing
invalid bytes. An empty body is `null`. Binary responses are decoded as text;
use a download tool for binary files. HTTP 4xx/5xx fail but retain response
status, headers and body. Network errors without a response store
`status_code: null`, `headers: {}`, and `body: null`.

Errors use `{"type": "ExceptionClass", "message": "details"}` and set
`success: false`. State is saved before propagating an execution error, even
without `ignore_error`. Ignoring an error does not change its saved success.
Results are available to the action's postcondition; a failed postcondition
updates success/error while retaining response/output. Skipped actions do not
write state. Invalid declarations or rendering failures before execution do
not create execution results.

Later actions and `finally` in the same node can read saved results with
`{actions[name][stdout]}` or `{actions[name][body]}`. Node/request contexts
remain isolated. Prepare results are available to later prepare actions and are
deep-copied into each request of that pipeline. Entry results are inherited by
pipeline preparation.

The former `save_response_to_context` field is rejected. Legacy registry actions also use `type` and
snake_case names (`command`, `create_dir`, `write_json_from_context`,
`write_jsons_from_context`), retaining their distinct legacy field schemas.
