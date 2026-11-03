---
status: completed
---

# Phase 3 — Local scheduler and node recovery

Phase 3 of the user's four-phase plan. Subsequent artifact receipts and real-backend
integration are documented in [Phase 4](phase-4.md). MasterFlow and the Python reference are unchanged.

## Configure and run

```yaml
server:
  url: http://127.0.0.1:3211
worker:
  unitId: gpu-01
  specs: [my-spec]
  maxClaim: 4
runtime:
  workspace: .mu
  concurrency: 8
  shutdownTimeout: 30
  devices:
    - family: cuda
      index: 0
      maxUnits: 4
```

```sh
MU_WORKER_TOKEN='YOUR_TOKEN' bun src/index.ts worker once --config mu.yaml
MU_WORKER_TOKEN='YOUR_TOKEN' bun src/index.ts worker start --config mu.yaml
bun src/index.ts worker info --config mu.yaml --json
```

CLI overrides: repeatable `--device cuda,0,4` (also `rocm`; `nvidia` is a CLI
alias for `cuda`), `--concurrency 8`, `--shutdown-timeout 30`. Concurrency must be
an integer from 1 to 32. Device indices are nonnegative integers, maxUnits finite
and positive; duplicate family/index pairs are rejected. Capacity is configured
admission accounting, not a measurement of actual process VRAM consumption.

When devices are omitted, the CLI probes NVIDIA with `nvidia-smi`, then AMD with
`rocm-smi` if NVIDIA yields no devices. Probes have finite timeouts, do not install
tools and do not execute model workloads. Capacity follows Python's ceil(VRAM /
4 GiB) heuristic. `runtime.devices: []` explicitly selects CPU-only placement and
disables probes. Heartbeats send CPU and GPU family/index metadata accepted by the
existing server; info/doctor additionally expose local capacity and concurrency.

## Admission and execution

- One scheduler per SpecExecutor covers **all requests and Specs** in that worker.
  Eligible nodes enter a stable queue; request dependency tables, params, node
  contexts and saved actions remain isolated. Shared pipeline preparation is
  serialized once per pipeline, including concurrent requests.
- All nodes consume one of the configured execution slots. CPU nodes require zero
  GPU units and may run while GPU nodes are active or queued. This slot limit is
  the CPU concurrency control; there is no invented CPU workload-unit syntax.
- Node GPU demand is the **maximum** workload units in before_run/run/after_run,
  including conditional calls. Best-fit selects the GPU with the smallest remaining
  free capacity after allocation, with declaration-order tie breaking.
- If a GPU has sufficient total capacity but is busy, the node waits; CPU work
  can pass the blocked queue entry. If **no GPU has sufficient total capacity**,
  Python's existing CPU fallback is preserved and logged. A zero-unit workload
  inside a GPU-placed node still gets no schedule/device_args.
- Reservations cover context/conditions, all actions, finally, terminal hooks and
  durable completion checkpointing. Failure, abort and checkpoint errors release
  resources. Devices are keyed by both family and index, avoiding collisions
  between cuda:0 and rocm:0.
- Node placement uses `{family: cuda|rocm, index: "0"}` or CPU `{family: cpu,
  index: null}`. GPU workload `device_args` and env receive schedule family/index;
  argv target/base args retain the legacy rendering order before schedule injection.
  No shell, GPU libraries, model install or distributed scheduler is introduced.
- Dependency success is published only after durable checkpoint completion.
  Failure blocks dependents; node ignore_error retains its existing semantics.
  Conditions/node_status see request-local terminal states as in Python.
- SIGINT/SIGTERM stops admission, cancels active subprocess groups, drains running
  tasks, attempts finally and finalization within the configured cleanup budgets,
  persists progress, and returns 130. No terminal pipeline hook is fabricated for
  an interrupted/infrastructure-uncertain execution.

`--fake` remains the serial Phase 1 harness. Real GPU scheduling tests inject fake
process effects and synthetic devices, so routine verification stays CPU-only.

## Durable state and resume

Private atomic checkpoints retain the claim/assignment, exact Spec text, versioned
engine snapshot, initialized/prepared/request contexts, per-node states and saved
completed-node contexts. They are synced before side effects start and before a
node's success becomes dependency-ready. Updates for the same request are ordered.
Direct session.token fields are omitted and hydrated from current configuration;
Spec-produced saved results may still contain sensitive data. Protect the workspace.

