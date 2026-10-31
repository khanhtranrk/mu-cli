# 07. Entries, CLI and master flow

## Entry lifecycle

```yaml
entries:
  direct_flow:
    initialization: []
    finalization: []
  master_flow:
    initialization: []
    finalization: []
```

`mu run` selects `direct_flow`; `mu master-flow run` selects `master_flow`.
Missing entries and action lists are empty. Initialization runs once before
requests are executed (before claim in master flow). Finalization runs once
on completion, failure, or interruption after initialization begins, including
initialization failure. All finalization actions are attempted. Cleanup errors
are reported without replacing the original error. Forced termination cannot
run cleanup. Actions use the existing action fields and `ignore_error` rules.
`entry.name` identifies the entry; `entry.status` is `running`, then `success`
or `failed` during finalization. Entry actions do not receive request params.

Root `prepare` and the old `master-flow.requests` section are rejected with a
migration error. Move common setup to entry initialization and pipeline-specific
setup to `pipeline.<name>.prepare`.

## Lazy pipeline preparation

```yaml
pipeline:
  demo:
    context:
      work: "{session[cache_dir]}/demo"
    prepare:
      - type: create_dir
        path: "{work}"
    params:
      name: {type: string}
    nodes: []
```

Prepare runs once per pipeline per invocation, after a valid request selects it
and before its nodes run. It is reused across batches. Unused pipelines are
never prepared. Prepare receives the entry context merged with pipeline context;
it has no `params`, `request`, `node` or `schedule`. Its context and saved action
results are deep-copied into each request, then params and remote metadata are
added. Node contexts are deep copies again. Pipeline context is merged once per
prepared pipeline and must not depend on request input. Model discovery is
refreshed after preparation. A preparation failure is cached for this invocation;
other pipelines in the batch still execute.

## Local requests

```sh
uv run mu run --spec ./spec.yaml --working_dir ./work \
  --pipeline demo,./input.yaml \
  --pipeline demo,./other.json
```

`--pipeline NAME,FILE` is required and repeatable. Files contain a mapping or a
list of mappings. `--request` was removed and reports the replacement syntax.
Other options: `--working_dir` (current directory), `--sys_cache_dir` (`~/.cache`),
`--unit_name` (`unknown`), `--device FAMILY,INDEX,MAX_UNITS` (repeatable; otherwise
hardware detection). Workload arguments remain argv lists, without a shell.

## Master flow

```sh
uv run mu master-flow run song-generation \
  --batch-size 10 --by-pipeline song-with-cover --by-status waiting \
  --unit-id kaggle-01 --refresh-loop
```

| Option | Behavior |
|---|---|
| `--server` | Convex HTTP site URL; overrides `MU_MASTER_FLOW_SERVER` |
| `--token` | Unit bearer token; overrides `MU_MASTER_FLOW_TOKEN` |
| `--batch-size` | 1–100; default 1 |
| `--by-pipeline` | Repeatable; OR within the pipeline filter |
| `--by-status` | Repeatable; OR within the status filter; default `waiting` |
| `--by-unit-id` | Filter previous assignment, before claim |
| `--unit-id` | Receiving unit; defaults to hostname |
| `--unit-type` | Unit type; defaults to `unknown` |
| `--refresh-loop` | Claim subsequent batches until an empty array |

