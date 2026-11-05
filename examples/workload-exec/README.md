# Standalone CPU workload

From the repository root:

```bash
bun src/index.ts workload exec ./examples/workload-exec/echo.yaml \
  --with message=hello \
  --with-json repeat=2 \
  --json
```

No server, worker configuration, GPU, model download or installation is required.
Preparation checks the Bun version. Process logs go to stderr; stdout contains:

```json
{"success":true,"outputs":{"text":"hellohello\n"}}
```

The same file can be referenced by `workloads.<alias>.source` in a pipeline Spec.
See the [CLI guide](../../docs/guides/cli.md#standalone-workload-execution) for
bindings, local context, path resolution, device selection and exit codes.
