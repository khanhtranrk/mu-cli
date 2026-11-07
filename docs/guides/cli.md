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
WORKER_TOKEN='YOUR_TOKEN' mu worker once --config ./mu.yaml --spec your-spec
```

## Configuration

Commander handles nested command routing, argument errors and generated help.
Use `--help` on any command or command group.

CLI flags override supported environment variables, then YAML, then defaults.
Configuration uses `--config`, then `MU_CONFIG`, then `./mu.yaml`. An explicitly
selected missing file fails; an absent implicit `mu.yaml` is allowed. Tokens come
from `WORKER_TOKEN` or `--token`, never YAML. Prefer the environment to avoid
putting tokens in process arguments.

`WORKER_TOKEN` is the only supported worker-token environment variable.
`MU_WORKER_TOKEN` and `UNIT_TOKEN` are not aliases. When upgrading an existing
worker, rename the credential variable in its shell, service or secret-manager
configuration to `WORKER_TOKEN`, keep the same token value, then restart the
worker with the updated CLI. Token regeneration on the server is not required.
An explicit `--token` takes precedence; an empty/whitespace-only explicit value
or `WORKER_TOKEN` is an error, with no fallback to old names.

| Flag | YAML / environment | Default or constraint |
| --- | --- | --- |
| `--token` | `WORKER_TOKEN` (no YAML credential) | Required; CLI flag overrides environment |
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
uses the per-user MU cache described below. Spec source validation and preparation caches stay
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

### Local sources in server-provided Specs

External workload modules support absolute local paths and HTTPS URLs. To use a
relative source such as `./workloads/echo.yaml` in a server-provided Spec, set an
explicit base in the worker configuration:

```yaml
runtime:
  workloadBaseDir: ./spec-assets
```

This base resolves relative to the configuration file's directory, not the worker
cwd or its run directory. Local module files are provisioned separately on the
worker; uploading a Spec does not upload them. `worker doctor` validates sources
without running their preparation. See [external workload modules](../reference/spec-engine.md#external-workload-modules)
for pinning, installation locking, limits, and recovery.

## Standalone workload execution

A CLI build that includes standalone workload execution (issue #25) can prepare
and run the same module used by pipeline external workloads, without a full Spec,
server URL, token or unit identity. This command is independent of `mu.yaml` and
worker environment credentials; it never claims Requests, sends heartbeats, or
publishes automatic lifecycle reports.

```bash
mu workload exec ./workloads/real-esrgan.yaml \
  --with input=./cover.png \
  --with output=./upscaled \
  --with-json outscale=1.05

mu workload exec https://example.com/real-esrgan.yaml \
  --sha256 <digest> \
  --with-file ./parameters.json \
  --with-json outscale=1.05 \
  --json
```

The positional source is a [workload module](../reference/spec-engine.md#external-workload-modules):
one `workload`, optional private `routines`, and optional `prepare`. Source/hash
rules, HTTPS limits, and installation locks are shared with pipeline execution.
SHA-256 remains optional; when supplied it verifies raw bytes before module parsing.

### Bindings

- Repeat `--with key=value` for strings. `code=001` stays `"001"` and
  `enabled=false` stays `"false"`. Splitting uses the first `=`; `key=` is an
  empty string and `url=a=b` preserves `a=b`.
- Repeat `--with-json key=value` for strict JSON. Examples: `scale=1.05`,
  `enabled=false`, `'sizes=[512,1024]'`, `'options={"fast":true}'`, and `value=null`.
  Shell-quote structured values as needed. Non-finite numbers are rejected.
- `--with-file path` reads a local JSON object (up to 1 MiB); malformed JSON and
  non-object roots fail. Explicit flags shallowly override matching file keys.
- Duplicate explicit flag keys, including duplicates across the two flag types,
  fail. Empty and internal/prototype keys fail. Dotted keys remain literal names,
  not nested paths. Binding values also obey the engine's bounded JSON rules.

Bindings map to `execute_workload.with`, not implicit Input Field overrides.
Extra keys are allowed. Workload Fields explicitly select values, for example:

```yaml
workload:
  target: bun
  units: 0
  inputs:
    message:
      type: string
      value: "${{ with.message }}"
  argv: [-e, 'console.log(process.argv[1])', "${{ inputs.message }}"]
  outputs:
    text: {type: string, value: "${{ result.stdout }}"}
