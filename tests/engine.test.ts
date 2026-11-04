import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Flow } from "../src/engine/flow";
import { Actions } from "../src/engine/actions";
import { condition } from "../src/engine/conditions";
import { parseSpec } from "../src/spec/parse";
import { BunEffects } from "../src/runtime/effects";
import { mapping, type Context, type Spec } from "../src/spec/types";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture(spec: unknown) {
  const cwd = await mkdtemp(join(tmpdir(), "mu-engine-")); directories.push(cwd);
  const effects = new BunEffects(fetch, () => {});
  const base: Context = { custom: {}, sys: { cache_dir: cwd, models: {} }, session: { working_dir: cwd, cache_dir: join(cwd, "cache"), output_dir: join(cwd, "output") } };
  const parsed = typeof spec === "string" ? parseSpec(spec) : parseSpec(JSON.stringify(spec));
  const flow = new Flow(parsed, base, effects);
  const signal = new AbortController().signal;
  await flow.initialize(signal);
  return { cwd, effects, base, parsed, flow, signal,
    execute: (payload: unknown = {}, registryContext?: unknown) => flow.execute({ pipelineName: "p", payload, metadata: { requestId: "r" }, registryContext }, signal),
    json: async (name: string) => JSON.parse(await readFile(join(cwd, name), "utf8")),
  };
}
const write = (path: string, content: unknown) => ({ type: "write_json", path: "${{ session.working_dir }}/" + path, content });
const command = (code: string, extra: Context = {}) => ({ type: "execute_command", target: "bun", args: ["-e", code], ...extra });

test("CPU workload resolves argv/env exactly once without a shell, then saves command state", async () => {
  const setup = await fixture({ workloads: { echo: { target: "bun", units: 0, inputs: { message: { type: "string", value: "${{ with.message }}" } }, env: { MU_TEST: "${{ inputs.message }}" }, argv: ["-e", "await Bun.write('workload.json',JSON.stringify({argv:process.argv[1],env:process.env.MU_TEST}));", "${{ inputs.message }}"] } }, pipeline: { p: { inputs: { message: { type: "string" } }, nodes: [{ name: "work", run: [{ type: "execute_workload", workload: "echo", with: { message: "${{ inputs.message }}" } }, command("process.stdout.write(' hi\\n');", { save_to: "cmd" }), write("state.json", "${{ node.actions.cmd }}")] }] } } });
  await setup.execute({ message: "${{ 1 + 1 }}; $(touch forbidden)" });
  expect(await setup.json("workload.json")).toEqual({ argv: "${{ 1 + 1 }}; $(touch forbidden)", env: "${{ 1 + 1 }}; $(touch forbidden)" });
  expect(await setup.json("state.json")).toEqual({ success: true, error: null, returncode: 0, stdout: " hi\n", stderr: "" });
  expect(await setup.effects.exists(join(setup.cwd, "forbidden"), "path")).toBe(false);
});

test("whole-value templates retain typed command argv/env/context", async () => {
  const setup = await fixture({ pipeline: { p: { inputs: { argv: { type: "array" }, env: { type: "object" }, local: { type: "object" } }, nodes: [{ name: "n", run: [
    { type: "execute_command", target: "bun", args: "${{ inputs.argv }}", env: "${{ inputs.env }}", context: "${{ inputs.local }}", save_to: "cmd" },
    write("typed.json", { stdout: "${{ node.actions.cmd.stdout }}", value: "${{ custom.value }}" }),
  ] }] } } });
  await setup.execute({ argv: ["-e", "process.stdout.write(process.env.MU_TEST)"], env: { MU_TEST: "${{ literal }}" }, local: { custom: { value: 42 } } });
  expect(await setup.json("typed.json")).toEqual({ stdout: "${{ literal }}", value: 42 });
});

