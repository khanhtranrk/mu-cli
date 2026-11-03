# 05 — Scheduler and Execution Runtime

Implemented behavior, legacy CPU fallback, capacity configuration and guarded
node recovery are documented in [Phase 3](phase-3.md). The remaining sections are
the target design; authoritative server node-state download is not currently an API.

## Scheduling scope

Data Center decides which Requests are claimable; local Worker Scheduler decides which **nodes of already-claimed Requests** can execute on available devices.

Node eligibility = dependencies satisfied + condition permits + required resources available + no conflicting in-flight execution. Priority policy must preserve the Python implementation unless explicitly changed.

## Resource model

A device is described by `{ family, index, maxUnits }`. A node/workload declares resource requirements. Unit capacity is a **configured heuristic**, not an automatically reliable VRAM measurement. CPU steps may run immediately when eligible; GPU workloads queue behind capacity constraints.

Do not accidentally introduce uncontrolled concurrency when migrating Python `asyncio` to Bun. Define concurrency limits and resource acquisition/release tests.

## ProcessRunner abstraction

```ts
interface ProcessRunner {
  run(command: string[], options: {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
    onStdout?: (chunk: Uint8Array) => void;
    onStderr?: (chunk: Uint8Array) => void;
  }): Promise<{ exitCode: number; signal?: string }>;
}
```

Bun implementation uses `Bun.spawn`, streaming logs without buffering unbounded output. Avoid shell interpolation for untrusted parameters; prefer argument arrays. Explicitly test process-tree cleanup, timeout, cancellation, and non-zero exit behavior on Kaggle.

## Failure and resume

- A node is successful only after required postconditions and durable reporting policy are met.
- Persist checkpoints/outputs needed to avoid recomputing expensive lyrics/transcript steps.
- Retry must not duplicate non-idempotent external actions or artifacts; use stable artifact IDs and idempotency keys where supported.
- On restart, fetch authoritative states, reconcile with local files/artifact metadata, and resume eligible work.
- Distinguish execution failure, artifact upload failure, report failure and worker interruption.

## Observability

Structured logs should include `unitId`, `requestId`, `nodeId`, `actionType`, duration, exit status and correlation ID. Redact secrets, signed URLs and sensitive input data. Use `debug` for verbose command logs.
