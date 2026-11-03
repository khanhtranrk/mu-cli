# 02 — Architecture and Repository Structure

## Ownership boundaries

| Component | Owns | Must not own |
|---|---|---|
| Mu Data Center | Request assignment, durable records, authorization, signed artifact URLs | Local GPU process execution |
| Mu CLI Worker | Worker lifecycle, claim loop, heartbeats, reporting, execution adapters | Authoritative Spec schema |
| `@mu/spec` | Spec types, parser, validator, normalization | Network, process spawning |
| `@mu/engine` | Pipeline/node semantics, conditions, events, action dispatch | Bun/Convex specifics |
| `@mu/runtime` (optional) | Scheduler and resource/process adapters | Server authorization |
| Mu MasterFlow | Owner UI and administration | Duplicated Spec validator or worker engine fork |
| Mu Agent | Read authorized resources and create requests | Worker execution or privileged management |

## Suggested logical workspace

```text
mu/                             # umbrella workspace / coordination repo
├── docs/
│   ├── architecture.md
│   └── decisions/
├── packages/
│   ├── spec/                  # @mu/spec
│   │   ├── src/schema/
│   │   ├── src/parser/
│   │   ├── src/validation/
│   │   └── src/index.ts
│   └── engine/                # @mu/engine
│       ├── src/pipeline/
│       ├── src/node/
│       ├── src/actions/
│       ├── src/conditions/
│       ├── src/events/
│       ├── src/context/
│       └── src/index.ts
├── mu-cli/                    # may remain a Git submodule
│   ├── src/
│   │   ├── cli/
│   │   ├── worker/
│   │   ├── scheduler/
│   │   ├── infrastructure/
│   │   │   ├── api/
│   │   │   ├── process/
│   │   │   ├── filesystem/
│   │   │   └── devices/
│   │   ├── config/
│   │   └── main.ts
│   ├── tests/
│   └── package.json
├── mu-masterflow/             # existing Git submodule
└── mu-agent/                  # future/optional repo
```

**Repository note:** This is a logical architecture, not a demand to immediately change Git submodule layout. Bun workspaces across nested Git submodules need deliberate package linking; a versioned internal package or separate `mu-spec`/`mu-engine` repositories are alternatives. Avoid duplicated source copies.

## Dependency direction

```text
mu-cli CLI ──> Worker ──> @mu/engine ──> @mu/spec
                  │             │
                  ├─ API client  └─ injected ports
                  ├─ Scheduler ──> process/device adapters
                  └─ state/reporting adapters

mu-masterflow ──> @mu/spec (and engine for safe simulation only)
mu-agent      ──> @mu/spec (no execution privileges)
```

Domain packages must not import worker code or infrastructure implementations. Explicit capability injection prevents UI/agent from acquiring execution authority by importing a package.

## Module conventions

- Group by feature/ownership, not one giant `utils.ts`.
- Public exports via `index.ts`; keep internals private.
- Small interfaces only at actual dependency boundaries (`StateStore`, `ActionExecutor`, `ProcessRunner`, `DataCenterClient`).
- Pure functions for parsing, validation, dependency eligibility and condition evaluation where possible.
- No god classes, global mutable registries, or hidden singleton state.
- Define dependency rules and test them to prevent circular imports.
- Avoid building unused generic plugin frameworks.