test("dependency readiness respects reverse YAML order and blocks failed dependents without finally", async () => {
  const setup = await fixture({ pipeline: { p: { nodes: [
    { name: "blocked", depends_on: ["failure"], run: [write("blocked.json", true)], finally: [write("blocked-final.json", true)] },
    { name: "last", depends_on: ["first"], run: [write("last.json", true)] },
    { name: "failure", run: [command("process.exit(7)")], after_run: [write("after.json", true)], finally: [write("failed.json", "${{ node.status }}")] },
    { name: "first", run: [write("first.json", true)] },
  ] } } });
  await expect(setup.execute()).rejects.toThrow("nodes failed");
  expect(await setup.json("failed.json")).toBe("failed");
  expect(await setup.json("last.json")).toBe(true);
  for (const name of ["blocked.json", "blocked-final.json", "after.json"]) expect(await setup.effects.exists(join(setup.cwd, name), "path")).toBe(false);
});

test("successful skip checks postcondition, action precondition skips, node precondition fails, finally keeps updating status", async () => {
  const setup = await fixture({ pipeline: { p: { nodes: [
    { name: "skipped", skip_if: { operator: "and", props: [] }, postcondition: { operator: "cel", expression: "${{ true }}" }, run: [write("not-run.json", true)], finally: [write("skip-final.json", "${{ node.status }}")] },
    { name: "pre", precondition: { operator: "or", props: [] }, finally: [write("pre-final.json", "${{ node.status }}")] },
    { name: "cleanup", run: [write("action-skip.json", true), { ...write("action-not-run.json", true), precondition: { operator: "or", props: [] } }], finally: [command("process.exit(1)"), write("cleanup-final.json", "${{ node.status }}")] },
  ] } } });
  await expect(setup.execute()).rejects.toThrow();
  expect(await setup.json("skip-final.json")).toBe("success"); expect(await setup.json("pre-final.json")).toBe("failed");
  expect(await setup.json("cleanup-final.json")).toBe("failed");
  expect(await setup.effects.exists(join(setup.cwd, "not-run.json"), "file")).toBe(false);
  expect(await setup.effects.exists(join(setup.cwd, "action-not-run.json"), "file")).toBe(false);
});

test("ignored action failures retain failed save_to and ignored node failure allows dependents", async () => {
  const setup = await fixture({ pipeline: { p: { nodes: [
    { name: "ignored-action", run: [command("process.exit(3)", { save_to: "failure", ignore_error: true }), write("saved.json", "${{ node.actions.failure }}")] },
    { name: "ignored-node", ignore_error: true, run: [command("process.exit(2)")], finally: [write("actual.json", "${{ node.status }}")] },
    { name: "dependent", depends_on: ["ignored-node"], run: [write("dependent.json", true)] },
  ] } } });
  expect(await setup.execute()).toEqual({ "ignored-action": "success", "ignored-node": "success", dependent: "success" });
  expect((await setup.json("saved.json")).success).toBe(false); expect((await setup.json("saved.json")).returncode).toBe(3);
  expect(await setup.json("actual.json")).toBe("failed"); expect(await setup.json("dependent.json")).toBe(true);
});

test("prepare runs once only after valid intake; Registry, request and node actions remain isolated", async () => {
  const setup = await fixture({ pipeline: { p: {
    inputs: { name: { type: "string" }, count: { type: "number", default: "${{ Request.Registry.Count }}" } },
    context: { captured: "${{ Request.Registry.Count }}" }, prepare: [command("const f=Bun.file('prepare-count'); await Bun.write(f,String(Number(await f.exists()?await f.text():0)+1));", { save_to: "prepared" })],
    nodes: [{ name: "first", run: [{ ...command("process.stdout.write('private')"), save_to: "private" }] }, { name: "second", run: [write("${{ inputs.name }}.json", { count: "${{ inputs.count }}", captured: "${{ captured }}", prepared: "${{ actions.prepared.success }}", private: "${{ has(actions.private) }}" })] }],
  } } });
  await expect(setup.execute({ name: 1 }, { Request: { Count: 1 } })).rejects.toThrow("string");
  expect(await setup.effects.exists(join(setup.cwd, "prepare-count"), "file")).toBe(false);
  await setup.execute({ name: "one" }, { Request: { Count: 1 } });
  await setup.execute({ name: "two" }, { Request: { Count: 2 } });
  expect(await readFile(join(setup.cwd, "prepare-count"), "utf8")).toBe("1");
  expect(await setup.json("one.json")).toEqual({ count: 1, captured: 1, prepared: true, private: false });
  expect(await setup.json("two.json")).toEqual({ count: 2, captured: 2, prepared: true, private: false });
});

