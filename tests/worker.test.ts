import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { DataCenterClient, ApiError, type ClaimedRequest } from "../src/api";
import { loadConfig, type WorkerConfig } from "../src/config";
import { FakeExecutor, validateEnvelope, type RequestExecutor } from "../src/runtime/fake";
import { Worker } from "../src/worker";
import { StateStore } from "../src/state";
import { main } from "../src/index";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const source = "pipelines:\n  cpu:\n    nodes:\n      - name: fake\n";
const request: ClaimedRequest = { requestId: "r1", assignmentVersion: 3, specSlug: "test", pipelineName: "cpu", payload: {}, artifacts: [] };

async function fixture(batch: ClaimedRequest[] = [request]) {
  const workspace = await mkdtemp(join(tmpdir(), "mu-phase1-"));
  directories.push(workspace);
  const config: WorkerConfig = { server: "http://localhost:3211", token: "secret", unitId: "cpu", specs: ["test"], workspace, maxClaim: 2, pollInterval: .005, heartbeatInterval: .005, fake: true };
  const calls: { path: string; body: Record<string, unknown>; headers: Headers }[] = [];
  let failReport = false;
  const transport = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const headers = new Headers(init?.headers);
    calls.push({ path, body, headers });
    expect(headers.get("Authorization")).toBe("Bearer secret");
    expect(init?.redirect).toBe("error");
    if (path.startsWith("/api/specs/")) {
      expect(headers.get("X-Mu-Expression-Engines")).toBe("cel-v1");
      return new Response(source);
    }
    if (path.endsWith("claim")) {
      expect(body.expressionEngine).toBe("cel-v1");
      expect(body.unitId).toBe("cpu");
      return Response.json(batch);
    }
    if (path.endsWith("report")) {
      expect(headers.get("X-Mu-Assignment-Version")).toBe("3");
      expect(body.artifacts).toBeUndefined();
      if (failReport && body.status === "succeeded") return new Response("secret", { status: 503 });
    }
    return Response.json({ ok: true });
  }) as typeof fetch;
  return { config, calls, api: new DataCenterClient(config, transport), failReports: () => { failReport = true; }, restore: () => { failReport = false; } };
}

test("once connects, claims once, fetches spec, runs real CPU fake subprocess, reports and disconnects", async () => {
  const setup = await fixture();
  expect(await new Worker(setup.config, setup.api, new FakeExecutor()).run("once", new AbortController().signal)).toBe(0);
  expect(setup.calls.filter(call => call.path.endsWith("claim"))).toHaveLength(1);
  expect(setup.calls.filter(call => call.path.endsWith("report")).map(call => call.body.status)).toEqual(["processing", "succeeded"]);
  expect(setup.calls[0]?.path).toBe("/api/health");
  expect(setup.calls[1]?.body.status).toBe("online");
  expect(setup.calls.at(-1)?.body.status).toBe("offline");
  expect(setup.calls.some(call => call.path.startsWith("/api/specs/"))).toBe(true);
});

test("empty batch exits without execution or report", async () => {
  const setup = await fixture([]);
  expect(await new Worker(setup.config, setup.api, new FakeExecutor()).run("once", new AbortController().signal)).toBe(0);
  expect(setup.calls.filter(call => call.path.endsWith("report"))).toHaveLength(0);
});

test("fake mode must be explicit before any network or claim", async () => {
  const setup = await fixture(); setup.config.fake = false;
  await expect(new Worker(setup.config, setup.api, new FakeExecutor()).run("once", new AbortController().signal)).rejects.toThrow("--fake");
  expect(setup.calls).toHaveLength(0);
});

test("execution failure reports process_failed and returns batch failure", async () => {
  const setup = await fixture();
  const executor: RequestExecutor = { async execute() { throw new Error("private payload"); } };
  expect(await new Worker(setup.config, setup.api, executor).run("once", new AbortController().signal)).toBe(6);
  expect(setup.calls.filter(call => call.path.endsWith("report")).at(-1)?.body).toEqual({ id: "r1", status: "process_failed" });
});

