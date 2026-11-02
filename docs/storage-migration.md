# Multi-storage cutover

MasterFlow owns storage connections, encrypted credentials, artifact records and presigned URL issuance. Mu CLI owns direct file transfers and request assignment propagation. Deploy the matching server and worker versions together.

The [artifact protocol and migration runbook](../mu-masterflow/docs/request-artifacts.md) is canonical. The [worker API](../mu-masterflow/docs/worker-hooks.md) defines token scopes and assignment generations; the [CLI integration guide](../mu-cli/docs/spec-format/07-master-flow-and-cli.md) describes worker execution. A CPU-only [artifact example](../mu-cli/examples/master-flow-artifacts/spec.yaml) exercises direct upload and download.

The initial development cutover backfilled 89 legacy artifact references without moving or deleting files. Recognized artifact handshake actions in the saved `mu-cpu-mock`, `scheduler-smoke` and `song-with-cover` specs were upgraded while preserving other workflow content. Existing tokens require explicit unit ID and allowed-spec configuration; no token mapping is inferred.

A disposable CLI request verified real private R2 upload, finalization and download. Unsigned access failed; deleting its artifact record stopped new URL issuance and retained the physical file. Only disposable test requests/specs were archived and their tokens revoked. After configuring bucket CORS, preflight succeeded for both local browser origins at port 4175 and rejected an unlisted origin. A browser at `http://127.0.0.1:4175` then uploaded directly, finalized through Convex and downloaded matching bytes successfully. Supabase and native Tauri transfer verification remain separate checks.

When moving Convex servers, transfer the database and the storage encryption key separately. External object locations and stable connection IDs remain unchanged. Preserve the old Convex files until a deliberate physical migration has been verified.

## Artifact/File identity upgrade

Creation Spaces phase 2 adds independent Artifact/File identity and ownership while preserving worker output-key payloads. Use the canonical [MasterFlow Artifact ownership migration](../mu-masterflow/docs/artifact-ownership.md#metadata-migration); track cross-repository delivery in the [upgrade tracker](creation-spaces-upgrade.md). This metadata backfill does not move or delete physical files.