test("routine context is private; inspect_file hashes bytes and returns typed output", async () => {
  const setup = await fixture({ routines: { inspect: { inputs: { path: { type: "string", value: "${{ with.path }}" } }, actions: [{ type: "inspect_file", target: "${{ inputs.path }}", save_to: "info", context: { custom: { secret: true } } }], outputs: {file: {type: "object", value: "${{ actions.info }}"}} } }, pipeline: { p: { nodes: [{ name: "file", run: [write("source.json", { hello: "world" }), { type: "execute_routine", routine: "inspect", with: { path: "source.json" }, save_to: "routine" }, write("result.json", { result: "${{ node.actions.routine }}", leaked: "${{ has(custom.secret) }}" })] }] } } });
  await setup.execute();
  const output = await setup.json("result.json");
  expect(output.leaked).toBe(false); expect(output.result.success).toBe(true);
  expect(output.result.outputs.file.sha256).toMatch(/^[a-f0-9]{64}$/); expect(output.result.outputs.file.name).toBe("source.json");
});

test("event hooks accumulate root/pipeline/node in order, have isolated state, and failures do not change outcomes", async () => {
  const setup = await fixture({
    events: [
      { on: "pipeline_started", do: [write("intake.json", "${{ request.requestId }}")] },
      { on: "node_started", do: [command("await Bun.write('order', 'root,')", { context: { custom: { leaked: true } } })] },
      { on: "node_finished", do: [command("process.exit(1)")] },
      { on: "node_finished", do: [write("finished.json", "${{ event }}")] },
    ],
    pipeline: { p: { events: [{ on: "node_started", do: [command("await Bun.write('order', (await Bun.file('order').text())+'pipeline,')")] }], nodes: [{ name: "n", events: [{ on: "node_started", do: [command("await Bun.write('order', (await Bun.file('order').text())+'node')")] }], run: [write("leaked.json", "${{ has(custom.leaked) }}")] }] } },
  });
  expect(await setup.execute()).toEqual({ n: "success" });
  expect(await readFile(join(setup.cwd, "order"), "utf8")).toBe("root,pipeline,node");
  expect(await setup.json("intake.json")).toBe("r"); expect(await setup.json("leaked.json")).toBe(false);
  const event = await setup.json("finished.json"); expect(event.node.status).toBe("success"); expect(event.error).toBeNull();
});

test("entry finalization attempts all actions after initialization failure", async () => {
  const setup = await fixture({});
  const spec = parseSpec(JSON.stringify({ entries: { master_flow: { initialization: [command("process.exit(1)")], finalization: [command("process.exit(1)"), write("final.json", "${{ entry.status }}")] } } }));
  const flow = new Flow(spec, setup.base, setup.effects);
  await expect(flow.initialize(setup.signal)).rejects.toThrow();
  await expect(flow.finalize(true, setup.signal)).rejects.toThrow();
  expect(await setup.json("final.json")).toBe("failed");
});

test("conditions distinguish missing from null, filesystem types and CPU node placement", async () => {
  const setup = await fixture({});
  const context = { ...setup.base, actions: { step: { value: null } }, node: { actions: {step: {value: null}}, device: { family: "cpu", index: null } } };
  expect(await condition({ operator: "action_state", target: ["step", "value"], expected: null }, context, {}, setup.effects, setup.signal)).toBe(true);
  expect(await condition({ operator: "action_state", target: ["missing"], expected: null }, context, {}, setup.effects, setup.signal)).toBe(false);
  expect(await condition({ operator: "node_state", target: ["device", "index"], expected: null }, context, {}, setup.effects, setup.signal)).toBe(true);
  expect(await condition({ operator: "folder_exists", path: setup.cwd }, context, {}, setup.effects, setup.signal)).toBe(true);
  expect(await condition({ operator: "file_exists", path: setup.cwd }, context, {}, setup.effects, setup.signal)).toBe(false);
  expect(await condition({ operator: "exit_code", target: ["bun", "-e", "process.exit(4)"], expected: 4 }, context, {}, setup.effects, setup.signal)).toBe(true);
});

