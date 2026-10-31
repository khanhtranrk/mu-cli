# Request-to-Node Scheduling Workflow

This document is an implementation-oriented map for coding agents. It describes **current behavior**, not a proposed redesign. Read `src/mu/runtime.py` and `src/mu/cli.py` before changing it.

## Execution path

```text
mu master-flow run <spec-slug>                  (src/mu/cli.py)
  -> fetch spec, register worker/unit, claim a batch of requests
  -> construct Flow(spec, "master_flow", ...)
  -> Flow.execute(claimed requests)
       -> validate each requested pipeline and its parameters
       -> prepare each selected pipeline before scheduling its nodes
       -> execute_pipelines(spec, [(pipeline_name, payload), ...], ...)
            -> build one job per (request index, node name)
            -> calculate each job's peak GPU units
            -> enter the shared scheduler loop
                 -> check dependencies
                 -> select device / reserve units / reserve execution slot
                 -> mark running and submit _execute_node(...)
                      -> copy request context and add node context
                      -> skip_if, precondition
                      -> before_run -> run -> after_run
                      -> postcondition -> finally
                      -> return success/failed
                 -> collect completion, release GPU units, publish state
            -> finish each request independently
  -> spec event hooks call reporting routines/HTTP actions
```

Local execution also uses the runtime pipeline scheduler; remote claiming is specific to the MasterFlow CLI path; reporting is spec-defined.

## 1. Request intake and preparation

- The MasterFlow CLI claims requests from `/api/requests/claim` and extracts `pipelineName`, `payload`, and request metadata. The batch is passed to `Flow.execute`.
- `Flow` validates the selected pipelines, prepares their request contexts, and runs `pipeline.<name>.prepare` **before** dispatching nodes. Preparation actions are not node jobs and do not wait for a node GPU reservation.
- Entry-level `initialization` and `finalization` actions also live outside the node scheduler.
- Each request has its own parameterized pipeline context. Node execution deep-copies that context, so sibling nodes do not share mutable node-local context.

## 2. Build jobs, not running processes

`execute_pipelines` reads `pipeline.<name>.nodes` and calls `validate_pipeline` (unique names, valid dependencies, no cycles). For each request and each node it creates a pending job keyed by `p{request_index}:{node_name}`, storing the request index, pipeline, context, node definition, and calculated units.

Example: three requests for a six-node pipeline create **18 pending jobs** in one scheduler, not six shared jobs and not 18 immediately running nodes. Dependencies are resolved **within the same request**; independent jobs from different requests can compete for the same GPU pool.

## 3. GPU demand is calculated per entire node

`node_units(spec, node)` examines actions in `before_run`, `run`, and `after_run`. It considers **only** actions with `type: execute_workload`, resolves each referenced `workloads.<name>.units`, and returns their **maximum**, not their sum.

For example, a node with sequential workload actions requesting 1, 4, and 2 units reserves **4 units for the whole node lifetime**, including `before_run` and `finally`. It does not reserve separately per action. A plain `execute_command` action is not counted as GPU demand, even if the subprocess happens to use CUDA. An action in `finally` does not contribute to the peak calculation.

```yaml
workloads:
  first:
    target: python
    args: ["first.py"]
    units: 1
  second:
    target: python
    args: ["second.py"]
    units: 4
pipeline:
  demo:
    nodes:
      - name: generate
        before_run:
          - type: execute_workload
            workload: first
        run:
          - type: execute_workload
            workload: second
```

Here `generate` requires 4 units, and `before_run` does not begin until that node is dispatched.

## 4. Scheduler admission

The scheduler uses a shared `ThreadPoolExecutor` (maximum 32 workers) and tracks free units per detected device.

For each pending job:
1. Wait while any `depends_on` node from **that request** is pending/running.
2. Block the job if a required dependency failed.
3. For a positive unit requirement, look for GPUs with sufficient **total capacity**, then select one with enough **currently free units**. If suitable GPUs exist but are busy, leave the job queued: no node action runs yet.
4. If a GPU is selected and an execution slot is available, reserve the node's units, publish `running`, and submit `_execute_node`.
5. When execution completes, release reserved units, publish the terminal node state, and update request completion independently of other requests.

**Current implementation caveats:**
- A zero-unit node runs without a GPU reservation and can execute concurrently with GPU nodes.
- If **no detected GPU has sufficient total capacity**, the current scheduler logs a warning and **falls back to CPU dispatch**. This is not equivalent to waiting for free GPU units. Check this path before changing GPU enforcement.
- The executor's worker limit is separate from the GPU-unit limit; seeing more active CPU-only nodes than GPUs is not necessarily a scheduling bug.
- `pipeline.prepare` and entry initialization/finalization are outside the node-admission boundary.

## 5. Node lifecycle

Once admitted, `_execute_node` constructs `node` context (name, running status, peak total_units, selected device), applies node-local context, and evaluates:

```text
skip_if (matched -> skip main actions)
  otherwise: precondition
             before_run actions
             run actions
             after_run actions
             postcondition
finally actions (also after skip or failure)
ignore_error handling -> final result
```

Actions within each phase are sequential. A failed dependency prevents the dependent node from entering this lifecycle. The GPU reservation remains held through `finally`. The scheduler distinguishes pending/queued, running, and terminal states; internal success is `success`, while the API may report `succeeded`.

## 6. Reporting boundary: current behavior versus desired configuration

Lifecycle reporting is spec-defined through [events](spec-format/10-events.md).
The runtime emits server-neutral events; hooks own API payloads and status mapping.
Node terminal events follow finally and ignore_error; blocked nodes also emit them.

## 7. Debugging unexpected concurrent execution

Inspect logs in this order:

- `[PIPELINE] ... queued (N nodes)`: jobs were created; **not** evidence that actions started.
- `[SCHEDULE] ... dispatched (X units; DEVICE)`: actual scheduler admission and placement. Watch for `cpu` and `0 units`.
- `[NODE] ... starting`: the node's action lifecycle begins after dispatch.
- `[WORKLOAD] ... starting`: a workload subprocess begins within an admitted node.

When 4–6 nodes appear active despite only 2–3 expected GPU slots, first compare the YAML `execute_workload` declarations and their `units` values with the dispatch log. Also distinguish `pipeline.prepare` actions and CPU-only jobs from GPU-reserved node jobs.

## Source map

- `src/mu/cli.py`: remote claim and batch construction.
- `src/mu/runtime.py`: `Flow`, `execute_pipelines`, `validate_pipeline`, `node_units`, `_execute_node`, `run_action`.
- `src/mu/hardware.py`: detected devices and GPU unit capacities.
- `tests/test_events.py`: focused scheduler/reporting behavior.
- `docs/spec-format/06-pipelines-and-nodes.md`: node spec fields.
- `docs/spec-format/07-master-flow-and-cli.md`: entry lifecycle, MasterFlow CLI, reporting details.
