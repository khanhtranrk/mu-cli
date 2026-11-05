import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Worker } from "../src/worker";
import { DataCenterClient, type ClaimedRequest } from "../src/api";
import { SpecExecutor } from "../src/runtime/spec-executor";
import { BunEffects } from "../src/runtime/effects";
import { StateStore } from "../src/state";
import type { WorkerConfig } from "../src/config";
import { Flow } from "../src/engine/flow";
import { Scheduler } from "../src/scheduler/scheduler";
import { parseSpec } from "../src/spec/parse";
import type { ExecutionSnapshot } from "../src/engine/checkpoint";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const request: ClaimedRequest = { requestId: "request", specSlug: "test", pipelineName: "p", assignmentVersion: 7, payload: {}, artifacts: [] };
const source = JSON.stringify({
  entries: { master_flow: { initialization: [{ type: "execute_command", target: "init" }], finalization: [{ type: "execute_command", target: "finalize" }] } },
  pipeline: { p: { prepare: [{ type: "execute_command", target: "prepare" }], nodes: [
    { name: "first", run: [{ type: "execute_command", target: "first" }] },
    { name: "second", depends_on: ["first"], run: [{ type: "execute_command", target: "second" }] },
    { name: "third", depends_on: ["second"], run: [{ type: "execute_command", target: "third" }] },
  ] } },
});

async function fixture(overrides: Partial<WorkerConfig> = {}) {
  const workspace = await mkdtemp(join(tmpdir(), "mu-recovery-")); directories.push(workspace);
  const config: WorkerConfig = { workspace, server: "http://localhost:3211", token: "private-worker-credential", unitId: "unit", specs: ["test"], maxClaim: 1, pollInterval: 1, heartbeatInterval: 30, fake: false, concurrency: 2, devices: [], ...overrides };
  let remoteSource = source, stale = false;
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const transport = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname, body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ path, body });
    if (path.startsWith("/api/specs/")) return new Response(remoteSource);
    if (path.endsWith("claim")) return Response.json([request]);
    if (path.endsWith("report")) {
      expect(new Headers(init?.headers).get("X-Mu-Assignment-Version")).toBe("7");
      expect(body.id).toBe("request");
      if (stale) return new Response("stale", { status: 400 });
    }
    return Response.json({ ok: true });
  }) as typeof fetch;
  const api = new DataCenterClient(config, transport);
  const scope = createHash("sha256").update(config.server + "\n" + config.unitId).digest("hex");
  const store = new StateStore(join(workspace, scope));
  return { config, api, transport, calls, store, changeSpec: () => { remoteSource += "\n"; }, stale: () => { stale = true; } };
}

async function interrupted(overrides: Partial<WorkerConfig> = {}) {
  const setup = await fixture(overrides), controller = new AbortController();
  const seen: string[] = [];
  let interrupt = true;
  class Effects extends BunEffects {
    override async process(argv: string[]) {
      seen.push(argv[0]!);
      if (argv[0] === "second" && interrupt) { controller.abort(); throw new Error("interrupted"); }
      return { returncode: 0, stdout: "", stderr: "" };
    }
  }
  const effects = new Effects(setup.transport, () => {});
  expect(await new Worker(setup.config, setup.api, new SpecExecutor(setup.config, effects)).run("once", controller.signal)).toBe(130);
  return { ...setup, seen, effects, continue: () => { interrupt = false; setup.config.resume = true; } };
}

test("interruption persists pinned Spec, completed nodes, unknown running outcome and no direct session token", async () => {
  const setup = await interrupted();
  const [checkpoint] = await setup.store.load();
  expect(checkpoint?.phase).toBe("executing"); expect(checkpoint?.source).toBe(source);
  expect(checkpoint?.execution?.states).toEqual({ first: "success", second: "running" });
  expect(checkpoint?.execution?.stage).toBe("nodes");
  expect(JSON.stringify(checkpoint)).not.toContain(setup.config.token);
  expect(setup.seen).toEqual(["init", "prepare", "first", "second", "finalize"]);
});