test("command failure state is available to postcondition/finally and postcondition failure retains output", async () => {
  const setup = await fixture({});
  const actions = new Actions({ pipeline: {} } as Spec, setup.effects);
  const context = { ...setup.base };
  await expect(actions.run({ type: "execute_command", target: "bun", args: ["-e", "process.stdout.write('ok')"], save_to: "cmd", postcondition: { operator: "or", props: [] } }, context, {}, setup.signal)).rejects.toThrow("postcondition");
  const state = mapping(mapping(context.actions).cmd);
  expect(state.stdout).toBe("ok"); expect(state.success).toBe(false); expect(state.returncode).toBe(0);
});

test("legacy offline events fixture produces canonical lifecycle snapshots", async () => {
  const source = await Bun.file(join(import.meta.dir, "fixtures/events.yaml")).text();
  const setup = await fixture(source);
  await setup.flow.execute({ pipelineName: "demo", payload: {}, metadata: {} }, setup.signal);
  expect((await setup.json("pipeline-started.json")).pipeline.status).toBe("running");
  expect((await setup.json("hello-started.json")).node).toMatchObject({ name: "hello", status: "running", device: { family: "cpu", index: null }, total_units: 0 });
  expect((await setup.json("hello-finished.json")).node).toMatchObject({ name: "hello", status: "success", skipped: false, blocked: false, ignored_error: null });
  expect((await setup.json("pipeline-finished.json")).pipeline.status).toBe("success");
});

test("explicit null JSON content remains null", async () => {
  const setup = await fixture({ pipeline: { p: { nodes: [{ name: "n", run: [write("null.json", null)] }] } } });
  await setup.execute();
  expect(await setup.json("null.json")).toBeNull();
});

test("interrupted node attempts finally with a separate bounded cleanup signal", async () => {
  const setup = await fixture({ pipeline: { p: { nodes: [{ name: "n", run: [command("await Bun.sleep(60000)")], finally: [write("interrupted.json", "${{ node.status }}")] }] } } });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 80);
  try {
    await expect(setup.flow.execute({ pipelineName: "p", payload: {}, metadata: {} }, controller.signal)).rejects.toThrow();
    expect(await setup.json("interrupted.json")).toBe("failed");
  } finally { clearTimeout(timeout); }
});

test("legacy offline routines fixture preserves nested calls, dynamic keys and file metadata", async () => {
  const source = await Bun.file(join(import.meta.dir, "fixtures/routines.yaml")).text();
  const setup = await fixture(source);
  await setup.flow.execute({ pipelineName: "demo", payload: {}, metadata: {} }, setup.signal);
  const manifest = await setup.json("output/manifest.json");
  expect(manifest["artifact-demo"].logs).toEqual(["File inspected"]);
  const inspected = await setup.effects.inspect(join(setup.cwd, "output/result.json"));
  expect(manifest["artifact-demo"].file).toEqual({ success: true, error: null, ...inspected });
});

