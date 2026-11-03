# 06 — Data Center protocol

MasterFlow owns the server contract. Use its
[worker hooks](https://github.com/khanhtranrk/mu-masterflow/blob/master/docs/worker-hooks.md),
[storage protocol](https://github.com/khanhtranrk/mu-masterflow/blob/master/docs/request-artifacts.md)
and [Artifact identity](https://github.com/khanhtranrk/mu-masterflow/blob/master/docs/artifact-ownership.md)
for payloads, limits and authorization. CLI adapters live in `src/api.ts`,
`src/artifacts.ts` and `src/runtime/effects.ts`.

## Implemented worker integration

- Connect to the HTTP site origin, not the Convex client/API origin.
- Bootstrap allowed Spec YAML with CEL capability headers; claim using the loaded
  engine and explicit Spec slug after token-bound heartbeat.
- Carry the returned assignment generation on Request-context reports/artifact calls.
- Real execution reports through Spec actions/hooks. `/api/requests/update` does
  not exist; use the documented report route. Fake mode alone reports automatically.
- Upload raw bytes to signed storage, complete the server receipt and retrieve signed
  download URLs. `/download` returns URL JSON, not proxied bytes. Never forward worker
  credentials to storage. HTTP `artifactId` denotes an output key, not a canonical ID.
- Retry completion once with identical details only for the bounded uncertain/transient
  cases in [Phase 4](phase-4.md#preserved-contracts); claim and PUT are not blindly retried.

The CPU integration suite loads real sibling HTTP handlers/schema when
`MU_MASTERFLOW_SOURCE` is supplied; otherwise those tests skip. See
[Phase 4 validation](phase-4.md#validation). Historical live smoke results do not
prove current provider configuration, GPU execution or production readiness.

## Authorization and recovery limits

Worker tokens do not grant owner administration, arbitrary Request inspection,
Request creation or artifact deletion. The server controls assignment atomically.
There is no assignment lease, immutable server Spec snapshot or node-state download.
Recovery uses local pinned state, exact current Spec text and the existing id-only
report guard; see [Phase 3](phase-3.md#protocol-limits-and-decisions).

Agent-specific credentials/permissions, lease expiration, broader retry policies
and distributed reconciliation remain design proposals. No available Mu Agent API
is asserted by this document.
