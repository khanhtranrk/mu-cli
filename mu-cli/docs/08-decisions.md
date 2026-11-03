# 08 — Open Decisions and Assumptions

| Topic | Proposed default | Needs confirmation |
|---|---|---|
| Primary runtime | Bun + TypeScript | Kaggle smoke test |
| Worker process identity | One CLI process = one Unit | Multiple devices per Unit allowed? |
| Production Spec source | Data Center only | Local debug fixture runner internal |
| Ephemeral mode | `worker once` processes one batch | Exit code on partial failure |
| Shared package split | `@mu/spec` and `@mu/engine` | Repo/workspace publishing strategy |
| Scheduler location | Local worker node scheduler | Exact resource/priority policy |
| API ownership | Server controls claim/auth; worker reports | `update` vs `report` semantics |
| Workload dependencies | External subprocess initially | Registry manifest later |
| Configuration | YAML + env + CLI | Config discovery paths |
| Spec schema versions | Explicit and immutable per request | Migration strategy for old Specs |

## Non-goals for first port

- Rewriting Mu MasterFlow UI.
- Introducing a general agent framework.
- Replacing Python inference libraries with TypeScript.
- Redesigning existing Spec YAML and status enums.
- Building a universal workload package manager.
- Refactoring the entire database.

## First agent assignment

> Audit the current Python Mu CLI and TypeScript Mu MasterFlow implementations. Compare actual behavior with this draft. Produce a discrepancy report and a migration plan. Do not implement the port until the architecture and compatibility matrix are reviewed.
