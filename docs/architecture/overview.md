# 02 — Architecture and repository ownership

## Checked-in implementation

This repository is independently versioned inside the MU workspace. The current
implementation uses internal modules, not published `@mu/spec`/`@mu/engine` packages.

| Module | Responsibility |
| --- | --- |
| `src/index.ts`, `src/config.ts` | CLI, configuration, workspace lock and signals |
| `src/worker.ts`, `src/api.ts` | Bootstrap, heartbeat, claim loop and authenticated API transport |
| `src/spec/` | Types, parsing, validation and bounded CEL rendering |
| `src/engine/` | Context, actions, conditions, events, DAG lifecycle and checkpoints |
| `src/runtime/` | Concrete process/filesystem/HTTP effects, devices and executor adapters |
| `src/scheduler/` | Shared local resource admission |
| `src/state.ts`, `src/artifacts.ts` | Durable worker state and artifact handshake helpers |

The engine receives injected effects. Spec parsing has no process execution or
network authority. The worker connects engine semantics to Bun infrastructure.
MasterFlow currently retains its own Spec validation; it does not import a shared
package from this checkout. See [Phase 2 boundaries](../tasks/completed/phase-2.md#implementation-and-boundaries).

## Repository boundaries

- MU workspace: integration history, documentation map and cross-project decisions.
- MU CLI: worker execution and local recovery.
- MasterFlow: authoritative Spec YAML storage, Request assignment, server auth,
  durable records, signed URLs and management UI.
- Legacy CLI: Python compatibility reference; no assumed feature parity.
- Mu Agent: separate Mastra starter with proposed creative workflows; Mu backend
  integration is not yet implemented. See its [current implementation](https://github.com/khanhtranrk/mu-agent/blob/master/docs/architecture/current-implementation.md).

## Proposed shared-package direction

The original architecture proposed `@mu/spec` for canonical schema/parser/types,
`@mu/engine` for capability-injected execution semantics, and optionally
`@mu/runtime` for scheduling adapters. Publishing, versioning and consumer migration
are still open. No `packages/` tree in the umbrella repository is required by this
proposal, and no source copying between repositories is intended. Versioned internal
packages or separate Spec/engine repositories remain alternatives; Bun workspaces
across nested Git submodules require deliberate linking.

If adopted, UI/agent consumers would receive parsing or safe simulation capabilities;
only workers would receive process effects. Package imports never replace server
authorization. This proposal is reference material, not an assigned refactor.

## Design rationale to retain

Group code by responsibility, keep interfaces at actual boundaries, and prefer
pure parsing/validation/admission functions. Keep domain modules independent of
worker infrastructure, avoid global mutable registries and circular dependencies,
and avoid adding unused plugin abstractions. The proposed dependency direction
remains CLI → worker → engine → Spec, with concrete effects injected at runtime.
MasterFlow/agent package consumption is a future proposal, not an existing import.

See [decisions](../decisions/runtime-decisions.md), [original roadmap](../tasks/superseded/migration-roadmap.md) and
[the workspace map](https://github.com/khanhtranrk/mu/blob/master/docs/README.md).
