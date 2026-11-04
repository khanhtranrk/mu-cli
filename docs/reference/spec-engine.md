# 04 — Spec engine

Current implementation is in `src/spec/` and `src/engine/`. The detailed semantics
and Python comparisons are recorded in [Phase 2](../tasks/completed/phase-2.md#implemented-semantics),
with later [scheduling/recovery](../tasks/completed/phase-3.md) and [artifact integration](../tasks/completed/phase-4.md).

## Supported surface

- YAML/JSON parsing and declaration/DAG validation; pinned YAML 1.1 scalar behavior.
- CEL is the only expression engine, including omitted declarations. Whole-value
  expressions preserve JSON types; supplied payloads are literal, not rerendered.
- Shared typed Input Fields, explicit Workload invocation context, defaults and isolated contexts.
- Actions: `execute_command`, `execute_workload`, `execute_routine`, `create_dir`,
  `write_json`, `inspect_file`, `send_http_request`, `report_request`, `report_node`,
  `upload_artifact`, `download_artifact`. See [parameters and results](reporting-actions.md).
- Conditions: `and`, `or`, `cel`, `file_exists`, `folder_exists`, `path_exists`,
  `exit_code`, `action_state`, `node_state`, `node_status`. There is no `not` operator.
- Events: `pipeline_started`, `pipeline_finished`, `node_started`, `node_finished`.
  Hook failures warn without changing execution outcomes; workload placement is restricted.

Entry initialization/finalization and lazy pipeline preparation are distinct from
Request execution. Successful preparation is shared per Flow/pipeline; Request,
node, routine and hook contexts are isolated. Captured uppercase Registry roots
are immutable; lowercase `session` is worker runtime context.

Node order is context → skip/precondition → before/run/after → postcondition →
finally, followed by terminal event handling. Dependency failure blocks dependent
execution. Runtime states are `running`, `success`, `failed`; server status mapping
belongs to Spec reporting hooks. See Phase 2 for skip, ignore_error and cleanup nuances.

## Effects and reporting

The parser cannot launch processes. Engine effects are injected through
`src/engine/ports.ts`; Bun adapters own actual processes, files and HTTP.
Commands use argv without an implicit shell. Reporting, notification and artifact
operations remain Spec-defined actions; importing the engine grants no server authority.

## Compatibility and remaining design

The shared 63-case CEL fixture is byte-identical across active CLI, legacy CLI and
MasterFlow. This proves fixture consistency, not full runtime parity. The
[Python format guide](https://github.com/khanhtranrk/mu-cli-legacy/blob/master/docs/spec-format/README.md)
remains a migration reference; Python CLI forms and extra legacy actions do not
become TypeScript features by being documented there.

Publishing shared packages and replacing MasterFlow validation remain proposals.
Server Specs are mutable; local recovery pins exact text and rejects changed source,
without claiming immutable server-side snapshots. See [architecture](../architecture/overview.md).

## Shared Input Fields

Pipeline, Node, Workload and Routine `inputs` use the same Field declaration:

```yaml
inputs:
  message:
    type: string
    value: "${{ request.requestId }}"
    default: hello
```

`type` is required: `string`, `number`, `boolean`, `array`, `object`, or
`artifact`. Fields allow only `type`, optional `value`, and optional `default`.
Values are bounded JSON and are validated after resolution without coercion.
`artifact` currently validates an opaque JSON object; identity, required metadata,
and the Workload Output protocol are not defined by this input contract.

Resolution precedence is an explicitly supplied caller value, then a Spec-owned
`value`, then a Spec-owned `default`. A Field with none of these is required and
fails resolution. Defaults apply only when the Field has no supplied value or
`value` declaration. A missing property accessed by a CEL expression is an error,
not a fallback trigger; use `has(...)` and a conditional to select a fallback.
Explicit null is present, never replaced by a default, and fails all six Field
types. Nested nulls inside arrays/objects remain JSON null. Nullable Fields are
not supported; a future nullable contract needs a separate decision.

Supplied Request JSON remains literal, including nested strings that look like
CEL. Routine `args` render once at the caller and then remain literal. Only
Spec-owned Field `value`/`default` declarations are evaluated by the resolver.
Fields resolve independently against the owning context, not sequentially against
other Fields in the same declaration.

- Pipeline Fields accept Request payload overrides. Resolved values are available
  as `inputs` and `pipeline.inputs` in Request execution, after pipeline context
  evaluation and intake validation. Shared preparation remains Request-independent.
- Node Fields resolve after Node context and before conditions/actions, with access
  to Pipeline inputs and runtime namespaces. Values are available as `node.inputs`;
  top-level `inputs` continues to refer to Pipeline inputs in Node actions.
- Routine Fields accept the existing rendered `execute_routine.args` overrides.
  Routine actions/returns use a private top-level `inputs` object.
- Workload Fields have no implicit caller overrides. They explicitly select values
  from `with` or runtime namespaces through their declarations.

## Workload invocation context and process arguments

```yaml
workloads:
  generate:
    inputs:
      message:
        type: string
        value: "${{ with.upper ? with.message + '!' : with.message }}"
    target: bun
    argv: [-e, 'console.log(process.argv[1])', "${{ inputs.message }}"]
pipeline:
  demo:
    inputs:
      message: {type: string}
    nodes:
      - name: generate
        inputs:
          message: {type: string, value: "${{ pipeline.inputs.message }}"}
        run:
          - type: execute_workload
            workload: generate
            with:
              message: "${{ node.inputs.message }}"
              upper: true
              unused: 123
```

`execute_workload.with` is rendered once in the caller's context and must resolve
to an object. That object is bound as `with` only during Workload Field resolution.
A same-named key never supplies an Input automatically: a Field with only `type`
still fails even if `with` contains that name. Extra keys are allowed in `with`
and remain unconsumed unless a Field explicitly selects them.

During Workload Field resolution, top-level `inputs` starts empty; caller Pipeline
inputs remain accessible through `pipeline.inputs`, Node inputs through
`node.inputs`. After resolution, `inputs` contains only the declared Workload
values. `target`, `argv` and `env` render using those inputs, with no invocation
`with` binding. Device allocation and `device_args` behavior are unchanged.
Workload-local values are isolated from caller actions and sibling executions.

Migration is intentional: declaration `params` is rejected with a field path;
rename it to `inputs`. Replace Workload process `args` with `argv`, invocation
`execute_workload.args` with `with`, and add explicit Field `value` expressions
such as `${{ with.message }}`. Command `args`, Routine invocation `args`, and
`device_args` retain their existing meanings. The shared CEL conformance fixture
keeps its historical variable names to preserve byte-identical engine coverage.

MasterFlow currently retains a separate `params`-based editor/Request validator;
this CLI issue does not migrate that UI, saved Specs, or Convex schema. Coordinate
the companion migration before using these Specs through its Request editor.
See the [CPU example](../../examples/cpu-artifacts/spec.yaml).