test("heartbeats continue while busy, batch executes serially with capacity one", async () => {
  const setup = await fixture([request, { ...request, requestId: "r2" }]);
  let active = 0, maximum = 0;
  const executor: RequestExecutor = { async execute() {
    active++; maximum = Math.max(maximum, active); await Bun.sleep(30); active--;
  } };
  await new Worker(setup.config, setup.api, executor).run("once", new AbortController().signal);
  expect(maximum).toBe(1);
  expect(setup.calls.filter(call => call.path.endsWith("heartbeat") && call.body.status === "online").length).toBeGreaterThan(2);
});

test("pending terminal report survives restart without replaying execution", async () => {
  const setup = await fixture();
  let executions = 0;
  const executor: RequestExecutor = { async execute() { executions++; } };
  setup.failReports();
  await expect(new Worker(setup.config, setup.api, executor).run("once", new AbortController().signal)).rejects.toBeInstanceOf(ApiError);
  expect(executions).toBe(1);
  setup.restore();
  setup.config.specs = ["test"];
  const controller = new AbortController(); controller.abort();
  expect(await new Worker(setup.config, setup.api, executor).run("once", controller.signal)).toBe(130);
  expect(executions).toBe(1);
  expect(setup.calls.filter(call => call.body.status === "succeeded")).toHaveLength(2);
});

test("interrupt drains claimed assignments as failed and stops polling", async () => {
  const setup = await fixture();
  const controller = new AbortController();
  const executor: RequestExecutor = { async execute() { controller.abort(); throw new Error("interrupted"); } };
  expect(await new Worker(setup.config, setup.api, executor).run("start", controller.signal)).toBe(130);
  expect(setup.calls.filter(call => call.path.endsWith("claim"))).toHaveLength(1);
  expect(setup.calls.some(call => call.body.status === "process_failed")).toBe(true);
});

test("state store round trips assignment generation and inputs", async () => {
  const setup = await fixture();
  const store = new StateStore(join(setup.config.workspace, "checkpoints"));
  await store.save({ request, phase: "executing" });
  expect(await store.load()).toEqual([{ request, phase: "executing" }]);
});

test("Spec envelope accepts YAML/JSON and rejects unsupported engine, missing pipeline and duplicate nodes", () => {
  validateEnvelope(source, "cpu");
  validateEnvelope(JSON.stringify({ pipelines: { cpu: { nodes: [{ name: "test" }] } } }), "cpu");
  expect(() => validateEnvelope("expression_engine: old\n" + source, "cpu")).toThrow("cel-v1");
  expect(() => validateEnvelope(source, "missing")).toThrow();
  expect(() => validateEnvelope(source + "      - name: fake\n", "cpu")).toThrow("unique");
});

test("config precedence, bounded claim size and URL validation", async () => {
  const setup = await fixture();
  const path = join(setup.config.workspace, "config.yaml");
  await Bun.write(path, "server:\n  url: http://localhost:3211\nworker:\n  unitId: file\n  specs: [test]\n");
  const config = await loadConfig({ config: path, "unit-id": "flag", fake: true }, { MU_UNIT_ID: "env", MU_WORKER_TOKEN: "secret" });
  expect(config.unitId).toBe("flag"); expect(config.specs).toEqual(["test"]);
  await expect(loadConfig({ config: path, "max-claim": "101" }, { MU_WORKER_TOKEN: "secret" })).rejects.toThrow("1 to 100");
  await expect(loadConfig({ config: path, server: "https://user:secret@host" }, { MU_WORKER_TOKEN: "secret" })).rejects.toThrow("origin");
});

test("API errors redact response body and never retry mutating calls", async () => {
  const setup = await fixture(); let calls = 0;
  const transport = (async () => { calls++; return new Response("Bearer secret", { status: 401 }); }) as unknown as typeof fetch;
  await expect(new DataCenterClient(setup.config, transport).claim("test", 1)).rejects.toThrow("HTTP 401");
  expect(calls).toBe(1);
});

test("CLI rejects unknown commands and missing option values", async () => {
  expect(await main(["worker", "once", "--invalid"])).toBe(2);
  expect(await main(["worker", "once", "--token"])).toBe(2);
  expect(await main(["unknown"])).toBe(2);
});

