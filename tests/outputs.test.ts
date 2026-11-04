import {expect, test} from "bun:test";
import {Flow} from "../src/engine/flow";
import {BunEffects} from "../src/runtime/effects";
import {parseSpec} from "../src/spec/parse";
import {Worker} from "../src/worker";
import {DataCenterClient} from "../src/api";
import {SpecExecutor} from "../src/runtime/spec-executor";
import {StateStore} from "../src/state";
import {createHash} from "node:crypto";
import {mkdtemp, rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import type {WorkerConfig} from "../src/config";
import type {Context} from "../src/spec/types";

test("typed Workload/Routine/Node/Pipeline outputs publish only after validation and feed dependencies", async () => {
  const bodies: Context[] = [];
  const transport = (async (_url: unknown, options: RequestInit) => {bodies.push(JSON.parse(String(options.body))); return Response.json({ok: true});}) as typeof fetch;
  class Effects extends BunEffects {override async process() {return {returncode: 0, stdout: "value", stderr: ""};}}
  const spec = parseSpec(JSON.stringify({workloads: {w: {target: "fake", outputs: {text: {type: "string", value: "${{ result.stdout }}"}}}}, routines: {r: {inputs: {x: {type: "string", value: "${{ with.x }}"}}, actions: [], outputs: {x: {type: "string", value: "${{ inputs.x }}"}}}}, pipeline: {p: {outputs: {result: {type: "string", value: "${{ pipeline.nodes.last.outputs.result }}"}}, nodes: [
    {name: "first", run: [{type: "execute_workload", workload: "w", save_to: "w"}, {type: "execute_routine", routine: "r", with: {x: "${{ node.actions.w.outputs.text }}"}, save_to: "r"}], outputs: {result: {type: "string", value: "${{ node.actions.r.outputs.x }}"}}},
    {name: "last", depends_on: ["first"], outputs: {result: {type: "string", value: "${{ pipeline.nodes.first.outputs.result + '!' }}"}}},
  ]}}}));
  const flow = new Flow(spec, {sys: {}, session: {working_dir: "/tmp", server: "http://server", token: "token"}}, new Effects(transport));
  const signal = new AbortController().signal; await flow.initialize(signal);
  await flow.execute({pipelineName: "p", payload: {}, metadata: {requestId: "r", assignmentVersion: 1}}, signal);
  expect(bodies.at(-1)?.pipelineState).toEqual({status: "success", outputs: {result: "value!"}});
  expect(bodies.some(body => (body.node_states as any)?.first?.outputs?.result === "value")).toBe(true);
});

test("terminal-report recovery resends persisted outputs without running actions or hooks", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "mu-outbox-"));
  try {
    const config: WorkerConfig = {server: "http://server", token: "token", unitId: "cpu", specs: ["s"], workspace, maxClaim: 1, pollInterval: 1, heartbeatInterval: 30, fake: false, resume: true};
    const reportBodies: unknown[] = [];
    const transport = (async (url: unknown, options?: RequestInit) => {const path = new URL(String(url)).pathname; if (path.endsWith("report")) reportBodies.push(JSON.parse(String(options?.body))); if (path.endsWith("claim")) throw new Error("Must not claim during resume"); return Response.json({ok: true});}) as typeof fetch;
    const store = new StateStore(join(workspace, createHash("sha256").update(config.server + "\n" + config.unitId).digest("hex")));
    await store.save({request: {requestId: "r", assignmentVersion: 1, specSlug: "s", pipelineName: "p", payload: {}, artifacts: []}, phase: "executing", reporting: "spec", execution: {version: 2, stage: "finishing", pipelineName: "p", base: {}, context: {pipeline: {status: "success", outputs: {result: 3}}}, states: {n: "success"}}});
    const effects = new BunEffects(transport);
    expect(await new Worker(config, new DataCenterClient(config, transport), new SpecExecutor(config, effects)).run("once", new AbortController().signal)).toBe(0);
    expect(reportBodies).toEqual([{id: "r", status: "succeeded", pipelineState: {status: "success", outputs: {result: 3}}}]);
    expect((await store.load())[0]?.phase).toBe("reported");
  } finally {await rm(workspace, {recursive: true, force: true});}
});

