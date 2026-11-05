import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { workloadBindings } from "../src/workload-bindings";
import { executeStandaloneWorkload, WorkloadExecutionError } from "../src/runtime/workload-executor";
import { BunEffects } from "../src/runtime/effects";
import { workloadLoader } from "../src/runtime/workload-loader";
import { sha256 } from "../src/spec/workload-modules";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, {recursive: true, force: true}); });
async function directory() {const dir = await mkdtemp(join(tmpdir(), "mu-workload-exec-")); dirs.push(dir); return dir;}
const signal = () => new AbortController().signal;
const module = {
  routines: {install: {actions: [{type: "execute_command", target: "install"}]}},
  prepare: [{type: "execute_routine", routine: "install"}],
  workload: {target: "run", units: 1, inputs: {message: {type: "string", value: "${{ with.message }}"}, count: {type: "number", default: 2}}, argv: ["${{ inputs.message }}", "${{ inputs.count }}"], device_args: ["--device", "${{ schedule.device_index }}"], outputs: {text: {type: "string", value: "${{ result.stdout }}"}}},
};
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
async function cli(args: string[], cwd: string) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/index.ts"), "workload", ...args], {cwd, env: {PATH: process.env.PATH, HOME: cwd}, stdout: "pipe", stderr: "pipe"});
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return {code, out, err};
}

test("bindings preserve strings, split only first equals, allow JSON types and shallow overrides", () => {
  expect(workloadBindings({with: ["code=001", "bool=false", "empty=", "url=a=b", "literal=${{ unknown }}", "dotted.key=value"], withJson: ["count=1.05", "enabled=false", "sizes=[512,1024]", 'options={"fast":true}', 'quoted="001"', "nullable=null"]}, {code: "old", options: {old: true}})).toEqual({code: "001", bool: "false", empty: "", url: "a=b", literal: "${{ unknown }}", "dotted.key": "value", count: 1.05, enabled: false, sizes: [512,1024], options: {fast: true}, quoted: "001", nullable: null});
});

test("invalid JSON, non-object files, duplicate or forbidden keys are errors", () => {
  for (const flags of [{with: ["missing"]}, {with: ["=x"]}, {with: [" =x"]}, {with: ["x=1", "x=2"]}, {with: ["x=1"], withJson: ["x=2"]}, {withJson: ["x=01"]}, {withJson: ["x="]}, {withJson: ["x=NaN"]}, {withJson: ["x=1e999"]}, {with: ["__proto__=x"]}, {with: ["constructor=x"]}, {with: ["__mu_expression_engine=x"]}]) expect(() => workloadBindings(flags)).toThrow();
  for (const file of [null, [], 1, "string", JSON.parse('{"__proto__":{}}')]) expect(() => workloadBindings({}, file)).toThrow();
});

test("standalone shares literal bindings, Field defaults, scoped setup, GPU args and Outputs", async () => {
  const cwd = await directory(), calls: string[][] = [], http: unknown[] = [];
  class Effects extends BunEffects {
    override async process(argv: string[]) {calls.push(argv); return {returncode: 0, stdout: "declared result", stderr: ""};}
    override async http(...args: Parameters<BunEffects["http"]>): Promise<never> {http.push(args); throw new Error("unexpected HTTP");}
  }
  const outputs = await executeStandaloneWorkload({source: "module.yaml", cwd, bindings: {message: "literal ${{ not_evaluated }}", extra: 123, count: 100}, devices: [{family: "cuda", index: 3, maxUnits: 2}]}, new Effects(), async () => bytes(module), signal());
  expect(outputs).toEqual({text: "declared result"});
  expect(calls).toEqual([["install"], ["run", "literal ${{ not_evaluated }}", "2", "--device", "3"]]);
  expect(http).toEqual([]);
});

test("invalid bindings/Fields/hash/module fail before any installation effect", async () => {
  const cwd = await directory(); let effects = 0;
  class Effects extends BunEffects {
    override async mkdir() {effects++;}
    override async process() {effects++; return {returncode: 0, stdout: "", stderr: ""};}
  }
  for (const bindings of [{}, {message: 12}, {message: null}]) await expect(executeStandaloneWorkload({source: "./m", cwd, bindings, devices: []}, new Effects(), async () => bytes(module), signal())).rejects.toThrow();
  await expect(executeStandaloneWorkload({source: "https://example.com/m", sha256: "0".repeat(64), cwd, bindings: {message: "x"}, devices: []}, new Effects(), async () => Buffer.from("invalid: ["), signal())).rejects.toThrow("SHA-256 mismatch");
  expect(effects).toBe(0);
});

