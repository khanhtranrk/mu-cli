# 08 — Decisions and remaining questions

## Implemented decisions

| Topic | Current decision / evidence |
| --- | --- |
| Runtime and identity | Bun/TypeScript; one configured Unit per worker, multiple configured/discovered GPU devices; `src/config.ts` |
| Work source | Authorized server Requests; no public local run command; `src/index.ts` |
| Ephemeral mode | once drains one batch; failed batch returns 6; [CLI](../guides/cli.md) |
| Scheduling | Worker-local shared slots and best-fit GPU admission with legacy CPU fallback; [runtime](../architecture/scheduler-runtime.md) |
| Reporting | Spec-owned in real mode, automatic only in fake mode; [protocol](../reference/protocol.md) |
| Configuration | YAML + supported env + flags; [configuration](../guides/cli.md#configuration) |
| Recovery | Local exact-Spec checkpoints plus assignment guard; [Phase 3](../tasks/completed/phase-3.md) |

## Open proposals and verification gaps

- Shared Spec/engine package publishing and versioning across independently versioned repositories.
- Migrating MasterFlow validation after demonstrated parity; no shared package consumption yet.
- Immutable server Spec snapshots, lease/reclaim and arbitrary assignment inspection.
- Durable action receipt recovery/receiver idempotency beyond bounded completion retry.
- Live CUDA/ROCm, Kaggle, Windows process-tree cleanup and production verification.
- Workload package registry/model installation, outside the first port's scope.

These are questions and limits, not approved implementation tasks. CPU simulation
and a historical local smoke do not settle hardware or production readiness.

## Historical initial assignment

The original architecture requested an audit of Python and MasterFlow before
porting. The four delivery records now describe implemented work. That old
assignment and [roadmap](../tasks/superseded/migration-roadmap.md) are reference history; do not restart the
port or assume that every original acceptance goal has been satisfied.

The original non-goals remain useful scope boundaries: no unsolicited MasterFlow
UI rewrite, agent framework, TypeScript inference rewrite, YAML/status redesign,
universal package manager or database refactor.