test("resume requires explicit retry for uncertain nodes and never replays successful work/init/prepare", async () => {
  const setup = await interrupted(); setup.continue();
  await expect(new Worker(setup.config, setup.api, new SpecExecutor(setup.config, setup.effects)).run("once", new AbortController().signal)).rejects.toThrow("--retry-incomplete");
  expect(setup.seen.filter(value => value === "second")).toHaveLength(1);
  setup.config.retryIncomplete = true;
  expect(await new Worker(setup.config, setup.api, new SpecExecutor(setup.config, setup.effects)).run("once", new AbortController().signal)).toBe(0);
  for (const label of ["init", "prepare", "first", "third"]) expect(setup.seen.filter(value => value === label)).toHaveLength(1);
  expect(setup.seen.filter(value => value === "second")).toHaveLength(2);
  expect(setup.calls.filter(call => call.path.endsWith("claim"))).toHaveLength(1);
  expect(setup.calls.filter(call => call.path.endsWith("report") && call.body.status === "succeeded")).toHaveLength(1);
  expect((await setup.store.load())[0]?.phase).toBe("reported");
});

test("normal restart refuses unfinished new checkpoints before claiming or executing", async () => {
  const setup = await interrupted();
  const count = setup.seen.length;
  await expect(new Worker(setup.config, setup.api, new SpecExecutor(setup.config, setup.effects)).run("once", new AbortController().signal)).rejects.toThrow("--resume");
  expect(setup.seen).toHaveLength(count);
  expect(setup.calls.filter(call => call.path.endsWith("claim"))).toHaveLength(1);
});

test("stale assignment or changed remote Spec refuses resume without side effects", async () => {
  for (const reason of ["stale", "spec"] as const) {
    const setup = await interrupted(); setup.continue(); setup.config.retryIncomplete = true;
    if (reason === "stale") setup.stale(); else setup.changeSpec();
    const count = setup.seen.length;
    await expect(new Worker(setup.config, setup.api, new SpecExecutor(setup.config, setup.effects)).run("once", new AbortController().signal)).rejects.toThrow();
    expect(setup.seen).toHaveLength(count);
    expect((await setup.store.load())[0]?.phase).toBe("executing");
  }
});

test("safe node-boundary checkpoint resumes pending dependencies without retry opt-in", async () => {
  const setup = await fixture();
  const controller = new AbortController(); let snapshot: ExecutionSnapshot | undefined;
  const seen: string[] = [];
  class Effects extends BunEffects {
    override async process(argv: string[]) { seen.push(argv[0]!); return { returncode: 0, stdout: "", stderr: "" }; }
  }
  const effects = new Effects(setup.transport, () => {}), executor = new SpecExecutor(setup.config, effects);
  await executor.prepare(source, "test", controller.signal);
  const executing = executor.execute(source, request, controller.signal, { async save(value) {
    snapshot = value;
    if (value.stage === "nodes" && value.states.first === "success" && !value.states.second) controller.abort();
  } });
  await expect(executing).rejects.toThrow(); await executor.finalize(true);
  expect(snapshot?.states).toEqual({ first: "success" });
  await setup.store.save({ request, reporting: "spec", phase: "executing", source, execution: snapshot });
  setup.config.resume = true;
  expect(await new Worker(setup.config, setup.api, new SpecExecutor(setup.config, effects)).run("once", new AbortController().signal)).toBe(0);
  for (const name of ["init", "prepare", "first", "second", "third"]) expect(seen.filter(label => label === name)).toHaveLength(1);
});

test("checkpoint write failure aborts node admission, drains tasks and releases reservations", async () => {
  const scheduler = new Scheduler([{ family: "cuda", index: 0, maxUnits: 2 }], 2);
  let operations = 0;
  class Effects extends BunEffects {
    override async process() { operations++; return { returncode: 0, stdout: "", stderr: "" }; }
  }
  const flow = new Flow(parseSpec(JSON.stringify({ pipeline: { p: { nodes: [{ name: "n", run: [{ type: "execute_command", target: "fake" }] }] } } })), { sys: { cache_dir: "/tmp", models: {} }, session: { working_dir: "/tmp" } }, new Effects(), "master_flow", scheduler);
  const signal = new AbortController().signal;
  await flow.initialize(signal);
  await expect(flow.execute({ pipelineName: "p", payload: {}, metadata: {} }, signal, { async save(value) { if (value.states.n === "running") throw new Error("disk unavailable"); } })).rejects.toThrow("disk unavailable");
  expect(operations).toBe(0); expect(scheduler.snapshot()).toMatchObject({ active: 0, queued: 0 });
});