test("setup failure prevents dispatch and nonzero workload exit is an execution error", async () => {
  const cwd = await directory();
  for (const failing of ["install", "run"]) {
    const calls: string[] = [];
    class Effects extends BunEffects {
      override async process(argv: string[]) {calls.push(argv[0]!); return {returncode: argv[0] === failing ? 1 : 0, stdout: "", stderr: ""};}
    }
    await expect(executeStandaloneWorkload({source: "./m", cwd, bindings: {message: "x"}, devices: []}, new Effects(), async () => bytes(module), signal())).rejects.toBeInstanceOf(WorkloadExecutionError);
    expect(calls).toEqual(failing === "install" ? ["install"] : ["install", "run"]);
  }
});

test("server-only actions fail clearly inside private preparation routines without HTTP calls", async () => {
  const cwd = await directory();
  for (const action of [
    {type: "report_request", events: []}, {type: "report_node", events: []},
    {type: "upload_artifact", artifact_id: "output", target: "file"},
    {type: "download_artifact", artifact: {artifactId: "x"}, target: "file"},
    {type: "send_notification", title: "title", message: "body"},
  ]) {
    const value = {...module, routines: {install: {actions: [action]}}};
    await expect(executeStandaloneWorkload({source: "./m", cwd, bindings: {message: "x"}, devices: []}, new BunEffects((async () => {throw new Error("unexpected HTTP");}) as unknown as typeof fetch), async () => bytes(value), signal())).rejects.toThrow("unavailable in standalone");
  }
});

test("local command runs real processes without credentials; source/file remain relative to caller when --cwd changes", async () => {
  const cwd = await directory(); await mkdir(join(cwd, "selected"));
  const value = {
    prepare: [{type: "execute_command", target: process.execPath, args: ["-e", "await Bun.write('installed', 'yes'); console.log('setup log')"]}],
    workload: {target: process.execPath, units: 0, inputs: {path: {type: "string", value: "${{ with.path }}"}, scale: {type: "number", value: "${{ with.scale }}"}}, argv: ["-e", "if (!await Bun.file('installed').exists()) process.exit(1); console.log(process.cwd() + ':' + process.argv[1] + ':' + process.argv[2]); console.error('process stderr')", "${{ inputs.path }}", "${{ inputs.scale }}"], outputs: {text: {type: "string", value: "${{ result.stdout }}"}}},
  };
  await Bun.write(join(cwd, "module.yaml"), bytes(value));
  await Bun.write(join(cwd, "bindings.json"), JSON.stringify({path: "./cover.png", scale: 2}));
  const result = await cli(["exec", "module.yaml", "--cwd", "selected", "--with-file", "bindings.json", "--with-json", "scale=1.05", "--json"], cwd);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out)).toEqual({success: true, outputs: {text: join(cwd, "selected") + ":./cover.png:1.05\n"}});
  expect(result.err).toContain("setup log"); expect(result.err).toContain("process stderr");
  expect(await Bun.file(join(cwd, "selected", "installed")).text()).toBe("yes");
});

test("HTTPS module runs through the shared loader with optional digest", async () => {
  const cwd = await directory(), value = bytes({workload: {target: process.execPath, units: 0, argv: ["-e", "console.log('https')"], outputs: {text: {type: "string", value: "${{ result.stdout }}"}}}});
  const transport = (async (_url: unknown, init: RequestInit) => {expect(new Headers(init.headers).get("authorization")).toBeNull(); return new Response(value);}) as unknown as typeof fetch;
  expect(await executeStandaloneWorkload({source: "https://example.com/module.yaml", sha256: sha256(value), cwd, bindings: {}, devices: []}, new BunEffects(), workloadLoader(undefined, transport), signal())).toEqual({text: "https\n"});
});

