# Mu CLI — Bun/TypeScript Worker

Mu CLI is the active **Bun + TypeScript** worker and execution runtime for the [MU workspace](https://github.com/khanhtranrk/mu). It claims authorized Requests from Mu Data Center (MasterFlow), evaluates Specs, schedules local CPU/GPU-capable workloads, reports lifecycle progress and typed results automatically, and handles Spec-defined artifact transfers.

> **Implementation status:** Phase 1–4 delivery records cover the CLI foundation, Spec engine, scheduler/recovery, and CPU artifact integration. GPU placement has been simulation-tested; live GPU operation and production deployment are **not** verified. This is a migration from [mu-cli-legacy](https://github.com/khanhtranrk/mu-cli-legacy), not a claim of full Python feature parity.

## Quick start

Requires [Bun](https://bun.sh/). Run commands from this repository.

```bash
bun install
bun run typecheck
bun test
bun src/index.ts config init
bun src/index.ts worker doctor --config ./mu.yaml --spec your-spec
MU_WORKER_TOKEN='YOUR_TOKEN' bun src/index.ts worker once --config ./mu.yaml
```

The installed command is `mu`; the source entry point is `src/index.ts`. Configure the server URL, unit ID, allowed Spec slugs and device capacity in `mu.yaml`; supply the worker token through `MU_WORKER_TOKEN`, **not** the YAML file. See the [CLI/configuration guide](docs/guides/cli.md) for the exact flags and examples.

To retain local cache/output files across Spec edits, opt into a stable run
directory with `--run-directory-scope spec`; add `--run-directory-name music-production`
to choose its name. The default remains the existing YAML-versioned directory.
See [scope, names and recovery](docs/guides/cli.md#run-directory-scope-and-shared-names).

Common commands:

```text
mu config init|show
mu worker doctor|info|once|start
mu version
mu help
```

Run a workload module locally without server credentials:

```bash
mu workload exec ./examples/workload-exec/echo.yaml --with message=hello --json
```

See [standalone workload execution](docs/guides/cli.md#standalone-workload-execution)
for module format, typed bindings, preparation, paths and exit codes.
There is no public local `mu run <spec>` mode for complete pipelines. `worker once` processes a claimed batch; `worker start` continues polling. `--fake` simulates execution but still claims real server Requests.

## Architecture

| Area | Responsibility |
| --- | --- |
| `src/index.ts`, `src/config.ts` | CLI, configuration, startup and shutdown |
| `src/worker.ts`, `src/api.ts` | Server communication, heartbeat and claim loop |
| `src/spec/` | Spec types, parsing, validation and CEL expressions |
| `src/engine/` | Actions, conditions, events, DAG execution and checkpoints |
| `src/runtime/` | Process, filesystem, HTTP and device adapters |
| `src/scheduler/` | Local capacity admission and scheduling |
| `src/state.ts`, `src/artifacts.ts` | Recovery state and artifact transfer helpers |

MasterFlow owns authoritative server-side records, authentication, Request assignment and signed artifact URLs. This repository owns worker-side execution. Shared `@mu/spec` / `@mu/engine` packages are **proposals**, not installed dependencies.

## Documentation

Start with the [documentation index](docs/README.md), which distinguishes current behavior from historical delivery notes and proposals.

**Current implementation**

- [CLI commands and configuration](docs/guides/cli.md)
- [Architecture and repository boundaries](docs/architecture/overview.md)
- [Worker lifecycle and reporting](docs/architecture/worker.md)
- [Spec engine and supported syntax](docs/reference/spec-engine.md)
- [Scheduler, devices and recovery](docs/architecture/scheduler-runtime.md)
- [Server protocol and artifact integration](docs/reference/protocol.md)
- [Built-in reporting and artifact actions](docs/reference/reporting-actions.md)
- [Native notification example](examples/notification/README.md)
- [CPU artifact example](examples/cpu-artifacts/README.md)

**Decisions and delivery history**

- [Runtime decisions and open questions](docs/decisions/runtime-decisions.md)
- [Completed Phase 1](docs/tasks/completed/phase-1.md) · [Phase 2](docs/tasks/completed/phase-2.md) · [Phase 3](docs/tasks/completed/phase-3.md) · [Phase 4](docs/tasks/completed/phase-4.md)
- [Superseded migration roadmap](docs/tasks/superseded/migration-roadmap.md) — historical reference, **not** a current task list
- [Creation Spaces integration history](docs/creation-spaces-upgrade.md) · [Storage migration notes](docs/storage-migration.md)

The former numbered flat document layout has been reorganized under `docs/architecture/`, `docs/guides/`, `docs/reference/`, `docs/decisions/` and `docs/tasks/`. Refer to the index for canonical locations.

## Development

```bash
bun run typecheck
bun test
bun run test:integration
```

Integration tests may require additional local services or fixtures; inspect the relevant test setup before running them. Avoid downloading models or launching costly GPU jobs as routine checks.

Read [AGENTS.md](AGENTS.md) for repository-specific guidance and [the contribution workflow](docs/CONTRIBUTING-WORKFLOW.md) before making changes. Use a topic branch and PR against `master`.

## Related projects

- [MU workspace](https://github.com/khanhtranrk/mu) — cross-repository integration and submodule pins
- [Mu MasterFlow](https://github.com/khanhtranrk/mu-masterflow) — Data Center, APIs and UI
- [Mu Agent](https://github.com/khanhtranrk/mu-agent) — separate agent/workflow project
- [Mu CLI Legacy](https://github.com/khanhtranrk/mu-cli-legacy) — read-only Python migration reference