The resolved connection is available in templates as `{session[server]}` and
`{session[token]}` during initialization, pipeline prepare, nodes and finalization.
The server has no trailing slash; use `Authorization: "Bearer {session[token]}"`
in HTTP action headers. These fields exist only for master flow. See
[connection context and example](02-context-and-templates.md#master-flow-connection-in-session).

Working directory, system cache and device options match local execution.
Filters combine with AND between groups. At most 100 distinct pipeline/status
combinations are supported. The server selects oldest matches atomically, capped
by batch size. API status `pending` is not the standard waiting status.

Execution order:

1. Resolve connection and devices; heartbeat `online` to `/api/units/heartbeat`.
2. Fetch `/api/specs/{specSlug}` once; validate the spec.
3. Run entry initialization.
4. Claim `/api/requests/claim` with filters and `maxCount`.
5. Convert `pipelineName` and mapping `payload` into a pipeline request.
6. Prepare selected pipelines and execute batch nodes through the shared scheduler.
7. Report request `processing`, then `succeeded` or `process_failed` using
   `/api/requests/report`. Validation/preparation failures are also reported.
8. Without refresh, exit after one batch. With refresh, claim again after the
   entire batch finishes; an empty array ends the flow. A failed batch stops refresh.
9. Run finalization, then heartbeat `offline`, retaining unit details.

Remote request templates expose `{request[requestId]}` and `{request[specSlug]}`.
Payload remains exclusively under `params`. Remote payloads must be mappings even
though the server can store arbitrary JSON. Request metadata is never shared.
The transport uses a 30-second timeout and never retries mutations automatically:
a claim may commit before a connection fails. HTTP errors are fatal, not empty
batches. A request returned twice in one invocation stops the flow to prevent
unbounded execution with broad status filters. Node reporting remains spec-defined;
the worker automatically reports overall request status only.

## Scheduling

Nodes across the batch share the existing scheduler, capped at 32 concurrent
nodes. Dependencies remain local to each request. GPU units are reserved for the
full node lifecycle; `units: 0` is CPU-only. Successful subprocess output is hidden.


HTTP requests identify themselves with `User-Agent: mu/<version>`, including
HTTP actions. An action can override this through its `header` mapping. This
avoids tunnel/proxy rules that reject urllib's default library user agent.
An empty claim prints `No matching requests` and exits successfully; the default
status filter is `waiting`. A successful public health check alone does not
verify token authentication, the spec slug, or the availability of waiting work.

Node GPU reservations use the maximum workload `units` across the sequential
action lists `before_run`, `run`, and `after_run`. Mu reserves this capacity
before starting any node actions and releases it after `finally`. Conditional
workload actions are included in this maximum. See [actions](04-actions.md) for `execute_workload`.


## Request artifacts

MasterFlow stores completed files in `requests.artifacts[]`, independently of `nodeStates`. Each entry has `id`, optional `nodeName`, `name`, optional `label`, `storageId`, backend-derived `contentType`, byte `size`, and server `createdAt`. Inspection and claim responses include optional artifact metadata, available to templates under `request[artifacts]`; local requests and older server records may omit it. Completing an upload does not mutate this local context or change execution status.

Use `send_http_request` to call `POST /api/requests/artifacts/upload-url` with `requestId`, stable `artifactId`, lowercase SHA-256 and byte size. The server accepts size as a number or canonical decimal string for command stdout. It returns `uploadId`, `uploadUrl` and `expiresAt` (one hour). POST raw bytes with `body_file` to that native URL **without a worker token**. Use the returned `storageId` in `POST /api/requests/artifacts/complete` with the original `requestId`/`uploadId`, a basename `name`, and optional `nodeName`/`label`. Complete using the same unit token that started the receipt. The receipt expires after one hour; Convex native uploads have a documented two-minute POST timeout even if the client timeout is longer. The server verifies expected bytes, receipt ownership/expiry and exclusive storage binding before atomically updating one artifact. Retry completion with the same IDs if its response is lost. A new upload for an existing logical ID replaces that artifact and deletes its old file; choose a new ID to keep another version.

Download with `GET /api/requests/artifacts/download?requestId=...&artifactId=...`, a worker Authorization header and `response_file`. URL-encode query values; the example uses a simple safe artifact ID. The authenticated endpoint supports files up to 100 MiB. For larger files, `GET /api/requests/artifacts/download-url` returns `{url,name,contentType,size}`; fetch `url` with `response_file` **without a worker token**. Such direct URLs are bearer links without automatic app-level expiry. Revoking the token or soft-deleting the request does not revoke an already issued link. Native upload/download URLs can use a different host/port from `session.server`, and both must be reachable.

A request supports at most 100 stored artifacts. Soft deletion preserves files but blocks new registration/download lookups. Abandoned uploads and receipts are not automatically cleaned up. Node `artifacts` now use the same metadata-array shape as request artifacts. A `node_states` report may reference only exact registered metadata on the same request and matching assigned node. Omit the field to retain references; use `[]` to clear node references without deleting storage. Legacy path/URL maps are rejected. Completion refreshes existing node references on replacement; the first node report inherits matching files if artifacts are omitted.

See [the executable example](../../examples/master-flow-artifacts/spec.yaml), which creates and uploads a small JSON file, downloads it again and compares the bytes. Store the spec in MasterFlow, create a disposable request for its `demo` pipeline, and run `uv run mu master-flow run <spec-slug> --unit-id artifact-demo` with `MU_MASTER_FLOW_SERVER` and `MU_MASTER_FLOW_TOKEN` configured. No GPU or model downloads are required. Only run against requests intended for this test.
