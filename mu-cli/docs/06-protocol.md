# 06 — Data Center Integration and Security

## Known/proposed endpoints to reconcile

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