test("CLI help, validation errors, runtime failures, and human-readable output use documented codes", async () => {
  const cwd = await directory();
  expect((await cli(["exec", "--help"], cwd)).out).toContain("--with-json");
  for (const args of [["exec"], ["exec", "m", "--unknown"], ["exec", "m", "--with", "bad"], ["exec", "m", "--device", "cuda,bad,1"]]) expect((await cli(args, cwd)).code).toBe(2);
  await Bun.write(join(cwd, "fail.yaml"), bytes({workload: {target: process.execPath, argv: ["-e", "console.log('failure log'); process.exit(3)"]}}));
  const failure = await cli(["exec", "fail.yaml", "--json"], cwd);
  expect(failure.code).toBe(6); expect(JSON.parse(failure.out)).toMatchObject({success: false, exitCode: 6}); expect(failure.err).toContain("failure log");
  await Bun.write(join(cwd, "ok.yaml"), bytes({workload: {target: process.execPath, argv: ["-e", "console.log('hello')"]}}));
  const success = await cli(["exec", "ok.yaml"], cwd); expect(success.code).toBe(0); expect(success.out).toContain("Workload succeeded"); expect(success.err).toContain("hello");
  await Bun.write(join(cwd, "bad.json"), "[]");
  const invalid = await cli(["exec", "ok.yaml", "--with-file", "bad.json", "--json"], cwd); expect(invalid.code).toBe(2); expect(JSON.parse(invalid.out).exitCode).toBe(2);
});

test("cancellation kills the real child and releases installation locks", async () => {
  const cwd = await directory(), controller = new AbortController();
  const value = {prepare: [{type: "execute_command", target: process.execPath, args: ["-e", "await Bun.sleep(10000)"]}], workload: {target: process.execPath, units: 0}};
  class Effects extends BunEffects {
    override async process(...args: Parameters<BunEffects["process"]>) {
      setTimeout(() => controller.abort(new Error("cancelled")), 30);
      return super.process(...args);
    }
  }
  await expect(executeStandaloneWorkload({source: "./m", cwd, bindings: {}, devices: []}, new Effects(), async () => bytes(value), controller.signal)).rejects.toThrow("cancelled");
  await new BunEffects().withWorkloadLock(join((await import("node:os")).homedir(), ".cache"), signal(), async () => {});
});


test("CLI interruption emits one JSON failure and stops the child process", async () => {
  const cwd = await directory();
  await Bun.write(join(cwd, "wait.yaml"), bytes({workload: {target: process.execPath, units: 0, argv: ["-e", "await Bun.write('child.pid', String(process.pid)); await Bun.sleep(10000)"]}}));
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/index.ts"), "workload", "exec", "wait.yaml", "--json"], {cwd, env: {PATH: process.env.PATH, HOME: cwd}, stdout: "pipe", stderr: "pipe"});
  try {
    const deadline = Date.now() + 3000;
    while (!await Bun.file(join(cwd, "child.pid")).exists()) {
      if (Date.now() > deadline) throw new Error("child did not start");
      await Bun.sleep(10);
    }
    const pid = Number(await Bun.file(join(cwd, "child.pid")).text());
    child.kill("SIGTERM");
    const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(130); expect(JSON.parse(out)).toMatchObject({success: false, exitCode: 130});
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {child.kill("SIGKILL"); await child.exited;}
});


test("preparation does not receive invocation bindings", async () => {
  const cwd = await directory(); let processes = 0;
  class Effects extends BunEffects {
    override async process() {processes++; return {returncode: 0, stdout: "", stderr: ""};}
  }
  const value = {...module, prepare: [{type: "execute_command", target: "install", args: ["${{ invocation.message }}"]}]};
  await expect(executeStandaloneWorkload({source: "./m", cwd, bindings: {message: "x"}, devices: []}, new Effects(), async () => bytes(value), signal())).rejects.toThrow();
  expect(processes).toBe(0);
});

test("CLI cancellation also terminates device detection probes", async () => {
  const cwd = await directory();
  await Bun.write(join(cwd, "nvidia-smi"), "#!/bin/sh\necho $$ > probe.pid\nsleep 10\n");
  await chmod(join(cwd, "nvidia-smi"), 0o755);
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/index.ts"), "workload", "exec", "unused.yaml", "--json"], {cwd, env: {PATH: cwd + ":" + process.env.PATH, HOME: cwd}, stdout: "pipe", stderr: "pipe"});
  try {
    const deadline = Date.now() + 3000;
    while (!await Bun.file(join(cwd, "probe.pid")).exists()) {
      if (Date.now() > deadline) throw new Error("probe did not start");
      await Bun.sleep(10);
    }
    const pid = Number(await Bun.file(join(cwd, "probe.pid")).text());
    child.kill("SIGINT");
    const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(130); expect(JSON.parse(out).exitCode).toBe(130);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {child.kill("SIGKILL"); await child.exited;}
});
