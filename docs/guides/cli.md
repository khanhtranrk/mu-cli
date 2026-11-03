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
```

There is no public local `mu run` command. `once` drains one batch (possibly several
Requests); `start` repeats claim cycles. Both execute Specs unless `--fake` is
explicitly selected. Fake mode claims real Requests and reports simulated results.
Real execution leaves reporting to Spec actions/hooks.

```sh
MU_WORKER_TOKEN='YOUR_TOKEN' mu worker once --config ./mu.yaml --spec your-spec
```

## Configuration

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
