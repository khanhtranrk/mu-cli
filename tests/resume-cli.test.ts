import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {resolveRunDirectory, type RunDirectoryScope} from "../src/run-directory";

for (const runDirectoryScope of ["spec-version", "spec"] as RunDirectoryScope[]) test(`fresh CLI process resumes after SIGINT without replaying completed CPU work or claiming again (${runDirectoryScope})`, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "mu-cli-resume-"));
  const statuses: unknown[] = []; let claims = 0;
  const command = (code: string) => ({ type: "execute_command", target: "bun", args: ["-e", code] });
  const count = (name: string) => command(`const file=Bun.file('${name}');await Bun.write(file,String(Number(await file.exists()?await file.text():0)+1));`);
  const source = JSON.stringify({
    entries: { master_flow: { initialization: [count("init-count")], finalization: [count("final-count")] } },
    pipelines: { p: { prepare: [count("prepare-count")], nodes: [
      { name: "first", run: [count("first-count")] },
      { name: "second", depends_on: ["first"], run: [command("await Bun.write('ready','yes');if(!await Bun.file('continue').exists())await Bun.sleep(60000);await Bun.write('second-output','ok');")] },
    ] } },
  });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(incoming) {
    const path = new URL(incoming.url).pathname;
    if (path.startsWith("/api/specs/")) return new Response(source);
    if (path.endsWith("claim")) { claims++; return Response.json([{ requestId: "r", assignmentVersion: 2, specSlug: "test", pipelineName: "p", payload: {}, artifacts: [] }]); }
    if (path.endsWith("report")) { expect(incoming.headers.get("x-mu-assignment-version")).toBe("2"); statuses.push(await incoming.json()); }
    return Response.json({ ok: true });
  } });
  const children: ReturnType<typeof Bun.spawn>[] = [];
  try {
    const config = join(workspace, "config.json");
    await Bun.write(config, JSON.stringify({ server: { url: server.url.origin }, worker: { unitId: "unit", specs: ["test"] }, runtime: { workspace, runDirectoryScope, ...(runDirectoryScope === "spec" ? {runDirectoryName: "resume-shared"} : {}), devices: [], concurrency: 1, shutdownTimeout: 1 } }));
    const spawn = (extra: string[] = []) => {
      const child = Bun.spawn(["bun", "src/index.ts", "worker", "once", "--config", config, ...extra], { cwd: import.meta.dir + "/..", env: { ...process.env, MU_WORKER_TOKEN: "private-token" }, stdout: "pipe", stderr: "pipe" });
      children.push(child); return child;
    };
    const first = spawn();
    let run = "";
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        run = resolveRunDirectory({workspace, server: server.url.origin, unitId: "unit", runDirectoryScope, ...(runDirectoryScope === "spec" ? {runDirectoryName: "resume-shared"} : {})}, "test", source).path;
        if (await Bun.file(join(run, "ready")).exists()) break;
      } catch {}
      await Bun.sleep(10);
    }
    expect(await Bun.file(join(run, "ready")).exists()).toBe(true);
    first.kill("SIGINT"); expect(await first.exited).toBe(130);
    expect(await Bun.file(join(workspace, "worker.lock")).exists()).toBe(false);
    await Bun.write(join(run, "continue"), "yes");
    const resumed = spawn(["--resume", "--retry-incomplete"]);
    expect(await resumed.exited).toBe(0);
    for (const name of ["init-count", "prepare-count", "first-count"]) expect(await Bun.file(join(run, name)).text()).toBe("1");
    expect(await Bun.file(join(run, "second-output")).text()).toBe("ok");
    expect(claims).toBe(1);
    expect(statuses.some((report: any) => report.node_states?.first?.status === "succeeded")).toBe(true);
    expect(statuses.some((report: any) => report.node_states?.second?.status === "succeeded")).toBe(true);
    expect(statuses.some((report: any) => report.status === "succeeded" && report.pipelineState?.status === "success")).toBe(true);
  } finally {
    for (const child of children) { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
    server.stop(true); await rm(workspace, { recursive: true, force: true });
  }
}, 10_000);
