import { RegistryClient } from "../../src/runtime/registry-client";
import { executeStandaloneWorkload } from "../../src/runtime/workload-executor";
import type { ExecutionSnapshot } from "../../src/engine/checkpoint";
import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { makeFunctionReference, type GenericSchema, type SchemaDefinition } from "convex/server";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { reportingAction } from "../../src/engine/reporting-actions";
import { Actions } from "../../src/engine/actions";
import { Worker } from "../../src/worker";
import { DataCenterClient } from "../../src/api";
import { SpecExecutor } from "../../src/runtime/spec-executor";
import { BunEffects } from "../../src/runtime/effects";
import { parseArtifacts } from "../../src/artifacts";
import type { WorkerConfig } from "../../src/config";

const source = process.env.MU_MASTERFLOW_SOURCE;
const integration = test.skipIf(!source);

async function fixture(options: { failPut?: boolean; corruptDownload?: boolean; loseCompletionResponse?: boolean } = {}) {
  const root = resolve(source!);
  const previous = Object.fromEntries(["CLERK_JWT_ISSUER_DOMAIN", "AUTH_ALLOWED_USER_IDS", "AUTH_ALLOWED_EMAILS", "STORAGE_ENCRYPTION_KEY"].map(key => [key, process.env[key]]));
  process.env.CLERK_JWT_ISSUER_DOMAIN = "https://test.clerk.accounts.dev";
  process.env.AUTH_ALLOWED_USER_IDS = '["user_owner"]';
  process.env.AUTH_ALLOWED_EMAILS = "[]";
  process.env.STORAGE_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");
  const schemaModule = await import(pathToFileURL(join(root, "convex/schema.ts")).href) as { default: SchemaDefinition<GenericSchema, boolean> };
  const s3Module = await import(pathToFileURL(join(root, "convex/s3.ts")).href) as { encrypt(value: { accessKeyId: string; secretAccessKey: string }, id: string): string };
  const modules: Record<string, () => Promise<unknown>> = {};
  for (const file of await readdir(join(root, "convex"))) if (file.endsWith(".ts") && !file.endsWith(".d.ts")) modules[`../convex/${file}`] = () => import(pathToFileURL(join(root, "convex", file)).href);
  modules["../convex/_generated/server.js"] = () => import(pathToFileURL(join(root, "convex/_generated/server.js")).href);
  const backend = convexTest(schemaModule.default, modules);
  const objects = new Map<string, Uint8Array>();
  const storageCalls: { method: string; signed: boolean; copy: boolean; headers: Headers; path: string }[] = [];
  const storage = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(incoming) {
    const url = new URL(incoming.url), path = decodeURIComponent(url.pathname);
    const signed = url.searchParams.has("X-Amz-Signature"), copy = incoming.headers.has("x-amz-copy-source");
    storageCalls.push({ method: incoming.method, signed, copy, headers: incoming.headers, path });
    if (signed) {
      expect(incoming.headers.has("authorization")).toBe(false);
      expect(incoming.headers.has("x-mu-assignment-version")).toBe(false);
      expect(incoming.headers.has("cookie")).toBe(false);
    }
    if (incoming.method === "PUT" && copy) {
      const original = objects.get("/" + decodeURIComponent(incoming.headers.get("x-amz-copy-source")!).replace(/^\//, ""));
      if (!original || incoming.headers.get("x-amz-copy-source-if-match") !== '"' + createHash("md5").update(original).digest("hex") + '"') return new Response(null, { status: 412 });
      objects.set(path, original.slice());
      return new Response('<CopyObjectResult><ETag>"copied"</ETag></CopyObjectResult>', { headers: { "Content-Type": "application/xml" } });
    }
    if (incoming.method === "PUT") {
      if (!signed) return new Response(null, { status: 403 });
      if (options.failPut) return new Response(null, { status: 503 });
      const bytes = new Uint8Array(await incoming.arrayBuffer());
      expect(incoming.headers.get("content-length")).toBe(String(bytes.length));
      expect(incoming.headers.get("content-type")).toBe("application/json");
      objects.set(path, bytes); return new Response(null);
    }
    const bytes = objects.get(path);
    if (!bytes) return new Response(null, { status: 404 });
    if (incoming.method === "HEAD") return new Response(null, { headers: { "Content-Length": String(bytes.length), ETag: '"' + createHash("md5").update(bytes).digest("hex") + '"' } });
    if (!signed) return new Response(null, { status: 403 });
    const result = bytes.slice();
    if (options.corruptDownload && result.length) result[0] = result[0]! ^ 1;
    return new Response(result);
  } });
  const spec = await Bun.file(join(import.meta.dir, "../../examples/cpu-artifacts/spec.yaml")).text();
  const ids = await backend.run(async ctx => {
    await ctx.db.insert("storageSettings", { ownerId: "user_owner", defaultConnectionId: "local" });
    await ctx.db.insert("storageConnections", { connectionId: "local", name: "Test storage", provider: "r2", endpoint: storage.url.origin, region: "auto", bucket: "private", prefix: "mu", encryptedCredentials: s3Module.encrypt({ accessKeyId: "test-key", secretAccessKey: "test-secret" }, "local"), enabled: true, createdAt: 1 });
    const tokenId = await ctx.db.insert("unitTokens", { name: "worker", tokenHash: createHash("sha256").update("worker-token").digest("hex"), unitId: "unit", specSlugs: ["demo"], createdAt: 1 });
    const specId = await ctx.db.insert("specs", { draftRevision: 0, slug: "demo", name: "CPU test", description: "", yaml: spec, enabled: true });
    const specVersionId = await ctx.db.insert("specVersions", {specId, version: "1.0.0", yaml: spec, yamlSha256: createHash("sha256").update(spec).digest("hex"), executionSha256: "fixture", changelog: "fixture", publishedBy: "test", publishedAt: 1});
    await ctx.db.patch(specId, {defaultVersionId: specVersionId});
    const requestId = await ctx.db.insert("requests", { specVersionId, specSlug: "demo", pipelineName: "demo", inputs: {message: {type: "string", value: "CPU integration"}}, resolvedInputs: {message: "CPU integration"}, outputs: {published: {type: "artifact", value: "${{ pipeline.outputs.published }}"}, size: {type: "number", value: "${{ pipeline.outputs.size }}"}, sha256: {type: "string", value: "${{ pipeline.outputs.sha256 }}"}}, status: "waiting" });
    return { tokenId, requestId, specId, specVersionId };
  });
  const apiCalls: { path: string; method: string; body?: Record<string, unknown> }[] = [];
  let lostResponse = false;
  const site = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(incoming) {
    const url = new URL(incoming.url), body = incoming.method === "GET" ? undefined : await incoming.text();
    apiCalls.push({ path: url.pathname, method: incoming.method, ...(body ? { body: JSON.parse(body) as Record<string, unknown> } : {}) });
    const response = await backend.fetch(url.pathname + url.search, { method: incoming.method, headers: incoming.headers, body });
    if (options.loseCompletionResponse && !lostResponse && url.pathname.endsWith("/complete") && response.ok) {
      lostResponse = true; await response.body?.cancel();
      return Response.json({ error: "Simulated proxy failure after completion committed" }, { status: 503 });
    }
    // convex-test hardcodes https://some.convex.site as the HttpAction origin.
    // Adapt that synthetic origin to the externally visible local test proxy.
    if (url.pathname.startsWith("/api/workloads/") && response.ok) {
      const payload = await response.json() as Record<string, unknown>;
      expect(payload.registry).toBe("https://some.convex.site");
      return Response.json({...payload, registry: url.origin});
    }
    return response;
  } });
  const workspace = await mkdtemp(join(tmpdir(), "mu-masterflow-integration-"));
  const config: WorkerConfig = { server: site.url.origin, token: "worker-token", unitId: "unit", specs: ["demo"], workspace, maxClaim: 1, pollInterval: 1, heartbeatInterval: 30, fake: false, devices: [], concurrency: 2 };
  const api = new DataCenterClient(config);
  const headers = { Authorization: "Bearer worker-token", "Content-Type": "application/json", "X-Mu-Assignment-Version": "1" };
  const call = (path: string, body?: unknown, override: Record<string, string> = {}) => fetch(site.url.origin + path, { method: body === undefined ? "GET" : "POST", headers: { ...headers, ...override }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { backend, ids, objects, storageCalls, apiCalls, config, api, call,
    run: () => new Worker(config, api, new SpecExecutor(config, new BunEffects(fetch, () => {}))).run("once", new AbortController().signal),
    close: async () => {
      site.stop(true); storage.stop(true); await rm(workspace, { recursive: true, force: true });
      for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    },
  };
}

integration("real MasterFlow HTTP handlers: claim, CPU generation, signed upload, completion, verified download and reports", async () => {
  const setup = await fixture();
  try {
    await setup.backend.run(async ctx => {const version = await ctx.db.get(setup.ids.specVersionId); await ctx.db.patch(version.specId, {yaml: "invalid: ["});});
    expect(await setup.run()).toBe(0);
    const state = await setup.backend.run(async ctx => ({ request: await ctx.db.get(setup.ids.requestId), artifacts: await ctx.db.query("artifacts").collect(), files: await ctx.db.query("physicalFiles").collect(), uploads: await ctx.db.query("storageUploads").collect() }));
    expect(state.request?.status).toBe("succeeded");
    expect(state.request?.events?.[0]?.message).toBe("Request started");
    expect(state.request?.nodeStates.publish.events?.some((event: any) => event.message === "Node finished")).toBe(true);
    expect(state.files[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(state.request?.nodeStates.publish.status).toBe("succeeded"); expect(state.request?.nodeStates.verify.status).toBe("succeeded");
    expect(state.artifacts).toHaveLength(1); expect(state.files).toHaveLength(1);
    expect(state.uploads[0]).not.toHaveProperty("nodeName");
    expect(setup.apiCalls.filter(call => call.path.endsWith("/complete")).every(call => !Object.hasOwn(call.body!, "nodeName"))).toBe(true);
    const rows = await setup.backend.withIdentity({ issuer: "https://test.clerk.accounts.dev", subject: "user_owner" }).query(makeFunctionReference<"query">("artifactStore:list"), { requestId: setup.ids.requestId });
    const outputs = parseArtifacts(rows);
    expect(outputs[0]?.id).toBe("result"); expect(outputs[0]?.nodeName).toBeUndefined();
    expect(outputs[0]?.id).not.toBe(state.artifacts[0]?._id);
    const requestStatuses = setup.apiCalls.filter(call => call.path.endsWith("/report") && call.body?.status).map(call => call.body!.status);
    expect(requestStatuses).toEqual(["processing", "succeeded"]);
    expect(setup.storageCalls.some(call => call.copy)).toBe(true);
    const upload = state.uploads[0]!;
    const completion = await setup.call("/api/requests/artifacts/complete", { requestId: setup.ids.requestId, uploadId: upload._id, name: "result.json", label: "CPU smoke output" });
    expect(completion.status).toBe(200); expect((await completion.json() as { artifact: unknown }).artifact).toEqual(outputs[0]);
    const legacy = await setup.call(`/api/requests/artifacts/download?requestId=${setup.ids.requestId}&artifactId=result`);
    expect(legacy.status).toBe(200); expect(legacy.headers.get("content-type")).toContain("application/json");
    expect((await legacy.json() as { url: string }).url).toContain("X-Amz-Signature");
  } finally { await setup.close(); }
});

integration("failed storage PUT blocks completion and dependent download, reporting process_failed", async () => {
  const setup = await fixture({ failPut: true });
  try {
    expect(await setup.run()).toBe(6);
    const row = await setup.backend.run(ctx => ctx.db.get(setup.ids.requestId));
    expect(row?.status).toBe("process_failed"); expect(row?.nodeStates.verify.status).toBe("failed");
    expect(setup.apiCalls.some(call => call.path.endsWith("/complete"))).toBe(false);
    expect(setup.apiCalls.some(call => call.path.endsWith("/download-url"))).toBe(false);
    expect(await setup.backend.run(ctx => ctx.db.query("artifacts").collect())).toHaveLength(0);
  } finally { await setup.close(); }
});

integration("equal-size corrupted download fails SHA verification and reports process_failed", async () => {
  const setup = await fixture({ corruptDownload: true });
  try {
    expect(await setup.run()).toBe(6);
    expect((await setup.backend.run(ctx => ctx.db.get(setup.ids.requestId)))?.status).toBe("process_failed");
    expect(await setup.backend.run(ctx => ctx.db.query("artifacts").collect())).toHaveLength(1);
  } finally { await setup.close(); }
});

integration("lost completion response retries the same receipt once without re-uploading or duplicating artifacts", async () => {
  const setup = await fixture({ loseCompletionResponse: true });
  try {
    expect(await setup.run()).toBe(0);
    const attempts = setup.apiCalls.filter(call => call.path.endsWith("/complete"));
    expect(attempts).toHaveLength(2); expect(attempts[0]?.body).toEqual(attempts[1]?.body);
    expect(setup.storageCalls.filter(call => call.method === "PUT" && call.signed)).toHaveLength(1);
    expect(setup.storageCalls.filter(call => call.copy)).toHaveLength(1);
    expect(await setup.backend.run(ctx => ctx.db.query("artifacts").collect())).toHaveLength(1);
    expect((await setup.backend.run(ctx => ctx.db.get(setup.ids.requestId)))?.status).toBe("succeeded");
  } finally { await setup.close(); }
});

integration("real worker authorization rejects foreign/stale/revoked assignments and forbids create/inspect", async () => {
  const setup = await fixture();
  try {
    await setup.api.heartbeat("online");
    const [request] = await setup.api.claim("demo", 1);
    const report = { id: request!.requestId, status: "processing" };
    expect((await setup.call("/api/requests/create", {})).status).toBe(403);
    expect((await setup.call("/api/requests?specSlug=demo")).status).toBe(403);
    expect((await setup.call("/api/requests/report", report, { "X-Mu-Assignment-Version": "0" })).status).toBe(400);
    expect((await setup.call("/api/requests/artifacts/upload-url", { requestId: request!.requestId, artifactId: "result", size: 1, sha256: "a".repeat(64) }, { "X-Mu-Assignment-Version": "0" })).status).toBe(400);
    const foreign = await setup.backend.run(ctx => ctx.db.insert("requests", { specVersionId: setup.ids.specVersionId, specSlug: "demo", pipelineName: "demo", payload: {}, status: "waiting" }));
    expect((await setup.call("/api/requests/report", { id: foreign, status: "succeeded" })).status).toBe(400);
    await setup.backend.run(ctx => ctx.db.patch(setup.ids.tokenId, { deletedAt: Date.now() }));
    expect((await setup.call("/api/requests/report", report)).status).toBe(401);
  } finally { await setup.close(); }
});

integration("report_request appends through MasterFlow without coupling events/status or changing nodes", async () => {
  const setup = await fixture();
  try {
    await setup.api.heartbeat("online");
    const [request] = await setup.api.claim("demo", 1);
    const context = {session: {working_dir: setup.config.workspace, server: setup.config.server, token: setup.config.token}, request};
    const actions = new Actions({pipelines: {}}, new BunEffects());
    const signal = new AbortController().signal;
    const first = {level: "info" as const, message: "accepted", createdAt: 100};
    const second = {level: "warning" as const, message: "retry", details: {attempt: 2}, createdAt: 200};
    await actions.run({type: "report_request", events: [first]}, context, {}, signal);
    let row = await setup.backend.run(ctx => ctx.db.get(setup.ids.requestId));
    expect(row?.status).toBe("possessed"); expect(row?.events).toEqual([first]);
    await reportingAction("report_request", {status: "processing"}, context, new BunEffects(), signal, true);
    row = await setup.backend.run(ctx => ctx.db.get(setup.ids.requestId));
    expect(row?.status).toBe("processing"); expect(row?.events).toEqual([first]);
    await actions.run({type: "report_request", events: [second]}, context, {}, signal);
    row = await setup.backend.run(ctx => ctx.db.get(setup.ids.requestId));
    expect(row?.status).toBe("processing"); expect(row?.events).toEqual([first, second]);
    await reportingAction("report_request", {status: "process_failed"}, context, new BunEffects(), signal, true);
    row = await setup.backend.run(ctx => ctx.db.get(setup.ids.requestId));
    expect(row?.status).toBe("process_failed"); expect(row?.events).toEqual([first, second]);
    expect(row?.nodeStates).toBeUndefined();
  } finally { await setup.close(); }
});

integration("native notification delivers expression strings through real authenticated handler", async () => {
  const setup = await fixture();
  try {
    const context = {session: {working_dir: setup.config.workspace, server: setup.config.server, token: setup.config.token}, inputs: {title: "Native title", message: "Native message", tags: "Example tag"}};
    const actions = new Actions({pipelines: {}}, new BunEffects());
    for (const tags of [undefined, "${{ inputs.tags }}"]) await actions.run({type: "send_notification", title: "${{ inputs.title }}", message: "${{ inputs.message }}", ...(tags === undefined ? {} : {tags})}, context, {}, new AbortController().signal);
    const rows = await setup.backend.run(ctx => ctx.db.query("notifications").collect());
    expect(rows).toHaveLength(2);
    expect(rows.map((row: any) => ({title: row.title, message: row.message, tags: row.tags}))).toEqual([
      {title: "Native title", message: "Native message", tags: undefined},
      {title: "Native title", message: "Native message", tags: ["Example tag"]},
    ]);
    const calls = setup.apiCalls.filter(call => call.path.endsWith("/notifications/send"));
    expect(calls.every(call => call.method === "POST")).toBe(true);
    expect((await setup.call("/api/notifications/send", {title: "array client", message: "m", tags: ["one", "two"]})).status).toBe(200);
    expect((await setup.call("/api/notifications/send", {title: "invalid client", message: "m", tags: 123})).status).toBe(400);
    await expect(actions.run({type: "send_notification", title: "t", message: "m"}, {...context, session: {...context.session, token: "invalid"}}, {}, new AbortController().signal)).rejects.toThrow("HTTP 401");
  } finally { await setup.close(); }
});


integration("registry publish/default/Spec lock/Request claim and standalone execution share immutable bytes", async () => {
  const setup = await fixture();
  try {
    const owner = setup.backend.withIdentity({issuer: "https://test.clerk.accounts.dev", subject: "user_owner"});
    const module = (text: string) => JSON.stringify({workload: {target: "bun", units: 0, argv: ["-e", `console.log('${text}')`], outputs: {text: {type: "string", value: "${{ result.stdout }}"}}}});
    const workloadId = await owner.mutation(makeFunctionReference<"mutation">("workloads:create"), {slug: "example", name: "Example", description: "", yaml: module("one")});
    const first = await owner.mutation(makeFunctionReference<"mutation">("workloads:publish"), {id: workloadId, version: "1.0.0", expectedRevision: 1, changelog: "", makeDefault: true});
    const spec = JSON.stringify({
      workloads: {w: "example"},
      pipelines: {demo: {
        nodes: [{name: "n", run: [{type: "execute_workload", workload: "w", save_to: "result"}], outputs: {text: {type: "string", value: "${{ node.actions.result.outputs.text }}"}}}],
        outputs: {text: {type: "string", value: "${{ pipeline.nodes.n.outputs.text }}"}},
      }},
    });
    await setup.backend.run(ctx => ctx.db.delete(setup.ids.requestId));
    const specId = setup.ids.specId;
    await owner.mutation(makeFunctionReference<"mutation">("specs:update"), {id: specId, expectedRevision: 0, name: "Registry", description: "", yaml: spec});
    await owner.mutation(makeFunctionReference<"mutation">("specs:publish"), {id: specId, expectedRevision: 1, version: "1.1.0", changelog: "Registry", makeDefault: true});
    const requestId = await owner.mutation(makeFunctionReference<"mutation">("requests:create"), {specSlug: "demo", pipelineName: "demo", inputs: {}});
    await owner.mutation(makeFunctionReference<"mutation">("workloads:saveDraft"), {id: workloadId, expectedRevision: 1, yaml: module("two")});
    const second = await owner.mutation(makeFunctionReference<"mutation">("workloads:publish"), {id: workloadId, version: "2.0.0", expectedRevision: 2, changelog: "", makeDefault: true});
    const saved = await owner.query(makeFunctionReference<"query">("specs:get"), {slug: "demo"});
    await owner.mutation(makeFunctionReference<"mutation">("specs:refreshWorkloads"), {id: specId, expectedYaml: spec, expectedLock: JSON.stringify(saved.workloadLock)});
    expect(await setup.run()).toBe(0);
    const request = await setup.backend.run(ctx => ctx.db.get(requestId));
    expect((await setup.backend.run(ctx => ctx.db.get(request.specVersionId))).workloadLock.pins[0].versionId).toBe(first);
    expect(request.resolvedOutputs.text).toBe("one\n");
    const issued = await owner.action(makeFunctionReference<"action">("workloadCredentials:issue"), {name: "CLI", slugs: ["example"]});
    const registry = new RegistryClient(setup.config.server, issued.token);
    const outputs = await executeStandaloneWorkload({source: "example", cwd: setup.config.workspace, bindings: {}, devices: [], registry: {origin: registry.origin, read: registry.read.bind(registry)}}, new BunEffects(), async () => {throw new Error("no local/URL fallback");}, new AbortController().signal);
    expect(outputs).toEqual({text: "two\n"});
    const profile = join(setup.config.workspace, "profiles.json");
    await Bun.write(profile, JSON.stringify({defaultProfile: "test", profiles: {test: {server: setup.config.server, tokenEnv: "MU_REGISTRY_TEST_TOKEN"}}}));
    const claims = setup.apiCalls.filter(call => call.path.endsWith("claim")).length;
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../src/index.ts"), "workload", "exec", "example@1.0.0", "--profile", "test", "--json"], {cwd: setup.config.workspace, env: {PATH: process.env.PATH, HOME: setup.config.workspace, MU_PROFILES_FILE: profile, MU_REGISTRY_TEST_TOKEN: issued.token}, stdout: "pipe", stderr: "pipe"});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(0); expect(JSON.parse(stdout)).toEqual({success: true, outputs: {text: "one\n"}}); expect(stderr).not.toContain(issued.token);
    expect(setup.apiCalls.filter(call => call.path.endsWith("claim"))).toHaveLength(claims);
    expect(second).not.toBe(first);
  } finally {await setup.close();}
});

integration("registry recovery validates pinned provenance and never reloads module bytes or current defaults", async () => {
  const setup = await fixture();
  try {
    const owner = setup.backend.withIdentity({issuer: "https://test.clerk.accounts.dev", subject: "user_owner"});
    const module = JSON.stringify({workload: {target: "bun", units: 0, argv: ["-e", "console.log('pinned')"]}});
    const workloadId = await owner.mutation(makeFunctionReference<"mutation">("workloads:create"), {slug: "recovery", name: "Recovery", description: "", yaml: module});
    await owner.mutation(makeFunctionReference<"mutation">("workloads:publish"), {id: workloadId, version: "1.0.0", expectedRevision: 1, changelog: "", makeDefault: true});
    const spec = JSON.stringify({workloads: {w: "recovery"}, pipelines: {demo: {nodes: [{name: "n", run: [{type: "execute_workload", workload: "w"}]}]}}});
    await setup.backend.run(ctx => ctx.db.delete(setup.ids.requestId));
    const specId = setup.ids.specId;
    await owner.mutation(makeFunctionReference<"mutation">("specs:update"), {id: specId, expectedRevision: 0, name: "Recovery", description: "", yaml: spec});
    await owner.mutation(makeFunctionReference<"mutation">("specs:publish"), {id: specId, expectedRevision: 1, version: "1.1.0", changelog: "Recovery", makeDefault: true});
    await owner.mutation(makeFunctionReference<"mutation">("requests:create"), {specSlug: "demo", pipelineName: "demo", inputs: {}});
    await setup.api.heartbeat("online"); const request = (await setup.api.claim("demo", 1))[0]!;
    const controller = new AbortController(); let interrupted = false, snapshot: ExecutionSnapshot | undefined;
    class Effects extends BunEffects {override async process() {if (!interrupted) {interrupted = true; controller.abort(new Error("interrupted")); throw new Error("interrupted");} return {returncode: 0, stdout: "pinned\n", stderr: ""};}}
    const effects = new Effects();
    await expect(new SpecExecutor(setup.config, effects).execute(spec, request, controller.signal, {save: async value => {snapshot = value;}})).rejects.toThrow();
    expect(snapshot!.workloadModules![0]!.registry!.version).toBe("1.0.0");
    const offline = new RegistryClient(setup.config.server, setup.config.token, (async () => {throw new Error("module network is offline");}) as unknown as typeof fetch);
    await new SpecExecutor(setup.config, effects, undefined, offline).execute(spec, request, new AbortController().signal, {snapshot, retryIncomplete: true, save: async () => {}});
    const bad = structuredClone(snapshot!); bad.workloadModules![0]!.registry!.registry = "https://other.example";
    await expect(new SpecExecutor(setup.config, effects, undefined, offline).execute(spec, request, new AbortController().signal, {snapshot: bad, retryIncomplete: true, save: async () => {}})).rejects.toThrow("provenance mismatch");
  } finally {await setup.close();}
});

integration("registry parallel preparation survives publication, worker pins, standalone execution and offline module restore", async () => {
  const setup = await fixture();
  try {
    const owner = setup.backend.withIdentity({issuer:"https://test.clerk.accounts.dev",subject:"user_owner"});
    const prepare = (name:string) => ({type:"installation_group",resources:[`integration-${name}`],actions:[{type:"execute_command",target:process.execPath,args:["-e",`await Bun.write(${JSON.stringify(join(setup.config.workspace,name))},'ready')`]}]});
    const yaml=JSON.stringify({prepare:[{type:"parallel",actions:[prepare("runtime"),prepare("model")]}],workload:{target:process.execPath,units:0,argv:["-e",`for(const f of ${JSON.stringify(['runtime','model'].map(name=>join(setup.config.workspace,name)))})if(!await Bun.file(f).exists())process.exit(9);console.log('prepared')`],outputs:{text:{type:"string",value:"${{ result.stdout }}"}}}});
    const id=await owner.mutation(makeFunctionReference<"mutation">("workloads:create"),{slug:"parallel-test",name:"Parallel",description:"",yaml});
    const version=await owner.mutation(makeFunctionReference<"mutation">("workloads:publish"),{id,expectedRevision:1,version:"1.0.0",changelog:"",makeDefault:true});
    const spec=JSON.stringify({workloads:{w:"parallel-test@1.0.0"},pipelines:{demo:{prepare:[{type:"ensure_workload",workload:"w"}],nodes:[{name:"n",run:[{type:"execute_workload",workload:"w",save_to:"result"}],outputs:{text:{type:"string",value:"${{ node.actions.result.outputs.text }}"}}}],outputs:{text:{type:"string",value:"${{ pipeline.nodes.n.outputs.text }}"}}}}});
    await setup.backend.run(ctx=>ctx.db.delete(setup.ids.requestId));
    await owner.mutation(makeFunctionReference<"mutation">("specs:update"),{id:setup.ids.specId,expectedRevision:0,name:"Parallel",description:"",yaml:spec});
    await owner.mutation(makeFunctionReference<"mutation">("specs:publish"),{id:setup.ids.specId,expectedRevision:1,version:"1.1.0",changelog:"",makeDefault:true});
    const requestId=await owner.mutation(makeFunctionReference<"mutation">("requests:create"),{specSlug:"demo",pipelineName:"demo",inputs:{}});
    expect(await setup.run()).toBe(0);
    expect((await setup.backend.run(ctx=>ctx.db.get(requestId))).resolvedOutputs).toEqual({text:"prepared\n"});
    const issued=await owner.action(makeFunctionReference<"action">("workloadCredentials:issue"),{name:"parallel",slugs:["parallel-test"]});
    const registry=new RegistryClient(setup.config.server,issued.token);
    const outputs=await executeStandaloneWorkload({source:"parallel-test@1.0.0",cwd:setup.config.workspace,bindings:{},devices:[],registry:{origin:registry.origin,read:registry.read.bind(registry)}},new BunEffects(),async()=>{throw new Error("no fallback");},new AbortController().signal);
    expect(outputs).toEqual({text:"prepared\n"});
    const {resolveWorkloadModules}=await import("../../src/spec/workload-modules");
    const loaded=await resolveWorkloadModules(spec,async()=>{throw new Error("no local source");},new AbortController().signal,undefined,{origin:registry.origin,read:registry.read.bind(registry)});
    expect(loaded.modules[0]!.registry!.versionId).toBe(version);
    const restored=await resolveWorkloadModules(spec,async()=>{throw new Error("offline");},new AbortController().signal,loaded.modules,{origin:registry.origin,read:async()=>{throw new Error("offline");}});
    await new Actions(restored.spec,new BunEffects()).run({type:"ensure_workload",workload:"w"},{sys:{cache_dir:join(setup.config.workspace,"cache")},session:{working_dir:setup.config.workspace}}, {},new AbortController().signal);
    expect(restored.modules).toEqual(loaded.modules);
    // Worker execution uses the published dependency pin.
    await setup.backend.run(async ctx=>{
      const request=await ctx.db.get(requestId);expect((await ctx.db.get(request.specVersionId)).workloadLock.pins[0].versionId).toBe(version);
    });
  } finally {await setup.close();}
});
