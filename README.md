# Mu CLI v2 — Worker-first Architecture

**Status:** Draft v0.1 — design proposal, not an assertion of current implementation.  
**Stack:** Bun + TypeScript (strict).  
**Primary objective:** Replace the Python orchestrator with a modular worker runtime that receives authorized work from Mu Data Center.

## Design principles

1. **Server-first:** production requests/specs originate from Mu Data Center. No public `mu run <spec>` mode.
2. **Single source of truth:** shared Spec parsing/validation/semantics, no duplicated Python/TypeScript validators.
3. **Separation of concerns:** CLI → Worker → Engine → Execution adapters; server handles assignment and authorization.
4. **Explicit capability boundaries:** importing the engine does not grant execution or data-access privileges.
5. **Resumability:** persist durable progress before considering work complete; ephemeral in-memory state is disposable.
6. **Minimal migration risk:** characterize Python behavior before porting, do not change YAML semantics implicitly.

## Documentation map

- [01 — CLI contract](docs/01-cli.md): commands, flags, configuration and exit codes.
- [02 — Architecture](docs/02-architecture.md): packages, dependency direction and project tree.
- [03 — Worker lifecycle](docs/03-worker.md): identity, claim, heartbeat, once/daemon and shutdown.
- [04 — Spec Engine](docs/04-spec-engine.md): validation, execution context, actions, conditions and events.
- [05 — Scheduler and runtime](docs/05-scheduler-runtime.md): device capacity, subprocess, failure and resume.
- [06 — Data Center protocol](docs/06-protocol.md): API boundary, permissions and persistence.
- [07 — Migration and testing](docs/07-migration.md): phased plan and acceptance tests.
- [08 — Open decisions](docs/08-decisions.md): unresolved design questions and explicit defaults.

## Proposed primary usage

```bash
mu config init
mu worker doctor
mu worker once --config ./mu.yaml
mu worker start --config ./mu.yaml
```

**Out of scope for v0.1:** full workload package registry, model installation, agent orchestration, new Spec syntax, automatic server-side scheduling redesign.
