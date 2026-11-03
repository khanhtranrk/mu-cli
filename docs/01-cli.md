# 01 — CLI Contract

Implemented Phase 3 options and recovery behavior: [scheduler and resume](phase-3.md).
`--device FAMILY,INDEX,MAX_UNITS`, `--concurrency`, `--shutdown-timeout`,
`--resume` and explicit `--retry-incomplete` are available; other proposed options
below still require verification against the CLI help.

## Command tree

```text
mu
├── worker
│   ├── start       Run continuously: claim → execute → repeat
│   ├── once        Claim one batch, process it, then exit
│   ├── doctor      Check environment and server reachability
│   └── info        Display resolved worker/device information
├── config
│   ├── init        Generate example configuration
│   └── show        Print resolved configuration (redacted)
├── version         Print CLI, engine, and protocol versions
└── help
```

No `mu run <file.yaml>` production command. Test harnesses may execute local fixtures internally without contacting the server.

## `mu worker start`

Long-running worker. Authenticate, detect devices, report heartbeat, claim eligible requests, execute and report, then poll again.

```bash
MU_WORKER_TOKEN='...' mu worker start   --server https://mu.example.com   --unit-id local-gpu-0   --spec music-generation   --max-claim 5   --poll-interval 15
```

## `mu worker once`

Claim **one batch**, not necessarily one request; process it until completed, terminally failed, or interrupted. No further claim cycle. Appropriate for Kaggle/Colab sessions.

```bash
MU_WORKER_TOKEN='...' mu worker once --config ./mu.yaml --max-claim 10
```

If the server returns no work, exit successfully unless configured otherwise in a future extension. A single batch may contain multiple requests; resource scheduling still governs concurrent execution.

## Common worker options

| Option | Type | Purpose | Proposed default |
|---|---|---|---|
| `--config <path>` | path | Configuration YAML | `./mu.yaml` if present |
| `--server <url>` | URL | Data Center API base | config/env required |
| `--token <value>` | secret | Worker bearer credential; **discouraged on CLI** | `MU_WORKER_TOKEN` |
| `--unit-id <id>` | string | Stable server-known Unit ID | required/config |
| `--spec <slug>` | repeatable | Allowed Spec filter for claim | server-authorized set |
| `--max-claim <n>` | positive int | Maximum requests claimed in batch | 1 |
| `--poll-interval <seconds>` | positive number | Idle polling cadence (`start`) | 15 |
| `--heartbeat-interval <seconds>` | positive number | Unit heartbeat cadence | 30 |
| `--workspace <path>` | path | Local temporary workspace | platform-specific |
| `--shutdown-timeout <seconds>` | positive number | Graceful shutdown budget | 30 |
| `--log-level <level>` | enum | `debug/info/warn/error` | info |
| `--json` | boolean | Machine-readable output for info/doctor | false |

`--token` is included for compatibility convenience, but environment variables or a secrets provider should be preferred: command-line tokens can leak through process listings and logs.

## Auxiliary commands

- `mu worker doctor [--config ...] [--json]`: verify Bun, config, writable workspace, API connectivity/auth, device detection and essential executables. No claim or execution.
- `mu worker info [--config ...] [--json]`: display unit ID, mode, detected devices and configuration summary. No secrets.
- `mu config init [--output mu.yaml] [--force]`: create a template; refuse overwrite without `--force`.
- `mu config show [--config ...] [--json]`: resolved configuration, secrets always redacted.
- `mu version [--json]`: CLI version, shared Spec/Engine versions, protocol version.

## Configuration precedence

`explicit CLI flags > environment variables > config YAML > built-in defaults`. Validate at startup and report field-specific errors. Never print bearer credentials.

```yaml
server:
  url: https://mu.example.com
worker:
  unitId: kaggle-t4-01
  mode: once
  specs: [music-generation]
  maxClaim: 10
runtime:
  workspace: /kaggle/working/mu
  shutdownTimeout: 30
polling:
  interval: 15
  heartbeatInterval: 30
logging:
  level: info
```

Suggested environment variables: `MU_SERVER_URL`, `MU_WORKER_TOKEN`, `MU_UNIT_ID`, `MU_CONFIG`, `MU_LOG_LEVEL`.

## Proposed process exit codes

| Code | Meaning |
|---|---|
| 0 | Normal shutdown / batch drained / no work |
| 2 | Invalid CLI arguments or configuration |
| 3 | Authentication or authorization failure |
| 4 | Server connection / protocol failure |
| 5 | Worker infrastructure failure |
| 6 | Batch ended with failed requests (policy to finalize) |
| 130 | Interrupted (SIGINT convention) |

Exit-code policy must be confirmed with existing notebooks and automation before freezing.
