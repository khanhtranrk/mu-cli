# Creation Spaces upgrade tracker

Status: phases 1–5 delivered; an explicitly authorized dev-only cleanup on 2026-11-03 supersedes their Artifact backward-compatibility layers. Current implementation details are canonical in the submodule documents linked below.

## Confirmed decisions

- Creation Spaces organize work only. They do not introduce membership, private data, or a new authorization boundary. Existing Clerk whitelist and application-owner rules remain in effect.
- Specs remain global reusable capabilities. Sessions belong to one Space; Requests keep their Spec/Pipeline and optionally belong to one Session.
- Artifact ownership is distinct from authorization. Artifact–Physical File cardinality is many-to-one.

## Delivery phases

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Spaces/Sessions CRUD, optional Request association, independent navigation, recent items, preserve Spec workflows | Implemented; verified locally |
| 2 | Separate Artifact/Physical File, ownership links, idempotent metadata backfill and legacy API adapter, Copy/Share/Clone | Implemented; verified locally |
| 3 | Products, file protection, orphan Trash representatives, restore and retryable physical purge | Implemented; verified locally |
| 4 | Typed Registry definitions, CEL evaluation and request snapshots, registry editing and parameter references | Implemented; verified locally |
| 5 | Versioned CEL Spec engine in both CLI and MasterFlow, migration tooling and cross-runtime conformance | Implemented; verified locally |

Phase 1 deliberately starts with usable organization/navigation. Phase 2 changes storage identity while preserving worker payloads and physical bytes; the Spec expression engine is unchanged.

## Ownership of documentation

Phase 5: [MasterFlow CEL integration](../mu-masterflow/docs/spec-cel.md) and
[canonical CLI CEL execution/migration](../mu-cli/docs/spec-format/11-cel.md).

Phase 4: [MasterFlow Registry/CEL and input snapshots](../mu-masterflow/docs/registry-cel.md).

Phase 3: [MasterFlow Products and Trash](../mu-masterflow/docs/products-trash.md).

Phase 2: [MasterFlow Artifact ownership](../mu-masterflow/docs/artifact-ownership.md).

Detailed phase-1 behavior: [MasterFlow Creation Spaces](../mu-masterflow/docs/creation-spaces.md).
Storage protocol remains canonical in [request artifacts](../mu-masterflow/docs/request-artifacts.md).
Existing expression behavior remains canonical in [CLI templates](../mu-cli/docs/spec-format/02-context-and-templates.md).

## Later-phase integration contracts

