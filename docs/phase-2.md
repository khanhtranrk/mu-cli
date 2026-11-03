---
status: completed
---

# Phase 2 — CPU Spec engine

Historical Phase 2 delivery. [Phase 3](phase-3.md) now adds shared CPU/GPU
admission, concurrent execution and versioned node checkpoints with guarded resume.

This is Phase 2 of the user's four-phase implementation plan. The older numbering
in `07-migration.md` is a target roadmap, not the delivery status.

## Usage

```sh
bun install
MU_WORKER_TOKEN='YOUR_TOKEN' bun src/index.ts worker doctor --config mu.yaml --json
MU_WORKER_TOKEN='YOUR_TOKEN' bun src/index.ts worker once --config mu.yaml
MU_WORKER_TOKEN='YOUR_TOKEN' bun src/index.ts worker start --config mu.yaml
```

Without `--fake`, workers now execute the fetched Spec. `--fake` retains the
explicit Phase 1 simulation. There is still no public local `mu run` command.
Use CPU-only Specs with workload `units: 0` (also the omitted default).
At Phase 2 delivery, any node referencing a GPU workload was rejected before claiming work, including
conditional workload actions. Unused GPU workload declarations are harmless.

## Implementation and boundaries

| Module | Responsibility |
| --- | --- |
| `src/spec/` | Types, YAML/JSON parsing, declaration/graph validation, bounded CEL templates |
| `src/engine/context.ts` | Strict parameters, literal supplied inputs, captured Registry scopes |
| `src/engine/actions.ts`, `conditions.ts` | Sequential actions, saved state, conditions, injected effects |
| `src/engine/flow.ts` | Entry lifecycle, lazy preparation, isolated request/node contexts and events |
| `src/runtime/effects.ts` | Bun subprocess groups, filesystem, HTTP and file transfers |
| `src/runtime/spec-executor.ts` | Data Center request adapter and per-Spec Flow lifetime |
| `src/worker.ts` | Connection, bootstrap before claim, heartbeat, batch loop and checkpoints |

The Spec parser has no execution/network capabilities. Engine effects are injected;
the engine does not import the CLI, worker, API client or concrete Bun adapter.
Publishing shared packages or moving MasterFlow validation is deferred until parity
is established; neither repository imports source from a sibling checkout.

## Implemented semantics

- YAML/JSON parsing uses pinned `yaml@2.9.1`, retaining legacy YAML 1.1 scalar
  resolution, merge keys, and the literal mapping key `on` for events. Duplicate
  mapping keys are rejected instead of accepting ambiguous declarations.
- `cel-v1` is the only expression engine and the omission default. The interpreter
  is pinned to `@marcbachmann/cel-js@8.0.0`, matching MasterFlow. The bounded
  function/method profile, JSON result constraints, escapes, whole-value typing,
  scalar interpolation, once-only rendering and syntax/runtime budgets are tested
  against all 63 shared vectors. The fixture is byte-identical to both references.
- Pipeline/workload/routine params support string, number, boolean, array and
  object; missing and unknown values fail. Supplied JSON is literal; only missing
  defaults execute in the caller context. No type coercion is performed.
- Captured `CreationSpace.Registry`, `Session.Registry`, `Request.Registry` are
  immutable context roots. Request metadata includes assignmentVersion, artifact
  projections and the captured Registry context. Lowercase `session` is separate.
- Entry `master_flow` initializes before claim, finalizes once after draining or
  failure, and attempts every finalization action. Pipeline preparation is lazy,
  validates intake before side effects, caches success/failure per Flow, and has no
  Request data. Prepared context is copied before each request; pipeline context
  precedes params, and nodes/routines/hooks receive private copies as documented.
- Nodes run dependency-ready, serially, in declaration scan order. Dependency
  failures block actions/finally; `ignore_error` can convert the scheduler outcome.
  Node order is context → skip → precondition → before/run/after → postcondition
  → finally. A skip still checks its postcondition; node precondition failure
  fails, while action precondition failure skips. Finally sees actual status;
  ignored-node conversion happens afterward.
- Actions: `execute_command`, CPU `execute_workload`, `execute_routine`,
  `create_dir`, `write_json`, `inspect_file`, `send_http_request`. Commands use
  argv and inherited environment without an implicit shell. Saved results are
  available before postconditions, retain failures, and stay local to their context.
  Workloads are forbidden in routines, events, entry lifecycle, prepare and finally.
