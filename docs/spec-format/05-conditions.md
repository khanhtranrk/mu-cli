# 05. Conditions

Actions and nodes use the same condition system. A condition is a mapping with an `operator`:

```yaml
operator: file-exists
path: "{params[output]}"
expected: true
```

## General rules

- `operator` is required and must be one of the supported operators.
- `expected` is the expected result.
- The default `expected` value depends on the operator.
- A missing condition (`null` or not declared) is treated as true.
- A failed condition in `precondition` means “do not run,” not “failure.”
- A failed condition in `postcondition` causes the action/node to fail.
- A failed condition in `skip_if` means normal execution continues.

## `and`

AND all of the child properties:

```yaml
operator: and
props:
  - operator: file-exists
    path: /tmp/result.mp3
  - operator: file-exists
    path: /tmp/result.abc
expected: true
```

`props` must be a list. An empty list evaluates to `true`, matching Python's `all([])` behavior.

If no nested condition is false, an empty list still evaluates to `and=true`.

## `or`

OR at least one child property:

```yaml
operator: or
props:
  - operator: file-exists
    path: /tmp/cache-a.bin
  - operator: file-exists
    path: /tmp/cache-b.bin
```

An empty list evaluates to `false`, matching Python's `any([])` behavior.

## `file-exists`

Returns true only if the path exists and is a file:

```yaml
operator: file-exists
path: "{session[output_dir]}/{params[name]}/cover.png"
expected: true
```

- Do not use this to check for a directory.
- A symlink to a regular file is usually treated as a file by `is_file()`.
- The default is `expected: true`.

## `folder-exists`

Returns true only if the path exists and is a directory:

```yaml
operator: folder-exists
path: "{session[output_dir]}/{params[name]}"
```

- A symlink to a directory is usually treated as a directory.
- The default is `expected: true`.

## `path-exists`

Returns true for any existing object: a file, folder, or valid symlink:

```yaml
operator: path-exists
path: "{params[output]}"
```

Use `file-exists` or `folder-exists` when the object type must be constrained.

## `exit-code`

Runs a command and compares its exit code:

```yaml
operator: exit-code
target: ["{sys[cache_dir]}/bin/yue-synth", --help]
expected: 0
```

- `target` must be a non-empty argument-vector list.
- `expected` must be an integer; booleans are not accepted.
- The default is `expected: 0`.
- A missing executable or an OS error makes the condition false.
- The command runs with `cwd = session.working_dir`.

Example that expects exit code `1` to identify a legacy command:

```yaml
operator: exit-code
target: [demucs, --help]
expected: 1
```

Do not use `exit-code` for expensive work. It is only a probe that re-executes the executable.

## `node_status`

Checks a node's state within the same pipeline request:

```yaml
operator: node_status
node: prepare
expected: success
```

`node` is the node name. If omitted, Mu uses the current node name:

```yaml
finally:
  - type: send_http_request
    precondition:
      operator: node_status
      expected: failed
```

Valid states:

- `success`: the node ran successfully or was skipped successfully;
- `failed`: the node failed;
- An unknown node state evaluates to false.

If `expected: succeeded`, the runtime normalizes the alias to `success`, but new documentation and specs should use `success`.

## `expected: false`

A condition can be inverted:

```yaml
operator: file-exists
path: /tmp/must-not-exist
expected: false
```

This is useful with `skip_if`: skip an action when its output does not exist, although the likely mistake is:

```yaml
skip_if:
  operator: file-exists
  path: output.png
expected: true
```

## Relative paths

Mu resolves relative paths against `session.working_dir`:

```yaml
operator: file-exists
path: output/demo.wav
```

That is equivalent to:

```yaml
path: "{session[working_dir]}/output/demo.wav"
```

Use an absolute template when a spec may run in a different environment or be started from an unexpected directory.

## Conditions on actions

```yaml
- type: execute-command
  target: python
  args: [convert.py]
  skip_if:
    operator: file-exists
    path: "{params[output]}"
  precondition:
    operator: folder-exists
    path: "{params[input_dir]}"
  postcondition:
    operator: file-exists
    path: "{params[output]}"
```

The sequence is:

1. `skip_if` is true: the action does not run.
2. `precondition` is false: the action does not run.
3. The action runs.
4. `postcondition` is false: the action fails.

## Conditions on nodes

```yaml
- name: generate
  skip_if:
    operator: file-exists
    path: "{params[output]}"
  precondition:
    operator: exit-code
    target: [generator, --help]
  postcondition:
    operator: file-exists
    path: "{params[output]}"
```

For details, see [Pipelines and nodes](06-pipelines-and-nodes.md).
