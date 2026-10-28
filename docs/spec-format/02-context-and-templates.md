# 02. Context, templates, and parameters

## What is context?

Context is a Python mapping passed through `{...}` formatting. It is built in stages:

```text
sys
session
params
node
schedule
declared action context
```

In a template, the outermost key is the context root. For example, `{params[name]}` reads `context["params"]["name"]`.

```yaml
args:
  - "{params[name]}"
  - "{session[output_dir]}/{params[name]}/cover.png"
```

## Base context

Mu creates this context before running `prepare`:

```yaml
sys:
  cache_dir: /system/cache/path
  models:
    model-file.gguf: /actual/path/to/file.gguf
session:
  working_dir: /working/path
  unit_name: unknown
  output_dir: /working/path/output
  cache_dir: /working/path/cache
```

`output_dir` and `session.cache_dir` are created automatically in `_runtime_base`.

### `sys.cache_dir`

This is `--sys_cache_dir`, defaulting to `$HOME/.cache`.

### `sys.models`

Mu scans `.gguf`, `.safetensor`, and `.safetensors` files under `sys.cache_dir/models`. Keys can be:

- a relative path such as `vae/qwen_image_2.1_vae_bf16`;
- a unique stem such as `YuE2-3B-BF16`;
- the full filename if the stem is duplicated.

When several files have the same stem or name, aliases may not be created consistently. Use the relative path or full key to avoid ambiguity.

## Pipeline context

Each pipeline can add context:

```yaml
pipeline:
  demo:
    context:
      media:
        image: png
      quality: high
```

These values are rendered first and then merged into the shared context. A template can reference context that already exists:

```yaml
context:
  work_name: "render/{params[name]}" # params does not exist at this stage!
```

Note: pipeline `context` is rendered **before** pipeline parameters. Therefore, `params[...]` placeholders cannot be resolved at this stage; they may be rendered later in node or action context, but relying on that behavior is discouraged. The clear approach is to place parameter-dependent values in node context or keep the template in arguments or an action.

## Parameter schema

Pipeline and workload schemas are declared under `params`. Every key is a parameter name; its declaration can include `type`, `default`, and an optional description:

```yaml
params:
  name:
    type: string
  width:
    type: number
    default: 1024
  optional_description:
    type: string
    default: untitled
```

Rules:

- A missing key without a `default` is an error.
- A key with a `default` uses that default.
- `type: string` requires a string value.
- `type: number` requires an `int` or `float` and rejects booleans.
- Parameters outside the schema are rejected.
- After schema processing, `params` becomes a mapping in the context.

YAML `1` is a number, while `"1"` is a string.

### Pipeline parameters

Request data is a mapping:

```yaml
name: demo
width: 1920
```

Or a list of mappings in a request file:

```yaml
- name: demo-a
- name: demo-b
```

If a mapping lacks a required parameter, Mu reports an error before running nodes.

### Workload parameters

Nodes supply arguments:

```yaml
run:
  workload: resize
  args:
    input: "{params[input]}"
    output: "{params[name]}.png"
```

The workload defines the schema for these arguments:

```yaml
workloads:
  resize:
    params:
      input: {type: string}
      output: {type: string}
```

Mu uses the supplied arguments to construct `workload.params`, renders them again using the current context, and then executes the target. Missing or extra keys cause a workload error.

## Node context

A node can add context:

```yaml
- name: render
  context:
    stage: main
    status_label: "rendering {params[name]}"
```

Mu renders node context using the current pipeline context and merges it. The resulting context also contains:

```yaml
node:
  name: render
  status: running
  total_units: 3
```

`node.status` is updated to `failed` or `success` before `finally` runs. `node.total_units` comes from `workload.units`.

## Action context

An action can merge its own context:

```yaml
- type: write-json
  context:
    payload:
      name: "{params[name]}"
  path: "{session[cache_dir]}/request.json"
  content: "{payload}"
```

Note that `write-json` renders the entire action before execution, so a context mapping may not merge as expected if `content` references the placeholder. Action context exists only in the local context object being used; it does not replace the original root context.

## Schedule context

This exists only when a workload has `units > 0` and the scheduler assigns a GPU:

```yaml
schedule:
  device_family: cuda | rocm
  device_index: "0"
```

For example:

```yaml
device_args:
  - --device
  - "{schedule[device_family]}:{schedule[device_index]}"
```

If a workload has `units: 0`, no GPU is assigned, no `schedule` is passed, and `device_args` are not appended.

## Rendering rules

Mu performs up to eight rendering passes so that a template can reference another template:

```yaml
context:
  stem: "{params[name]}"
args:
  - "{stem}.wav"
```

A placeholder that cannot be resolved is **left unchanged** rather than replaced. This can conceal a misspelled key. For safer checking:

- a value placeholder such as `{params[output]}` should use a root that has already been created;
- run a small test with a complete request;
- inspect the `[NODE]` output log to verify the command.

Rendering supports:

- strings: `{params[name]}`;
- mappings: each value is rendered;
- lists: each item is rendered;
- numbers and booleans: preserve the original type when the entire string is a placeholder;
- composed strings: replacements are converted to text.

## Full context example

```text
sys:
  cache_dir: "/home/u/.cache"
  models:
    demo-model: "/home/u/.cache/models/demo.gguf"
session:
  working_dir: "/work"
  unit_name: "worker-1"
  output_dir: "/work/output"
  cache_dir: "/work/cache"
params:
  name: "demo"
  quality: 4
node:
  name: upscale
  status: running
  total_units: 2
schedule:
  device_family: cuda
  device_index: "1"
```
