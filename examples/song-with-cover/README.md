# Song with cover

This MasterFlow example executes workloads and uploads request artifacts using
sequential actions in each node's `run`. Configure `MU_MASTER_FLOW_SERVER` and
`MU_MASTER_FLOW_TOKEN`, store `spec.yaml` in MasterFlow, and submit a request
using the parameter shape in `input.yaml`. The notification/upload actions
require the MasterFlow session and request context.

| Node | Registered artifact ID | File |
|---|---|---|
| `generate-song` | `song-mp3` | `<name>.mp3` |
| `generate-song` | `song-abc` | `<name>.abc` (ABC notation) |
| `generate-cover` | `cover-png` | `cover.png` |
| `separate-vocals` | None | Vocals remain local for transcription |
| `transcribe-vocals` | `transcript-json` | `transcript/vocals.json` |

Each workload action skips generation when its output files already exist;
the remaining actions still hash, size, upload and register those files. Stable
artifact IDs replace earlier versions on the same request. Upload failures fail
the node. Successful upload completion assigns `nodeName`, associating each
artifact with its generating/transcribing node. No WAV, SRT, or other
intermediate outputs are uploaded.

The final `complete-request` node depends on every other pipeline node. It sends
the request-level `succeeded` status only from `finally` when that node itself
finishes successfully, after all generation, upload, and transcription work has
completed. A workload-node failure sends `process_failed`; dependent nodes are
blocked and the final success report is never sent. The final node also sends a
success notification. Entry initialization/finalization continue to send
worker-lifecycle notifications, which are separate from request status.

Report calls use `ignore_error: true`, so a temporary report API failure does
not replace the workload result. If the server is unreachable, the request may
remain in its previous status and should be inspected/retried.

## Collected artifacts

| Artifact ID | Node | File in request artifacts |
|---|---|---|
| `song-mp3` | `generate-song` | `<name>.mp3` |
| `song-abc` | `generate-song` | `<name>.abc` |
| `cover-png` | `generate-cover` | `cover.png` |
| `transcript-json` | `transcribe-vocals` | `vocals.json` |

Artifacts are registered on the MasterFlow request and shown in its **Artifacts**
section. Re-running a request with the same stable artifact IDs replaces those
artifacts with the newly uploaded files.

Uploads follow the existing [request artifact protocol](../../docs/spec-format/07-master-flow-and-cli.md#request-artifacts).
Worker authorization is sent only to the application API, never to the returned
storage upload URL. File bytes stream via `body_file`.

This example downloads models and runs GPU/media tools. Validate it with schema
checks or mocked execution; do not run the full pipeline as a routine smoke test.
