import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpecExecutor } from "../src/runtime/spec-executor";
import { BunEffects } from "../src/runtime/effects";
import { Worker } from "../src/worker";
import { DataCenterClient, type ClaimedRequest } from "../src/api";
import type { WorkerConfig } from "../src/config";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function config(): Promise<WorkerConfig> {
  const workspace = await mkdtemp(join(tmpdir(), "mu-spec-worker-")); directories.push(workspace);
  return { server: "http://localhost:3211", token: "secret", unitId: "cpu", specs: ["cpu"], workspace, maxClaim: 1, pollInterval: .01, heartbeatInterval: .01, fake: false };
}
const request: ClaimedRequest = { requestId: "r1", specSlug: "cpu", pipelineName: "p", assignmentVersion: 12, payload: {}, artifacts: [] };

test("real CLI loads Spec, initializes after claiming, executes CPU workload and reports without Spec hooks", async () => {
  const configuration = await config();
  const paths: string[] = [], reports: unknown[] = [], notices: unknown[] = [];
  const notice = (message: string) => ({ type: "send_http_request", url: "${{ session.server }}/api/notifications/send", method: "post", header: { Authorization: "Bearer ${{ session.token }}" }, body: { title: "CPU worker", message } });
  const source = JSON.stringify({
    entries: { master_flow: { initialization: [notice("initialized")], finalization: [notice("${{ entry.status }}")] } },
    workloads: { work: { target: "bun", units: 0, argv: ["-e", "await Bun.write('completed', 'ok');"] } },
    pipeline: { p: { nodes: [{ name: "work", run: [{ type: "execute_workload", workload: "work" }] }] } },
  });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(incoming) {
    const path = new URL(incoming.url).pathname; paths.push(path);
    expect(incoming.headers.get("authorization")).toBe("Bearer secret");
    if (path.startsWith("/api/specs/")) return new Response(source);
    if (path.endsWith("claim")) return Response.json([request]);
    if (path.endsWith("report")) { expect(incoming.headers.get("x-mu-assignment-version")).toBe("12"); reports.push(await incoming.json()); }
    if (path.endsWith("send")) notices.push(await incoming.json());
    return Response.json({ ok: true });
  } });
  try {
    const configPath = join(configuration.workspace, "cli-config.json");
    await Bun.write(configPath, JSON.stringify({ runtime: { devices: [] } }));
    const child = Bun.spawn(["bun", "src/index.ts", "worker", "once", "--config", configPath, "--server", server.url.origin, "--unit-id", "cpu", "--spec", "cpu", "--workspace", configuration.workspace], { cwd: import.meta.dir + "/..", env: { ...process.env, MU_WORKER_TOKEN: "secret" }, stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    expect(paths.indexOf("/api/notifications/send")).toBeGreaterThan(paths.indexOf("/api/requests/claim"));
    expect(reports.map((raw: any) => {const {events, node_states, ...report} = raw; return {...report, ...(node_states ? {node_states: Object.fromEntries(Object.entries(node_states).map(([key, value]: [string, any]) => {const {events, ...node} = value; return [key, node];}))} : {})};})).toEqual([
      { id: "r1", status: "processing" },
      { id: "r1", node_states: { work: { status: "queue" } } },
      { id: "r1", node_states: { work: { status: "running" } } },
      { id: "r1", node_states: { work: { status: "succeeded", outputs: {}, skipped: false, blocked: false } } },
      { id: "r1", status: "succeeded", pipelineState: {status: "success", outputs: {}} },
    ]);
    expect(notices).toEqual([{ title: "CPU worker", message: "initialized" }, { title: "CPU worker", message: "success" }]);
    const runs = await readdir(join(configuration.workspace, "runs"));
    expect(await Bun.file(join(configuration.workspace, "runs", runs[0]!, "completed")).text()).toBe("ok");
    expect(await new Response(child.stdout).text()).not.toContain("secret");
    expect(await new Response(child.stderr).text()).not.toContain("secret");
  } finally { server.stop(true); }
});

