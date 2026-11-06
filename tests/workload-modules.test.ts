import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveWorkloadModules, sha256, workloadModules, moduleByteLimit } from "../src/spec/workload-modules";
import { workloadLoader } from "../src/runtime/workload-loader";
import { parseSpec } from "../src/spec/parse";
import { BunEffects } from "../src/runtime/effects";
import { Flow } from "../src/engine/flow";
import { SpecExecutor } from "../src/runtime/spec-executor";
import { Scheduler } from "../src/scheduler/scheduler";
import type { ExecutionSnapshot } from "../src/engine/checkpoint";
import type { WorkerConfig } from "../src/config";
import { loadConfig } from "../src/config";
import cases from "./fixtures/workload-modules.json";

const signal = () => new AbortController().signal;
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function directory() { const dir = await mkdtemp(join(tmpdir(), "mu-modules-")); dirs.push(dir); return dir; }
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const module = {
  routines: { install: { actions: [{ type: "execute_command", target: "module-install" }] } },
  prepare: [{ type: "execute_routine", routine: "install" }],
  workload: { target: "module-run", units: 1, device_args: ["--device", "${{ schedule.device_index }}"], inputs: { message: { type: "string", value: "${{ with.message }}" } }, argv: ["${{ inputs.message }}"], outputs: { text: { type: "string", value: "${{ result.stdout }}" } } },
};
const spec = (declaration: unknown = { source: "module.yaml" }) => ({
  routines: { install: { actions: [{ type: "execute_command", target: "global-install" }] } },
  workloads: { external: declaration, inline: { target: "inline", units: 0 } },
  pipeline: { p: { inputs: {message: {type: "string"}}, prepare: [{ type: "ensure_workload", workload: "external" }, { type: "ensure_workload", workload: "inline" }], nodes: [{ name: "n", run: [{ type: "execute_workload", workload: "external", with: { message: "${{ pipeline.inputs.message }}" }, save_to: "work" }], outputs: { text: { type: "string", value: "${{ node.actions.work.outputs.text }}" } } }] } },
});

for (const entry of cases) test(`structural contract: ${entry.name}`, () => {
  const check = () => parseSpec(JSON.stringify(entry.spec), { allowExternal: true });
  if (entry.valid) expect(check).not.toThrow(); else expect(check).toThrow();
});

test("resolve optional hashes, private routines, shared preparation, outputs and scheduler device_args", async () => {
  const cwd = await directory(), calls: string[][] = [];
  class Effects extends BunEffects {
    override async process(argv: string[]) { calls.push(argv); return { returncode: 0, stdout: "result", stderr: "" }; }
  }
  const effects = new Effects(), content = bytes(module);
  const result = await resolveWorkloadModules(JSON.stringify(spec({ source: "module.yaml", sha256: sha256(content).toUpperCase() })), async () => content, signal());
  expect(result.spec.workloads!.external!.units).toBe(1);
  expect(result.spec.routines!.install!.actions[0]!.target).toBe("global-install");
  expect(workloadModules.get(result.spec)!.get("external")!.spec.routines!.install!.actions[0]!.target).toBe("module-install");
  const flow = new Flow(result.spec, { sys: { cache_dir: cwd }, session: { working_dir: cwd } }, effects, "master_flow", new Scheduler([{ family: "cuda", index: 2, maxUnits: 1 }], 2));
  await flow.initialize(signal());
  const snapshots: ExecutionSnapshot[] = [];
  await Promise.all([1, 2].map(id => flow.execute({ pipelineName: "p", payload: {message: "literal ${{ not_rerendered }}"}, metadata: { requestId: String(id) } }, signal(), { save: async value => { snapshots.push(value); } })));
  expect(calls.filter(argv => argv[0] === "module-install")).toHaveLength(1);
  expect(calls.filter(argv => argv[0] === "global-install")).toHaveLength(0);
  expect(calls.filter(argv => argv[0] === "module-run")).toEqual([ ["module-run", "literal ${{ not_rerendered }}", "--device", "2"], ["module-run", "literal ${{ not_rerendered }}", "--device", "2"] ]);
  expect(snapshots.filter(s => s.stage === "finished").map(s => (s.context.pipeline as any).nodes.n.outputs)).toEqual([{ text: "result" }, { text: "result" }]);
});

