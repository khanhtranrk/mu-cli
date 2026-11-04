# CPU artifact round trip

This example uses the Issue #8 `inputs`/`with`/`argv` contract. MasterFlow’s
separate editor and Request validator still require a companion migration from
`params`; do not assume its current Request form supports this schema. The CLI
integration test seeds this Spec and its Request directly. Optional
payload: `{"message":"hello"}`. Authorize the Spec slug for the worker token and
configure `runtime.devices: []` to force CPU-only execution.

The Spec generates JSON, uploads it using the current receipt protocol, downloads
it through a signed URL and verifies size/SHA-256. All reports and artifact calls
use built-in `report_request`, `report_node`, `upload_artifact` and `download_artifact` actions. Completion alone has one bounded idempotent
retry; the upload is not retried automatically.

See the [action reference](../../docs/reference/reporting-actions.md) for parameters,
results and legacy checksum handling. Both transfer failures report `process_failed`;
availability is represented by registered artifacts.

See [Phase 4](../../docs/tasks/completed/phase-4.md) for setup, test commands and recovery limits.

The Workload explicitly resolves each Input Field from `with`; extra invocation
keys never become inputs. `argv` uses the resolved Workload `inputs`. See the
[Field and null semantics](../../docs/reference/spec-engine.md#shared-input-fields).
