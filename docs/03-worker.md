# 03 — Worker Runtime

## Worker responsibilities

1. Load validated config and credentials.
2. Discover physical devices and report configured capacity.
3. Authenticate and identify Unit with Data Center.
4. Maintain heartbeat independently of long-running workloads.
5. Claim only authorized Requests and fetch their Specs/previous states.
6. Create request-scoped execution sessions and submit eligible nodes to local scheduler.
7. Persist progress and report statuses; upload artifacts via server-authorized signed URLs.
8. Handle interruption, recovery and graceful shutdown.

## Modes

- `start`: repeated claim cycles; poll when idle; respond to SIGINT/SIGTERM.
- `once`: claim once, drain that batch, exit; suitable for ephemeral Kaggle/Colab kernels.

## State machine (conceptual)

```text
BOOTING → CONNECTING → READY → CLAIMING → EXECUTING → REPORTING
                        ↑            │            │
                        └─ IDLE ◀─────┘            ├─ SHUTTING_DOWN
                                                   └─ DEGRADED / RETRY
```

Worker state is **not** Request status. Existing Request statuses (`waiting`, `possessed`, `processing`, `process_failed`, `artifact_available`, `retrieve_artifact_failed`, `succeeded`) must be inventoried and mapped, not replaced silently.

## Claiming and ownership

- Server is authoritative for claims and ownership/lease semantics.
- A claim response must carry request ID, Spec identifier/version, and required resume metadata.
- Do not steal in-progress requests; use server-supported exclusion/lease protocol.
- Worker must not create new Requests as part of ordinary execution unless separately authorized by future policy.
- Unit identity and token must be bound by the server; user-supplied `--unit-id` is not proof of authorization.

## Graceful shutdown

1. Stop claiming.
2. Stop scheduling new nodes.
3. Signal running processes and wait up to `shutdownTimeout`.
4. Persist/report best-effort final states.
5. Exit with appropriate code; rely on server lease/recovery for ungraceful kernel loss.

Kaggle can terminate the kernel without delivering usable signals. Durable checkpointing is mandatory; graceful shutdown is only best effort.

## Execution session

A session is per Request: `requestId`, immutable Spec snapshot/version, parameters, scoped variables, node states, artifact references, cancellation signal and logging correlation ID. Do not confuse this internal execution session with the Mu Creation Space Session entity.
