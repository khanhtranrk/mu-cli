# Coding agent instructions — MU CLI v2

## Repository role

This is the **active Bun + TypeScript CLI/worker** repository, tracked as a submodule in [MU](https://github.com/khanhtranrk/mu). It replaces the historical Python worker in [mu-cli-legacy](https://github.com/khanhtranrk/mu-cli-legacy). The legacy repository is a compatibility reference, not the default target for new features.

**Migration is in progress.** The [documentation map](docs/README.md) separates current implementation, completed delivery records and proposals; verify the current code before claiming a command, action, scheduler behavior or API is implemented. Do not assume feature parity with Python.

## Work ownership

- CLI commands, worker lifecycle, Spec parsing and validation, scheduler, execution actions and subprocess adapters belong here.
- Convex schemas, server HTTP endpoints, dashboard and Tauri/React UI belong in [mu-masterflow](https://github.com/khanhtranrk/mu-masterflow).
- Cross-repository decisions and integration documentation belong in the [MU workspace](https://github.com/khanhtranrk/mu).
- Read the [migration plan](docs/tasks/superseded/migration-roadmap.md), [architecture](docs/architecture/overview.md), [Spec Engine](docs/reference/spec-engine.md) and [protocol](docs/reference/protocol.md) before changing related behavior.

## Git and development safeguards

- Keep `master` as integration base. Use topic branches and reviewed PRs per [contribution workflow](docs/CONTRIBUTING-WORKFLOW.md); do not assume `main`.
- Keep changes small and scoped. Do not rewrite the runtime or database speculatively.
- Use Bun/TypeScript; Python may be invoked for specific workloads, not as a duplicate orchestration layer.
- Preserve documented worker/server, CEL/Spec, scheduling and artifact semantics unless explicitly approved. Inspect the legacy implementation to characterize behavior before porting.
- Avoid expensive GPU, model-download and network workflows as routine tests. Prefer focused CPU-only checks.
- Do not commit secrets, local environments, generated artifacts or downloaded models.
- For cross-repository work, merge reviewed submodule PRs first, then propose parent gitlink updates in a separate integration PR.

## Basic validation

Inspect `package.json` for available scripts before running them. For a lightweight type check, use `bunx tsc --noEmit` after dependencies are installed. Do not treat a passing type check as evidence of complete worker functionality.
