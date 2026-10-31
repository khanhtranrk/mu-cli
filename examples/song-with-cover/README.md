# Song with cover

This MasterFlow example executes workloads and uploads request artifacts using
reusable routines called from each node's `after_run`. Configure `MU_MASTER_FLOW_SERVER` and
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
the upload routine still inspects, uploads and registers those files. inspect_file
provides an integer byte size and SHA-256, avoiding string-valued sizes from command stdout. Stable
artifact IDs replace earlier versions on the same request. Upload failures fail
the node. Successful upload completion assigns `nodeName`, associating each
artifact with its generating/transcribing node. No WAV, SRT, or other
intermediate outputs are uploaded.

Shared lifecycle event hooks report node running/succeeded/failed and request
processing/succeeded/process_failed. Node terminal reports follow finally and
include dependency-blocked nodes. Pipeline completion is per request, after all
nodes terminate; no complete-request node is needed. A separate pipeline-finished
hook sends the success notification. Entry initialization/finalization use the
shared notification routine for worker lifecycle notifications.

Hook failures print warnings without replacing execution results. Uploads remain
required node actions: an upload failure fails the producing node and blocks its
dependents. External reporting and upload protocols remain defined entirely in
this spec; Mu only executes lifecycle hooks, routines and generic actions.

Preparation installs Demucs and WhisperX with uv tool; workloads invoke those
installed commands directly. Ensure the uv tool executable directory is on PATH.
The yue-synth and sd-cli binaries must already exist under the configured cache
bin directory. File preconditions check their presence instead of assuming a
particular --help exit code; actual execution still verifies command success.
The existing cover_with parameter spelling is retained for request compatibility.

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
