# MU CLI documentation

This repository owns the Bun/TypeScript CLI, worker, Spec execution, local
scheduler and recovery. Python parity is not assumed.

## Current implementation

- [CLI and configuration](guides/cli.md)
- [Architecture and module ownership](architecture/overview.md)
- [Worker lifecycle and reporting](architecture/worker.md)
- [Spec engine and supported syntax](reference/spec-engine.md)
- [Scheduler and recovery](architecture/scheduler-runtime.md)
- [Server protocol and artifact integration](reference/protocol.md)
- [CPU artifact example](../examples/cpu-artifacts/README.md)

## Directory organization

`architecture/` describes implemented structure/lifecycle; `guides/` contains CLI
usage; `reference/` contains execution/protocol details; `decisions/` separates
settled choices from open questions. Delivery records live in `tasks/completed/`;
the old roadmap is retained in `tasks/superseded/`, not a pending-work queue.
There is no newly assigned active implementation task in this documentation change.

## Delivery records and proposals

| Document | Status and use |
| --- | --- |
| [Phase 1](tasks/completed/phase-1.md) | Completed foundation; historical serial fake-mode behavior |
| [Phase 2](tasks/completed/phase-2.md) | Completed CPU Spec engine; serial/GPU restrictions superseded by Phase 3 |
| [Phase 3](tasks/completed/phase-3.md) | Completed scheduler and guarded resume; GPU verification uses simulation |
| [Phase 4](tasks/completed/phase-4.md) | Completed CPU artifact integration; live GPU/production not verified |
| [Original migration roadmap](tasks/superseded/migration-roadmap.md) | Historical proposal; its phase numbering differs from delivery records |
| [Decisions and remaining questions](decisions/runtime-decisions.md) | Current decisions separated from open proposals |

Delivery records are implementation history, not pending assignments. Historical
commands and limitations apply to their stated phase. Old TODOs do not authorize
work; verify current source before changing behavior. No completion date is inferred.

## Related repositories

- [MasterFlow documentation](https://github.com/khanhtranrk/mu-masterflow/blob/master/docs/README.md): canonical server contracts.
- [Python Spec reference](https://github.com/khanhtranrk/mu-cli-legacy/blob/master/docs/spec-format/README.md): migration comparison, including Python-only commands/actions.
- [Workspace documentation](https://github.com/khanhtranrk/mu/blob/master/docs/README.md): cross-project integration and history.

CEL conformance vectors are synchronized in all three implementations. Shared
packages and replacing MasterFlow validation remain proposals, not installed packages.

- [Built-in reporting and artifact actions](reference/reporting-actions.md) — parameters, results, events and integrity/retry semantics.
