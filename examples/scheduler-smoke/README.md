# Scheduler smoke test

This example exercises the workload/pipeline runtime without downloading models
or requiring a GPU. It runs through MasterFlow so node status can be sent with
`send_http_request`. Two simulated GPU workloads each reserve **6 scheduling
units** and sleep for 20 seconds; a CPU-only workload sleeps for 3 seconds. A
final node waits for all three and writes a completion file. Every node sends
`running` before its work and `succeeded` or `failed` from `finally`. Queue
status is not reported because specs have no hook for that scheduler event.

The workloads do **not** use a GPU. Their `units` values only let you observe
how the scheduler accounts for GPU capacity.

## Run

Configure `MU_MASTER_FLOW_SERVER` and `MU_MASTER_FLOW_TOKEN`, store
`spec.yaml` in MasterFlow, and create one waiting request for the
`scheduler-smoke` pipeline with an empty payload (`{}`). From the `mu-cli`
repository root, run:

```sh
uv run mu master-flow run scheduler-smoke \
  --by-pipeline scheduler-smoke \
  --by-status waiting \
  --unit-id scheduler-smoke \
  --working_dir /tmp/mu-scheduler-smoke \
  --device cuda,0,8
```

`--device cuda,0,8` declares a scheduler-only device with 8 units (32 GiB in
the CLI's 4-GiB unit bands). It is a simulated capacity declaration; `mu-cli`
does not check whether that GPU exists, and these workloads never access it.
Because both simulated GPU nodes need 6 units, they cannot run simultaneously
on this 8-unit device. The 0-unit CPU node can run alongside one of them.
Expect about 43 seconds of workload sleep, plus startup overhead.

The exit code should be zero. In the console, look for the node dispatch and
completion messages; the second simulated GPU node should dispatch after the
first releases its units. Check the output files:

```sh
ls -l /tmp/mu-scheduler-smoke
```

Expected files:

- `simulated-gpu-a-finally.json`
- `simulated-gpu-b-finally.json`
- `scheduler-smoke-complete.json`

This example explicitly reports node states only. It does not report overall
request status, so MasterFlow may continue to show the request as possessed
after the worker finishes. Create a fresh request for another run.

The report actions use `ignore_error: true`: an unavailable report endpoint
prints a warning but does not fail the workload or change its result. If you
omit `--device`, no device capacity is declared and the scheduler uses its
existing CPU fallback for GPU-unit requests; this does not demonstrate
GPU-unit serialization.