```

CLI values remain literal, even if they look like CEL. Only module-owned Field
expressions execute. Missing keys, defaults and explicit null keep existing Field
semantics: accessing a missing `with.key` in `value` is an error, not a trigger for
`default`. Use `has(with.key) ? with.key : fallback` when selecting an optional key.

### Preparation, context and devices

The command resolves/validates the module and Input Fields before installer
side effects, runs module preparation automatically under the shared installation
lock, refreshes discovered models, and then acquires resources and executes through
the shared Actions engine. Invalid invocation Fields fail before setup. Fields
requiring unavailable local namespaces cannot pass preflight. Installation scripts
must tolerate repeated calls and partial installs. There is no standalone resume,
`--skip-prepare`, or separate `workload prepare` command in this version.

- The default process cwd is the caller's current directory. `--cwd path` must
  identify an existing directory.
- The module source, binding file and relative `--cwd` resolve from the original
  caller cwd. Selecting `--cwd` does not change which module/file is loaded.
- Binding strings are never guessed to be paths or rewritten; the workload process
  interprets relative path values against its selected cwd.
- `sys.cache_dir` is the per-user MU cache shared with worker execution:
  Linux `$XDG_CACHE_HOME/mu` (default `~/.cache/mu`), macOS
  `~/Library/Caches/mu`, Windows `%LOCALAPPDATA%\mu\Cache`
  (fallback `~/AppData/Local/mu/Cache`). Empty or relative environment overrides
  are ignored. `sys.models` discovers models under `${sys.cache_dir}/models`.
  `session.working_dir` and `session.output_dir` are the selected cwd.
  `session.cache_dir` is `${sys.cache_dir}/standalone`.
- No authenticated Request, server, token or captured Registry namespaces are
  supplied. Server reporting, Artifact transfers, and server notifications fail
  explicitly when reached, including inside private routines. Explicit generic
  `send_http_request` actions retain their normal HTTP behavior.
- Devices auto-detect unless repeatable `--device FAMILY,INDEX,MAX_UNITS` flags are
  provided (cuda/rocm; nvidia normalizes to cuda). Scheduler placement and CPU
  fallback match worker behavior. `units: 0` stays CPU-only. GPU device_args are
  appended only when placed on a GPU. Preparation holds no GPU reservation.

### Results and exit codes

Normal mode prints a success message and declared Outputs. Process stdout/stderr
are forwarded to CLI stderr after each process completes, using the shared adapter's
bounded capture. Workload stdout is not guessed or parsed into Outputs.

`--json` reserves stdout for one result object after command parsing:

```json
{"success":true,"outputs":{"text":"hello\n"}}
```

Failures emit `{"success":false,"error":{"message":"..."},"exitCode":6}`
with the appropriate exit code. Commander usage errors (unknown flags, missing
arguments) are written to stderr and do not emit a result object.

| Exit code | Meaning |
| --- | --- |
| 0 | Success; declared Outputs returned |
| 2 | Invalid usage, source/module, bindings, cwd, device configuration or Input Fields |
| 6 | Preparation, admission, process or Output resolution failure |
| 130 | Interrupted by SIGINT or SIGTERM |

Cancellation propagates through source loading, device probes, installation locks,
and subprocess execution. Process groups and scheduler reservations are cleaned up.
See [CPU standalone example](../../examples/workload-exec/README.md).

## MU registry workloads

Named workload modules can be downloaded from MU and executed locally using the
same preparation, Field resolution, scheduler and process adapters:

```bash
mu workload exec real-esrgan --profile personal \
  --with input=./cover.png --with output=./upscaled --with-json outscale=1.05
