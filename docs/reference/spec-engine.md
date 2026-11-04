# 04 — Spec engine

Current implementation is in `src/spec/` and `src/engine/`. The detailed semantics
and Python comparisons are recorded in [Phase 2](../tasks/completed/phase-2.md#implemented-semantics),
with later [scheduling/recovery](../tasks/completed/phase-3.md) and [artifact integration](../tasks/completed/phase-4.md).

## Supported surface

- YAML/JSON parsing and declaration/DAG validation; pinned YAML 1.1 scalar behavior.
- CEL is the only expression engine, including omitted declarations. Whole-value
  expressions preserve JSON types; supplied payloads are literal, not rerendered.
- Strict string/number/boolean/array/object parameters, defaults and isolated contexts.
- Actions: `execute_command`, `execute_workload`, `execute_routine`, `create_dir`,
  `write_json`, `inspect_file`, `send_http_request`, `report_node`,
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