- Conditions: `and`, `or`, `cel`, `file_exists`, `folder_exists`, `path_exists`,
  `exit_code`, `action_state`, `node_state`, `node_status`. There is no `not` or
  hyphenated operator; those names in the draft engine document were proposals.
- Events: pipeline/node started/finished; hooks accumulate root → pipeline → node.
  Each hook gets fresh actions and an isolated event snapshot. Hook errors stop
  that hook and warn without changing execution outcomes. Routine cycles and
  invalid event/action placement fail before entry initialization or claims.
- HTTP actions support JSON bodies, dynamic payload keys, raw `body_file`, atomic
  `response_file`, saved JSON/text/error results and assignment propagation only
  to the configured server origin. Redirects strip auth/cookie/assignment headers
  when crossing origins. Requests and external effects are never automatically retried.
- POSIX subprocess groups are killed on cancellation, including descendants.
  Entered nodes attempt finally after cancellation with a separate 30-second
  cleanup deadline; entry cleanup also has a 30-second budget. Forced kernel loss
  cannot guarantee cleanup or terminal hook delivery.

## Reporting compatibility

Real execution preserves the Python contract: **the Spec owns request/node
reporting through HTTP actions/routines and events**. No implicit worker status
reports are added in real mode, so existing hooks are not duplicated. A Spec
without reporting hooks leaves its server Request possessed even if local work
succeeds. Runtime `success` must be mapped by hooks to API `succeeded`; request
failure maps to `process_failed`. The loopback CLI test verifies these mappings
and exact assignment headers. Fake mode alone keeps Phase 1 automatic reports.

Local checkpoints distinguish these reporting modes. Restart never reruns Spec
actions or replays their hooks. An unfinished Spec checkpoint is marked locally
handled and warns that the owner must inspect/reset the assignment in MasterFlow.
The original unknown-outcome limitations remain: no server lease/reclaim or
arbitrary assignment-inspection endpoint is available.

## Limits at Phase 2 delivery (superseded where noted)

CPU nodes/requests remain serial. GPU admission/capacity, concurrent scheduling,
node checkpoint/resume and durable external-effect delivery belong to Phase 3.
MasterFlow S3 receipt workflows and live-backend verification belong to Phase 4;
generic HTTP file transport does not establish artifact-protocol integration.
Specs are fetched once per worker invocation and pinned in memory, matching the
legacy Flow lifetime; the server still returns no immutable assignment snapshot.

Process stdout/stderr and in-memory HTTP responses have a 16 MiB per-stream/body
guard and fail rather than silently truncate; use `response_file` for large HTTP
responses. HTTP timeout is a total request/redirect/body deadline in Bun, stricter
than urllib's socket-operation timeout. Relative create_dir/write_json paths use
process cwd, preserving Python's behavior; inspection/HTTP/condition paths instead
use `session.working_dir`. Prefer explicit absolute session-path templates.
Exact Python float lexical formatting is not portable after JSON normalization;
use CEL `string(...)` when argv text formatting matters. JSON boolean/null/list/map
argv spellings retain the legacy representation.

MasterFlow uses YAML 1.2 in its editor while Python preserves YAML 1.1 values:
quote ambiguous scalars such as `on`, `yes`, dates or leading-zero strings when
their textual value matters. No backend schema/API or editor change is made here.
Full Python runtime parity, Windows process-tree cleanup, Kaggle and production
deployment are not claimed.

## Validation

- `bun run typecheck` and `bun test`: parser/profile limits, parameter/context
  isolation, every action/condition, dependencies, failures/skip/finally, routines,
  hooks, HTTP errors/redirects/streaming/timeouts, cancellation, and CLI → mock HTTP
  → real CPU subprocess → Spec-defined reporting.
- Read-only Python reference suites: `test_expressions.py` (8), `test_events.py`
  (7), `test_routines.py` (6), run with existing venv and `PYTHONPATH=src`.
- Direct differential execution of the two offline reference fixtures: five event
  JSON outputs and two routine JSON outputs match Python after normalizing only
  the temporary working directory. No model/GPU workload is involved.
- Shared CEL fixture parity verified with `cmp` against MasterFlow and Python.

Only `mu-cli` is modified. No backend deployment, live Request mutation, model
download, commit/push or parent submodule gitlink update is performed.
