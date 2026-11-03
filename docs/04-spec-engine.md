# 04 — Shared Spec and Engine

## Package responsibilities

`@mu/spec` provides a **single canonical** parser, schema, validator, normalizer and TypeScript types for Spec YAML. It must not read the network or spawn processes.

`@mu/engine` provides execution semantics: dependency graph, node eligibility, conditions, action dispatch, events, context and state transitions. Its dependencies are injected interfaces, not concrete Bun/Convex APIs.

## Conceptual interfaces (illustrative; not frozen API)

```ts
interface EnginePorts {
  actions: ActionExecutor;
  state: ExecutionStateStore;
  clock: Clock;
  logger: Logger;
}

interface ActionExecutor {
  execute(action: ActionDefinition, context: ActionContext): Promise<ActionResult>;
}

interface ExecutionStateStore {
  load(requestId: string): Promise<ExecutionSnapshot>;
  save(requestId: string, patch: ExecutionPatch): Promise<void>;
}
```

## Action registry

Handlers own only their action implementation. Proposed initial actions to preserve if present in existing Python engine:

- `execute_command`: subprocess command, stdout/stderr/exit handling.
- `send_http_request`: HTTP method/headers/body, timeout and response persistence.
- `execute_workload`: resolve and launch a named workload.

Support existing reusable defined actions and action-level options only after verifying their actual syntax. Do not invent new YAML fields during migration.

## Conditions and events

Preserve existing logical operators (`and`, `or`, `not`) and leaf checks (`file-exists`, `node_status`) where implemented. Event hooks (`on: execute_node`, `on: action`) must be audited for actual implementation status before porting; proposals are not automatically existing behavior.

## Execution context

Scope variables explicitly; distinguish immutable request input, ephemeral action/node state, persisted request variables and artifacts. Existing precedence (Creation Space → Session → Request → pipeline/action context) must be documented with concrete examples and verified before implementation.

## Shared does not mean universally executable

MasterFlow may parse/validate or simulate safely; Mu Agent may inspect Specs to create Requests. Only the Worker receives process execution capabilities. Backend permissions remain enforced independently of package imports.

## Versioning

Every saved Spec should have an identifiable schema version and ideally a stable content hash/snapshot. Do not reinterpret in-progress Requests using a newer schema silently.
