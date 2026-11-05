import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig, type WorkerConfig } from "../src/config";
import { resolveRunDirectory, runDirectoryOptions, verifyRunDirectoryContainment } from "../src/run-directory";
import { SpecExecutor } from "../src/runtime/spec-executor";
import { BunEffects } from "../src/runtime/effects";
import {DataCenterClient, type ClaimedRequest} from "../src/api";
import {Worker} from "../src/worker";
import {StateStore} from "../src/state";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture(): Promise<WorkerConfig> {
  const workspace = await mkdtemp(join(tmpdir(), "mu-run-directory-")); directories.push(workspace);
  return { workspace, server: "http://localhost:3211", token: "private-token", unitId: "unit", specs: ["s"], maxClaim: 1, pollInterval: 1, heartbeatInterval: 30, fake: false, devices: [] };
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

test("default and explicit spec-version retain the exact existing hash/path", async () => {
  const config = await fixture(), source = "pipeline: {p: {nodes: []}}";
  const expected = join(config.workspace, "runs", sha(config.server + "\n" + config.unitId + "\ns\n" + source));
  expect(resolveRunDirectory(config, "s", source)).toEqual({scope: "spec-version", path: expected});
  expect(resolveRunDirectory({...config, runDirectoryScope: "spec-version"}, "s", source).path).toBe(expected);
  for (const changed of [{server: "http://other"}, {unitId: "other"}]) expect(resolveRunDirectory({...config, ...changed}, "s", source).path).not.toBe(expected);
  expect(resolveRunDirectory(config, "other", source).path).not.toBe(expected);
  expect(resolveRunDirectory(config, "s", source + "\n").path).not.toBe(expected);
});

test("stable auto names isolate arbitrary slugs; explicit names share only within a server/unit", async () => {
  const config = {...await fixture(), runDirectoryScope: "spec" as const};
  const auto = resolveRunDirectory(config, "../some/spec", "v1");
  expect(auto.path).toBe(join(config.workspace, "runs", sha(config.server + "\n" + config.unitId), "__spec-" + sha("../some/spec")));
  expect(resolveRunDirectory(config, "../some/spec", "v2")).toEqual(auto);
  expect(resolveRunDirectory(config, "other", "v1").path).not.toBe(auto.path);
  const named = {...config, runDirectoryName: "music-production"};
  const first = resolveRunDirectory(named, "s", "v1");
  expect(first.path).toBe(join(config.workspace, "runs", sha(config.server + "\n" + config.unitId), "music-production"));
  expect(resolveRunDirectory(named, "other", "v2")).toEqual(first);
  for (const change of [{server: "http://other"}, {unitId: "other"}, {runDirectoryName: "another"}]) expect(resolveRunDirectory({...named, ...change}, "s", "v1").path).not.toBe(first.path);
});

test("config resolves field-by-field CLI precedence and validates the effective scope/name", async () => {
  const config = await fixture(), path = join(config.workspace, "config.yaml");
  const write = (runtime: object) => Bun.write(path, JSON.stringify({server: {url: config.server}, worker: {unitId: config.unitId}, runtime}));
  const env = {MU_WORKER_TOKEN: config.token};
  await write({}); expect((await loadConfig({config: path}, env)).runDirectoryScope).toBe("spec-version");
  await write({runDirectoryScope: "spec", runDirectoryName: "from-config"});
  expect(await loadConfig({config: path}, env)).toMatchObject({runDirectoryScope: "spec", runDirectoryName: "from-config"});
  expect(await loadConfig({config: path, "run-directory-name": "from-cli"}, env)).toMatchObject({runDirectoryScope: "spec", runDirectoryName: "from-cli"});
  await expect(loadConfig({config: path, "run-directory-scope": "spec-version"}, env)).rejects.toThrow("requires");
  await write({runDirectoryScope: "spec-version"});
  expect(await loadConfig({config: path, "run-directory-scope": "spec", "run-directory-name": "music"}, env)).toMatchObject({runDirectoryScope: "spec", runDirectoryName: "music"});
  await write({runDirectoryScope: "bad"});
  expect((await loadConfig({config: path, "run-directory-scope": "spec"}, env)).runDirectoryScope).toBe("spec");
  for (const runtime of [{runDirectoryScope: null}, {runDirectoryScope: 1}, {runDirectoryScope: "spec", runDirectoryName: null}]) {
    await write(runtime); await expect(loadConfig({config: path}, env)).rejects.toThrow();
  }
});

test("unsafe names, device names, auto-name collisions and invalid scopes are rejected", () => {
  for (const name of ["", " ", ".", "..", "../outside", "a/b", "a\\b", "/absolute", "C:\\data", "a.", "foo ", "MixedCase", "foo:bar", "foo?bar", "a\0b", "con", "con.txt", "nul", "com1", "lpt9.txt", "__spec-" + "a".repeat(64), "a".repeat(65), 2, null]) {
    expect(() => runDirectoryOptions("spec", name)).toThrow();
  }
  for (const scope of ["", "bad", "Spec", null, false]) expect(() => runDirectoryOptions(scope)).toThrow();
  expect(() => runDirectoryOptions(undefined, "music")).toThrow("requires");
  expect(runDirectoryOptions("spec", "a")).toEqual({runDirectoryScope: "spec", runDirectoryName: "a"});
  expect(runDirectoryOptions("spec", "a".repeat(64)).runDirectoryName).toHaveLength(64);
});

test("pre-existing symlinks cannot redirect run/cache/output directories outside the workspace", async () => {
  for (const part of ["root", "cache", "output"]) {
    const config = {...await fixture(), runDirectoryScope: "spec" as const, runDirectoryName: "shared"};
    const outside = (await fixture()).workspace, path = resolveRunDirectory(config, "s", "").path;
    await mkdir(part === "root" ? resolve(path, "..") : path, {recursive: true});
    await symlink(outside, part === "root" ? path : join(path, part), "dir");
    await expect(verifyRunDirectoryContainment(config.workspace, path)).rejects.toThrow("inside the workspace");
  }
});

test("stable scope reuses old files but initializes/prepares/executes each revised Spec", async () => {
  const config = {...await fixture(), runDirectoryScope: "spec" as const};
  const sources = (version: string) => JSON.stringify({entries: {master_flow: {initialization: [{type: "execute_command", target: "init-" + version}]}}, pipeline: {p: {
    prepare: [{type: "execute_command", target: "prepare-" + version}], nodes: [
      {name: "generate", skip_if: {operator: "file_exists", path: "${{ session.output_dir }}/cached.json"}, run: [{type: "write_json", path: "${{ session.output_dir }}/cached.json", content: {version}}]},
      {name: "current", run: [{type: "write_json", path: "${{ session.output_dir }}/current.json", content: {version, cache: "${{ session.cache_dir }}", models: "${{ sys.cache_dir }}"}}]},
    ]}}});
  const operations: string[] = [];
  class Effects extends BunEffects {
    override async process(argv: string[]) { operations.push(argv[0]!); return {returncode: 0, stdout: "", stderr: ""}; }
    override async discoverModels() { return {}; }
  }
  const effects = new Effects((async () => Response.json({ok: true})) as unknown as typeof fetch), executor = new SpecExecutor(config, effects);
  const request: ClaimedRequest = {requestId: "r", assignmentVersion: 1, specSlug: "s", pipelineName: "p", payload: {}, artifacts: []};
  try {
    for (const version of ["v1", "v2"]) await executor.execute(sources(version), {...request, assignmentVersion: version === "v1" ? 1 : 3}, new AbortController().signal);
    const path = resolveRunDirectory(config, "s", sources("v2")).path;
    expect(await Bun.file(join(path, "output/cached.json")).json()).toEqual({version: "v1"});
    expect(await Bun.file(join(path, "output/current.json")).json()).toEqual({version: "v2", cache: join(path, "cache"), models: join(homedir(), ".cache")});
    expect(operations).toEqual(["init-v1", "prepare-v1", "init-v2", "prepare-v2"]);
    // Switching scope selects a new directory, leaving old outputs unchanged.
    const versioned = new SpecExecutor({...config, runDirectoryScope: "spec-version"}, effects);
    try { await versioned.execute(sources("v2"), {...request, assignmentVersion: 5}, new AbortController().signal); }
    finally { await versioned.finalize(false); }
    expect(await Bun.file(join(path, "output/cached.json")).json()).toEqual({version: "v1"});
    expect(await Bun.file(join(resolveRunDirectory({...config, runDirectoryScope: "spec-version"}, "s", sources("v2")).path, "output/cached.json")).json()).toEqual({version: "v2"});
  } finally { await executor.finalize(false); }
});


test("reclaimed Request uses a fresh assignment in the shared directory, not old completed-node state", async () => {
  const config = {...await fixture(), runDirectoryScope: "spec" as const, runDirectoryName: "reset-shared"};
  const source = JSON.stringify({pipeline: {p: {nodes: [{name: "work", run: [{type: "execute_command", target: "work"}, {type: "write_json", path: "${{ session.output_dir }}/assignment.json", content: "${{ request.assignmentVersion }}"}]}]}}});
  let assignmentVersion = 1, runs = 0;
  const transport = (async (url: unknown) => {
    const path = new URL(String(url)).pathname;
    if (path.startsWith("/api/specs/")) return new Response(source);
    if (path.endsWith("claim")) return Response.json([{requestId: "same", assignmentVersion, specSlug: "s", pipelineName: "p", payload: {}, artifacts: [], specYaml: source}]);
    return Response.json({ok: true});
  }) as typeof fetch;
  class Effects extends BunEffects {
    override async process() {runs++; return {returncode: 0, stdout: "", stderr: ""};}
    override async discoverModels() {return {};}
  }
  for (const version of [1, 3]) {
    assignmentVersion = version;
    expect(await new Worker(config, new DataCenterClient(config, transport), new SpecExecutor(config, new Effects(transport))).run("once", new AbortController().signal)).toBe(0);
  }
  expect(runs).toBe(2);
  const directory = resolveRunDirectory(config, "s", source);
  expect(await Bun.file(join(directory.path, "output/assignment.json")).json()).toBe(3);
  const [checkpoint] = await new StateStore(join(config.workspace, sha(config.server + "\n" + config.unitId))).load();
  expect(checkpoint?.request.assignmentVersion).toBe(3); expect(checkpoint?.runDirectory).toEqual(directory);
});