The target behavior is recorded in the [canonical MasterFlow design](../mu-masterflow/docs/creation-spaces.md#target-architecture-for-later-phases). Registry/CEL inputs and snapshots are delivered in phase 4; versioned CEL Spec execution is delivered in phase 5. Artifact ownership/reuse was delivered in phase 2 and Products/Trash in phase 3.

- Preserve existing worker output keys and assignment/reset guards through derived transport views while keeping Artifact identity independent.
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
- Implementation belongs to MasterFlow; the parent records the integration and submodule revision. CLI unchanged. Graphify output is local-only and ignored by Git.

## Phase 2 verification and integration

- Canonical Artifact/File identities, ownership, Copy/Share/Clone and worker adapters are implemented in MasterFlow. The CLI runtime/wire format is unchanged; its artifact protocol documentation was corrected to the existing S3 protocol and output-key semantics.
- A metadata-only snapshot was saved outside Git with private filesystem permissions before backfill on the existing local self-hosted backend (`http://127.0.0.1:3210`). No production target was used.
- All 95 existing output bindings were mapped to 95 independent Artifacts, 93 Physical Files and 77 current ownership links. Deleted/stale outputs did not gain current ownership. Physical bytes were neither downloaded nor deleted.
- Comparison against the pre-migration snapshot confirmed all 101 original Request documents and all 95 compatibility output documents were preserved, excluding the new output `recordId` mapping field.
- A second backfill retained identical File, Artifact and ownership IDs. Live Copy/Share/scoped-list smoke tests used disposable Space/Session records; temporary owners were removed and containers archived afterward, preserving original Request ownership and file counts.
- Clone byte copying, new storage identity, conditional-copy guards, expiration and repeat-operation behavior were verified against a local S3 protocol fixture. Actual R2/Supabase bucket cloning is not claimed.
- Typechecks/build passed. Bun suites: 30 passed. Node suites: 50 passed, one existing conditional DST test skipped. Browser fixtures verified operation choices, legacy Clone gating, keyboard Escape, native-dialog portals and a 390 px layout. Authenticated desktop E2E and native Tauri build were not exercised.
- At the phase-2 delivery, phases 3–5 remained unimplemented. Phase 3 is now delivered below; Registry/CEL snapshots (phase 4) and versioned CEL Specs (phase 5) remain future work.

## Phase 3 verification and integration

- Products provide editable drafts, immutable numbered manifests with ordered package paths/roles, and protected file references. Release downloads remain independent of original Request/Artifact lifetimes. This delivery does not generate archive bytes.
- Orphan files gain one dedicated Artifact representative owned by Trash. Restore links that representative to a valid normal destination. Explicit owner-only purge reserves the file, blocks new references, deletes via the provider, and retains a tombstone or retryable failure. Ambiguous failures remain locked until a purge retry reconciles them.
- Product/Space archival preserves release protection. Global Artifacts exposes retained releases, including those in archived containers, plus Ready/Failed/Purging/Purged Trash views. Spaces remain organization only; no Space membership or permissions were added.
- MasterFlow owns all implementation changes. Worker/CLI contract and Spec expression behavior are unchanged; mu-cli requires no phase-3 changes. Canonical behavior and rollout procedure: [Products and Trash](../mu-masterflow/docs/products-trash.md).
- Local development schema/functions synchronized to `http://127.0.0.1:3210`. A private metadata snapshot outside Git preceded orphan reconciliation: 93 files processed, 16 Trash entries created. Comparison preserved all 101 Requests, 95 compatibility outputs, 93 Files, 77 ownership links and 96 existing Artifact records. No real storage bytes were purged.
- 43 Bun tests pass (13 new Product/Trash cases), frontend/backend typechecks and Vite build pass. Node regressions: 50 passed, one existing conditional DST skip. Byte deletion and ambiguous-failure retries were verified using a local S3 fixture and a disposable Convex test blob.
- Local authenticated CLI smoke verified disposable Product create/save/publish, immutable manifest reads and download URL issuance without transferring bytes; release removed and Product/Space archived afterward.
- Browser fixtures verified Product draft selection, release manifests and Trash destinations, including a 390 px layout. Authenticated desktop E2E and native Tauri build were not exercised.
- At the phase-3 delivery, Registry/CEL snapshots (phase 4) and versioned CEL Specs (phase 5) remained unimplemented. Phase 4 is now delivered below; phase 5 remains future work.

## Phase 4 verification and integration

- Typed Registry definitions and revision-checked editors are implemented for Space, Session and Request. The bounded `mu-registry-cel-v1` profile uses a pinned CEL interpreter, explicit namespaces, cycle/type/missing-key diagnostics and typed whole-value or scalar interpolated parameter references.
- New Requests retain submitted definitions/templates plus resolved payload and ancestor snapshots. Waiting edits retain captured ancestors; explicit revision-checked refresh uses current ancestry. Reset/retry and association moves retain existing snapshots. Creation Spaces remain organizational, with the existing shared access policy.
- MasterFlow owns schema/evaluation/UI. CLI runtime and worker claim/report fields are unchanged; workers receive resolved JSON only. CLI documentation and a parameter handoff regression test record this boundary. Canonical details, limits and compatibility: [Registry/CEL](../mu-masterflow/docs/registry-cel.md).
- Local development schema/functions synchronized to `http://127.0.0.1:3210`; no production target was used. No backfill or automatic re-evaluation ran. Private before/after metadata snapshots outside Git confirmed that all original 101 Requests, 12 Specs, 6 Spaces, 4 Sessions, 93 Files, 95 output bindings, 112 Artifact records, 77 ownership links and 16 Trash entries were preserved.
- Authenticated local smoke used a disposable, worker-unassigned Spec/Space/Session/Request. It verified save, CEL resolution, stable snapshots after parent edits, frozen Request edits and explicit refresh. The Request was soft-deleted; Spec/Session/Space were archived afterward. No workload executed and no storage bytes were touched.
- MasterFlow: 57 Bun tests pass; 52 Node tests pass with one existing conditional DST skip. Frontend/backend TypeScript and Vite build pass (existing bundle-size advisory). CLI: 4 focused Python rendering/parameter tests pass, including typed Registry-derived payload handoff.
- Browser fixtures verified Space/Request Registry editors, missing-key error recovery, typed input preview/submission, light/dark themes and 390 px layout. These are fixture UI checks, not authenticated desktop E2E or native Tauri verification.
- At the phase-4 delivery, phase 5 remained unimplemented. Phase 5 is now delivered below; existing Specs retain their legacy default unless explicitly migrated.

## Phase 5 verification and integration

- Both submodules implement explicit `cel-v1` / `python-format-v1` engine contracts. Omitted engines remain legacy; unknown versions fail closed. Creation Spaces remain organizational only; captured Registry values are isolated per Request. No existing Spec/Request is auto-converted.
- CLI owns execution, bounded interpreter/profile adapters, CEL conditions and once-only rendering. MasterFlow owns diagnostics, conservative migration preview into a YAML draft, stale-draft save protection and worker engine compatibility checks at bootstrap and atomic claim.
- Migration CLI writes a new candidate only; ambiguous braces/structural names/context-dependent shared preparation require manual conversion. Canonical behavior/limits: [CLI CEL guide](../mu-cli/docs/spec-format/11-cel.md), [MasterFlow integration](../mu-masterflow/docs/spec-cel.md).
- Identical 63-case JSON conformance fixtures are committed in both independent submodules. Workspace `cmp` confirms byte parity; language-specific suites consume their local copy.
- MasterFlow: 126 Bun tests, 52 Node tests passed; one existing conditional DST test skipped. Frontend/backend TypeScript and Vite build passed (existing bundle-size advisory). CLI: 41 CPU-only tests passed, including actual HTTP master-flow batches with capability negotiation, captured Registry handoff, workloads/routines/lifecycle/conditions and migration overwrite protection.
- Self-hosted local development backend `http://127.0.0.1:3210` synchronized successfully. Private metadata snapshots outside Git before/after synchronization confirmed all 706 application documents across 20 tables are identical. No schema backfill, stored Spec conversion or physical storage operation ran in this phase.
- Header migration controls were verified by server-rendered component tests and editor/model diagnostics. Authenticated desktop/browser E2E and native Tauri build were not exercised in phase 5.
- Commit/push each changed submodule first, then commit the integration gitlinks in this parent. Graphify outputs remain ignored and local-only.

## Post-roadmap dev cleanup — 2026-11-03

The user explicitly authorized deleting development data in favor of a clean
model, so no legacy Artifact migration/adapter layer is retained.

- MasterFlow now has one canonical `artifacts` table, `physicalFiles`, and N–N
  `artifactOwners`. Request output keys/node placement live on ownership links;
  Request/node metadata arrays are derived reads, never stored copies.
- Removed old Artifact output bindings, native Convex-file handlers, backfill/
  migration scripts and obsolete catalog/link/URL APIs. Operational receipts are
  `storageUploads` / `storageClones`; orphan purge is tracked by `fileTrash`.
- CLI now retains claimed output metadata in `request.artifacts` for Copy/Share
  inputs. The S3 execution-slot protocol remains independent of canonical IDs.
- Local self-hosted dev target: `http://127.0.0.1:3210`. Schema/functions synced;
  reset/import removed 684 old business/run/Artifact documents. Database has 18
  tables and 22 retained configuration documents: 13 Specs, 7 worker tokens, one
  storage connection and one storage settings row, all matching the decoded documents
  in the pre-reset snapshot exactly. Old table names
  `artifactRecords`, `artifactClones`, `artifactTrash`, `artifactUploads` are absent.
  No bucket objects or physical storage bytes were deleted. Private snapshots
  remain outside Git.
- 122 Bun tests and 50 Node tests passed (one existing conditional DST skip),
  frontend/backend TypeScript and Vite build passed. Nine CLI Flow tests passed,
  including actual HTTP claim batches carrying derived Artifact inputs under
  both expression engines. Live authenticated Artifact browse, Specs and storage
  configuration queries succeeded after reset.
- Canonical details: [Artifact model](../mu-masterflow/docs/artifact-ownership.md),
  [Request storage protocol](../mu-masterflow/docs/request-artifacts.md), and
  [worker context](../mu-cli/docs/spec-format/07-master-flow-and-cli.md).
  Submodule changes are committed/pushed before updating this parent’s gitlinks.
