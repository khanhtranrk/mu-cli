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
  `write_json`, `inspect_file`, `send_http_request`, `send_notification`, `report_request`, `report_node`,
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
belongs to automatic worker reporting. See Phase 2 for skip, ignore_error and cleanup nuances.

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
- Routine Fields explicitly select from `execute_routine.with`, like Workloads.
  Routine actions/outputs use private top-level `inputs` and `actions` objects.
- Workload Fields have no implicit caller overrides. They explicitly select values
  from `with` or runtime namespaces through their declarations.

## Node context namespace

A Node's `context` renders once against its initial execution context, including
Pipeline inputs, captured Registry values, `session`, `request`, and Node runtime
metadata. The resulting mapping is injected only into that Node's private `node`
object, before Node Input Fields and conditions resolve. Keys are accessed as
`node.<key>`; no bare root aliases are created. Fields in the same context mapping
are rendered together, not sequentially against one another.

```yaml
context:
  result_path: "${{ session.output_dir }}/result.json"
run:
  - type: execute_workload
    workload: generate
    with:
      path: "${{ node.result_path }}"
```

`name`, `status`, `inputs`, `outputs`, `actions`, `state`, `total_units`, `device`,
`skipped`, `blocked`, and `ignored_error` are reserved Node fields. Internal and
prototype keys are also forbidden. Literal collisions fail Spec validation;
collisions in a whole-value context template fail at runtime before any values
are injected. This reservation does not implement additional runtime namespaces.
Values remain private to the owning Node and are available to its later phases
and terminal event snapshot; they do not leak to the Pipeline, sibling Nodes,
or subsequent Requests. Pipeline and Action context behavior is unchanged.

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

## Typed Outputs and result capture

Pipeline, Node, Routine and Workload `outputs` use the same Field declarations as
`inputs`. `save_to` stores an Action result at `node.actions[name]` in Node actions,
or `actions[name]` inside a Routine/lifecycle context. Routine and Workload results
contain `outputs`; command/inspect/transfer results keep their documented fields.
Routine and Workload `with` is an explicit binding context: use Field `value`
expressions such as `${{ with.path }}`; it is not automatically forwarded to argv.
Workload output expressions can explicitly read `result.returncode/stdout/stderr`;
stdout is never guessed or parsed as structured JSON. A side-effect-only Workload
needs no outputs or adapter.

Node Outputs resolve after finally and postcondition validation. Failed, skipped,
blocked or ignored-error Nodes do not publish Outputs. Dependents read resolved
values through `pipeline.nodes[name].outputs`; declare depends_on for every such
producer. Pipeline Outputs resolve after all Nodes settle successfully, then are
reported atomically with terminal status. A type/resolution error fails the Node
or Pipeline. Request Outputs are server-resolved from pipeline.outputs and
request.inputs using captured declarations.

`request.inputs` contains frozen values; `node.inputs` and `pipeline.inputs` contain
owner-scoped resolved values. Field expressions render nested objects/lists once;
strings produced by evaluation are literal, never recursively executed as CEL.
Artifact Fields require `{artifactId: canonicalId}` (optional name), never output
keys, copied storage locators or signed URLs. Upload's saved `.artifact` can feed
Node outputs and download's `artifact` parameter directly.

Breaking migration: use save_to instead of save_state; named Routine outputs
instead of returns; execute_routine.with instead of args; event-only report actions
instead of status-report hooks. No parser alias silently accepts removed syntax.

## External workload modules

Workloads may remain inline or reference a local/HTTPS YAML module. Each
external declaration contains only `source` and optional `sha256`; overrides and
nested imports are rejected. Sources are static literals, never Request/CEL values.

```yaml
workloads:
  inline:
    target: bun
    units: 0
    argv: [--version]
  external:
    source: ./workloads/echo.yaml
    # sha256: "<64 hexadecimal characters>"  # optional
pipeline:
  demo:
    prepare:
      - type: ensure_workload
        workload: external
    nodes:
      - name: echo
        run:
          - type: execute_workload
            workload: external
            with: {message: hello}
```

The referenced module is a mapping with exactly one `workload`, optional
`routines`, optional `prepare`, and optional `installation.resources`:

```yaml
routines:
  install:
    actions:
      - type: execute_command
        target: bun
        args: [--version]
prepare:
  - type: execute_routine
    routine: install
workload:
  target: bun
  units: 0
  inputs:
    message: {type: string, value: "${{ with.message }}"}
  argv: [-e, 'console.log(process.argv[1])', "${{ inputs.message }}"]
```

Module routines are private: they resolve only module-local routine references
and cannot collide with or call global routines. Preparation runs in a copied,
Request-independent context; local context/result changes do not leak to the
caller. Installation files can be shared through explicit cache paths.
`ensure_workload` is allowed only directly in `pipeline.<name>.prepare`. It runs
module preparation under an installation lock; existing inline workloads have
no module preparation and are a no-op. `execute_workload` never installs implicitly.
Successful pipeline preparation is reused within that Flow/pipeline. Preparation
failure prevents dispatch and is retained for the rest of that Flow/pipeline.
Scripts must tolerate repeats and partial installation; use versioned environments
and write readiness markers only after successful verification.

The runtime resolver loads modules before full validation and scheduling, so
resolved `units`, `device_args`, Inputs and Outputs retain the inline semantics.
Worker preflight and `worker doctor` resolve/validate without executing preparation.
The parser has no filesystem/HTTP/process effects. Library callers can supply a
`ModuleLoader` and resolve before constructing a Flow. For local Specs, pass the
Spec directory to `workloadLoader`; server-provided Specs have no implicit local
base. Configure `runtime.workloadBaseDir` explicitly for their relative sources
(relative configuration values resolve from the configuration file's directory).
Absolute local source paths do not require a base.

HTTPS loads omit credentials and worker headers, allow at most five redirects
(HTTPS only), and time out after 30 seconds per module. Sources must be at most
1 MiB each, with at most 64 modules and 8 MiB total resolved bytes per Spec.
SHA-256, when supplied, is checked against raw bytes before parsing. Without a
supplied digest, the computed hash identifies content but does not authenticate
its origin. Module bytes (base64), source and digest are included in execution
checkpoints, verified again on recovery, and never refetched during resume.
Old external checkpoints missing their manifests are rejected. Inline checkpoints
remain readable. These are worker-local pins, not immutable server snapshots.

Resolution is cached only in the executor for the current Flow/source; no URL-only
disk cache or offline fallback is used on a fresh run. Restart to refresh unpinned
sources. Resume instead uses pinned bytes and works without the module source.

The Bun adapter coordinates installation across processes with supervisor-owned
OS locks. Unannotated modules take a cache-wide exclusive lock; resource-scoped
modules/groups share a cache gate and take exclusive resource locks. Waiting has
no default deadline and is cancellable; `MU_WORKLOAD_LOCK_WAIT_MS` optionally
bounds acquisition. The supervisor stops and joins installer process groups on
worker disconnect before releasing locks. Injected effects must provide
`withWorkloadLock` for external preparation. See [preparation](workload-preparation.md)
for parallel/group syntax, supported platforms and safe directory-lock upgrades.

MasterFlow performs structural validation only and shows external metadata as
unresolved; it never fetches modules or executes preparation. Use a worker with
external-module support; CEL capability negotiation alone does not certify this
feature. See [MasterFlow companion](https://github.com/khanhtranrk/mu-masterflow/issues/30).

## Workload preparation locks and parallel groups

See [workload preparation](workload-preparation.md) for `parallel`, `installation_group`, module resource keys, cancellable waiting and platform/upgrade requirements. These actions currently apply only to workload-module preparation.
