---
status: completed
---

# Phase 4 — MasterFlow and artifact integration

The CPU-only path is validated against current MasterFlow source (`17a9433`):
connect/heartbeat → claim → fetch Spec → execute Bun subprocess → report nodes →
upload artifact → download and verify → report request success. No backend schema,
endpoint, legacy runtime or Spec syntax changes are required.

## Runnable Spec

[`examples/cpu-artifacts/spec.yaml`](../examples/cpu-artifacts/spec.yaml) uses existing
actions, routines, conditions and lifecycle hooks, not a second artifact engine.
Its `demo` pipeline generates a small JSON file with zero workload units. `publish`
uploads output key `result`; dependent `verify` downloads it and compares size and
SHA-256. A failed upload reports `process_failed`; a failed download after a
successful publish reports `retrieve_artifact_failed`. Reporting remains Spec-owned.

Create a Spec containing this YAML in MasterFlow, authorize its slug on a worker
token, then create a `demo` request with optional `payload.message`. Configure:

```yaml
server:
  url: http://127.0.0.1:3211
worker:
  unitId: cpu-worker
  specs: [your-spec-slug]
  maxClaim: 1
runtime:
  workspace: .mu
  devices: []
  concurrency: 2
```

```sh
MU_WORKER_TOKEN='YOUR_SCOPED_TOKEN' bun src/index.ts worker once --config mu.yaml
```

Explicit `devices: []` disables GPU discovery. This example requires Bun on PATH,
an enabled default storage connection and an authorized request assignment.

## Preserved contracts

- Worker JSON requests carry the token and current assignment version. Signed
  storage PUT/GET requests carry returned storage headers, never worker credentials.
- `POST /api/requests/artifacts/upload-url` issues a receipt and signed raw-byte upload;
  `POST /api/requests/artifacts/complete` verifies/finalizes that receipt. The example never
  substitutes multipart upload, direct database writes or legacy storage adapters.
- Completion retries once with the identical body only after an unknown response
  or selected transient 5xx statuses. It never retries claim or PUT automatically.
  An already-committed completion returns the same artifact without another copy.
- Worker metadata `id` is the output key, not the canonical Artifact document ID.
  Claims preserve and validate current S3 metadata for copied/shared inputs.
- Downloads use `POST /api/requests/artifacts/download-url`. The historical `/download`
  endpoint returns URL JSON, not file bytes. The example verifies downloaded SHA-256;
  server HEAD/ETag checks alone are not independent proof of the submitted SHA.
- File uploads bind an opened regular file and reject source replacement/change.
  Downloads retain atomic replacement and content-length validation; unresolved
  redirects fail instead of appearing successful.

Canonical server contracts remain in
[storage protocol](../../mu-masterflow/docs/request-artifacts.md) and
[Artifact ownership](../../mu-masterflow/docs/artifact-ownership.md).

## Validation

```sh
bun run typecheck
bun test
MU_MASTERFLOW_SOURCE=../mu-masterflow bun run test:integration
MU_MASTERFLOW_SOURCE=../mu-masterflow bun test
```

The opt-in suite imports the actual sibling schema and HTTP handlers through
`convex-test`; it does not copy the backend implementation. It uses in-memory
database state, mocked signed storage and real local CPU subprocesses. Without
`MU_MASTERFLOW_SOURCE`, these five integration tests explicitly skip. The full
opt-in run passes 138 tests, covering success, failed PUT, equal-size corruption,
lost completion response, stale/foreign/revoked assignment and forbidden worker
create/inspect operations. No models or GPU workloads are downloaded or run.

A live dev smoke also passed against local self-hosted backend `3210`, HTTP `3211`
and its configured storage: two succeeded nodes, one 89-byte artifact, byte-for-byte
download verification. Its disposable request was soft-deleted, Spec archived and
token revoked. Physical storage bytes were retained; no purge or deployment ran.

For an explicitly selected disposable local development environment only:

```sh
bun scripts/smoke-local.ts ../mu-masterflow/.env.local http://127.0.0.1:3211
```

This separate test harness requires local self-hosted admin credentials and an
existing enabled storage connection. It accepts only loopback HTTP origins and
rejects production deploy configuration. It creates its own unique records and
attempts cleanup in `finally`; failed cleanup requires manual inspection of its
printed slug. The CLI itself has no owner/admin credential requirement. The smoke
leaves audit/history, an offline unit and storage bytes; it is not a zero-write test.

## Limits and decisions

No verified incompatibility requires backend changes. Existing backend limitations
remain: no worker lease/immutable Spec snapshot/arbitrary request inspection API.
Recovery therefore retains Phase 3 assignment and exact-Spec checks.

The bounded completion retry is not durable per-action receipt recovery. A crash
inside a node remains an unknown outcome; `--retry-incomplete` is an explicit
whole-node retry and may repeat external effects. Do not assume it safely replaces
an existing output key or restores an upload receipt after process loss. Permanent
completion failures fail the node. No automatic artifact replacement or distributed
scheduling infrastructure is introduced. Live GPU and production environments were
not tested.
