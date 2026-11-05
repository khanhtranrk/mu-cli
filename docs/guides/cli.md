# 01 — CLI and configuration

Current implementation: `src/index.ts` and `src/config.ts`.

## Commands

```text
mu worker start|once     Execute authorized server work
mu worker doctor        Check workspace, health and scoped Spec access; no claim
mu worker info          Print resolved configuration and devices, token redacted
mu config init          Write example YAML; --output PATH, --force to overwrite
mu config show          Print resolved configuration, token redacted
mu version              Print the CLI version and capability summary
mu help                 Print usage
mu worker --help        List worker commands
mu worker once --help   Show worker options
```

There is no public local `mu run` command. `once` drains one batch (possibly several
Requests); `start` repeats claim cycles. Both execute Specs unless `--fake` is
explicitly selected. Fake mode claims real Requests and reports simulated results.
Real execution leaves reporting to Spec actions/hooks.

```sh
MU_WORKER_TOKEN='YOUR_TOKEN' mu worker once --config ./mu.yaml --spec your-spec
```

## Configuration

Commander handles nested command routing, argument errors and generated help.
Use `--help` on any command or command group.

CLI flags override supported environment variables, then YAML, then defaults.
Configuration uses `--config`, then `MU_CONFIG`, then `./mu.yaml`. An explicitly
selected missing file fails; an absent implicit `mu.yaml` is allowed. Tokens come
from `MU_WORKER_TOKEN` or `--token`, never YAML. Prefer the environment to avoid
putting tokens in process arguments.

| Flag | YAML / environment | Default or constraint |
| --- | --- | --- |
| `--server` | `server.url` / `MU_SERVER_URL` | Required HTTP site origin, no path/query/credentials |
| `--unit-id` | `worker.unitId` / `MU_UNIT_ID` | Required; server token binding must match |
| `--spec` (repeatable) | `worker.specs` | Explicit list needed to claim; doctor requires a Spec |
| `--workspace` | `runtime.workspace` | `.mu` |
| `--run-directory-scope` | `runtime.runDirectoryScope` | `spec-version` (default) or `spec` |
| `--run-directory-name` | `runtime.runDirectoryName` | Optional shared directory name; requires `spec` scope |
| `--max-claim` | `worker.maxClaim` | 1; integer 1–100 across the batch |
| `--poll-interval` | `polling.interval` | 15 seconds, positive |
| `--heartbeat-interval` | `polling.heartbeatInterval` | 30 seconds, positive |
| `--device FAMILY,INDEX,MAX_UNITS` (repeatable) | `runtime.devices` | Positive capacity; family cuda/rocm (`nvidia` CLI alias) |
| `--concurrency` | `runtime.concurrency` | 32; integer 1–32 |
| `--shutdown-timeout` | `runtime.shutdownTimeout` | 30 seconds, positive |
| `--resume` | CLI only | Resume recorded work; see recovery guide |
| `--retry-incomplete` | CLI only | Requires --resume; whole-node effects may repeat |
| `--fake` | CLI only | Off; simulation over real assignments |

Omitted devices trigger bounded hardware discovery; `runtime.devices: []` disables
probes and selects CPU-only placement. `info`, `show` and successful `doctor` print
JSON even without `--json`; `version` prints text. The parser accepts `--json`, but
there is no distinct JSON version payload. `--log-level`, logging YAML settings
and `MU_LOG_LEVEL` are not implemented configuration options.

```yaml
server:
  url: http://127.0.0.1:3211
worker:
  unitId: cpu-worker
  specs: [your-spec]
  maxClaim: 1
runtime:
  workspace: .mu
  runDirectoryScope: spec-version
  devices: []
  concurrency: 2
  shutdownTimeout: 30
polling:
  interval: 15
  heartbeatInterval: 30
```

## Exit codes and diagnostics

