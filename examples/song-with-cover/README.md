# Song with cover — required uploads in finally

[spec-finally.yaml](spec-finally.yaml) ports the legacy
`mu-cli-legacy/examples/song-with-cover/spec-finally.yaml` to the current
Bun/TypeScript Spec contract. The legacy file is unchanged.

The pipeline generates song audio and ABC notation with YuE2, generates a cover
with Qwen Image, separates vocals with Demucs, then transcribes with WhisperX.
Generation actions skip existing files; required uploads still execute in Node
`finally`. Missing upload sources or transfer failures fail the Node. Failed or
blocked Nodes do not publish Outputs. Successful completion publishes four
canonical Artifact Outputs: `song_mp3`, `song_abc`, `cover_png`, `transcript_json`.

Migration details:

- Typed `inputs` replace `params`; Workloads explicitly select values from `with`
  and use `argv` for process arguments. Routine calls also use `with`.
- `save_to` replaces `save_state`. Built-in `upload_artifact` replaces the manual
  inspect/signed-PUT/complete Routine and handles assignment headers and integrity.
- Worker lifecycle reporting replaces HTTP status hooks. Optional worker-ready,
  worker-ended and successful-pipeline notifications remain a Routine.
- The request JSON parent directory is created before `write_json`.

## Requirements and submission

This is a real media/GPU example, not a CPU smoke test. Install compatible
`yue-synth` and `sd-cli` executables in `sys.cache_dir/bin`, plus Bun's worker,
`hf` and `uv`. Preparation downloads the listed model files and installs Demucs
and WhisperX if their help commands fail. It does not install the two native
executables. Check model licenses and available disk/VRAM before execution.

Use a CUDA device with at least 3 configured scheduler units; the inherited
Demucs and WhisperX device arguments explicitly target CUDA. Units are admission
weights, not a guarantee that the models fit in VRAM. Model IDs, tool options and
actual GPU behavior have not been verified by the migration checks.

Save this file as a MasterFlow Spec, create a Request for pipeline
`song-with-cover`, and run a configured worker with that Spec allowed. Its server
must support captured Request Fields, automatic lifecycle reports and canonical
Artifacts, with working private artifact storage. See
[CLI configuration](../../docs/guides/cli.md) and
[artifact actions](../../docs/reference/reporting-actions.md).

For example, Request Input declarations can be:

```json
{
  "name": {"type": "string", "value": "demo-song"},
  "style": {"type": "string", "value": "Acoustic pop"},
  "lyrics": {"type": "string", "value": "Your lyrics here"},
  "cover_prompt": {"type": "string", "value": "A painted sunrise over the sea"}
}
```

Optional `cover_with` and `cover_height` default to 1280 and 768. The spelling
`cover_with` is retained from the source Spec for compatibility. Use a simple
filesystem-safe `name`; it is also the output directory and cache key. Requests
sharing a name share cached media paths, so use distinct names for distinct work.

## Validation boundary

The migrated file passes the CLI parser and MasterFlow editor/save validators.
Fresh and cached flows were exercised with injected process/filesystem/HTTP
effects, checking four uploads, canonical Outputs and automatic lifecycle
reports. No model download, real media process, live storage or GPU job was run.
