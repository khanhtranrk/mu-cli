# 06 — Data Center Integration and Security

The implemented Phase 1 client and verified differences from the draft below are
recorded in [Phase 1 contracts](phase-1.md#verified-contracts-and-mismatches).
In particular, `/api/requests/update` does not exist; report requires the claimed
assignment generation, and both claim and Spec retrieval require CEL negotiation.

[Phase 2](phase-2.md#reporting-compatibility) preserves Spec-owned reporting for
real execution; automatic request reports remain confined to explicit fake mode.

[Phase 3 recovery](phase-3.md#durable-state-and-resume) verifies the saved assignment
with an id-only report and its generation header before resuming. This existing
route validates authorization without changing request/node status or appending logs;
it does not expose server node states or provide an assignment lease.

## Known/proposed endpoints to reconcile

Current artifact receipts, signed transfers and executable CPU round-trip are
verified in [Phase 4](phase-4.md#preserved-contracts). Use that contract rather than
the historical draft table below; `/download` returns URL JSON, not raw bytes.

The following routes reflect previously discussed Mu contracts, **not a verified current OpenAPI specification**:

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/requests/claim` | Claim eligible Requests (`unitId`, `specSlug`, `maxCount`) |
| POST | `/api/requests/update` | Report Request/node progress |
| POST | `/api/requests/report` | Report Request status/state from Spec-defined action where applicable |
| POST | `/api/units/heartbeat` | Report Unit status/devices |
| GET | `/api/specs/{slug}` | Retrieve Spec |
| POST | `/api/requests/artifacts/upload-url` | Obtain authorized signed upload URL |
| GET | `/api/requests/artifacts/download` | Obtain authorized artifact download |

**Important:** `/api/requests/report` may be intentionally exposed for explicit Spec actions rather than automatically called inside engine logic. Preserve this boundary after inspecting existing code. `update` versus `report` ownership must be resolved before coding.

## Worker credential policy

- Worker may access only Requests it is authorized to process.
- Worker may submit artifacts and report authorized progress; no artifact deletion, no unrestricted Convex access.
- Owner administration is authenticated separately (e.g., Clerk); worker token must never grant owner powers.
- Agent credentials are distinct: read-only Specs/Requests/Artifacts/Products/Creation Spaces, create Requests only; no Storage or Units/Workers access, no execution/report privileges.
- Signed upload/download URLs should be scoped, expiring, and never printed in normal logs.

## Reliability contract

Specify timeouts, retry/backoff, idempotency keys, error schema, pagination/batch limits, lease expiration and stale worker recovery. Heartbeats and reporting should be independent of long-running subprocess completion.

## Compatibility checklist

Verify server request/response schemas from the actual current code before implementing TS clients. Do not infer that endpoint names, status values or authentication mechanisms remain unchanged after recent refactors.
