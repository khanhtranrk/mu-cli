import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
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
const request: ClaimedRequest = { requestId: "r1", pipelineSlug: "cpu", pipelineName: "cpu", assignmentVersion: 12, assignmentKey: "a".repeat(64), payload: {}, artifacts: [] };

test("worker executes a local module with real CPU processes after claiming and resolves only once", async () => {
  const configuration = await config();
  configuration.maxClaim = 2;
  configuration.workloadBaseDir = configuration.workspace;
  const paths: string[] = [];
  const source = JSON.stringify({
    workloads: { external: { source: "module.yaml" } },
    kind: "pipeline", schema_version: 1,
    prepare: [{type: "ensure_workload", workload: "external"}], nodes: [{name: "n", run: [{type: "execute_workload", workload: "external"}]}],
  });
  await Bun.write(join(configuration.workspace, "module.yaml"), JSON.stringify({
    prepare: [{type: "execute_command", target: "bun", args: ["-e", "await Bun.write('installed', 'ready')"]}],
    workload: {target: "bun", units: 0, argv: ["-e", "if (await Bun.file('installed').text() !== 'ready') process.exit(1); await Bun.write('module-result', 'ok')"]},
  }));
  let claims = 0;
  const transport = (async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname; paths.push(path);
    if (path.startsWith("/api/pipelines/")) return new Response(source);
    if (path.endsWith("claim")) {claims++; return Response.json([{...request, pipelineYaml: source}, {...request, requestId: "r2", pipelineYaml: source}]);}
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

test("malformed assigned external modules fail without running installation", async () => {
  const configuration = await config(); let claims = 0, processes = 0;
  const source = JSON.stringify({workloads: {external: {source: "bad.yaml"}}, kind: "pipeline", schema_version: 1, nodes: []});
  const transport = (async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    if (path.startsWith("/api/pipelines/")) throw new Error("Current Spec must not be read");
    if (path.endsWith("claim")) {claims++; return Response.json([{...request, pipelineYaml: source}]);}
    return Response.json({ok: true});
  }) as typeof fetch;
  class Effects extends BunEffects {override async process(): Promise<never> {processes++; throw new Error("Installation must not run");}}
  const executor = new SpecExecutor(configuration, new Effects(transport), async () => Buffer.from("workload: {units: 1}"));
  expect(await new Worker(configuration, new DataCenterClient(configuration, transport), executor).run("once", new AbortController().signal)).toBe(6);
  expect(claims).toBe(1); expect(processes).toBe(0);
});

test("worker executes the claimed single-pipeline YAML without fetching the current draft", async () => {
  const configuration = await config();
  const source = [
    "kind: pipeline",
    "schema_version: 1",
    "nodes:",
    "  - name: execute",
    "    run:",
    "      - type: execute_command",
    "        target: bun",
    "        args: ['-e', \"await Bun.write('pinned-result', 'published')\"]",
  ].join("\n");
  const paths: string[] = [];
  const transport = (async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    if (path.endsWith("claim")) {
      return Response.json([{...request, pipelineName: request.pipelineSlug, pipelineYaml: source,
        yamlSha256: createHash("sha256").update(source).digest("hex"),
        executionSha256: createHash("sha256").update(JSON.stringify([1, source, null, []])).digest("hex")}]);
    }
    return Response.json({ok: true});
  }) as typeof fetch;

  const executor = new SpecExecutor(configuration, new BunEffects(transport));
  const worker = new Worker(configuration, new DataCenterClient(configuration, transport), executor);
  expect(await worker.run("once", new AbortController().signal)).toBe(0);
  expect(paths.some(path => path.startsWith("/api/pipelines/"))).toBe(false);
  const runs = await readdir(join(configuration.workspace, "runs"));
  expect(await Bun.file(join(configuration.workspace, "runs", runs[0]!, "pinned-result")).text()).toBe("published");
});

test("rejects a claim that omits published Pipeline YAML", async () => {
  const configuration = await config();
  const paths: string[] = [];
  const transport = (async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    return Response.json(path.endsWith("claim") ? [request] : {ok: true});
  }) as typeof fetch;
  const executor = new SpecExecutor(configuration, new BunEffects(transport));
  const worker = new Worker(configuration, new DataCenterClient(configuration, transport), executor);
  await expect(worker.run("once", new AbortController().signal)).rejects.toThrow("Invalid claimed assignment");
  expect(paths.some(path => path.startsWith("/api/pipelines/"))).toBe(false);
});