test("permanent terminal-output rejection fails the Request instead of replaying invalid success forever", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "mu-output-rejected-"));
  try {
    const config: WorkerConfig = {server: "http://server", token: "token", unitId: "cpu", specs: ["s"], workspace, maxClaim: 1, pollInterval: 1, heartbeatInterval: 30, fake: false};
    const reports: Context[] = [];
    const transport = (async (url: unknown, options?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path.includes("/specs/")) return new Response('pipeline: {p: {outputs: {answer: {type: number, value: 3}}, nodes: []}}');
      if (path.endsWith("claim")) return Response.json([{requestId: "r", assignmentVersion: 1, specSlug: "s", pipelineName: "p", payload: {}, artifacts: []}]);
      if (path.endsWith("report")) {const body = JSON.parse(String(options?.body)); reports.push(body); if (body.pipelineState) return new Response(null, {status: 400});}
      return Response.json({ok: true});
    }) as typeof fetch;
    const worker = new Worker(config, new DataCenterClient(config, transport), new SpecExecutor(config, new BunEffects(transport)));
    expect(await worker.run("once", new AbortController().signal)).toBe(6);
    expect(reports.at(-1)?.status).toBe("process_failed");
    expect(reports.filter(report => report.pipelineState)).toHaveLength(1);
  } finally {await rm(workspace, {recursive: true, force: true});}
});

test("concurrent Requests share one initialized captured Spec and do not execute a failed initialization", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "mu-initialization-"));
  try {
    const config: WorkerConfig = {server: "http://server", token: "token", unitId: "cpu", specs: ["s"], workspace, maxClaim: 2, pollInterval: 1, heartbeatInterval: 30, fake: false};
    let initialized = 0, ran = 0;
    class Effects extends BunEffects {override async process(argv: string[]) {if (argv[0] === "initialize") {initialized++; await new Promise(resolve => setTimeout(resolve, 10));} else ran++; return {returncode: 0, stdout: "", stderr: ""};}}
    const transport = (async () => Response.json({ok: true})) as unknown as typeof fetch;
    const executor = new SpecExecutor(config, new Effects(transport));
    const source = JSON.stringify({entries: {master_flow: {initialization: [{type: "execute_command", target: "initialize"}]}}, pipeline: {p: {nodes: [{name: "n", run: [{type: "execute_command", target: "run"}]}]}}});
    await Promise.all(["a", "b"].map(requestId => executor.execute(source, {requestId, assignmentVersion: 1, specSlug: "s", pipelineName: "p", payload: {}, artifacts: []}, new AbortController().signal)));
    expect(initialized).toBe(1); expect(ran).toBe(2);
    await executor.finalize(false);
    let attempts = 0;
    class FailedEffects extends Effects {override async process(argv: string[]) {if (argv[0] === "initialize") {attempts++; return {returncode: 1, stdout: "", stderr: ""};} return super.process(argv);}}
    const failed = new SpecExecutor(config, new FailedEffects(transport));
    const outcomes = await Promise.allSettled(["c", "d"].map(requestId => failed.execute(source, {requestId, assignmentVersion: 1, specSlug: "s", pipelineName: "p", payload: {}, artifacts: []}, new AbortController().signal)));
    expect(outcomes.every(outcome => outcome.status === "rejected")).toBe(true); expect(attempts).toBe(1); expect(ran).toBe(2);
    await failed.finalize(true);
  } finally {await rm(workspace, {recursive: true, force: true});}
});

for (const outputs of [false, true]) test(`fake execution respects captured output contract (${outputs ? "typed outputs" : "no outputs"})`, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "mu-fake-outputs-"));
  try {
    const config: WorkerConfig = {server: "http://server", token: "token", unitId: "cpu", specs: ["s"], workspace, maxClaim: 1, pollInterval: 1, heartbeatInterval: 30, fake: true};
    const specYaml = outputs ? 'pipeline: {p: {outputs: {result: {type: number, value: 3}}}}' : 'pipeline: {p: {nodes: []}}';
    const reports: Context[] = [];
    const transport = (async (url: unknown, options?: RequestInit) => {const path = new URL(String(url)).pathname; if (path.endsWith("claim")) return Response.json([{requestId: "r", assignmentVersion: 1, specSlug: "s", pipelineName: "p", payload: {}, artifacts: [], specYaml}]); if (path.endsWith("report")) reports.push(JSON.parse(String(options?.body))); return Response.json({ok: true});}) as typeof fetch;
    const worker = new Worker(config, new DataCenterClient(config, transport), {execute: async () => {}});
    expect(await worker.run("once", new AbortController().signal)).toBe(outputs ? 6 : 0);
    expect(reports.at(-1)?.status).toBe(outputs ? "process_failed" : "succeeded");
    expect(reports.at(-1)?.pipelineState).toEqual(outputs ? undefined : {status: "success", outputs: {}});
  } finally {await rm(workspace, {recursive: true, force: true});}
});