test("Workload with selects explicit Fields, isolates siblings and renders argv from only its inputs", async () => {
  const setup = await fixture({
    workloads: { echo: {
      inputs: {
        selected: { type: "object", value: "${{ with.use ? {'message': with.nested.message, 'id': request.requestId} : {'message': 'fallback', 'id': request.requestId} }}" },
        fixed: { type: "number", value: 7 },
        fallback: { type: "boolean", default: false },
      },
      target: "bun", argv: ["-e", "await Bun.write(process.argv[1], process.argv[2]);", "${{ node.inputs.path }}", "${{ string(inputs.selected.message) + ':' + inputs.selected.id + ':' + string(inputs.fixed) + ':' + string(has(inputs.extra)) + ':' + string(has(inputs.message)) + ':' + string(inputs.fallback) }}"],
    } },
    pipeline: { p: { inputs: { message: { type: "string" } }, nodes: [
      { name: "one", inputs: { path: { type: "string", value: "one.txt" } }, run: [
        { type: "execute_workload", workload: "echo", with: { use: true, nested: { message: "${{ inputs.message }}" }, extra: 100, message: "implicit" } },
        write("caller.json", { inputs: "${{ inputs }}", node: "${{ node.inputs }}" }),
      ] },
      { name: "two", inputs: { path: { type: "string", value: "two.txt" } }, run: [
        { type: "execute_workload", workload: "echo", with: "${{ {'use': false, 'nested': {}} }}" },
      ] },
    ] } },
  });
  await setup.execute({ message: "${{ literal }}" });
  expect(await readFile(join(setup.cwd, "one.txt"), "utf8")).toBe("${{ literal }}:r:7:false:false:false");
  expect(await readFile(join(setup.cwd, "two.txt"), "utf8")).toBe("fallback:r:7:false:false:false");
  expect(await setup.json("caller.json")).toEqual({ inputs: { message: "${{ literal }}" }, node: { path: "one.txt" } });
});

test("Workload with cannot implicitly supply a required Field, and with is unavailable to argv", async () => {
  const setup = await fixture({});
  for (const workload of [
    { inputs: { x: { type: "string" } }, target: "bun", argv: [] },
    { inputs: {}, target: "bun", argv: ["${{ with.x }}"] },
    { inputs: {}, target: "bun", argv: ["${{ inputs.x }}"] },
    { inputs: { x: { type: "number", value: "${{ with.x }}" } }, target: "bun", argv: [] },
  ]) {
    const spec = parseSpec(JSON.stringify({ workloads: { w: workload } }));
    const context = structuredClone(setup.base);
    await expect(new Actions(spec, setup.effects).run({ type: "execute_workload", workload: "w", with: { x: "provided" } }, context, {}, setup.signal)).rejects.toThrow();
    expect(Object.hasOwn(context, "with")).toBe(false);
    expect(Object.hasOwn(context, "inputs")).toBe(false);
  }
});

test("Pipeline, Node and Routine Fields resolve explicit values in their owner scope", async () => {
  const setup = await fixture({
    routines: { r: { inputs: { n: { type: "number", value: "${{ node.inputs.n + 1 }}" }, text: { type: "string", value: "unused" } }, actions: [], outputs: {values: {type: "object", value: "${{ inputs }}"}} } },
    pipeline: { p: { inputs: { n: { type: "number", value: 2 }, label: { type: "string", value: "unused" } }, nodes: [
      { name: "n", inputs: { n: { type: "number", value: "${{ pipeline.inputs.n * 3 }}" } }, run: [
        { type: "execute_routine", routine: "r", with: { text: "${{ inputs.label }}" }, save_to: "r" },
        write("scopes.json", { pipeline: "${{ inputs }}", node: "${{ node.inputs }}", routine: "${{ node.actions.r.outputs.values }}" }),
      ] },
    ] } },
  });
  await setup.execute({ label: "${{ literal }}" });
  expect(await setup.json("scopes.json")).toEqual({ pipeline: { n: 2, label: "${{ literal }}" }, node: { n: 6 }, routine: { n: 7, text: "unused" } });
});

