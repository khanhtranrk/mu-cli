import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "mu-commander-")); directories.push(path); return path;
}
function spawn(args: string[], cwd: string, env: Record<string, string> = {}) {
  return Bun.spawn([process.execPath, join(import.meta.dir, "../src/index.ts"), ...args], {
    cwd, env: { PATH: process.env.PATH, ...env }, stdout: "pipe", stderr: "pipe",
  });
}
async function cli(args: string[], cwd: string, env: Record<string, string> = {}) {
  const child = spawn(args, cwd, env);
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, out, err };
}
const auth = ["--server", "http://127.0.0.1:3211", "--token", "private", "--unit-id", "unit", "--fake"];

test("root, group, leaf and help command use nested Commander help without loading config", async () => {
  const cwd = await fixture();
  for (const args of [[], ["help"], ["--help"], ["worker", "--help"], ["config", "--help"],
    ...["once", "start", "doctor", "info"].map(name => ["worker", name, "--help"]),
    ["config", "init", "--help"], ["config", "show", "--help"], ["help", "worker"], ["worker", "help", "once"]]) {
    const result = await cli(args, cwd); expect(result.code).toBe(0); expect(result.out).toContain("Usage: mu");
  }
  expect((await cli(["worker", "once", "--help"], cwd)).out).toContain("--spec <slug>");
  expect((await cli(["version"], cwd)).out).toContain("mu-cli 0.4.0-phase4");
});

test("invalid commands, missing values, unknown options and extra arguments return 2", async () => {
  const cwd = await fixture();
  for (const args of [["nope"], ["worker", "nope"], ["config", "nope"], ["version", "extra"],
    ["worker", "once", "--unknown"], ["worker", "once", "--spec"], ["worker", "info", "extra"],
    ["worker", "once", "--concurrency", "33", ...auth], ["worker", "once", "--retry-incomplete", ...auth],
    ["worker", "once", "--config", "missing.yaml"]]) {
    expect((await cli(args, cwd)).code).toBe(2);
  }
});

test("init honors output and force; show/info preserve precedence, repeated options and redaction", async () => {
  const cwd = await fixture();
  expect((await cli(["config", "init", "--output", "sample.yaml"], cwd)).code).toBe(0);
  expect((await cli(["config", "init", "--output", "sample.yaml"], cwd)).code).toBe(2);
  expect((await cli(["config", "init", "--output", "sample.yaml", "--force"], cwd)).code).toBe(0);
  for (const command of [["config", "show"], ["worker", "info"]]) {
    const result = await cli([...command, "--config", "sample.yaml", "--server", "http://localhost:9999", "--unit-id", "cli",
      "--spec", "one", "--spec=two", "--device", "nvidia,0,2", "--device", "rocm,1,3", "--workspace", "state",
      "--max-claim", "7", "--concurrency", "4", "--poll-interval", "2", "--heartbeat-interval", "3", "--shutdown-timeout", "5",
      "--resume", "--retry-incomplete", "--fake", "--json"], cwd,
      { MU_SERVER_URL: "http://localhost:8888", MU_UNIT_ID: "env", WORKER_TOKEN: "secret" });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ server: "http://localhost:9999", unitId: "cli", specs: ["one", "two"],
      token: "[REDACTED]", maxClaim: 7, concurrency: 4, pollInterval: 2, heartbeatInterval: 3, shutdownTimeout: 5,
      resume: true, retryIncomplete: true, fake: true, devices: [{ family: "cpu", index: 0 },
        { family: "cuda", index: 0, maxUnits: 2 }, { family: "rocm", index: 1, maxUnits: 3 }] });
    expect(result.out).not.toContain("secret");
  }
});

test("worker/doctor route API errors correctly and release owned locks on success and failure", async () => {
  const cwd = await fixture(); let status = 200; let malformed = false; let claims = 0;
  const source = "pipeline:\n  p:\n    nodes:\n      - name: fake\n";
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    if (status !== 200) return new Response("error", { status });
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/specs/")) return new Response(source);
    if (path.endsWith("claim")) { claims++; return Response.json(malformed ? {} : []); }
    return Response.json({ ok: true });
  } });
  const args = ["--server", server.url.origin, "--token", "private", "--unit-id", "unit", "--spec", "test", "--fake"];
  try {
    for (const [http, code] of [[401, 3], [403, 3], [500, 4], [200, 0]] as const) {
      status = http;
      for (const mode of ["once", "doctor"]) {
        expect((await cli(["worker", mode, ...args], cwd)).code).toBe(code);
        expect(await Bun.file(join(cwd, ".mu/worker.lock")).exists()).toBe(false);
      }
    }
    expect(claims).toBe(1); // doctor never claims
    malformed = true;
    expect((await cli(["worker", "once", ...args], cwd)).code).toBe(5);
    expect(await Bun.file(join(cwd, ".mu/worker.lock")).exists()).toBe(false);
    await Bun.write(join(cwd, ".mu/worker.lock"), "other worker");
    expect((await cli(["worker", "once", ...args], cwd)).code).toBe(5);
    expect(await Bun.file(join(cwd, ".mu/worker.lock")).text()).toBe("other worker");
  } finally { server.stop(true); }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) test(`${signal} awaits offline heartbeat before removing lock and exiting`, async () => {
  const cwd = await fixture(); let ready!: () => void; const claimed = new Promise<void>(resolve => { ready = resolve; });
  let lockDuringOffline = false; let offline = false;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    if (new URL(request.url).pathname.endsWith("claim")) { ready(); return Response.json([]); }
    if (request.method === "POST" && (await request.json() as { status?: string }).status === "offline") {
      lockDuringOffline = await Bun.file(join(cwd, ".mu/worker.lock")).exists();
      await Bun.sleep(50); offline = true;
    }
    return Response.json({ ok: true });
  } });
  const child = spawn(["worker", "start", "--server", server.url.origin, "--token", "private", "--unit-id", "unit", "--spec", "test", "--fake"], cwd);
  try {
    await Promise.race([claimed, Bun.sleep(3000).then(() => { throw new Error("worker did not claim"); })]);
    child.kill(signal); expect(await child.exited).toBe(130);
    expect(offline).toBe(true); expect(lockDuringOffline).toBe(true);
    expect(await Bun.file(join(cwd, ".mu/worker.lock")).exists()).toBe(false);
  } finally { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; server.stop(true); }
}, 5000);

