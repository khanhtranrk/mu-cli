import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("fresh CLI process resumes after SIGINT without replaying completed CPU work or claiming again", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "mu-cli-resume-"));
  const statuses: unknown[] = []; let claims = 0;
  const command = (code: string) => ({ type: "execute_command", target: "bun", args: ["-e", code] });
  const count = (name: string) => command(`const file=Bun.file('${name}');await Bun.write(file,String(Number(await file.exists()?await file.text():0)+1));`);
  const report = (status: string) => ({ type: "send_http_request", url: "${{ session.server }}/api/requests/report", method: "post", header: { Authorization: "Bearer ${{ session.token }}" }, body: { id: "${{ request.requestId }}", status } });
  const source = JSON.stringify({
    entries: { master_flow: { initialization: [count("init-count")], finalization: [count("final-count")] } },
    events: [{ on: "pipeline_started", do: [report("processing")] }, { on: "pipeline_finished", do: [report("${{ event.pipeline.status == 'success' ? 'succeeded' : 'process_failed' }}")] }],
    pipeline: { p: { prepare: [count("prepare-count")], nodes: [
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
    await Bun.write(config, JSON.stringify({ server: { url: server.url.origin }, worker: { unitId: "unit", specs: ["test"] }, runtime: { workspace, devices: [], concurrency: 1, shutdownTimeout: 1 } }));
    const spawn = (extra: string[] = []) => {
      const child = Bun.spawn(["bun", "src/index.ts", "worker", "once", "--config", config, ...extra], { cwd: import.meta.dir + "/..", env: { ...process.env, MU_WORKER_TOKEN: "private-token" }, stdout: "pipe", stderr: "pipe" });
      children.push(child); return child;
    };
    const first = spawn();
    let run = "";
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        const entries = await readdir(join(workspace, "runs"));
        if (entries[0]) { run = join(workspace, "runs", entries[0]); if (await Bun.file(join(run, "ready")).exists()) break; }
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
    expect(statuses).toEqual([{ id: "r", status: "processing" }, { id: "r" }, { id: "r", status: "succeeded" }]);
  } finally {
    for (const child of children) { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
    server.stop(true); await rm(workspace, { recursive: true, force: true });
  }
}, 10_000);
