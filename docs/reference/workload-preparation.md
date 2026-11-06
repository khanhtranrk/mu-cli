# Workload preparation and installation locks

A pipeline's first Request starts its preparation. Concurrent Requests in the same Flow/pipeline share that preparation; different pipelines/Flows may prepare concurrently. Preparation still happens before device admission and node execution. Standalone `mu workload exec` prepares automatically. Existing inline workloads keep their existing explicit setup behavior.

## Sequential preparation

Action lists run sequentially. External workload modules with no installation metadata use an exclusive cache-wide installation lock. Module-level shorthand narrows the lock scope:

```yaml
installation:
  resources: [yue2-runtime-v1, yue2-models-v1]
prepare:
  - type: execute_routine
    routine: install_yue2
workload:
  target: python
  argv: [inference.py]
```

The module takes **all** resource locks before running preparation and holds them through cleanup. If either resource is busy, no preparation action starts. Readiness checks and `skip_if` inside the preparation run while locked. Scripts must tolerate retries and partial installation; locks do not establish an installed state.

## Parallel installation groups

Use explicit independent branches to download a model while waiting for a runtime lock:

```yaml
routines:
  install_runtime:
    actions:
      - type: execute_command
        target: ./install-runtime.sh
  download_model:
    actions:
      - type: execute_command
        target: ./download-model.sh
prepare:
  - type: parallel
    save_to: preparation
    actions:
      - type: installation_group
        resources: [yue2-runtime-v1]
        actions:
          - type: execute_routine
            routine: install_runtime
      - type: installation_group
        resources: [yue2-model-3-v1]
        actions:
          - type: execute_routine
            routine: download_model
workload:
  target: python
  argv: [inference.py]
```

Each group waits independently, runs its child actions sequentially under all its locks, and releases them after process cleanup. `parallel` waits for every branch; later actions wait for the join. The first unsuppressed failure cancels siblings and waits for their cleanup before propagating that failure. Parent cancellation joins every branch too.

Branches receive isolated copies of the incoming context. Their `save_to` results and context changes never merge into the parent or siblings. `parallel.save_to`, when present, saves only `{success, error}` using ordinary action-result semantics; it does not collect branch outputs.

Both new actions are initially restricted to workload-module preparation and its private routines. They are not general node/lifecycle actions. Lists outside explicit `parallel` remain sequential. Groups cannot nest, and parallel actions cannot nest, including through routine calls. A parallel action inside a group is permitted if its branches do not acquire more locks. Container actions accept only `type`, `actions`, group `resources`, and parallel `save_to`; put conditions on the actions/routines inside a group so they execute under its locks.

Grouped modules must put all preparation effects inside groups; orchestration routines and parallel actions may sit outside. Do not combine groups with module-level `installation.resources`. Modules using parallel alone retain the global lock unless module-level resources are declared. There are at most 64 child actions per container and 64 resources per scope.

## Choosing resource keys

Keys are coordination labels, not paths or workload versions. Use 1–128 ASCII letters/digits/dot/underscore/hyphen, beginning with a letter/digit. Lists must be nonempty, unique and static. Two installers modifying the same environment/files must use matching keys even if their module aliases or registry versions differ. Different version labels are safe only for independent installation paths.

Keys share the canonical MU cache namespace across worker and standalone processes. The global fallback excludes every scoped group; scoped groups share a cache gate and acquire resource locks in sorted order. Independent groups can proceed concurrently. Locks cover preparation writes, not inference: avoid mutating an environment currently used by a running workload.

## Waiting, cancellation and crash handling

There is no default acquisition timeout. Set `MU_WORKLOAD_LOCK_WAIT_MS` to a positive integer to bound the total acquisition wait for each group/module/global scope. It does not limit installation duration. Diagnostics identify the waiting workload/resource and elapsed time, at most once every five seconds per scope; standalone diagnostics remain on stderr.

A separate Bun supervisor owns OS advisory locks and executes installer commands. Worker cancellation or loss of its input pipe cancels and joins installer process groups before releasing locks. Normal success/failure also waits for cleanup. Persistent files under `<cache>/.workload-locks` are lock identities, not stale ownership markers: do not delete them while workers run. Resource lock filenames are SHA-256 digests of labels.

Supported lock backend: Linux with glibc and macOS on local filesystems. Linux process/crash behavior is exercised by CPU tests; macOS requires platform verification. Windows is currently unsupported by this backend and installation fails clearly. Network filesystem locking semantics are outside the supported contract; use a local cache. Installers must not daemonize or deliberately detach descendants from the supervised process group. Killing the supervisor itself can bypass descendant cleanup; stop the entire worker/install process tree before restarting after such an incident.

### Upgrading from directory locks

Do not run older and newer installers against the same cache during upgrade. Stop old workers and their installer children first. If `<cache>/workload-install.lock` remains, inspect its owner and remove it only after confirming no installer is active. New workers reject this legacy artifact instead of automatically stealing/removing it. The new OS lock files are never automatically unlinked or reclaimed by PID/age guesses.

## Models, registry and recovery

`sys.models` is still scanned after the pipeline's own complete preparation, under `<sys.cache_dir>/models`. Resource labels do not create model directories or change discovery. Prefer `models/<workload>/` and qualified keys such as `sys.models["yue2/model"]`. Download into a non-model temporary suffix and atomically rename completed files before returning; readers must not see partial model files. Each pipeline explicitly ensures its own dependencies.

Local, HTTPS and MU registry modules use the same preparation contract. Exact raw bytes/digests and installation declarations remain pinned in recovery snapshots; new syntax does not change module formatVersion or silently rewrite publications. Upgrade MasterFlow validation and workers together before publishing modules with the new syntax. Older readers reject unsupported syntax.

A runnable CPU-only example is [parallel.yaml](../../examples/workload-exec/parallel.yaml): `mu workload exec ./examples/workload-exec/parallel.yaml --json`. It prepares two cache markers without downloading dependencies or models.

## Compiled releases

The compiled executable embeds its installation supervisor and starts it through a private internal entrypoint, before public CLI argument parsing. No external Bun installation is required for that helper; workload programs still need their own declared executables. Source mode continues to run the supervisor with the current Bun interpreter.

The release workflow runs `bun scripts/smoke-compiled.ts ./dist/mu-cli-linux-x64` against the actual artifact before checksumming or publishing it. This CPU-only check removes Bun from the child PATH and verifies sequential/parallel preparation, cancellation and lock reuse. The Linux x64 regression test compiles with the same release target.
