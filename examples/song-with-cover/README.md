# Song with cover

This MasterFlow example executes workloads and uploads request artifacts using
sequential actions in each node's `run`. Configure `MU_MASTER_FLOW_SERVER` and
`MU_MASTER_FLOW_TOKEN`, store `spec.yaml` in MasterFlow, and submit a request
using the parameter shape in `input.yaml`. The notification/report/upload actions
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
the node and prevent its `after_run` success report. Successful upload completion
assigns `nodeName`, so the following node report inherits those artifact references.
No WAV, SRT, or other intermediate outputs are uploaded.

Uploads follow the existing [request artifact protocol](../../docs/spec-format/07-master-flow-and-cli.md#request-artifacts).
Worker authorization is sent only to the application API, never to the returned
storage upload URL. File bytes stream via `body_file`.

This example downloads models and runs GPU/media tools. Validate it with schema
checks or mocked execution; do not run the full pipeline as a routine smoke test.
