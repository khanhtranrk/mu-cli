# 03 — Worker lifecycle

Current implementation: `src/worker.ts`, `src/runtime/spec-executor.ts` and
`src/state.ts`. Historical delivery details are in [Phases 1–4](../README.md#delivery-records-and-proposals).

## Intake and execution

The worker loads configuration, discovers or accepts configured devices, loads
Request-pinned published Specs after claim, maintains heartbeats and claims waiting Requests for explicit Spec
slugs. The server binds token/unit identity and supplies assignment generations.
The local scheduler executes eligible nodes across claimed Requests and Specs.

`once` claims at most one global batch and drains it. `start` repeats the cycle.
`once --resume` processes recorded recovery work without claiming a new batch;
`start --resume` drains recovery before normal claiming.

Real execution automatically reports Request and Node lifecycle states and resolved
Outputs. General Spec hooks remain optional; their failures warn independently of
mandatory reporting failures. Standard start/finish/failure events use the same
embedded event shape; error details contain the execution failure. Transfers still require explicit Spec actions.

## Identity and durable state

Claims include Request ID, pipeline, payload, assignment version, derived output
metadata and optional frozen Registry values. They do not provide a server lease,
arbitrary assignment inspection or authoritative node-state download. New claims
include the exact YAML from the immutable Spec version pinned by the Request.
Startup does not fetch/validate the current default Spec before claiming; a draft
or default change cannot block older pinned assignments. Local checkpoints retain exact Spec text and execution state.

An execution session is Request-local; it is distinct from a Creation Space Session.
Runtime `success` is mapped by the worker to API `succeeded`; failure reporting
uses server statuses such as `process_failed`. See [protocol](../reference/protocol.md).

## Shutdown and recovery

Signals stop intake/admission, cancel subprocess groups, attempt cleanup/finalization
and persist progress within the documented budgets. Kernel loss may bypass cleanup.
There is no server lease to reclaim stranded work automatically; lost claim responses
can require owner inspection/reset.

Resume verifies saved identity, exact current remote Spec and assignment generation.
Successful nodes are retained and declared postconditions rechecked. Unknown running
or failed node outcomes require explicit `--retry-incomplete` in an unfinished
pipeline; external effects may repeat. Unknown preparation/hook outcomes are not
blindly replayed. See [recovery details](../tasks/completed/phase-3.md#durable-state-and-resume).

A workspace lock prevents two processes sharing local state. After forced loss,
verify the old worker and children have stopped before removing a stale lock.
Separate workspaces do not constitute a multi-host lease.

## Output publication and recovery

Checkpoint version 2 persists published dependency Outputs and terminal Pipeline
Outputs. Successful Node results are checkpointed before dependents proceed.
The finishing checkpoint is an outbox: after a crash, the worker resends the
idempotent terminal status/Outputs without repeating actions or hooks. Node reports
use the same assignment-scoped route. Lifecycle status/Outputs are idempotent;
event delivery is at-least-once under uncertain transport/recovery, so a replay
can append the same message again. No event IDs or separate deduplication system
are introduced.
Cancellation reports process_failed while retaining the node-boundary checkpoint;
explicit --resume/--retry-incomplete can repeat uncertain Node effects. Old execution
checkpoints are rejected with reset guidance. Entry finalization is worker-wide;
a failure exits the worker unsuccessfully without rewriting completed Request results.

Fake execution can acknowledge an empty captured output contract, but cannot
synthesize declared typed Outputs. Such a simulation fails explicitly rather
than publishing a false successful result. It still claims real Requests.

## Filesystem placement

Default execution retains `.mu/runs/<version-hash>/`. The optional `spec` run
directory scope reuses a stable server/unit/Spec directory across YAML edits, or
a chosen shared name with `--run-directory-name`. This only selects filesystem
paths: Flow preparation stays keyed by exact Spec source, and assignment/checkpoint
identity remains separate. Scope/name/path are persisted for recovery and a changed
selection cannot silently redirect a node-boundary resume. No MasterFlow API change
is required. See [run directory configuration](../guides/cli.md#run-directory-scope-and-shared-names)
for defaults, naming, intentional sharing and stale-output/concurrency limits.