test("Spec without reporting hooks reports lifecycle automatically", async () => {
  const configuration = await config();
  const paths: string[] = [];
  const transport = (async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname; paths.push(path);
    if (path.startsWith("/api/specs/")) return new Response("pipeline: {p: {nodes: []}}");
    if (path.endsWith("claim")) return Response.json([request]);
    return Response.json({ ok: true });
  }) as typeof fetch;
  expect(await new Worker(configuration, new DataCenterClient(configuration, transport), new SpecExecutor(configuration, new BunEffects(transport))).run("once", new AbortController().signal)).toBe(0);
  expect(paths.some(path => path.endsWith("report"))).toBe(true);
  expect(paths.indexOf("/api/requests/claim")).toBeLessThan(paths.indexOf("/api/specs/cpu"));
});

test("invalid assigned Specs fail without startup preflight", async () => {
  const configuration = await config();
  for (const source of ["pipeline: {p: {nodes: [{name: n, run: {workload: w}}]}}"] ) {
    let claims = 0;
    const transport = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.startsWith("/api/specs/")) return new Response(source);
      if (path.endsWith("claim")) claims++;
      return Response.json({ ok: true });
    }) as typeof fetch;
    await expect(new Worker(configuration, new DataCenterClient(configuration, transport), new SpecExecutor(configuration, new BunEffects(transport))).run("once", new AbortController().signal)).rejects.toThrow();
    expect(claims).toBe(1);
  }
});

test("worker executes a local module with real CPU processes after claiming and resolves only once", async () => {
  const configuration = await config();
  configuration.maxClaim = 2;
  configuration.workloadBaseDir = configuration.workspace;
  const paths: string[] = [];
  const source = JSON.stringify({
    workloads: { external: { source: "module.yaml" } },
    pipeline: { p: { prepare: [{type: "ensure_workload", workload: "external"}], nodes: [{name: "n", run: [{type: "execute_workload", workload: "external"}]}] } },
  });
  await Bun.write(join(configuration.workspace, "module.yaml"), JSON.stringify({
    prepare: [{type: "execute_command", target: "bun", args: ["-e", "await Bun.write('installed', 'ready')"]}],
    workload: {target: "bun", units: 0, argv: ["-e", "if (await Bun.file('installed').text() !== 'ready') process.exit(1); await Bun.write('module-result', 'ok')"]},
  }));
  let claims = 0;
  const transport = (async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname; paths.push(path);
    if (path.startsWith("/api/specs/")) return new Response(source);
    if (path.endsWith("claim")) {claims++; return Response.json([request, {...request, requestId: "r2"}]);}
    return Response.json({ok: true});
  }) as typeof fetch;
  class Effects extends BunEffects {
    override async process(argv: string[], env: Record<string, string>, cwd: string, signal: AbortSignal) {
      expect(claims).toBe(1);
      return super.process(argv, env, cwd, signal);
    }
  }
  expect(await new Worker(configuration, new DataCenterClient(configuration, transport), new SpecExecutor(configuration, new Effects(transport))).run("once", new AbortController().signal)).toBe(0);
  const runs = await readdir(join(configuration.workspace, "runs"));
  expect(await Bun.file(join(configuration.workspace, "runs", runs[0]!, "module-result")).text()).toBe("ok");
});

test("malformed external modules fail before claiming without running installation", async () => {
  const configuration = await config(); let claims = 0;
  const source = JSON.stringify({workloads: {external: {source: "bad.yaml"}}, pipeline: {p: {nodes: []}}});
  const transport = (async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    if (path.startsWith("/api/specs/")) return new Response(source);
    if (path.endsWith("claim")) claims++;
    return Response.json({ok: true});
  }) as typeof fetch;
  const executor = new SpecExecutor(configuration, new BunEffects(transport), async () => Buffer.from("workload: {units: 1}"));
  await expect(new Worker(configuration, new DataCenterClient(configuration, transport), executor).run("once", new AbortController().signal)).rejects.toThrow("target");
  expect(claims).toBe(0);
});
