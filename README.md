# Mu CLI v2 — Worker-first Architecture

**Status:** Phase 4 validates the real MasterFlow request/artifact lifecycle with CPU workloads, signed S3 transfers and Spec-owned reporting. See [Phase 4 integration and limits](docs/tasks/completed/phase-4.md), [Phase 3 scheduler and recovery](docs/tasks/completed/phase-3.md) and [Spec engine compatibility](docs/tasks/completed/phase-2.md). GPU placement remains CPU-simulation tested; no production deployment is implied.
**Stack:** Bun + TypeScript (strict).  
**Primary objective:** Replace the Python orchestrator with a modular worker runtime that receives authorized work from Mu Data Center.

This is the **active CLI development repository** and a Git submodule of the [MU workspace](https://github.com/khanhtranrk/mu). The previous Python runtime is preserved separately in [mu-cli-legacy](https://github.com/khanhtranrk/mu-cli-legacy) for compatibility and migration reference.

For coding agents, read [AGENTS.md](AGENTS.md) and the [migration plan](docs/tasks/superseded/migration-roadmap.md) before editing.

## Design principles

1. **Server-first:** production requests/specs originate from Mu Data Center. No public `mu run <spec>` mode.
2. **Single source of truth:** shared Spec parsing/validation/semantics, no duplicated Python/TypeScript validators.
3. **Separation of concerns:** CLI → Worker → Engine → Execution adapters; server handles assignment and authorization.
4. **Explicit capability boundaries:** importing the engine does not grant execution or data-access privileges.
5. **Resumability:** persist durable progress before considering work complete; ephemeral in-memory state is disposable.
6. **Minimal migration risk:** characterize Python behavior before porting, do not change YAML semantics implicitly.

## Documentation map

The [documentation index](docs/README.md) distinguishes current references, completed
delivery records and the original migration proposal.

- [01 — CLI contract](docs/guides/cli.md): commands, flags, configuration and exit codes.
- [02 — Architecture](docs/architecture/overview.md): current modules, repository boundaries and proposed shared packages.
- [03 — Worker lifecycle](docs/architecture/worker.md): identity, claim, heartbeat, once/daemon and shutdown.
- [04 — Spec Engine](docs/reference/spec-engine.md): validation, execution context, actions, conditions and events.
- [05 — Scheduler and runtime](docs/architecture/scheduler-runtime.md): device capacity, subprocess, failure and resume.
- [06 — Data Center protocol](docs/reference/protocol.md): API boundary, permissions and persistence.
- [07 — Original migration roadmap](docs/tasks/superseded/migration-roadmap.md): historical proposal and acceptance goals, superseded by delivery records.
- [08 — Decisions](docs/decisions/runtime-decisions.md): implemented decisions and remaining proposals/verification gaps.

## Primary usage

```bash
mu config init
mu worker doctor
mu worker once --config ./mu.yaml
mu worker start --config ./mu.yaml
```

**Out of scope for v0.1:** full workload package registry, model installation, agent orchestration, new Spec syntax, automatic server-side scheduling redesign.
