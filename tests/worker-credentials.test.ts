import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { DataCenterClient } from "../src/api";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, {recursive: true, force: true});
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "mu-worker-credentials-"));
  directories.push(directory);
  const config = join(directory, "mu.yaml");
  await Bun.write(config, "server: {url: 'http://localhost:3211'}\nworker: {unitId: cpu}\nruntime: {devices: []}\n");
  return {directory, flags: {config}};
}

test("WORKER_TOKEN supplies the bearer credential and explicit --token takes precedence", async () => {
  const {flags} = await fixture();
  const env = {WORKER_TOKEN: "canonical-secret", MU_WORKER_TOKEN: "old-secret", UNIT_TOKEN: "unit-secret"};
  for (const [overrides, expected] of [[{}, "canonical-secret"], [{token: "flag-secret"}, "flag-secret"]] as const) {
    const config = await loadConfig({...flags, ...overrides}, env);
    const client = new DataCenterClient(config, (async (_url, init) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${expected}`);
      expect(init?.redirect).toBe("error");
      return Response.json({ok: true});
    }) as typeof fetch);
    await client.health();
  }
});

test("missing, blank and legacy-only credentials fail with the canonical name and no secret disclosure", async () => {
  const {flags} = await fixture();
  for (const env of [{}, {WORKER_TOKEN: ""}, {WORKER_TOKEN: "  "},
    {MU_WORKER_TOKEN: "old-secret"}, {UNIT_TOKEN: "unit-secret"},
    {WORKER_TOKEN: "", MU_WORKER_TOKEN: "old-secret", UNIT_TOKEN: "unit-secret"}]) {
    await expect(loadConfig(flags, env)).rejects.toThrow("WORKER_TOKEN is required");
  }
  for (const token of ["", "  "]) {
    await expect(loadConfig({...flags, token}, {WORKER_TOKEN: "canonical-secret"})).rejects.toThrow("WORKER_TOKEN is required");
  }
  // An old name is never needed when the explicit override is supplied.
  expect((await loadConfig({...flags, token: "flag-secret"}, {})).token).toBe("flag-secret");
});

test("YAML credentials do not replace the required environment or explicit token", async () => {
  const {flags} = await fixture();
  await Bun.write(flags.config, JSON.stringify({server: {url: "http://localhost:3211", token: "server-secret"}, worker: {unitId: "cpu", token: "worker-secret"}, token: "root-secret", WORKER_TOKEN: "yaml-secret"}));
  await expect(loadConfig(flags, {})).rejects.toThrow("WORKER_TOKEN is required");
});

test("CLI authenticates with WORKER_TOKEN, redacts diagnostics and rejects old names before network calls", async () => {
  const {directory, flags} = await fixture();
  let calls = 0;
  const server = Bun.serve({port: 0, hostname: "127.0.0.1", fetch(request) {
    calls++;
    if (request.headers.get("Authorization") !== "Bearer canonical-secret") return new Response("denied", {status: 401});
    if (new URL(request.url).pathname.endsWith("claim")) return Response.json([]);
    return Response.json({ok: true});
  }});
  async function cli(command: string[], env: NodeJS.ProcessEnv) {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/index.ts"), ...command, "--config", flags.config, "--server", server.url.origin], {
      cwd: directory, env: {PATH: process.env.PATH, ...env}, stdout: "pipe", stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    for (const secret of ["canonical-secret", "old-secret", "unit-secret"]) expect(out + err).not.toContain(secret);
    return {code, out, err};
  }
  try {
    for (const env of [{MU_WORKER_TOKEN: "old-secret"}, {UNIT_TOKEN: "unit-secret"}, {WORKER_TOKEN: ""}]) {
      const result = await cli(["worker", "once", "--fake", "--spec", "demo"], env);
      expect(result.code).toBe(2);
      expect(result.err).toContain("WORKER_TOKEN is required");
    }
    expect(calls).toBe(0);
    const help = await cli(["worker", "once", "--help"], {});
    expect(help.code).toBe(0);
    expect(help.out).toContain("prefer WORKER_TOKEN");
    expect(help.out).not.toContain("MU_WORKER_TOKEN");
    const env = {WORKER_TOKEN: "canonical-secret", MU_WORKER_TOKEN: "old-secret", UNIT_TOKEN: "unit-secret"};
    for (const command of [["config", "show"], ["worker", "info"]]) {
      const result = await cli(command, env);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.out).token).toBe("[REDACTED]");
    }
    expect((await cli(["worker", "once", "--fake", "--spec", "demo"], env)).code).toBe(0);
    expect(calls).toBeGreaterThan(0);
  } finally { server.stop(true); }
});
