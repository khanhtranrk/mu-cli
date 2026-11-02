# Creation Spaces upgrade tracker

Status: phases 1 and 2 implemented and verified locally on 2026-11-02. This is a staged implementation, not a declaration that the entire redesign is finished.

## Confirmed decisions

- Creation Spaces organize work only. They do not introduce membership, private data, or a new authorization boundary. Existing Clerk whitelist and application-owner rules remain in effect.
- Specs remain global reusable capabilities. Sessions belong to one Space; Requests keep their Spec/Pipeline and optionally belong to one Session.
- Artifact ownership is distinct from authorization. Artifact–Physical File cardinality is many-to-one.

## Delivery phases

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Spaces/Sessions CRUD, optional Request association, independent navigation, recent items, preserve Spec workflows | Implemented; verified locally |
| 2 | Separate Artifact/Physical File, ownership links, idempotent metadata backfill and legacy API adapter, Copy/Share/Clone | Implemented; verified locally |
| 3 | Products, file protection, orphan Trash representatives, restore and retryable physical purge | Not implemented |
| 4 | Typed Registry definitions, CEL evaluation and request snapshots, registry editing and parameter references | Not implemented |
| 5 | Versioned CEL Spec engine in both CLI and MasterFlow, migration tooling and cross-runtime conformance | Not implemented |

Phase 1 deliberately starts with usable organization/navigation. Phase 2 changes storage identity while preserving worker payloads and physical bytes; the Spec expression engine is unchanged.

## Ownership of documentation

Phase 2: [MasterFlow Artifact ownership](../mu-masterflow/docs/artifact-ownership.md).

Detailed phase-1 behavior: [MasterFlow Creation Spaces](../mu-masterflow/docs/creation-spaces.md).
Storage protocol remains canonical in [request artifacts](../mu-masterflow/docs/request-artifacts.md).
Existing expression behavior remains canonical in [CLI templates](../mu-cli/docs/spec-format/02-context-and-templates.md).

## Later-phase integration contracts

The target behavior is recorded in the [canonical MasterFlow design](../mu-masterflow/docs/creation-spaces.md#target-architecture-for-later-phases). Registry/CEL and Products/Trash are still remaining work; Artifact ownership/reuse was delivered in phase 2.

- Preserve existing worker output keys and assignment/reset guards through adapters when Artifact identity becomes independent.
- Introduce typed Registry and request snapshots before switching Spec execution to CEL.
- Keep current worker `session` context distinct from Creation Session; update both repos and canonical Spec docs for the versioned language change.
- Products protect their referenced files; physical deletion is an explicit Trash operation, never an effect of organization archival.

## Verification and deployment

- Frontend and Convex TypeScript checks passed; Vite production build passed (bundle-size advisory remains).
- New and storage Bun suites: 23 tests passed (7 organization/catalog, 3 navigation, 13 storage).
- Node regression suites: 48 passed, 1 pre-existing environment-dependent DST test skipped.
- Convex functions/schema synchronized successfully to the existing self-hosted **local development** backend at `http://127.0.0.1:3210`; its existing backend container was started. No production target was used.
- Live local smoke verified Space/Session create/read/update/list/archive using disposable organizational records. Those records were archived; no real Request, Spec or storage bytes were modified.
- Browser visual checks used an isolated sidebar fixture: light/dark, collapse and 390 px responsive layout. An authenticated desktop end-to-end workflow and native Tauri build were not exercised.
- Implementation belongs to MasterFlow; the parent records the integration and submodule revision. CLI unchanged. The tracked Graphify query timestamp reflects the architecture inspection for this upgrade.

## Phase 2 verification and integration

- Canonical Artifact/File identities, ownership, Copy/Share/Clone and worker adapters are implemented in MasterFlow. The CLI runtime/wire format is unchanged; its artifact protocol documentation was corrected to the existing S3 protocol and output-key semantics.
- A metadata-only snapshot was saved outside Git with private filesystem permissions before backfill on the existing local self-hosted backend (`http://127.0.0.1:3210`). No production target was used.
- All 95 existing output bindings were mapped to 95 independent Artifacts, 93 Physical Files and 77 current ownership links. Deleted/stale outputs did not gain current ownership. Physical bytes were neither downloaded nor deleted.
- Comparison against the pre-migration snapshot confirmed all 101 original Request documents and all 95 compatibility output documents were preserved, excluding the new output `recordId` mapping field.
- A second backfill retained identical File, Artifact and ownership IDs. Live Copy/Share/scoped-list smoke tests used disposable Space/Session records; temporary owners were removed and containers archived afterward, preserving original Request ownership and file counts.
- Clone byte copying, new storage identity, conditional-copy guards, expiration and repeat-operation behavior were verified against a local S3 protocol fixture. Actual R2/Supabase bucket cloning is not claimed.
- Typechecks/build passed. Bun suites: 30 passed. Node suites: 50 passed, one existing conditional DST test skipped. Browser fixtures verified operation choices, legacy Clone gating, keyboard Escape, native-dialog portals and a 390 px layout. Authenticated desktop E2E and native Tauri build were not exercised.
- Phase 3 (Products/Trash/physical purge), phase 4 (Registry/CEL snapshots) and phase 5 (versioned CEL Specs) remain unimplemented. The phase-2 constraints and migration procedure are documented in the linked canonical MasterFlow guide.