test("Node context resolves parent namespaces under node only, before Node inputs and conditions", async () => {
  const setup = await fixture({pipeline: {p: {
    inputs: {message: {type: "string"}},
    nodes: [{name: "publish", context: {
      result_path: "${{ session.working_dir }}/node-context.json",
      message: "${{ inputs.message + ':' + request.requestId + ':' + node.name }}",
      captured: "${{ Request.Registry.Tag }}",
    }, inputs: {path: {type: "string", value: "${{ node.result_path }}"}},
    precondition: {operator: "cel", expression: "${{ node.message == 'hello:r:publish' }}"},
    run: [{type: "write_json", path: "${{ node.inputs.path }}", content: {message: "${{ node.message }}", captured: "${{ node.captured }}", name: "${{ node.name }}"}}],
    finally: [write("node-context-final.json", "${{ node.result_path }}")],
    events: [{on: "node_finished", do: [write("node-context-event.json", "${{ event.node.result_path }}")]}],
    }],
  }}});
  await setup.execute({message: "hello"}, {Request: {Tag: "captured"}});
  expect(await setup.json("node-context.json")).toEqual({message: "hello:r:publish", captured: "captured", name: "publish"});
  expect(await setup.json("node-context-final.json")).toBe(join(setup.cwd, "node-context.json"));
  expect(await setup.json("node-context-event.json")).toBe(join(setup.cwd, "node-context.json"));
});

test("Node context does not create bare root variables or replace parent values", async () => {
  const setup = await fixture({pipeline: {p: {
    context: {shared: "parent"}, nodes: [{name: "n", context: {result_path: "private", shared: "node"}, run: [
      write("node-shadow.json", {root: "${{ shared }}", local: "${{ node.shared }}"}),
      write("bare-must-fail.json", "${{ result_path }}"),
    ]}],
  }}});
  await expect(setup.execute()).rejects.toThrow("nodes failed");
  expect(await setup.json("node-shadow.json")).toEqual({root: "parent", local: "node"});
  expect(await setup.effects.exists(join(setup.cwd, "bare-must-fail.json"), "file")).toBe(false);
});

test("Node context remains private across sibling Nodes, Pipeline hooks and repeated Requests", async () => {
  const setup = await fixture({pipeline: {p: {
    inputs: {private: {type: "boolean"}},
    events: [{on: "pipeline_finished", do: [{...write("pipeline-context.json", "${{ private_key }}"), ignore_error: true}]}],
    nodes: [
      {name: "owner", context: "${{ inputs.private ? {'private_key': 'owned'} : {} }}", run: [write("owner-context.json", "${{ has(node.private_key) }}")]},
      {name: "sibling", depends_on: ["owner"], run: [write("sibling-context.json", "${{ has(node.private_key) }}")]},
    ],
  }}});
  await setup.execute({private: true});
  expect(await setup.json("owner-context.json")).toBe(true);
  expect(await setup.json("sibling-context.json")).toBe(false);
  expect(await setup.effects.exists(join(setup.cwd, "pipeline-context.json"), "file")).toBe(false);
  await setup.execute({private: false});
  expect(await setup.json("owner-context.json")).toBe(false);
  expect(await setup.json("sibling-context.json")).toBe(false);
});

test("literal and dynamic Node context collisions reject reserved fields without modifying Node metadata", async () => {
  const reserved = ["name", "status", "inputs", "outputs", "actions", "state", "total_units", "device", "skipped", "blocked", "ignored_error"];
  for (const key of reserved) expect(() => parseSpec(JSON.stringify({pipeline: {p: {nodes: [{name: "n", context: {[key]: "forged"}}]}}}))).toThrow(`node.n.context.${key}: reserved Node field`);
  const setup = await fixture({pipeline: {p: {
    inputs: {context: {type: "object"}}, nodes: [{name: "n", context: "${{ inputs.context }}",
      run: [write("collision-ran.json", true)],
      finally: [write("collision-metadata.json", "${{ node }}")],
      events: [{on: "node_finished", do: [write("collision-error.json", "${{ event.error.message }}")]}],
    }],
  }}});
  for (const key of reserved) {
    await expect(setup.execute({context: {safe: "not-injected", [key]: "forged"}})).rejects.toThrow("nodes failed");
    expect(await setup.json("collision-error.json")).toBe(`node.n.context.${key}: reserved Node field`);
    expect(await setup.json("collision-metadata.json")).toEqual({actions: {}, name: "n", status: "failed", total_units: 0, device: {family: "cpu", index: null}});
  }
  expect(await setup.effects.exists(join(setup.cwd, "collision-ran.json"), "file")).toBe(false);
});
