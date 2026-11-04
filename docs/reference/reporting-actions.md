# Built-in reporting and artifact actions

All actions use the existing CEL context, conditions, `ignore_error`,
`postcondition` and `save_state` handling. Saved results include `success` and
`error`; failures propagate to the node unless explicitly ignored. Reporting and
transfer remain Spec-controlled. Lifecycle hook failures retain the engine's
existing warning behavior; put required reports/transfers in node actions when
failure must fail execution.

These actions require active `session.server`, `session.token`,
`request.requestId` and `request.assignmentVersion`; `report_node` additionally
require `node.name` when sending node fields. The worker supplies these contexts.
Storage requests never receive worker credentials. All paths below resolve
relative to `session.working_dir`.

| Action | Parameters | Saved result beyond success/error |
| --- | --- | --- |
| `report_request` | Optional request `status`, `events`; `timeout` (seconds, default 120) | No additional fields |
| `report_node` | Optional node `status`, `events`; `timeout` (seconds, default 120) | No additional fields |
| `inspect_file` | Required `target` local path | `path` (absolute), `name`, `size` (bytes), `sha256`, `contentType` |
| `upload_artifact` | Required `target`, `artifact_id`; optional `connection_id`, `content_type`, `node_name`, `label`, `timeout` (default 120 seconds per call) | `artifact` registered Request output metadata |
| `download_artifact` | Required destination `target`, `artifact_id`; optional expected `sha256`, `timeout` (default 120 seconds per call) | `path`, `name`, `size`, `sha256`, `contentType` for downloaded local file |

`report_request` and `report_node` send only explicitly supplied fields: no implicit status change.
They update separate scopes: `report_request` never sends node updates and needs no
node context; `report_node` only updates the current node. The former mixed-scope
`request_status`/`request_events` parameters are rejected; use a separate
`report_request` action with `status`/`events` instead.
Node statuses are `queue`, `running`, `failed`, `succeeded`; request statuses a
worker can report are `processing`, `process_failed`, `succeeded`. Engine node
`success` maps to report `succeeded` explicitly in the example below.

Both event lists use `{level: "info" | "warning" | "error", message: string,
details?: object, createdAt: number}`. The action fills missing `createdAt` with
current epoch milliseconds. Additional event fields are rejected. MasterFlow
appends arrays atomically, preserves omitted/empty arrays, and updates status
independently. A first event-only node report initializes its status to `queue`.
Request reset clears both request and node events.

Uploads inspect a regular file with a streaming SHA-256, negotiate a signed PUT,
send raw bytes with the returned headers, check the opened source's identity and
stat signature during transfer, inspect again, and complete the receipt. Content
type defaults to Bun's filename-based MIME type or `application/octet-stream`;
`content_type` overrides it. Completion retries once with identical details for
transport uncertainty/timeouts or HTTP 500/502/503/504. PUT and URL issuance are
never automatically retried; permanent failures propagate. Retry does not create
another upload receipt. Cancellation prevents retry.

Downloads obtain signed metadata, stream into a temporary file, and check size
and SHA-256 before atomically replacing the destination. Failed HTTP, timeout,
size or digest checks leave an existing destination intact. An expected digest
must come from signed metadata or the action's explicit `sha256`; conflicting
digests fail before transfer. Older persisted files may lack a digest: supply an
expected value or the action fails clearly. Server digests are upload declarations,
not independently verified security attestations.

```yaml
events:
  - on: pipeline_started
    do:
      - type: report_request
        status: processing
        events: [{level: info, message: Request started}]
  - on: node_finished
    do:
      - type: report_node
        status: '${{ node.status == "success" ? "succeeded" : "failed" }}'
        events:
          - level: info
            message: 'Finished ${{ node.name }}'
# In a node's after_run:
# - type: upload_artifact
#   target: '${{ session.output_dir }}/result.json'
#   artifact_id: result
#   content_type: application/json
#   save_state: published
# In a dependent node's run:
# - type: download_artifact
#   artifact_id: result
#   target: '${{ session.output_dir }}/downloaded.json'
#   save_state: downloaded
```

See the runnable [CPU round trip](../../examples/cpu-artifacts/spec.yaml) and
[server protocol](protocol.md). Deploy the companion MasterFlow event/checksum
contract before using these actions. Existing persisted artifact-specific statuses
are projected as lifecycle statuses there: `artifact_available` → `processing`,
`retrieve_artifact_failed` → `process_failed`. New reports cannot write them.
