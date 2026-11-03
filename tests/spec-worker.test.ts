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

test("real CLI loads Spec, initializes before claiming, executes CPU workload and reports solely through hooks", async () => {
  const configuration = await config();
  const paths: string[] = [], reports: unknown[] = [], notices: unknown[] = [];
  const report = (status: unknown, nodes?: unknown) => ({ type: "send_http_request", url: "${{ session.server }}/api/requests/report", method: "post", header: { Authorization: "Bearer ${{ session.token }}" }, body: { id: "${{ request.requestId }}", ...(status ? { status } : {}), ...(nodes ? { node_states: nodes } : {}) } });
  const notice = (message: string) => ({ type: "send_http_request", url: "${{ session.server }}/api/notifications/send", method: "post", header: { Authorization: "Bearer ${{ session.token }}" }, body: { title: "CPU worker", message } });
  const source = JSON.stringify({
    entries: { master_flow: { initialization: [notice("initialized")], finalization: [notice("${{ entry.status }}")] } },
    events: [
      { on: "pipeline_started", do: [report("processing")] },
      { on: "node_started", do: [report(null, { "${{ node.name }}": { status: "running" } })] },
      { on: "node_finished", do: [report(null, { "${{ node.name }}": { status: "${{ node.status == 'success' ? 'succeeded' : 'failed' }}" } })] },
      { on: "pipeline_finished", do: [report("${{ event.pipeline.status == 'success' ? 'succeeded' : 'process_failed' }}")] },
    ],
    workloads: { work: { target: "bun", units: 0, args: ["-e", "await Bun.write('completed', 'ok');"] } },
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
    const child = Bun.spawn(["bun", "src/index.ts", "worker", "once", "--server", server.url.origin, "--unit-id", "cpu", "--spec", "cpu", "--workspace", configuration.workspace], { cwd: import.meta.dir + "/..", env: { ...process.env, MU_WORKER_TOKEN: "secret" }, stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    expect(paths.indexOf("/api/notifications/send")).toBeLessThan(paths.indexOf("/api/requests/claim"));
    expect(reports).toEqual([
      { id: "r1", status: "processing" },
      { id: "r1", node_states: { work: { status: "running" } } },
      { id: "r1", node_states: { work: { status: "succeeded" } } },
      { id: "r1", status: "succeeded" },
    ]);
    expect(notices).toEqual([{ title: "CPU worker", message: "initialized" }, { title: "CPU worker", message: "success" }]);
    const runs = await readdir(join(configuration.workspace, "runs"));
    expect(await Bun.file(join(configuration.workspace, "runs", runs[0]!, "completed")).text()).toBe("ok");
    expect(await new Response(child.stdout).text()).not.toContain("secret");
    expect(await new Response(child.stderr).text()).not.toContain("secret");
  } finally { server.stop(true); }
});

test("Spec without reporting hooks sends no implicit reports", async () => {
  const configuration = await config();
  const paths: string[] = [];
  const transport = (async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname; paths.push(path);
    if (path.startsWith("/api/specs/")) return new Response("pipeline: {p: {nodes: []}}");
    if (path.endsWith("claim")) return Response.json([request]);
    return Response.json({ ok: true });
  }) as typeof fetch;
  expect(await new Worker(configuration, new DataCenterClient(configuration, transport), new SpecExecutor(configuration, new BunEffects())).run("once", new AbortController().signal)).toBe(0);
  expect(paths.some(path => path.endsWith("report"))).toBe(false);
  expect(paths.indexOf("/api/specs/cpu")).toBeLessThan(paths.indexOf("/api/requests/claim"));
});

test("invalid or GPU Specs fail before assignment", async () => {
  const configuration = await config();
  for (const source of ["pipeline: {p: {nodes: [{name: n, run: {workload: w}}]}}", "workloads: {w: {target: bun, units: 1}}\npipeline: {p: {nodes: [{name: n, run: [{type: execute_workload, workload: w}]}]}}"] ) {
    let claims = 0;
    const transport = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.startsWith("/api/specs/")) return new Response(source);
      if (path.endsWith("claim")) claims++;
      return Response.json({ ok: true });
    }) as typeof fetch;
    await expect(new Worker(configuration, new DataCenterClient(configuration, transport), new SpecExecutor(configuration, new BunEffects())).run("once", new AbortController().signal)).rejects.toThrow();
    expect(claims).toBe(0);
  }
});