test("reject mismatches before parsing and malformed/nested modules", async () => {
  await expect(resolveWorkloadModules(JSON.stringify(spec({source: "x", sha256: "0".repeat(64)})), async () => Buffer.from("invalid: ["), signal())).rejects.toThrow("SHA-256 mismatch");
  for (const value of [{}, {workload: {source: "nested.yaml"}}, {...module, pipeline: {}}, {...module, prepare: [{type: "ensure_workload", workload: "module"}]}, {...module, routines: {install: {actions: [{type: "execute_routine", routine: "missing"}]}}}]) {
    await expect(resolveWorkloadModules(JSON.stringify(spec()), async () => bytes(value), signal())).rejects.toThrow();
  }
  await expect(resolveWorkloadModules(JSON.stringify(spec()), async () => new Uint8Array(moduleByteLimit + 1), signal())).rejects.toThrow("size limit");
  let loads = 0;
  await expect(resolveWorkloadModules(JSON.stringify(spec({source: "x", target: "bad"})), async () => { loads++; return bytes(module); }, signal())).rejects.toThrow();
  expect(loads).toBe(0);
});

test("local paths use the supplied Spec base; server-relative paths need explicit configuration", async () => {
  const dir = await directory(); await Bun.write(join(dir, "module.yaml"), bytes(module));
  await expect(workloadLoader()("module.yaml", signal())).rejects.toThrow("workloadBaseDir");
  expect(await workloadLoader(dir)("module.yaml", signal())).toEqual(bytes(module));
  expect(await workloadLoader()(join(dir, "module.yaml"), signal())).toEqual(bytes(module));
  await expect(workloadLoader()(dir, signal())).rejects.toThrow("regular file");
  await Bun.write(join(dir, "config.yaml"), "runtime:\n  workloadBaseDir: ./modules\n");
  const config = await loadConfig({ config: join(dir, "config.yaml") }, { MU_WORKER_TOKEN: "test", MU_SERVER_URL: "http://localhost:3211", MU_UNIT_ID: "test" });
  expect(config.workloadBaseDir).toBe(join(dir, "modules"));
});

test("HTTPS redirects omit credentials, enforce HTTPS, response status, byte and redirect limits", async () => {
  const calls: RequestInit[] = [];
  const transport = (async (url: any, init: RequestInit) => {
    calls.push(init);
    return String(url).endsWith("/first") ? new Response(null, {status: 302, headers: {location: "https://other.example/module"}}) : new Response(bytes(module));
  }) as unknown as typeof fetch;
  expect(await workloadLoader(undefined, transport)("https://example.com/first", signal())).toEqual(bytes(module));
  expect(calls).toHaveLength(2);
  for (const init of calls) { expect(new Headers(init.headers).get("authorization")).toBeNull(); expect(init.credentials).toBe("omit"); }
  for (const response of [new Response("missing", {status: 404}), new Response(null, {status: 302, headers: {location: "http://example.com/x"}}), new Response(new Uint8Array(moduleByteLimit + 1))]) {
    await expect(workloadLoader(undefined, (async () => response) as unknown as typeof fetch)("https://example.com/x", signal())).rejects.toThrow();
  }
  await expect(workloadLoader(undefined, (async () => new Response(null, {status: 302, headers: {location: "/again"}})) as unknown as typeof fetch)("https://example.com/x", signal())).rejects.toThrow("redirect limit");
});

test("HTTPS loading is cancellable and bounded by timeout", async () => {
  const transport = (async (_url: any, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason), {once: true});
  })) as unknown as typeof fetch;
  await expect(workloadLoader(undefined, transport, 10)("https://example.com/x", signal())).rejects.toThrow();
  const controller = new AbortController();
  const pending = workloadLoader(undefined, transport)("https://example.com/x", controller.signal);
  controller.abort(new Error("cancelled")); await expect(pending).rejects.toThrow("cancelled");
});