test("resume rechecks completed-node postconditions before continuing and refuses missing outputs", async () => {
  const setup = await fixture();
  let pendingRuns = 0, writes = 0;
  class Effects extends BunEffects {
    override async process() { pendingRuns++; return { returncode: 0, stdout: "", stderr: "" }; }
    override async writeJson(path: string, value: unknown) { writes++; await super.writeJson(path, value); }
  }
  const effects = new Effects(setup.transport, () => {}), controller = new AbortController();
  const spec = parseSpec(JSON.stringify({ pipeline: { p: { nodes: [
    { name: "a", run: [{ type: "write_json", path: "${{ session.working_dir }}/output.json", content: {} }], postcondition: { operator: "and", props: [{ operator: "file_exists", path: "output.json" }, { operator: "node_state", target: ["status"], expected: "running" }] } },
    { name: "b", depends_on: ["a"], run: [{ type: "execute_command", target: "fake" }] },
  ] } } }));
  const base = { sys: { cache_dir: setup.config.workspace, models: {} }, session: { working_dir: setup.config.workspace } };
  const first = new Flow(spec, base, effects); await first.initialize(controller.signal);
  let snapshot: ExecutionSnapshot | undefined;
  await expect(first.execute({ pipelineName: "p", payload: {}, metadata: {} }, controller.signal, { async save(value) {
    snapshot = value;
    if (value.states.a === "success" && !value.states.b) controller.abort();
  } })).rejects.toThrow();
  expect(snapshot?.states).toEqual({ a: "success" });
  const output = join(setup.config.workspace, "output.json"); await rm(output);
  const resumed = new Flow(spec, base, effects); resumed.restore(snapshot!);
  await expect(resumed.execute({ pipelineName: "p", payload: {}, metadata: {} }, new AbortController().signal, { snapshot, async save() {} })).rejects.toThrow("postcondition");
  expect(pendingRuns).toBe(0);
  await Bun.write(output, "{}");
  expect(await resumed.execute({ pipelineName: "p", payload: {}, metadata: {} }, new AbortController().signal, { snapshot, async save() {} })).toEqual({ a: "success", b: "success" });
  expect(pendingRuns).toBe(1); expect(writes).toBe(1);
});


test("stable named scope persists its binding and resumes without replaying completed work", async () => {
  const setup = await interrupted({runDirectoryScope: "spec", runDirectoryName: "music"});
  const [checkpoint] = await setup.store.load();
  expect(checkpoint?.runDirectory).toMatchObject({scope: "spec", name: "music"});
  expect(checkpoint?.runDirectory?.path).toBe((checkpoint?.execution?.base.session as any).working_dir);
  setup.continue(); setup.config.retryIncomplete = true;
  expect(await new Worker(setup.config, setup.api, new SpecExecutor(setup.config, setup.effects)).run("once", new AbortController().signal)).toBe(0);
  for (const label of ["init", "prepare", "first", "third"]) expect(setup.seen.filter(value => value === label)).toHaveLength(1);
});

test("resume refuses changed scope/name or stored directory before verification reports and actions", async () => {
  for (const change of ["scope", "name", "path", "auto"] as const) {
    const setup = await interrupted({runDirectoryScope: "spec", runDirectoryName: "music"});
    setup.continue(); setup.config.retryIncomplete = true;
    if (change === "scope") {setup.config.runDirectoryScope = "spec-version"; delete setup.config.runDirectoryName;}
    if (change === "name") setup.config.runDirectoryName = "other";
    if (change === "auto") delete setup.config.runDirectoryName;
    if (change === "path") {
      const [saved] = await setup.store.load(); saved!.runDirectory!.path += "-moved"; await setup.store.save(saved!);
    }
    const count = setup.seen.length, reports = setup.calls.filter(call => call.path.endsWith("report")).length;
    await expect(new Worker(setup.config, setup.api, new SpecExecutor(setup.config, setup.effects)).run("once", new AbortController().signal)).rejects.toThrow("Run directory");
    expect(setup.seen).toHaveLength(count);
    expect(setup.calls.filter(call => call.path.endsWith("report"))).toHaveLength(reports);
    expect(setup.calls.filter(call => call.path.endsWith("claim"))).toHaveLength(1);
  }
});

test("legacy checkpoints without directory metadata resume only with the original versioned path", async () => {
  for (const change of [false, true]) {
    const setup = await interrupted();
    const [saved] = await setup.store.load(); delete saved!.runDirectory; await setup.store.save(saved!);
    setup.continue(); setup.config.retryIncomplete = true;
    if (change) setup.config.runDirectoryScope = "spec";
    const worker = new Worker(setup.config, setup.api, new SpecExecutor(setup.config, setup.effects));
    if (change) await expect(worker.run("once", new AbortController().signal)).rejects.toThrow("Run directory");
    else expect(await worker.run("once", new AbortController().signal)).toBe(0);
  }
});
