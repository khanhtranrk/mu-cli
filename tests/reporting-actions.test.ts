import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Actions } from "../src/engine/actions";
import { BunEffects } from "../src/runtime/effects";
import { parseSpec } from "../src/spec/parse";
import type { Action, Context } from "../src/spec/types";

const signal = () => new AbortController().signal;
async function fixture(complete: (attempt: number) => Response | Promise<Response>, mutate = false) {
  const directory = await mkdtemp(join(tmpdir(), "mu-builtins-"));
  const target = join(directory, "source.txt"); await Bun.write(target, "original");
  const calls: {url: string; body: unknown; headers: Headers}[] = [];
  let attempts = 0;
  const transport = (async (url: unknown, options: RequestInit) => {
    const path = String(url); calls.push({url: path, body: typeof options.body === "string" ? JSON.parse(options.body) : undefined, headers: new Headers(options.headers)});
    if (path.endsWith("upload-url")) return Response.json({uploadId: "u", uploadUrl: "http://storage/put", method: "PUT", headers: {"Content-Type": "text/plain"}});
    if (path.endsWith("/put")) {
      expect(new Headers(options.headers).has("authorization")).toBe(false);
      await (options.body as Blob).text();
      if (mutate) await Bun.write(target, "mutation");
      return new Response(null);
    }
    if (path.endsWith("complete")) return complete(++attempts);
    return Response.json({ok: true});
  }) as typeof fetch;
  const effects = new BunEffects(transport);
  const actions = new Actions({pipeline: {}}, effects);
  const context: Context = {session: {working_dir: directory, server: "http://server", token: "secret"}, request: {requestId: "r", assignmentVersion: 7}, node: {name: "publish"}};
  return {directory, target, calls, actions, context, effects, attempts: () => attempts, cleanup: () => rm(directory, {recursive: true, force: true})};
}
const upload: Action = {type: "upload_artifact", artifact_id: "result", target: "source.txt", save_state: "uploaded"};

test("built-ins register with parser and report rendered node/request events using active assignment", async () => {
  const f = await fixture(() => Response.json({artifact: {id: "result"}}));
  try {
    const spec = parseSpec(JSON.stringify({pipeline: {p: {nodes: [{name: "n", run: [{type: "report_node", status: "running", events: [{level: "info", message: "${{ node.name }}"}], request_events: [{level: "warning", message: "request", createdAt: 12}], save_state: "report"}]}]}}}));
    await f.actions.run(spec.pipeline.p!.nodes![0]!.run![0]!, f.context, {}, signal());
    const call = f.calls[0]!; const body = call.body as any;
    expect(call.headers.get("x-mu-assignment-version")).toBe("7");
    expect(body.status).toBeUndefined(); expect(body.node_states.publish.status).toBe("running");
    expect(body.node_states.publish.events[0].message).toBe("publish"); expect(body.node_states.publish.events[0].createdAt).toBeNumber();
    expect(body.events[0].createdAt).toBe(12);
    await f.actions.run({type: "report_node", request_events: [{level: "info", message: "only request"}]}, {...f.context, node: undefined}, {}, signal());
    expect((f.calls[1]!.body as any).node_states).toBeUndefined();
  } finally { await f.cleanup(); }
});

for (const code of [500, 502, 503, 504, 400, 401, 403, 409, 422]) test(`completion HTTP ${code} has bounded safe retry`, async () => {
  const f = await fixture(() => new Response(null, {status: code}));
  try {
    await expect(f.actions.run(upload, f.context, {}, signal())).rejects.toThrow(`HTTP ${code}`);
    expect(f.attempts()).toBe(code >= 500 ? 2 : 1);
    expect((f.context.actions as any).uploaded.success).toBe(false);
    const completions = f.calls.filter(call => call.url.endsWith("complete"));
    if (completions.length === 2) expect(completions[0]!.body).toEqual(completions[1]!.body);
  } finally { await f.cleanup(); }
});

test("completion retries timeout once then saves registered artifact; inspection returns content type", async () => {
  const f = await fixture(attempt => {if (attempt === 1) throw new DOMException("timeout", "TimeoutError"); return Response.json({artifact: {id: "result"}});});
  try {
    await f.actions.run(upload, f.context, {}, signal());
    expect(f.attempts()).toBe(2); expect((f.context.actions as any).uploaded.artifact.id).toBe("result");
    await f.actions.run({type: "inspect_file", target: "source.txt", save_state: "file"}, f.context, {}, signal());
    expect((f.context.actions as any).file.contentType).toContain("text/plain");
  } finally { await f.cleanup(); }
});

test("source mutation fails before completion, including a same-size rewrite", async () => {
  const f = await fixture(() => Response.json({artifact: {id: "result"}}), true);
  try { await expect(f.actions.run(upload, f.context, {}, signal())).rejects.toThrow("changed"); expect(f.attempts()).toBe(0); }
  finally { await f.cleanup(); }
});

test("abort never retries completion", async () => {
  const abort = new AbortController();
  const f = await fixture(() => {abort.abort(); throw new Error("connection lost");});
  try { await expect(f.actions.run(upload, f.context, {}, abort.signal)).rejects.toThrow(); expect(f.attempts()).toBe(1); }
  finally { await f.cleanup(); }
});

for (const mode of ["digest", "size", "missing", "http", "timeout"]) test(`download ${mode} failure preserves existing destination`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "mu-download-")), target = join(directory, "out.txt");
  await Bun.write(target, "keep");
  const transport = (async (url: unknown) => {
    if (String(url).includes("download-url")) return Response.json({url: "http://storage/get", size: mode === "size" ? 8 : 3, ...(mode === "missing" ? {} : {sha256: "a".repeat(64)})});
    if (mode === "timeout") throw new DOMException("timeout", "TimeoutError");
    return new Response("bad", {status: mode === "http" ? 403 : 200});
  }) as typeof fetch;
  const context = {session: {working_dir: directory, server: "http://server", token: "secret"}, request: {requestId: "r", assignmentVersion: 1}};
  try {
    await expect(new Actions({pipeline: {}}, new BunEffects(transport)).run({type: "download_artifact", artifact_id: "result", target}, context, {}, signal())).rejects.toThrow();
    expect(await Bun.file(target).text()).toBe("keep");
  } finally { await rm(directory, {recursive: true, force: true}); }
});
