# Agent instructions — MU workspace

## Scope and purpose

This is the parent workspace, not the implementation repository. MU consists of two independent Git submodules:

- `mu-cli/`: Python CLI worker, YAML/JSON spec interpretation, execution, scheduling and master-flow integration. Its executable remains `mu`.
- `mu-masterflow/`: React/Tauri desktop, Convex database and HTTP API, requests, units, notifications, artifact management and spec editing.

Read this file first, then the relevant submodule's README and agent instructions. In particular, `mu-masterflow/AGENT.md` (singular) is its existing agent guide. Consult `mu-cli/docs/spec-format/README.md` for current CLI spec behavior.

## Choose the owner of each change

- Runtime, scheduler, worker, action/condition execution, CLI: `mu-cli/`.
- Desktop UI, Convex schemas/functions, HTTP hooks and server behavior: `mu-masterflow/`.
- Shared architecture, integration notes and cross-repository coordination: parent `docs/`.
- If a change touches the worker/server contract or YAML spec, inspect both repositories and update implementation and relevant docs on both sides as needed. Do not assume they are automatically synchronized.

## Git and submodule discipline

1. Check `git status` in the parent and affected submodules before editing. Do not overwrite unrelated or uncommitted work.
2. Work in the relevant submodule(s); do not copy their source into the parent. Each submodule has independent history, branches and commits.
3. Validate with the smallest relevant checks documented by each project. Avoid running expensive GPU/model downloads as routine tests.
4. Commit and push submodule changes first. Then update and commit the submodule gitlink pointers in the parent so others can reproduce the integration.
5. Do not silently move submodule pointers to unrelated latest commits or change their remote URLs.
6. When reporting work, state the modified repositories, tests run, and whether the parent gitlinks were updated.

## Documentation ownership

The submodules own their detailed API, CLI, database and UI documentation. The parent `docs/` holds only cross-project architecture, integration decisions and pointers. Link to canonical documents instead of duplicating them. If code and documentation disagree, inspect actual code and report the mismatch; do not invent behavior.

## Development commands

Run Python/uv commands inside `mu-cli/` and Bun/Convex/Tauri commands inside `mu-masterflow/`. The workspace root intentionally has no combined build or test command.


## Current integration contracts

- The five-phase Creation Spaces roadmap and the subsequent dev-only Artifact
  cleanup are recorded in [docs/creation-spaces-upgrade.md](docs/creation-spaces-upgrade.md).
- Current Artifact/Storage/Product behavior is canonical in
  [MasterFlow Artifact ownership](mu-masterflow/docs/artifact-ownership.md),
  [storage protocol](mu-masterflow/docs/request-artifacts.md), and
  [Products/Trash](mu-masterflow/docs/products-trash.md). There is one canonical
  Artifact table; do not bring back removed legacy adapters/backfills.
- The CEL engine/worker contract is canonical in
  [CLI CEL Specs](mu-cli/docs/spec-format/11-cel.md) and
  [MasterFlow CEL integration](mu-masterflow/docs/spec-cel.md). Both submodules
  carry an identical CEL conformance fixture; update and validate both together.
- The prior development reset is historical authorization, not blanket permission
  for later resets. Verify the target and current user scope before deleting data.
