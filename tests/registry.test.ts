import {afterEach, expect, test} from "bun:test";
import {mkdtemp, rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {registryReference, workloadSourceKind, type RegistryModule, type RegistryLock} from "../src/spec/registry-reference";
import {resolveWorkloadModules, sha256} from "../src/spec/workload-modules";
import {RegistryClient} from "../src/runtime/registry-client";
import {registryProfile} from "../src/registry-profile";
import {parseSpec} from "../src/spec/parse";
import references from "./fixtures/registry-references.json";
const dirs: string[] = [];
afterEach(async () => {for (const dir of dirs.splice(0)) await rm(dir, {recursive: true, force: true});});
const yaml = 'workload: {target: bun, units: 0, argv: [--version]}\n';
const result: RegistryModule = {registry: "https://mu.example", slug: "example", version: "1.0.0", versionId: "version-one", sha256: sha256(yaml), formatVersion: 1, yaml};
const signal = () => new AbortController().signal;
for (const item of references) test(`registry reference: ${item.name}`, () => {
  const check = () => parseSpec(JSON.stringify({workloads: {w: item.value}, pipelines: {}}), {allowExternal: true});
  if (item.valid) expect(check).not.toThrow(); else expect(check).toThrow();
});
test("source grammar is deterministic; registry misses never fall back to files or HTTPS", async () => {
  for (const source of ["example", "example@1.2.0", "mu://example@1.2.0"]) expect(workloadSourceKind(source)).toBe("registry");
  for (const source of ["./example", "../example", "/opt/example", "file.yaml", "file.yml", "file.json", "https://example.com/x"]) expect(workloadSourceKind(source)).toBe("source");
  for (const source of ["example@latest", "example@^1.0.0", "mu://server/example", "bad name"]) expect(() => workloadSourceKind(source)).toThrow();
  expect(registryReference({registry: "example", version: "1.2.0"})).toEqual(registryReference("example@1.2.0"));
  let fallback = 0;
  await expect(resolveWorkloadModules(JSON.stringify({workloads: {w: "example"}}), async () => {fallback++; return Buffer.from(yaml);}, signal(), undefined, {origin: "https://mu.example", read: async () => {throw new Error("not found");}})).rejects.toThrow("not found");
  expect(fallback).toBe(0);
});
test("registry digest/identity checks run before parsing and restore uses verified pinned provenance offline", async () => {
  const source = JSON.stringify({workloads: {w: "example"}, pipelines: {}});
  const lock: RegistryLock = {yamlSha256: sha256(source), pins: [{alias: "w", reference: "example", slug: "example", version: "1.0.0", versionId: result.versionId, sha256: result.sha256, formatVersion: 1}]};
  const noFallback = async () => {throw new Error("unexpected source load");};
  const resolved = await resolveWorkloadModules(source, noFallback, signal(), undefined, {origin: result.registry, lock, read: async () => result});
  expect(resolved.modules[0]!.registry!.versionId).toBe(result.versionId);
  const restored = await resolveWorkloadModules(source, noFallback, signal(), resolved.modules, {origin: result.registry, lock, read: async () => {throw new Error("offline");}});
  expect(restored.modules).toEqual(resolved.modules);
  for (const patch of [{registry: "https://other.example"}, {versionId: "other"}, {sha256: "0".repeat(64)}, {formatVersion: 2}, {version: "2.0.0"}]) {
    await expect(resolveWorkloadModules(source, noFallback, signal(), undefined, {origin: result.registry, lock, read: async () => ({...result, ...patch}) as RegistryModule})).rejects.toThrow();
  }
  await expect(resolveWorkloadModules(source, noFallback, signal(), undefined, {origin: result.registry, read: async () => ({...result, yaml: "invalid: ["})})).rejects.toThrow("SHA-256 mismatch");
  await expect(resolveWorkloadModules(source, noFallback, signal(), undefined, {origin: result.registry, lock: {...lock, yamlSha256: "0".repeat(64)}, read: async () => result})).rejects.toThrow("stale");
});
test("registry client authenticates only its origin, refuses redirects/oversize/mismatched payloads", async () => {
  const requests: string[] = [];
  const token = "mu_workload_v1_" + "a".repeat(64);
  const transport = (async (url: unknown, init: RequestInit) => {requests.push(String(url)); expect(init.redirect).toBe("error"); expect(init.credentials).toBe("omit"); expect(new Headers(init.headers).get("Authorization")).toBe("Bearer " + token); return Response.json(result);}) as unknown as typeof fetch;
  const client = new RegistryClient(result.registry, token, transport);
  expect(await client.read({slug: "example", version: "1.0.0"}, signal())).toEqual(result);
  expect(requests[0]).toStartWith(result.registry + "/api/workloads/resolve?");
  for (const payload of [{...result, registry: "https://foreign.example"}, {...result, version: "2.0.0"}, {...result, sha256: "0".repeat(64)}, {...result, formatVersion: 2}, {...result, versionId: null}]) {
    const c = new RegistryClient(result.registry, token, (async () => Response.json(payload)) as unknown as typeof fetch);
    await expect(c.read({slug: "example", version: "1.0.0"}, signal())).rejects.toThrow();
  }
  const big = new RegistryClient(result.registry, token, (async () => new Response(" ".repeat(2 * 1024 * 1024 + 1))) as unknown as typeof fetch);
  await expect(big.read({slug: "example"}, signal())).rejects.toThrow("size limit");
  const denied = new RegistryClient(result.registry, token, (async () => new Response(token, {status: 403})) as unknown as typeof fetch);
  try {await denied.read({slug: "example"}, signal()); throw new Error("expected failure");} catch (e) {expect((e as Error).message).not.toContain(token); expect((e as Error).message).toContain("403");}
});
test("profiles use explicit server and environment-backed workload credentials without worker auth", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mu-registry-profile-")); dirs.push(dir);
  const path = join(dir, "profiles.json"), token = "mu_workload_v1_" + "a".repeat(64);
  await Bun.write(path, JSON.stringify({defaultProfile: "personal", profiles: {personal: {server: result.registry, tokenEnv: "MY_WORKLOAD_TOKEN"}}}));
  expect((await registryProfile(undefined, {MU_PROFILES_FILE: path, MY_WORKLOAD_TOKEN: token})).origin).toBe(result.registry);
  await expect(registryProfile("missing", {MU_PROFILES_FILE: path, MY_WORKLOAD_TOKEN: token})).rejects.toThrow("existing registry profile");
  await expect(registryProfile(undefined, {MU_PROFILES_FILE: path, MY_WORKLOAD_TOKEN: "worker-token"})).rejects.toThrow("dedicated workload");
  await Bun.write(path, JSON.stringify({defaultProfile: "personal", profiles: {personal: {server: result.registry, token}}}));
  await expect(registryProfile(undefined, {MU_PROFILES_FILE: path})).rejects.toThrow("do not store plaintext");
});


