# Lifecycle events

Events attach reusable actions to execution lifecycle without adding DAG nodes.
The engine has no built-in reporting endpoints or server status mappings. Reports,
notifications and uploads remain spec-defined HTTP/file actions and routines.

```yaml
events:
  - on: node_started
    do:
      - type: execute_routine
        routine: report_node_status
        args:
          status: running
  - on: node_finished
    do:
      - type: execute_routine
        routine: report_node_status
        args:
          status: succeeded
        precondition:
          operator: node_state
          target: [status]
          expected: success
      - type: execute_routine
        routine: report_node_status
        args:
          status: failed
        precondition:
          operator: node_state
          target: [status]
          expected: failed
```

Define `report_node_status` in `routines`; it owns the endpoint, credentials and
payload. See the [scheduler smoke spec](../../examples/scheduler-smoke/spec.yaml)
for all four events and request-status mapping. It requires a configured server
and is not a safe offline smoke test.

## Events and scopes

| Event | Boundary |
| --- | --- |
| `pipeline_started` | Each request entering `Flow.execute`, before validation/preparation |
| `pipeline_finished` | That request's preparation/validation failure, or all its nodes terminal |
| `node_started` | Admitted node begins execution, before node context/skip/preconditions |
| `node_finished` | After finally and ignore_error; also for dependency-blocked nodes |

`pipeline` means one request execution, not the once-per-flow `prepare` lifecycle.
An empty pipeline finishes successfully immediately. Each request completes
independently of other requests in the batch. Invalid hook declarations are rejected
when constructing the flow, before events or entry initialization execute.

Declare `events` lists at root, `pipeline.<name>`, and nodes. Node scope only accepts
node events. Hooks accumulate in root → pipeline → node order and declaration
order within each scope. No filtering/overrides are provided in this version;
use pipeline/node scope or action conditions. Omitted events means no hooks.

## Context

All hooks get a private copy of their caller context, `event`, and a fresh `actions`
mapping. Routine calls can read `event`, and still get their own params/actions.
Node hooks also get `node` set to the event's final/current node snapshot, including
for blocked nodes. Hook changes never propagate back to the node or another hook.

```yaml
event:
  name: node_finished
  pipeline:
    name: example
  node:
    name: generate
    status: failed
    skipped: false
    blocked: false
    ignored_error: null
  error:
    type: RuntimeError
    message: "..."
```

`pipeline.status` exists on pipeline events; `node.status` exists on node events.
The definitive pipeline outcome is only available on `pipeline_finished`. Status values are
`running`, `success`, `failed`. Node events have `node`; pipeline events do not.
Node snapshots include device/total_units when dispatched; blocked nodes have no
allocated device. `error` is null on success; execution errors use RuntimeError,
blocked errors use DependencyError, intake errors retain their exception type.
`ignored_error` carries the original error message when node ignore_error converts
failure to success. A successful skip emits finished/success with skipped true.
A skip whose postcondition fails emits finished/failed with skipped true.

Pipeline-start context contains base flow context and request metadata, but no
validated params or prepared pipeline context. Failed intake context may also lack
params. Do not reference node-local outputs from pipeline hooks. Ordinary process
logs are not automatically exposed as an event log array; construct report logs
from available error/context data in the spec.

## Execution and errors

Actions in a hook run sequentially. An unignored failure stops that hook, prints a
warning, and continues remaining hooks. It never changes the node/pipeline result.
An action's explicit ignore_error still controls continuation inside that hook.
Hooks and their nested routines never emit lifecycle events. execute_workload is
forbidden in hooks and routines; it requires scheduler admission in node actions.

Different nodes can execute hooks concurrently. Node hooks run inside the node's
resource reservation; slow hooks can hold GPU units longer. HTTP actions use their
existing finite timeout (default 30 seconds). No background event worker, automatic
retry, durable delivery, or crash/cancellation completion guarantee is provided.
Re-execution can repeat external effects; implement deduplication in the receiving
service where needed.

Required uploads remain explicit node actions (for example after_run calling an
upload routine), so upload failure affects the node before node_finished. Terminal
report hooks observe the final result; they cannot turn success into failure.

## Offline example

The [events example](../../examples/events/spec.yaml) writes lifecycle snapshots
locally without network/GPU work. From the CLI repository:

```sh
uv run mu run --spec ./examples/events/spec.yaml --working_dir /tmp/mu-events-demo \
  --pipeline demo,./examples/events/input.yaml
```
