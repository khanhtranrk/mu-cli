# CPU artifact round trip

Import `spec.yaml` into MasterFlow and create a `demo` pipeline request. Optional
payload: `{"message":"hello"}`. Authorize the Spec slug for the worker token and
configure `runtime.devices: []` to force CPU-only execution.

The Spec generates JSON, uploads it using the current receipt protocol, downloads
it through a signed URL and verifies size/SHA-256. All reports and artifact calls
use existing Spec routines/actions. Completion alone has one bounded idempotent
retry; the upload is not retried automatically.

See [Phase 4](../../docs/phase-4.md) for setup, test commands and recovery limits.