test("worker execution refuses a registry Request missing its captured lock before module I/O", async () => {
  const {SpecExecutor} = await import("../src/runtime/spec-executor");
  const {BunEffects} = await import("../src/runtime/effects");
  const cwd = await mkdtemp(join(tmpdir(), "mu-registry-lock-")); dirs.push(cwd);
  let reads = 0;
  const client = new RegistryClient(result.registry, "worker-token", (async () => {reads++; throw new Error("must not read module");}) as unknown as typeof fetch);
  class Effects extends BunEffects {override async http() {return {status_code: 200, body: {ok: true}};}}
  const executor = new SpecExecutor({workspace: cwd, server: result.registry, token: "worker-token", unitId: "unit", specs: ["demo"], maxClaim: 1, pollInterval: 1, heartbeatInterval: 30, fake: false}, new Effects(), undefined, client);
  await expect(executor.execute(JSON.stringify({workloads: {w: "example"}, pipelines: {p: {nodes: []}}}), {requestId: "r", specSlug: "demo", pipelineName: "p", assignmentVersion: 1, payload: {}, artifacts: []}, signal())).rejects.toThrow("matching dependency lock");
  expect(reads).toBe(0);
});

test("published module on-key routines use the same YAML 1.1 compatibility as the worker", async () => {
  const yaml = 'routines:\n  on:\n    actions: []\nprepare:\n  - type: execute_routine\n    routine: "on"\nworkload: {target: bun, units: 0}\n';
  await expect(resolveWorkloadModules(JSON.stringify({workloads: {w: {source: "./module"}}}), async () => Buffer.from(yaml), signal())).resolves.toHaveProperty("spec.workloads.w.target", "bun");
});
