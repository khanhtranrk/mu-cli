# Creation Spaces upgrade tracker

Status: phase 1 implemented and verified locally on 2026-11-02. This is a staged implementation, not a declaration that the entire redesign is finished.

## Confirmed decisions

- Creation Spaces organize work only. They do not introduce membership, private data, or a new authorization boundary. Existing Clerk whitelist and application-owner rules remain in effect.
- Specs remain global reusable capabilities. Sessions belong to one Space; Requests keep their Spec/Pipeline and optionally belong to one Session.
- Artifact ownership is distinct from authorization. Future Artifact–Physical File cardinality is many-to-one.

## Delivery phases

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Spaces/Sessions CRUD, optional Request association, independent navigation, recent items, preserve Spec workflows | Implemented; verified locally |
| 2 | Separate Artifact/Physical File, ownership links, idempotent metadata backfill and legacy API adapter, Copy/Share/Clone | Not implemented |
| 3 | Products, file protection, orphan Trash representatives, restore and retryable physical purge | Not implemented |
| 4 | Typed Registry definitions, CEL evaluation and request snapshots, registry editing and parameter references | Not implemented |
| 5 | Versioned CEL Spec engine in both CLI and MasterFlow, migration tooling and cross-runtime conformance | Not implemented |

Phase order deliberately starts with usable organization/navigation. It does not change the existing artifact storage or spec expression contract.

## Ownership of documentation

Detailed phase-1 behavior: [MasterFlow Creation Spaces](../mu-masterflow/docs/creation-spaces.md).
Existing storage remains canonical in [request artifacts](../mu-masterflow/docs/request-artifacts.md).
Existing expression behavior remains canonical in [CLI templates](../mu-cli/docs/spec-format/02-context-and-templates.md).

## Later-phase integration contracts

The target behavior is recorded in the [canonical MasterFlow design](../mu-masterflow/docs/creation-spaces.md#target-architecture-for-later-phases). These are remaining implementation work, not completed features.

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