test("installation lock serializes separate adapters, releases on failure, and supports cancellation", async () => {
  const dir = await directory(), first = new BunEffects(), second = new BunEffects();
  let active = 0, max = 0;
  await Promise.all([first, second].map(effects => effects.withWorkloadLock(dir, signal(), async () => {
    active++; max = Math.max(max, active); await Bun.sleep(20); active--;
  })));
  expect(max).toBe(1);
  await expect(first.withWorkloadLock(dir, signal(), async () => { throw new Error("failed installation"); })).rejects.toThrow("failed installation");
  await first.withWorkloadLock(dir, signal(), async () => {});
  await mkdir(join(dir, "workload-install.lock"));
  await expect(first.withWorkloadLock(dir, AbortSignal.timeout(10), async () => {})).rejects.toThrow();
});

test("preparation failure is shared and prevents workload dispatch", async () => {
  const dir = await directory(), calls: string[] = [];
  class Effects extends BunEffects {
    override async process(argv: string[]) { calls.push(argv[0]!); return {returncode: 1, stdout: "", stderr: "failed"}; }
  }
  const {spec: resolved} = await resolveWorkloadModules(JSON.stringify(spec()), async () => bytes(module), signal());
  const flow = new Flow(resolved, {sys: {cache_dir: dir}, session: {working_dir: dir}}, new Effects());
  await flow.initialize(signal());
  for (let i = 0; i < 2; i++) await expect(flow.execute({pipelineName: "p", payload: {message: "literal ${{ not_rerendered }}"}, metadata: {}}, signal())).rejects.toThrow();
  expect(calls).toEqual(["module-install"]);
});

test("executor pins bytes for offline recovery, without replaying installation or loading changed sources", async () => {
  const dir = await directory();
  const config: WorkerConfig = {workspace: dir, server: "https://server.example", token: "secret", unitId: "test", specs: ["test"], maxClaim: 1, pollInterval: 1, heartbeatInterval: 30, fake: false};
  const calls: string[] = [], controller = new AbortController(); let interrupted = false;
  class Effects extends BunEffects {
    override async process(argv: string[]) {
      calls.push(argv[0]!);
      if (argv[0] === "module-run" && !interrupted) { interrupted = true; controller.abort(); throw new Error("interrupted"); }
      return {returncode: 0, stdout: "result", stderr: ""};
    }
  }
  const effects = new Effects((async () => Response.json({ok: true})) as unknown as typeof fetch, () => {});
  const source = JSON.stringify(spec()); let loads = 0;
  const executor = new SpecExecutor(config, effects, async () => { loads++; return bytes(module); });
  const request = {requestId: "r", assignmentVersion: 1, specSlug: "test", pipelineName: "p", payload: {message: "literal ${{ not_rerendered }}"}, artifacts: []};
  let snapshot: ExecutionSnapshot | undefined;
  await expect(executor.execute(source, request, controller.signal, {save: async value => {snapshot = structuredClone(value);}})).rejects.toThrow();
  expect(snapshot!.stage).toBe("nodes"); expect(snapshot!.workloadModules![0]!.sha256).toBe(sha256(bytes(module)));
  expect(JSON.stringify(snapshot)).not.toContain('"token":"secret"');
  const resumed = new SpecExecutor(config, effects, async () => { throw new Error("offline; must not fetch"); });
  await resumed.execute(source, request, signal(), {snapshot, retryIncomplete: true, save: async () => {}});
  expect(loads).toBe(1); expect(calls).toEqual(["module-install", "module-run", "module-run"]);
  const broken = structuredClone(snapshot!); broken.workloadModules![0]!.sha256 = "0".repeat(64);
  await expect(new SpecExecutor(config, effects).execute(source, request, signal(), {snapshot: broken, retryIncomplete: true, save: async () => {}})).rejects.toThrow("mismatch");
});
