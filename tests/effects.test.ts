import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunEffects } from "../src/runtime/effects";
import { Actions } from "../src/engine/actions";
import { mapping, type Context } from "../src/spec/types";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "mu-effects-")); directories.push(cwd);
  const effects = new BunEffects(fetch, () => {});
  return { cwd, effects, signal: new AbortController().signal };
}

test("HTTP action saves typed success/failure results and adds assignment only to server origin", async () => {
  const setup = await fixture();
  const received: { path: string; assignment: string | null; body: unknown }[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const path = new URL(request.url).pathname;
    received.push({ path, assignment: request.headers.get("x-mu-assignment-version"), body: await request.json() });
    return Response.json({ id: "job" }, { status: path === "/fail" ? 400 : 201 });
  } });
  try {
    const context: Context = { session: { working_dir: setup.cwd, server: server.url.origin }, request: { assignmentVersion: 9 }, node: { name: "render" } };
    const actions = new Actions({ pipelines: {} }, setup.effects);
    await actions.run({ type: "send_http_request", url: server.url + "ok", method: "post", body: { "${{ node.name }}": { status: "running" } }, save_to: "http", postcondition: { operator: "action_state", target: ["http", "status_code"], expected: 201 } }, context, {}, setup.signal);
    expect(mapping(mapping(mapping(context.node).actions).http)).toMatchObject({ success: true, status_code: 201, body: { id: "job" } });
    expect(received[0]).toEqual({ path: "/ok", assignment: "9", body: { render: { status: "running" } } });
    await actions.run({ type: "send_http_request", url: server.url + "fail", method: "post", body: {}, save_to: "failure", ignore_error: true }, context, {}, setup.signal);
    expect(mapping(mapping(mapping(context.node).actions).failure)).toMatchObject({ success: false, status_code: 400, body: { id: "job" } });
    const externalContext: Context = { session: { working_dir: setup.cwd, server: "http://other.invalid" }, request: { assignmentVersion: 9 } };
    await actions.run({ type: "send_http_request", url: server.url + "ok", method: "post", body: {} }, externalContext, {}, setup.signal);
    expect(received.at(-1)?.assignment).toBeNull();
  } finally { server.stop(true); }
});

test("cross-origin redirects strip authorization, cookie and assignment headers", async () => {
  const setup = await fixture();
  const observed: Headers[] = [];
  const destination = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) { observed.push(request.headers); return Response.json({ ok: true }); } });
  const origin = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { return Response.redirect(destination.url.href, 302); } });
  try {
    await setup.effects.http({ url: origin.url.href, method: "GET", headers: { Authorization: "Bearer private", Cookie: "secret=1", "X-Mu-Assignment-Version": "8" }, timeout: 1 }, setup.signal);
    expect(observed).toHaveLength(1);
    for (const name of ["authorization", "cookie", "x-mu-assignment-version"]) expect(observed[0]!.get(name)).toBeNull();
  } finally { origin.stop(true); destination.stop(true); }
});

test("body_file transfers bytes and response_file replaces destination only after success", async () => {
  const setup = await fixture();
  const source = join(setup.cwd, "input.bin"), destination = join(setup.cwd, "output.bin");
  const bytes = new Uint8Array([0, 1, 255, 100]);
  await Bun.write(source, bytes); await Bun.write(destination, "old");
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    if (new URL(request.url).pathname === "/fail") return new Response("failure", { status: 503 });
    expect(request.headers.get("content-length")).toBe("4");
    expect(new Uint8Array(await request.arrayBuffer())).toEqual(bytes);
    return new Response(bytes);
  } });
  try {
    const result = await setup.effects.http({ url: server.url + "bytes", method: "PUT", headers: {}, bodyFile: source, responseFile: destination, timeout: 1 }, setup.signal);
    expect(result.size).toBe(4); expect(result.body).toBeNull(); expect(new Uint8Array(await Bun.file(destination).arrayBuffer())).toEqual(bytes);
    const failed = await setup.effects.http({ url: server.url + "fail", method: "GET", headers: {}, responseFile: destination, timeout: 1 }, setup.signal);
    expect(failed.status_code).toBe(503); expect(new Uint8Array(await Bun.file(destination).arrayBuffer())).toEqual(bytes);
  } finally { server.stop(true); }
});

test("truncated download leaves existing destination intact; timeout fails promptly", async () => {
  const setup = await fixture();
  const path = join(setup.cwd, "output"); await Bun.write(path, "old");
  const transport = (async () => new Response("short", { headers: { "content-length": "100" } })) as unknown as typeof fetch;
  const effects = new BunEffects(transport);
  await expect(effects.http({ url: "http://localhost/", method: "GET", headers: {}, responseFile: path, timeout: 1 }, setup.signal)).rejects.toThrow("Incomplete");
  expect(await readFile(path, "utf8")).toBe("old");
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch() { await Bun.sleep(100); return new Response("late"); } });
  try {
    await expect(setup.effects.http({ url: server.url.href, method: "GET", headers: {}, timeout: .01 }, setup.signal)).rejects.toThrow();
  } finally { server.stop(true); }
});

test("abort terminates process and descendant group, without waiting for a long fake workload", async () => {
  const setup = await fixture();
  const controller = new AbortController();
  const pidFile = join(setup.cwd, "pid");
  const running = setup.effects.process(["bun", "-e", "const child=Bun.spawn(['bun','-e','await Bun.sleep(60000)'],{stdout:'inherit',stderr:'inherit'});await Bun.write('pid',String(child.pid));await Bun.sleep(60000);"], {}, setup.cwd, controller.signal);
  for (let attempt = 0; attempt < 100 && !await Bun.file(pidFile).exists(); attempt++) await Bun.sleep(10);
  expect(await Bun.file(pidFile).exists()).toBe(true);
  controller.abort();
  await expect(running).rejects.toThrow();
  const pid = Number(await Bun.file(pidFile).text());
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(pid, 0); }
    catch { return; }
    const status = Bun.file(`/proc/${pid}/stat`);
    if (await status.exists() && (await status.text()).split(" ")[2] === "Z") return;
    await Bun.sleep(10);
  }
  throw new Error("Descendant is still running");
});

test("model discovery provides relative path and unique stem/filename aliases", async () => {
  const setup = await fixture();
  await setup.effects.mkdir(join(setup.cwd, "models", "nested"));
  await Bun.write(join(setup.cwd, "models", "nested", "demo.gguf"), "fake");
  const models = await setup.effects.discoverModels(setup.cwd);
  expect(models["nested/demo.gguf"]).toBe(join(setup.cwd, "models", "nested", "demo.gguf"));
  expect(models["nested/demo"]).toBe(models.demo!); expect(models["demo.gguf"]).toBe(models.demo!);
});
