# 05 — Scheduler and recovery

Current implementation: `src/scheduler/scheduler.ts`, `src/engine/flow.ts`,
`src/engine/checkpoint.ts`, `src/runtime/` and `src/state.ts`.
[Phase 3](../tasks/completed/phase-3.md) retains detailed delivery and validation evidence.

## Admission

The server selects Requests; the local worker schedules nodes of already-claimed
Requests. One shared scheduler covers all Requests/Specs in a SpecExecutor.
All admitted nodes consume an execution slot (`concurrency` 1–32, default 32).
CPU nodes request zero GPU units and may pass queued GPU work.

Devices have `{family, index, maxUnits}`. Node demand is the maximum workload units
across before/run/after actions, including conditional calls. Best-fit placement
uses the smallest available fitting capacity with declaration-order ties. A fitting
but busy GPU queues work; no GPU with sufficient total capacity triggers the retained
Python CPU fallback. Reservations last through finally, terminal hooks and durable
completion checkpointing. Units are a capacity heuristic, not guaranteed VRAM usage.

Omitted devices invoke bounded NVIDIA/AMD discovery; explicit `devices: []` disables
probes. Discovery uses the legacy ceil(VRAM / 4 GiB) heuristic. Scheduling tests use
synthetic devices/effects; live GPU placement and Kaggle are not established.

## Process effects

Bun adapters launch argv subprocesses without an implicit shell and cancel POSIX
process groups. Cleanup attempts have bounded budgets; forced kernel loss cannot
guarantee finally or terminal delivery. Windows process-tree behavior is unverified.
The actual injected interface is `src/engine/ports.ts`, rather than the original
proposal's illustrative ProcessRunner API.

## Checkpoints and resume

Private atomic checkpoints retain exact Spec text, assignment identity, contexts
and node outcomes. Dependency success is exposed after durable completion.
Resume checks exact remote Spec and the existing id-only report assignment guard;
it does not download authoritative server node states or obtain a lease.

Successful nodes are skipped after declared postconditions are rechecked. Unknown
running/failed nodes require explicit whole-node retry in an unfinished pipeline.
Actions, HTTP effects and entry finalization may repeat at documented boundaries;
there is no general exactly-once or durable per-action receipt recovery.
Unknown intake/preparation/hook outcomes still require manual inspection.

See [resume commands and boundaries](../tasks/completed/phase-3.md#durable-state-and-resume),
[artifact retry limits](../tasks/completed/phase-4.md#limits-and-decisions) and [CLI configuration](../guides/cli.md).
Keep successful-node output files; only declared postconditions verify them.
Concurrent Requests must use distinct Spec-defined output paths.

## Remaining proposals

Receiver-side idempotency, richer structured observability and server-assisted
reconciliation may improve recovery, but are not current protocol guarantees or
assigned implementation work. Historical target designs must not override these limits.
