# 06 — Data Center protocol

MasterFlow owns the server contract. Use its
[worker hooks](https://github.com/khanhtranrk/mu-masterflow/blob/master/docs/reference/worker-hooks.md),
[storage protocol](https://github.com/khanhtranrk/mu-masterflow/blob/master/docs/reference/request-artifacts.md)
and [Artifact identity](https://github.com/khanhtranrk/mu-masterflow/blob/master/docs/architecture/artifact-ownership.md)
for payloads, limits and authorization. CLI adapters live in `src/api.ts`,
`src/artifacts.ts` and `src/runtime/effects.ts`.

## Implemented worker integration

- Connect to the HTTP site origin, not the Convex client/API origin.
- Claim using the supported CEL engine and explicit Pipeline slug after token-bound
  heartbeat. Each claim supplies the exact published Pipeline YAML in `pipelineYaml`.
  Explicit inspection with doctor can fetch the default at `/api/pipelines/<slug>`.
- Send the returned assignment version and key on Request-context reports,
  artifact calls and locked workload reads. The key is stored in the private
  local checkpoint and omitted from Spec expressions and storage requests.
- The worker checks active assignments periodically and verifies unfinished
  checkpoints before recovery. On `ASSIGNMENT_LOST`, it cancels the affected
  execution where possible and marks its checkpoint revoked so later starts
  skip it.
- Real execution reports lifecycle status and typed Outputs automatically. `/api/requests/update` does
  not exist; use the documented report route. Custom report actions append events independently.
- Upload raw bytes to signed storage, complete the server receipt and retrieve signed
  download URLs. `/download` returns URL JSON, not proxied bytes. Never forward worker
  credentials to storage. HTTP `artifactId` denotes an output key, not a canonical ID.
- Retry completion once with identical details only for the bounded uncertain/transient
  cases in [Phase 4](../tasks/completed/phase-4.md#preserved-contracts); claim and PUT are not blindly retried.

The CPU integration suite loads real sibling HTTP handlers/schema when
`MU_MASTERFLOW_SOURCE` is supplied; otherwise those tests skip. See
[Phase 4 validation](../tasks/completed/phase-4.md#validation). Historical live smoke results do not
prove current provider configuration, GPU execution or production readiness.

Built-in [reporting/artifact actions](reporting-actions.md) encapsulate these
protocols and append Request/Node events through the existing report endpoint.
Downloads require size and SHA-256 and verify before destination replacement.
Artifact-specific request statuses are no longer accepted by the companion server.

## Authorization and recovery limits

Worker tokens do not grant owner administration, arbitrary Request inspection,
Request creation or artifact deletion. The server controls assignment atomically.
There is no assignment lease or node-state download. MasterFlow pins immutable
Pipeline versions and returns their YAML/lock on claim. Recovery uses locally captured
Pipeline YAML and assignment-generation fencing; see [Phase 3](../tasks/completed/phase-3.md#protocol-limits-and-decisions).

Agent-specific credentials/permissions, lease expiration, broader retry policies
and distributed reconciliation remain design proposals. No available Mu Agent API
is asserted by this document.

## Heartbeat transport recovery

Only periodic online heartbeats receive bounded orchestration recovery at worker
boundaries: transient failures pause new claims and can recover with three
additional calls after 1/2/4-second backoff. Successful heartbeats clear transient
failure state; permanent authorization/response errors remain fatal. The server
heartbeat contract is unchanged (the same token/unit updates status/lastSeen).
See [worker heartbeat recovery](../architecture/worker.md#heartbeat-failures-and-recovery).

The API adapter still makes each claim/report call once. Connection errors now
include method/path, elapsed time and a safe underlying network code without
credentials or response-body text. Heartbeat cancellation is combined with the
existing 10-second call deadline, including while reading its response body.
