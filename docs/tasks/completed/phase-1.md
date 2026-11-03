---
id: MU-CLI-PHASE-1
title: Phase 1 — CPU worker foundation
status: completed
---

# Phase 1 — CPU worker foundation

Historical Phase 1 delivery. [Phase 2](phase-2.md) now adds real CPU Spec execution
without `--fake`, with Spec-owned reporting. Fake mode retains the behavior below.

Implemented in `src/config.ts`, `src/api.ts`, `src/worker.ts`,
`src/state.ts`, `src/runtime/fake.ts` and the CLI `src/index.ts`.
Worker and execution interfaces can be imported without starting the CLI.

## Run

Requires Bun 1.4+ (built-in YAML parser). Install with `bun install`.

```sh
bun src/index.ts config init
MU_WORKER_TOKEN='YOUR_DISPOSABLE_TOKEN' bun src/index.ts worker doctor --config mu.yaml --json
MU_WORKER_TOKEN='YOUR_DISPOSABLE_TOKEN' bun src/index.ts worker once --config mu.yaml --fake
MU_WORKER_TOKEN='YOUR_DISPOSABLE_TOKEN' bun src/index.ts worker start --config mu.yaml --fake
```

Create the token, unit binding, allowed Spec and disposable waiting Requests in
MasterFlow first. Use a token scoped exclusively to disposable test Specs.
`--fake` is mandatory for execution: it claims real Requests and reports simulated
success, without interpreting their actions, conditions, parameters or dependencies.
It launches a fixed, CPU-only Bun subprocess for each Request, validates only the
Spec envelope/selected pipeline/node names, and reports no fabricated node states
or artifacts. This is an integration harness, not a production Spec engine.
No new Spec syntax is introduced; any workload definitions in fetched YAML are
ignored in fake mode. CEL capability negotiation is sent solely to access the
current API in this explicitly selected harness mode; CEL evaluation is unavailable.

## Behavior at Phase 1 delivery (fake mode)

- CLI flags override environment, then YAML, then defaults. Tokens come from
  `MU_WORKER_TOKEN` or `--token`; show/info redact them. Configuration initialization
  refuses overwrite without `--force`. Unknown options fail.
- `once` claims at most one global batch across the explicit Spec list, with a
  total `maxClaim` of 1–100. Requests execute serially (capacity one), isolated by
  assignment in checkpoints. Empty queues succeed. `start` repeats at the poll interval.
- Online heartbeat precedes claims; heartbeats continue independently during work.
  Shutdown stops claims, cancels the fake subprocess, marks claimed work failed,
  attempts final reports and sends an offline heartbeat. HTTP calls time out after
  ten seconds. No mutation is automatically retried within a run.
- Private local checkpoints are synced and atomically renamed before terminal
  reporting. They retain original claim inputs, artifacts and Registry snapshots,
  scoped by server and unit. On restart, terminal reports are resent without
  rerunning execution. Nonterminal checkpoints are failed conservatively; unknown
  execution outcomes are never replayed automatically. Repeated reports contain
  no append-only logs or artifact operations.
- A workspace lock prevents simultaneous CLI processes. After an ungraceful kill,
  verify the old worker is stopped, then remove `worker.lock` in the configured
  workspace before restarting. Keep the workspace on durable local storage.
- Doctor checks configuration, workspace write access, health and scoped Spec
  authentication. It never claims or registers a unit. It cannot prove the token's
  unit binding without a mutating heartbeat. JSON output describes this limitation.
- Exit codes: 0 success/no work; 2 argument/config error; 3 HTTP 401/403;
  4 other HTTP errors; 5 infrastructure/transport/local-state error;
  6 failed batch; 130 graceful interruption. Server authorization refusals surfaced
  as HTTP 400 remain code 4.

## Verified contracts and mismatches

Inspected `mu-masterflow/convex/http.ts`, `units.ts`, worker hook documentation,
and legacy `master_flow.py` plus runtime instructions. Backend remains unchanged.

- Use the HTTP site origin, not the Convex client origin.
- Claim requires a single `specSlug`, registered token-bound `unitId`, and
  `expressionEngine: cel-v1`. Fetch requires `X-Mu-Expression-Engines: cel-v1`.
- Reports use `/api/requests/report`, `id`, optional `node_states`, and the exact
  `X-Mu-Assignment-Version` returned by claim. `/api/requests/update` does not exist.
- The server cannot enumerate allowed Spec slugs: provide `worker.specs` or
  repeated `--spec`. Server limits claim count, not CPU/GPU capacity.
- No lease expiry, reclaim, assignment inspection or immutable Spec snapshot is
  returned. A lost claim response can strand a possessed Request; mutations cannot
  safely be blindly retried. Recovery of unrecorded claims needs an owner decision
  or a future backend protocol. Failed persisted assignments can be reset in the UI.
- Legacy progress reporting is Spec-action-driven; Phase 1 reports request-level
  simulated status directly. Decide automatic vs Spec-action ownership before the
  production engine is integrated, to avoid duplicate lifecycle reports.
- Artifact transfers are deferred. Current contracts are presigned PUT + completion
  receipts and URL JSON for downloads; no old storage IDs or byte proxy is added.

## Validation and next phases

`bun run typecheck` and `bun test` use fake HTTP responses and tiny CPU subprocesses.
No live backend mutation, model download, GPU work, backend deployment or Kaggle
verification is performed. This does not establish Python runtime parity.

Phase 2 owns full Spec validation, CEL, context/parameter resolution, lifecycle
hooks, routines and actual actions. Phase 3 owns DAG/resource scheduling and node
recovery. Phase 4 owns artifact transfers and real-backend integration. These were
unimplemented at the Phase 1 delivery; all four deliveries are now recorded in
[the documentation map](../../README.md#delivery-records-and-proposals). Draft roadmap numbering in [the original roadmap](../superseded/migration-roadmap.md) predates
the user's four-phase assignment; this document records the delivered Phase 1.
