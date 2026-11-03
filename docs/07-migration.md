# 07 — Migration Plan and Acceptance Tests

## Phase 0 — Inventory (no code changes)

Inspect Python Mu CLI and current MasterFlow. Record real CLI commands, YAML schema, validators, scheduler semantics, action handlers, state transitions, server API calls and existing tests. Mark implemented versus planned features.

Deliverables: `docs/current-behavior.md`, compatibility matrix, risk register.

## Phase 1 — Characterization tests

Capture representative real Specs and expected behavior in fixtures. Build fake CPU workloads (20–30 seconds) to test GPU-style scheduling without Kaggle GPU usage. Golden tests should cover parser/validator errors, node dependencies, action output, events, state persistence, interruption and resume.

## Phase 2 — Shared packages

Create `@mu/spec`, then `@mu/engine`. Verify package consumption strategy across Git submodules. Do not migrate MasterFlow validator until behavior parity is established.

## Phase 3 — TypeScript Worker

Port config and CLI → API client → worker lifecycle → process runner → scheduler/resource management → artifact transfers. Prefer incremental vertical slices that execute end-to-end fixtures.

## Phase 4 — Integration

Test `mu worker once` on local CPU and Kaggle; test `start` on a stable Linux host. Confirm authorization, heartbeat while busy, server outage, retry, signal handling and sudden kernel death recovery.

## Phase 5 — Cutover

Only after parity: switch worker deployment, remove duplicate MasterFlow validation, archive Python orchestrator. Keep Python AI workloads as subprocesses where needed.

## Required tests

- CLI: missing config, bad token, unknown flag, `--json`, redaction.
- Spec: valid/invalid fixtures; same normalization on CLI and MasterFlow.
- Engine: dependency ordering, skip/success conditions, event hooks, failure propagation.
- Scheduler: resource accounting across requests, CPU/GPU eligibility, no over-allocation.
- Process: streaming, nonzero exit, timeout, SIGINT/SIGTERM, child process cleanup.
- Worker: claim once vs polling loop, empty queue, heartbeat during long job, shutdown.
- Resume: crash between action completion and state report; no unintended duplicate artifact.
- Security: cannot claim/report another worker's request; cannot delete artifact.
- Kaggle: Bun installation and executable compatibility, subprocess launch, termination behavior.

## Definition of done

Behavior parity documented, tests pass, no duplicated canonical Spec schema, documented module boundaries, no secret leakage, recoverable interrupted work, Kaggle smoke tests completed, and human-readable architecture documentation maintained.
