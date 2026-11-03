# 03 — Worker lifecycle

Current implementation: `src/worker.ts`, `src/runtime/spec-executor.ts` and
`src/state.ts`. Historical delivery details are in [Phases 1–4](README.md#delivery-records-and-proposals).

## Intake and execution

The worker loads configuration, discovers or accepts configured devices, bootstraps
permitted Specs, maintains heartbeats and claims waiting Requests for explicit Spec
slugs. The server binds token/unit identity and supplies assignment generations.
The local scheduler executes eligible nodes across claimed Requests and Specs.

`once` claims at most one global batch and drains it. `start` repeats the cycle.
`once --resume` processes recorded recovery work without claiming a new batch;
`start --resume` drains recovery before normal claiming.

Real execution preserves Spec-owned reporting through HTTP actions/routines/events;
there is no automatic status reporter. A Spec without reporting can finish locally
while its server Request remains possessed. `--fake` is a separate serial simulation
that claims real work and sends request-level reports.

## Identity and durable state

Claims include Request ID, pipeline, payload, assignment version, derived output
metadata and optional frozen Registry values. They do not provide a server lease,
arbitrary assignment inspection, authoritative node-state download or immutable
server Spec snapshot. Local checkpoints retain exact Spec text and execution state.

An execution session is Request-local; it is distinct from a Creation Space Session.
Runtime `success` is mapped by Spec reporting to API `succeeded`; failure reporting
uses server statuses such as `process_failed`. See [protocol](06-protocol.md).

## Shutdown and recovery

Signals stop intake/admission, cancel subprocess groups, attempt cleanup/finalization
and persist progress within the documented budgets. Kernel loss may bypass cleanup.
There is no server lease to reclaim stranded work automatically; lost claim responses
can require owner inspection/reset.

Resume verifies saved identity, exact current remote Spec and assignment generation.
Successful nodes are retained and declared postconditions rechecked. Unknown running
or failed node outcomes require explicit `--retry-incomplete` in an unfinished
pipeline; external effects may repeat. Unknown preparation/hook outcomes are not
blindly replayed. See [recovery details](phase-3.md#durable-state-and-resume).

A workspace lock prevents two processes sharing local state. After forced loss,
verify the old worker and children have stopped before removing a stale lock.
Separate workspaces do not constitute a multi-host lease.