test("fake once claims and reports without executing Spec actions, retaining batch failure code 6", async () => {
  const cwd = await fixture(); const reports: string[] = []; let valid = true;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/specs/")) return new Response(valid
      ? JSON.stringify({ pipeline: { p: { nodes: [{ name: "action", run: [{ type: "execute_command", target: "bun", args: ["-e", "await Bun.write('should-not-exist','executed')"] }] }] } } })
      : "pipeline: {}");
    if (path.endsWith("claim")) return Response.json([{ requestId: valid ? "success" : "failure", assignmentVersion: 1, specSlug: "test", pipelineName: "p", payload: {}, artifacts: [] }]);
    if (path.endsWith("report")) reports.push((await request.json() as { status: string }).status);
    return Response.json({ ok: true });
  } });
  const args = ["worker", "once", "--server", server.url.origin, "--token", "private", "--unit-id", "unit", "--spec", "test", "--fake"];
  try {
    expect((await cli(args, cwd)).code).toBe(0);
    expect(await Bun.file(join(cwd, "should-not-exist")).exists()).toBe(false);
    valid = false;
    expect((await cli(args, cwd)).code).toBe(6);
    expect(reports).toEqual(["processing", "succeeded", "processing", "process_failed"]);
    expect(await Bun.file(join(cwd, ".mu/worker.lock")).exists()).toBe(false);
  } finally { server.stop(true); }
});


test("run directory flags appear in help and resolved config; invalid settings fail before network", async () => {
  const cwd = await fixture();
  for (const command of [["worker", "once"], ["worker", "start"], ["worker", "doctor"], ["worker", "info"], ["config", "show"]]) {
    const help = await cli([...command, "--help"], cwd);
    expect(help.out).toContain("--run-directory-scope"); expect(help.out).toContain("--run-directory-name");
  }
  const configPath = join(cwd, "scope.json");
  await Bun.write(configPath, JSON.stringify({runtime: {runDirectoryScope: "spec", runDirectoryName: "file-name"}}));
  const configured = await cli(["config", "show", ...auth, "--config", configPath, "--run-directory-name", "cli-name"], cwd);
  expect(configured.code).toBe(0); expect(JSON.parse(configured.out)).toMatchObject({runDirectoryScope: "spec", runDirectoryName: "cli-name", token: "[REDACTED]"});
  const omitted = await cli(["worker", "info", ...auth], cwd);
  expect(JSON.parse(omitted.out).runDirectoryScope).toBe("spec-version");
  let calls = 0;
  const server = Bun.serve({port: 0, hostname: "127.0.0.1", fetch(request) {
    calls++;
    if (new URL(request.url).pathname.startsWith("/api/specs/")) return new Response("pipeline: {p: {nodes: []}}");
    return Response.json({ok: true});
  }});
  try {
    for (const extra of [["--run-directory-scope", "bad"], ["--run-directory-name", "music"], ["--run-directory-scope", "spec", "--run-directory-name", "../escape"]]) {
      const result = await cli(["worker", "once", ...auth, "--server", server.url.origin, ...extra], cwd);
      expect(result.code).toBe(2); expect(result.err).not.toContain("private");
    }
    expect(calls).toBe(0); expect(await Bun.file(join(cwd, ".mu/worker.lock")).exists()).toBe(false);
    const doctor = await cli(["worker", "doctor", ...auth, "--server", server.url.origin, "--spec", "test", "--run-directory-scope", "spec", "--run-directory-name", "music"], cwd);
    expect(doctor.code).toBe(0);
    const diagnostics = JSON.parse(doctor.out);
    expect(diagnostics).toMatchObject({claims: 0, runDirectoryScope: "spec", runDirectoryName: "music"});
    expect(diagnostics.runDirectories.test).toMatchObject({scope: "spec", name: "music"});
    expect(diagnostics.runDirectories.test.path).toEndWith("/music");
    expect(calls).toBe(2); // health and Spec lookup only, no claim/heartbeat
    expect(await Bun.file(join(diagnostics.runDirectories.test.path, "output")).exists()).toBe(false);
  } finally { server.stop(true); }
});