| Code | Meaning |
| --- | --- |
| 0 | Success, no work or normal shutdown |
| 2 | Argument/configuration error before configuration succeeds |
| 3 | HTTP 401/403 |
| 4 | Other API HTTP errors, including authorization refusals returned as 400 |
| 5 | Infrastructure, transport or local-state failure after configuration |
| 6 | Batch execution failure |
| 130 | Graceful interruption |

Doctor checks local workspace writes, API health and permitted Spec parsing. It
does not claim or register a unit and cannot prove unit binding without a heartbeat.
See [scheduler/recovery](../architecture/scheduler-runtime.md) and [integration](../tasks/completed/phase-4.md).

## Run directory scope and shared names

Without either setting, execution keeps the original `.mu/runs/<hash>/` layout.
The SHA-256 input remains exactly `server + "\n" + unitId + "\n" + specSlug +
"\n" + specYaml` (the separators are newline characters). Editing YAML selects
another directory. Explicit `spec-version` is identical to the default.

Use `spec` to keep local cache/output files available across YAML revisions:

```yaml
runtime:
  workspace: .mu
  runDirectoryScope: spec
  runDirectoryName: music-production # optional
```

```sh
mu worker start --spec your-spec --run-directory-scope spec
mu worker once --spec your-spec --run-directory-scope spec --run-directory-name music-production
mu worker doctor --spec your-spec --run-directory-scope spec --run-directory-name music-production
```

| Configuration | Effective working directory |
| --- | --- |
| Default or `spec-version` | `<workspace>/runs/<existing-version-hash>/` |
| `spec`, no name | `<workspace>/runs/<worker-hash>/__spec-<slug-hash>/` |
| `spec`, named | `<workspace>/runs/<worker-hash>/<name>/` |

`worker-hash` is SHA-256 of server origin, newline, and unit ID. `slug-hash` is
SHA-256 of the exact Spec slug. The automatic `__spec-` prefix cannot be chosen
as a custom name. Different servers/units remain isolated. With an explicit
matching name, multiple Specs on the same server/unit intentionally share one
directory. A global named option applies to all selected `--spec` filters.

CLI values override the corresponding YAML fields; the effective scope/name are
then validated together. A configured name still applies if only the CLI scope
is overridden, so selecting `spec-version` with that name is an error. No
setting implicitly switches scope. `info`/`config show` expose resolved options;
`doctor` also returns `runDirectories` keyed by Spec slug without claiming work
or initializing Specs. Fake execution accepts the options but does not create
Spec run directories.

Names must be 1–64 lowercase ASCII letters/digits, dots, hyphens or underscores,
start with a letter/digit, and not end with a dot. Empty names, whitespace,
absolute paths, separators, `.`/`..`, leading underscores and Windows device
names (including `con.txt`, `com1` and `nul`) are rejected. Existing symlinks
must not redirect the selected run/cache/output directories outside the workspace.
This is directory-selection validation, not a filesystem sandbox for Spec actions.

Changing scope/name selects another location; files are never automatically moved,
copied, cleaned or deleted, and there is no fallback search of older directories.
`session.working_dir` selects the run root; `session.cache_dir` and
`session.output_dir` remain its `cache` and `output` children. `sys.cache_dir`
remains the shared `~/.cache`. Spec source validation and preparation caches stay
version-specific even when the directory is shared.

Reusing a directory does not establish that old output is valid for new inputs,
models or configuration. Specs decide reuse, for example through `file_exists`.
Concurrent Requests/Specs can collide; use request-specific output paths when
needed. This option neither serializes requests nor isolates attempts.

New checkpoints retain scope, custom name and the effective absolute path.
Node-boundary resume rejects a different scope, name or directory before replaying
execution; restore the original options or inspect/reset in MasterFlow. Old
checkpoints without this metadata are treated as `spec-version`; they can resume
with the original versioned directory, not be silently moved into shared scope.
Terminal outbox reports can still be delivered without executing filesystem work.
Reset/reclaim uses a new assignment and never resumes completed-node state merely
because it shares the old directory. See [recovery](../architecture/scheduler-runtime.md).