mu workload exec real-esrgan@1.2.0 --profile personal --with-json sample=1
mu workload exec mu://real-esrgan@1.2.0 --profile personal --with-json sample=1
```

A bare name selects the registry's explicitly chosen default version, not necessarily
the most recently published release. Resolution returns that immutable version and
content together; default changes cannot alter it mid-execution. Exact stable
`MAJOR.MINOR.PATCH` versions are supported; ranges, tags and prereleases are not.
The CLI verifies configured server origin, slug, selected version identity, format
version 1, payload size and raw-byte SHA-256 before parsing or setup. `--sha256`
is optional and, when supplied, must also match the registry's content digest.

### Profiles and credentials

Create `~/.config/mu/profiles.json` with nonsecret connection information:

```json
{
  "defaultProfile": "personal",
  "profiles": {
    "personal": {
      "server": "https://mu.example.com",
      "tokenEnv": "MU_WORKLOAD_TOKEN"
    }
  }
}
```

Use the MU HTTP site origin, not the Convex client/API origin. The server owner issues
a read credential in MasterFlow's Workloads page, optionally scoped to specific slugs
and an expiry. Supply its one-time `mu_workload_v1_…` plaintext through the named
environment variable, using your shell/secret manager. Never put it in the profile,
module YAML, arguments or committed files. Worker/agent credentials cannot substitute
for this standalone capability. Expired or revoked reads fail without falling back.

`--profile` selects explicitly; otherwise `MU_PROFILE`, then `defaultProfile` is used.
`MU_PROFILES_FILE` overrides the profile file location. Profiles accept only `server`
and `tokenEnv`; stored plaintext credentials are rejected. Local/HTTPS execution
continues to work without a profile or MU token. Downloading a registry module does
not create a Request, register a unit, send heartbeats or authorize server reporting,
Artifact actions or server notifications during standalone execution.

### Source grammar

- `mu://name[@version]` is explicitly a registry reference.
- HTTPS, explicit local path prefixes (`./`, `../`, absolute paths), paths containing
  separators, and filenames ending in `.yaml`, `.yml` or `.json` use existing source
  loading. `module.yaml` remains local even if missing.
- Other bare identifiers are registry names. Use `./name` for an extensionless local
  file that would otherwise be interpreted as a registry name.
- There is no existence-based guessing, source fallback or cross-profile fallback.
  Missing local files stay local failures; missing registry names stay registry failures.

The profile selects one registry origin; `mu://` does not accept an arbitrary server
host/path. Credential-bearing requests reject redirects, enforce timeouts and bounded
JSON responses, and never forward credentials to module source URLs. Registry module
YAML is limited to 256 KiB; the existing total module bounds still apply.

### Pipeline references and recovery

```yaml
workloads:
  upscale: real-esrgan@1.2.0
  default_upscale: real-esrgan
  explicit:
    registry: real-esrgan
    version: "1.2.0"
```

Each workload chooses inline, local/HTTPS source, or registry form; forms cannot be
mixed. Alias names used by `ensure_workload`/`execute_workload` remain unchanged.
Server saves pin references atomically with exact Spec YAML. Unchanged references
keep their pins until explicit dependency refresh. Requests capture their matching
pins and change only through permitted explicit Spec sync.

Worker preflight loads the current saved lock with its authorized Spec token. After
claim it uses the assigned Request's captured lock, even if the current Spec/default
has moved. Missing, substituted or stale locks fail before module setup; workers
never independently resolve a bare name against a new default. Registry capability
is advertised separately from CEL support.

Checkpoints keep the exact bytes/hash plus registry origin and version provenance.
Resume verifies them against the captured lock without downloading a module or
looking up a current default. Server assignment verification still applies. No
persistent registry cache or standalone resume is introduced. Existing non-registry
Specs and compatible checkpoints remain supported.

Module versioning alone does not pin external Git/package/model dependencies. See
[MasterFlow's registry contract](https://github.com/khanhtranrk/mu-masterflow/blob/master/docs/reference/workload-registry.md)
for publication, archival and authorization semantics.

### Installation lock waiting

Workload preparation waits for installation locks without a default deadline. Set `MU_WORKLOAD_LOCK_WAIT_MS` to positive integer milliseconds to bound acquisition per lock scope. Installation duration is unaffected; cancellation remains supported. See [preparation and platform/upgrade requirements](../reference/workload-preparation.md).

### Heartbeat recovery

`--heartbeat-interval` continues to control regular online heartbeats (default
30 seconds). A transient failure pauses new claims at the next boundary and
allows three additional heartbeat attempts after 1, 2 and 4 seconds; a successful
heartbeat clears the failure. HTTP 401/403 and invalid responses remain fatal.
These recovery defaults and the 10-second per-call API timeout are currently
fixed, not separate CLI flags. Claims and completed workloads are not replayed.
See [recovery and cancellation](../architecture/worker.md#heartbeat-failures-and-recovery).
