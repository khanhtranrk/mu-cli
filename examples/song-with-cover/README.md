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
the node. Mu automatically reports the final state after postcondition and
`finally`; the spec does not send node lifecycle reports. Successful upload
completion assigns `nodeName`, so Mu’s final node report inherits those artifact references.
No WAV, SRT, or other intermediate outputs are uploaded.

Uploads follow the existing [request artifact protocol](../../docs/spec-format/07-master-flow-and-cli.md#request-artifacts).
Worker authorization is sent only to the application API, never to the returned
storage upload URL. File bytes stream via `body_file`.

This example downloads models and runs GPU/media tools. Validate it with schema
checks or mocked execution; do not run the full pipeline as a routine smoke test.