```sh
# Resume only work already recorded locally; once does not claim a new batch.
MU_WORKER_TOKEN='YOUR_TOKEN' bun src/index.ts worker once --config mu.yaml --resume

# Explicitly allow rerunning failed/in-flight nodes in an unfinished pipeline.
# Their commands, HTTP actions, hooks or other external effects may repeat.
MU_WORKER_TOKEN='YOUR_TOKEN' bun src/index.ts worker once --config mu.yaml --resume --retry-incomplete
```

`start --resume` drains recovered work, then returns to normal claiming. A normal
restart refuses unfinished Phase 3 snapshots and explains the resume options.
Completed snapshots and old fake-report outboxes are handled without replaying
real Spec hooks. Old Phase 2 checkpoints lacking engine state retain conservative
manual-inspection behavior; they cannot become resumable retroactively.

Before resuming, the worker checks the saved Spec filter and exact current remote
Spec text and revalidates token/assignment generation with the **existing**
`POST /api/requests/report` route, using `{id}` and X-Mu-Assignment-Version.
Inspection of the current server implementation confirms this empty patch checks
authorization/assignment without changing statuses, nodes, logs or artifacts.
Snapshot identity and graph states are checked before node execution. Initialization
and successful preparation are restored, not rerun. Successful nodes are skipped;
declared postconditions are reevaluated using saved node context (with main-phase
running status). A missing output/failed postcondition refuses continuation.
Ignored-error nodes retain their successful dependency outcome without this check.

Running states represent **unknown outcomes**, even after graceful process
cancellation: external effects may already have committed. Bare resume refuses
them. `--retry-incomplete` explicitly discards failed/running node states in an
unfinished pipeline and retries each such node from its start; successful nodes
are retained. There is no action-level retry or automatic replay of non-idempotent
operations. Completed failed pipelines use the existing owner reset workflow.

Unknown intake, preparation or pipeline-hook outcomes are **not** automatically
replayed, even with --retry-incomplete; inspect/reset those assignments. Checkpoint
I/O failure aborts further node admission and drains running work. Entry finalization
is per worker invocation and can run again after a resumed invocation; application
cleanup should tolerate that. Postcondition probes may also execute again on resume.

## Protocol limits and decisions

- Reporting remains Spec-owned. No automatic node/request status changes are added;
  the assignment guard above sends no status. Hooks must map runtime success to API
  succeeded. Runtime GPU indices are strings and CPU index is null, whereas the
  API's optional report device.index is numeric: translate or omit that field.
- The server has no assignment lease, arbitrary worker request inspection, immutable
  Spec snapshot or authoritative node-state download. Recovery uses the saved
  assignment plus the authorization guard, not fabricated server reconciliation.
  A lost claim response still requires owner intervention. No backend change is
  needed for the implemented local recovery path.
- Local checkpoint success does not guarantee external hook delivery. A crash after
  a side effect but before its terminal checkpoint remains uncertain; safe exactly-once
  external effects require receiver-side idempotency. Artifact receipt reconciliation
  and output verification beyond declared postconditions belong to Phase 4.
- Keep generated files referenced by successful nodes. There is no universal output
  declaration to verify all files automatically; file checks require appropriate
  Spec postconditions. Request context/graph isolation does not rename Spec-defined
  paths: concurrent requests must use distinct output paths as in Python.
- The workspace lock prevents concurrent CLI processes sharing a workspace. After
  SIGKILL/kernel loss, first verify the prior worker and subprocesses are stopped,
  then remove its stale worker.lock before resume. This is not a multi-host lease;
  do not run the same unit simultaneously with independent local workspaces.
- CUDA/ROCm hardware execution, Windows process-tree cleanup, Kaggle and production
  behavior are not established by CPU simulation. No GPU model workload is run here.

## Validation

`bun run typecheck`, `bun test`, and `git diff --check` cover the retained Phase 1/2
tests plus best-fit placement, capacity release, CPU progress under GPU contention,
shared slot limits, fractional-capacity declarations, duplicate devices, cancellation,
peak reservation through finally/hooks, request isolation and shared preparation.
GPU probes are stubbed. Recovery tests cover pinned source/identity, stale assignment,
explicit uncertain-node retry, safe boundaries, disk failure and missing postcondition
outputs. A fresh CLI subprocess is interrupted with SIGINT and resumed in a second
process over mock HTTP, proving completed work/init/prepare are not repeated and
once --resume does not claim again. Python's five CPU-only scheduler characterization
tests also pass using the existing reference venv.

Only mu-cli changes. No MasterFlow schema/API/deployment, real Request, physical
artifact bytes or legacy source is changed. No Phase 4 work or gitlink update is
performed as part of this phase.