test("restart fails unfinished execution without running it again", async () => {
  const setup = await fixture();
  const first = new Worker(setup.config, setup.api, { async execute() {} });
  const report = setup.api.report.bind(setup.api);
  setup.api.report = async () => { throw new Error("lost processing response"); };
  await expect(first.run("once", new AbortController().signal)).rejects.toThrow();
  setup.api.report = report;
  let executions = 0;
  const controller = new AbortController(); controller.abort();
  await new Worker(setup.config, setup.api, { async execute() { executions++; } }).run("once", controller.signal);
  expect(executions).toBe(0);
  expect(setup.calls.some(call => call.body.status === "process_failed")).toBe(true);
});

test("CLI subprocess completes worker flow over loopback HTTP and doctor never claims", async () => {
  const setup = await fixture();
  const paths: string[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(incoming) {
    const path = new URL(incoming.url).pathname;
    paths.push(path);
    expect(incoming.headers.get("authorization")).toBe("Bearer secret");
    if (path.startsWith("/api/specs/")) return new Response(source);
    if (path.endsWith("claim")) return Response.json([request]);
    if (path.endsWith("report")) expect(incoming.headers.get("x-mu-assignment-version")).toBe("3");
    return Response.json({ ok: true });
  } });
  try {
    const configPath = join(setup.config.workspace, "cli-config.json");
    await Bun.write(configPath, JSON.stringify({ runtime: { devices: [] } }));
    const options = ["--config", configPath, "--server", server.url.origin, "--unit-id", "cpu", "--spec", "test", "--workspace", setup.config.workspace];
    const run = (command: string[]) => Bun.spawn(["bun", "src/index.ts", ...command, ...options], {
      cwd: import.meta.dir + "/..", env: { ...process.env, MU_WORKER_TOKEN: "secret" }, stdout: "pipe", stderr: "pipe",
    });
    const doctor = run(["worker", "doctor", "--json"]);
    expect(await doctor.exited).toBe(0);
    expect(JSON.parse(await new Response(doctor.stdout).text()).claims).toBe(0);
    expect(paths.some(path => path.endsWith("claim"))).toBe(false);
    const worker = run(["worker", "once", "--fake"]);
    expect(await worker.exited).toBe(0);
    expect(paths.filter(path => path.endsWith("report"))).toHaveLength(2);
    expect((await readdir(setup.config.workspace)).some(name => name.startsWith(".probe") || name === "worker.lock")).toBe(false);
  } finally { server.stop(true); }
});

test("pinned assignments execute without loading the mutable/default Spec at startup", async () => {
  const pinned = {...request, specYaml: source};
  const setup = await fixture([pinned]);
  const executed: string[] = [];
  const executor: RequestExecutor = {
    async prepare() { throw new Error("Preparation must happen after assignment"); },
    async execute(yaml) { executed.push(yaml); },
  };
  expect(await new Worker(setup.config, setup.api, executor).run("once", new AbortController().signal)).toBe(0);
  expect(executed).toEqual([source]);
  expect(setup.calls.some(call => call.path.startsWith("/api/specs/"))).toBe(false);
});

test("worker claims token scope or an explicit list in one batch and advertises per-device capacity", async () => {
  const setup = await fixture([]);
  setup.config.devices = [{family: "cuda", index: 1, maxUnits: 6}];
  setup.config.specs = [];
  await new Worker(setup.config, setup.api, new FakeExecutor()).run("once", new AbortController().signal);
  expect(setup.calls.find(call => call.path.endsWith("heartbeat"))?.body.devices).toEqual([
    {family: "cpu", index: 0, maxUnits: 0}, {family: "cuda", index: 1, maxUnits: 6},
  ]);
  expect(setup.calls.filter(call => call.path.endsWith("claim")).map(call => call.body)).toEqual([
    {unitId: "cpu", maxCount: 2, expressionEngine: "cel-v1"},
  ]);
  setup.config.specs = ["first", "second"];
  setup.calls.length = 0;
  await new Worker(setup.config, setup.api, new FakeExecutor()).run("once", new AbortController().signal);
  expect(setup.calls.filter(call => call.path.endsWith("claim")).map(call => call.body)).toEqual([
    {unitId: "cpu", specSlugs: ["first", "second"], maxCount: 2, expressionEngine: "cel-v1"},
  ]);
});
