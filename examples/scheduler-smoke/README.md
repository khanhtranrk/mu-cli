# Scheduler smoke with lifecycle events

This server-connected example uses Python sleep workloads to make GPU scheduling
visible without accessing GPU hardware or downloading models. Upload the current
`spec.yaml` to MasterFlow and create a waiting request for `scheduler-smoke` with
payload `{}`.

## Run

Configure `MU_MASTER_FLOW_SERVER` and `MU_MASTER_FLOW_TOKEN` in the environment.
From the CLI repository, run:

```sh
uv run mu master-flow run scheduler-smoke \
  --by-pipeline scheduler-smoke \
  --by-status waiting \
  --unit-id scheduler-smoke \
  --working_dir /tmp/mu-scheduler-smoke \
  --device cuda,0,8
```

The first `scheduler-smoke` argument is the saved spec slug; change it if your
uploaded spec has a different slug. `--device cuda,0,8` declares a simulated
8-unit device (32 GiB in scheduler accounting), even without a real GPU.

| Node | Units | Work | Expected behavior with 8 units |
| --- | --- | --- | --- |
| simulated-gpu-a | 6 | sleep 20s | Starts in the first wave |
| simulated-gpu-b | 6 | sleep 20s | Waits for the first heavy node to finish |
| simulated-gpu-light | 2 | sleep 10s | Runs alongside the first heavy node: 6 + 2 = 8 |
| cpu-check | 0 | sleep 3s | Runs without consuming GPU capacity |
| artifact-upload | 0 | create/upload a small text file | Runs independently; uses real server/storage endpoints |
| complete | 0 | write completion marker | Waits for all five preceding nodes |

Watch the request graph in MasterFlow. Initially, `simulated-gpu-a` and
`simulated-gpu-light` should be running together; `simulated-gpu-b` has no running
report until admitted. There is no queue event in this version. CPU work and
upload can run alongside them. Once the first heavy node finishes, the second
heavy node starts. Expect roughly 40 seconds of workload sleep on the critical
path, plus HTTP/reporting overhead; slow uploads can extend total duration.

To compare, create a fresh request and use `--device cuda,0,14`: all three GPU
workloads fit together (6 + 6 + 2), reducing the sleep critical path to about
20 seconds. Run one worker at a time for this comparison. Omitting `--device`
uses hardware detection and may fall back to CPU, which does not demonstrate the
intended capacity limit.

## Reports and outputs

Shared root event hooks report request `processing`, then `succeeded` or
`process_failed`. They report node `running`, then `succeeded` or `failed`, and
append readable start/finish logs. Terminal reports follow finally and include
blocked-node outcomes. Status mappings and HTTP payloads are defined in the spec.
Hook failures print warnings without changing workload results; inspect these
warnings if the desktop graph does not update.

Files are isolated under `/tmp/mu-scheduler-smoke/<requestId>/`:

- `simulated-gpu-a-finally.json`
- `simulated-gpu-b-finally.json`
- `scheduler-smoke-complete.json`
- `scheduler-smoke.txt`

The request's Artifacts section should contain `scheduler-smoke.txt`, associated
with `artifact-upload`. Upload remains an explicit required routine in after_run;
its failure fails the node and blocks complete. This example does not download
the uploaded file. Use a fresh waiting request for another run.
