# Built-in reporting and artifact actions

All actions use the existing CEL context, conditions, `ignore_error`,
`postcondition` and `save_to` handling. Saved results include `success` and
`error`; failures propagate to the node unless explicitly ignored. Artifact transfers remain Spec-controlled; lifecycle status and typed Outputs are worker-owned. Lifecycle hook failures retain the engine's
existing warning behavior; put required reports/transfers in node actions when
failure must fail execution.

These actions require active `session.server`, `session.token`,
`request.requestId` and `request.assignmentVersion`; `report_node` additionally
require `node.name` when sending node fields. The worker supplies these contexts.
Storage requests never receive worker credentials. All paths below resolve
relative to `session.working_dir`.

| Action | Parameters | Saved result beyond success/error |
| --- | --- | --- |
| `report_request` | Optional request `events`; `timeout` (seconds, default 120) | No additional fields |
| `report_node` | Optional node `events`; `timeout` (seconds, default 120) | No additional fields |
| `inspect_file` | Required `target` local path | `path` (absolute), `name`, `size` (bytes), `sha256`, `contentType` |
| `upload_artifact` | Required `target`, `artifact_id`; optional `connection_id`, `content_type`, `label`, `timeout` (default 120 seconds per call) | `artifact` registered Request output metadata |
| `download_artifact` | Required destination `target`, canonical `artifact` object; optional expected `sha256`, `timeout` (default 120 seconds per call) | `path`, `name`, `size`, `sha256`, `contentType` for downloaded local file |

`report_request` and `report_node` append events for their own scope. Spec-authored
`status` is rejected: the engine automatically reports Request processing/succeeded/
process_failed and Node queue/running/succeeded/failed. Event-only actions leave
status unchanged. Mandatory status reports use the same endpoint and assignment
context as these actions, and include standard lifecycle events. Status/Outputs are idempotent; event append
remains at-least-once when an uncertain report is retried or recovered.

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
        events: [{level: info, message: Request started}]
  - on: node_finished
    do:
      - type: report_node
        events:
          - level: info
            message: 'Finished ${{ node.name }}'
# In a node's after_run:
# - type: upload_artifact
#   target: '${{ session.output_dir }}/result.json'
#   artifact_id: result
#   content_type: application/json
#   save_to: published
# In a dependent node's run:
# - type: download_artifact
#   artifact: '${{ pipeline.nodes.publish.outputs.published }}'
#   target: '${{ session.output_dir }}/downloaded.json'
#   save_to: downloaded
```

See the runnable [CPU round trip](../../examples/cpu-artifacts/spec.yaml) and
[server protocol](protocol.md). Deploy the companion MasterFlow event/checksum
contract before using these actions. Existing persisted artifact-specific statuses
are projected as lifecycle statuses there: `artifact_available` → `processing`,
`retrieve_artifact_failed` → `process_failed`. New reports cannot write them.

## Notifications

`send_notification` requires nonempty string `title` and `message`, and accepts
optional string `tags`. All three support CEL expressions. It sends JSON to
`POST {session.server}/api/notifications/send` with the active session bearer
token. It needs no Request or Node identity. Omitted tags are absent from JSON;
Data Center stores a supplied string as one tag (no splitting). Existing API
clients may continue sending tag arrays.

`save_to` captures `status_code`, `headers`, `body`, `success` and `error`, like
`send_http_request`. Delivery errors fail the action; normal `ignore_error` and
hook warning behavior apply. The call has a 30-second timeout and is not retried
automatically, avoiding duplicate notifications after uncertain delivery.

See the runnable [notification Spec](../../examples/notification/spec.yaml).
Uploads now complete with filename and optional label only. Deploy the companion
Data Center contract and follow its receipt cleanup runbook before schema removal.

Storage connections can use R2, Supabase Storage, or Google Drive. The actions
use MasterFlow-issued transfer URLs for every provider. Google Drive credentials
and download routing are managed by MasterFlow.

When an artifact HTTP transfer fails, the worker writes a diagnostic to stderr
with the Request ID, action, and failing stage. The node error also includes
the stage. `upload-url` and `complete` refer to MasterFlow API calls, while
`storage PUT` and `storage GET` refer to the file transfer itself. Logs omit
signed URLs, credentials, and arbitrary upstream error text.
