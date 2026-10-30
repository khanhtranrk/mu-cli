# 08. Complete example

The example below makes no network or large-model calls. It creates directories, writes JSON, invokes a local Python workload, and checks the resulting file. It is a complete, copyable starting point.

## File structure

```text
demo-spec.yaml
render.py
request.yaml
```

## `render.py`

```python
import json
import sys
from pathlib import Path

request = json.loads(Path(sys.argv[sys.argv.index('--request') + 1]).read_text())
output = Path(sys.argv[sys.argv.index('--output') + 1])
output.write_text(
    f"# {request['title']}\n"
    f"Style: {request['style']}\n"
    f"Size: {request['width']}x{request['height']}\n"
)
print(output)
```

## `request.yaml`

```yaml
name: first-demo
title: Morning Lake
style: minimal
width: 1200
height: 800
```

## `demo-spec.yaml`

```yaml
prepare:
  - type: execute_command
    target: python
    args: [--version]

workloads:
  render:
    params:
      request:
        type: string
        description: JSON request path
      output:
        type: string
        description: text output path
      script:
        type: string
        description: renderer script path
    env:
      PYTHONUTF8: "1"
    target: python
    args:
      - "{params[script]}"
      - --request
      - "{params[request]}"
      - --output
      - "{params[output]}"
    units: 0

  mkdir:
    params:
      path:
        type: string
    target: python
    args:
      - -c
      - "import pathlib,sys; pathlib.Path(sys.argv[1]).mkdir(parents=True, exist_ok=True)"
      - "{params[path]}"

pipeline:
  demo:
    params:
      name:
        type: string
      title:
        type: string
      style:
        type: string
      width:
        type: number
        default: 1024
      height:
        type: number
        default: 1024
    context:
      item_dir: "{session[output_dir]}/{params[name]}"

    nodes:
      - name: make-output-dir
        run:
          workload: mkdir
          args:
            path: "{item_dir}"

      - name: write-request
        depends_on:
          - node: make-output-dir
            condition:
              operator: node_status
              expected: success
        run:
          workload: noop
        before_run:
          - type: write_json
            path: "{session[cache_dir]}/{params[name]}.json"
            content:
              title: "{params[title]}"
              style: "{params[style]}"
              width: "{params[width]}"
              height: "{params[height]}"
        finally:
          - type: create_dir
            path: "{item_dir}"

      - name: render-text
        depends_on:
          - node: write-request
            condition:
              operator: node_status
              expected: success
        precondition:
          operator: file_exists
          path: "{session[cache_dir]}/{params[name]}.json"
        skip_if:
          operator: file_exists
          path: "{item_dir}/result.txt"
        run:
          workload: render
          args:
            script: "{session[working_dir]}/render.py"
            request: "{session[cache_dir]}/{params[name]}.json"
            output: "{item_dir}/result.txt"
        postcondition:
          operator: and
          props:
            - operator: file_exists
              path: "{item_dir}/result.txt"
            - operator: folder_exists
              path: "{item_dir}"
        finally:
          - type: send_http_request
            ignore_error: true
            precondition:
              operator: node_status
              expected: failed
            url: https://example.invalid/status
            method: post
            body:
              status: failed
              name: "{params[name]}"
```

This example contains one intentionally demonstrated error: the `write-request` node declares `run.workload: noop`, but `noop` is not defined in `workloads`. Remove `run` or add the workload to fix it.

An action-only node is valid:

```yaml
- name: write-request
  depends_on:
    - node: make-output-dir
  before_run:
    - type: write_json
      path: "{session[cache_dir]}/{params[name]}.json"
      content:
        title: "{params[title]}"
        style: "{params[style]}"
        width: "{params[width]}"
        height: "{params[height]}"
```

The complete corrected version:

```yaml
prepare:
  - type: execute_command
    target: python
    args: [--version]

workloads:
  mkdir:
    params:
      path: {type: string}
    target: python
    args:
      - -c
      - "import pathlib,sys; pathlib.Path(sys.argv[1]).mkdir(parents=True, exist_ok=True)"
      - "{params[path]}"

  render:
    params:
      request: {type: string}
      output: {type: string}
      script: {type: string}
    env:
      PYTHONUTF8: "1"
    target: python
    args:
      - "{params[script]}"
      - --request
      - "{params[request]}"
      - --output
      - "{params[output]}"
    units: 0

pipeline:
  demo:
    params:
      name: {type: string}
      title: {type: string}
      style: {type: string}
      width: {type: number, default: 1024}
      height: {type: number, default: 1024}
    context:
      item_dir: "{session[output_dir]}/{params[name]}"

    nodes:
      - name: make-output-dir
        run:
          workload: mkdir
          args:
            path: "{item_dir}"

      - name: write-request
        depends_on:
          - node: make-output-dir
            condition:
              operator: node_status
              expected: success
        before_run:
          - type: write_json
            path: "{session[cache_dir]}/{params[name]}.json"
            content:
              title: "{params[title]}"
              style: "{params[style]}"
              width: "{params[width]}"
              height: "{params[height]}"

      - name: render-text
        depends_on:
          - node: write-request
            condition:
              operator: node_status
              expected: success
        precondition:
          operator: file_exists
          path: "{session[cache_dir]}/{params[name]}.json"
        skip_if:
          operator: file_exists
          path: "{item_dir}/result.txt"
        run:
          workload: render
          args:
            script: "{session[working_dir]}/render.py"
            request: "{session[cache_dir]}/{params[name]}.json"
            output: "{item_dir}/result.txt"
        postcondition:
          operator: file_exists
          path: "{item_dir}/result.txt"
```

## Run

```bash
uv run mu run \
  --spec ./demo-spec.yaml \
  --request demo,./request.yaml \
  --working_dir ./work
```

## Result

```text
./work/cache/first-demo.json
./work/output/first-demo/result.txt
```

## Check the output

```bash
cat ./work/output/first-demo/result.txt
```

## Modify individual sections

### Increase request size

Add `width` and `height` to the request file.

### Start again from scratch

Delete `work/output/first-demo/result.txt` to prevent the action from being skipped.

### Run two requests together

```yaml
- name: morning
  title: Morning Lake
  style: minimal
- name: evening
  title: Evening Lake
  style: cinematic
```

Mu schedules the two pipeline requests concurrently when resources allow. Use multiple requests with the same shared cache; `name` values must differ to avoid overwriting files.

### Switch to GPU

Add units and scheduling arguments:

```yaml
workloads:
  render:
    units: 2
    device_args:
      - --device
      - "{schedule[device_family]}:{schedule[device_index]}"
```

The executable must actually understand `--device cuda:0` or equivalent syntax.
