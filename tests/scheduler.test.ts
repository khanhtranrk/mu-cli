import { expect, test } from "bun:test";
import { Scheduler, validateDevices } from "../src/scheduler/scheduler";
import { Flow } from "../src/engine/flow";
import { parseSpec } from "../src/spec/parse";
import { BunEffects } from "../src/runtime/effects";
import { detectDevices } from "../src/runtime/devices";
import { loadConfig } from "../src/config";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const signal = () => new AbortController().signal;
const tick = async () => { for (let count = 0; count < 20; count++) await Promise.resolve(); };

test("best-fit GPU placement uses composite device identity and never oversubscribes", async () => {
  const scheduler = new Scheduler([{ family: "cuda", index: 0, maxUnits: 4 }, { family: "rocm", index: 0, maxUnits: 8 }], 4);
  const first = deferred(), second = deferred();
  const started: string[] = [];
  const running = scheduler.run(3, signal(), async device => { started.push(device!.family); await first.promise; });
  const other = scheduler.run(4, signal(), async device => { started.push(device!.family); await second.promise; });
  const queued = scheduler.run(5, signal(), async device => { started.push("queued-" + device!.family); });
  await tick();
  expect(started).toEqual(["cuda", "rocm"]);
  expect(scheduler.snapshot().devices.map(device => device.freeUnits)).toEqual([1, 4]);
  first.resolve(); await running; await tick();
  expect(started).toEqual(["cuda", "rocm"]);
  second.resolve(); await Promise.all([other, queued]);
  expect(started).toEqual(["cuda", "rocm", "queued-rocm"]);
  expect(scheduler.snapshot()).toMatchObject({ active: 0, queued: 0 });
  expect(scheduler.snapshot().devices.map(device => device.freeUnits)).toEqual([4, 8]);
});

test("GPU-busy requests queue while CPU work advances; impossible requirements use legacy CPU fallback", async () => {
  const warnings: string[] = [], gate = deferred(), seen: string[] = [];
  const scheduler = new Scheduler([{ family: "cuda", index: 0, maxUnits: 2 }], 4, message => warnings.push(message));
  const first = scheduler.run(2, signal(), async () => { seen.push("first"); await gate.promise; });
  const second = scheduler.run(2, signal(), async () => { seen.push("second"); });
  await scheduler.run(0, signal(), async device => { expect(device).toBeUndefined(); seen.push("cpu"); });
  await scheduler.run(3, signal(), async device => { expect(device).toBeUndefined(); seen.push("fallback"); });
  expect(seen).toEqual(["first", "cpu", "fallback"]); expect(warnings).toHaveLength(1);
  gate.resolve(); await Promise.all([first, second]);
  expect(seen.at(-1)).toBe("second");
});

test("concurrency bound is shared, failures release capacity, cancellation never runs queued jobs", async () => {
  const scheduler = new Scheduler([{ family: "cuda", index: 0, maxUnits: 1 }], 1);
  const gate = deferred();
  const first = scheduler.run(1, signal(), async () => { await gate.promise; throw new Error("failure"); });
  const firstFailed = first.catch(error => error as Error);
  const controller = new AbortController(); let ran = false;
  const queued = scheduler.run(0, controller.signal, async () => { ran = true; });
  const queuedFailed = queued.catch(error => error as Error);
  controller.abort(); await queuedFailed;
  expect(ran).toBe(false); expect(scheduler.snapshot().active).toBe(1);
  gate.resolve(); expect((await firstFailed)?.message).toBe("failure");
  expect(scheduler.snapshot().active).toBe(0); expect(scheduler.snapshot().devices[0]!.freeUnits).toBe(1);
  const fastAbort = new AbortController();
  const scheduled = scheduler.run(1, fastAbort.signal, async () => { ran = true; });
  fastAbort.abort(); await expect(scheduled).rejects.toThrow();
  expect(ran).toBe(false); expect(scheduler.snapshot().active).toBe(0);
});

test("global execution slots cap CPU concurrency independently of GPU units", async () => {
  const scheduler = new Scheduler([], 2), gate = deferred();
  let maximum = 0, active = 0;
  const tasks = Array.from({ length: 8 }, () => scheduler.run(0, signal(), async () => {
    active++; maximum = Math.max(maximum, active); await gate.promise; active--;
  }));
  await tick(); expect(scheduler.snapshot()).toMatchObject({ active: 2, queued: 6 });
  gate.resolve(); await Promise.all(tasks); expect(maximum).toBe(2);
});

test("invalid capacities, duplicate physical devices and invalid concurrency are refused", () => {
  expect(() => validateDevices([{ family: "cuda", index: 0, maxUnits: 0 }])).toThrow();
  expect(() => validateDevices([{ family: "cuda", index: 0, maxUnits: 2 }, { family: "cuda", index: 0, maxUnits: 4 }])).toThrow("Duplicate");
  expect(() => new Scheduler([], 33)).toThrow();
});

test("fractional workload units reserve and restore the configured capacity", async () => {
  const scheduler = new Scheduler([{ family: "cuda", index: 0, maxUnits: 2.5 }], 3), gate = deferred();
  const first = scheduler.run(1.5, signal(), async () => { await gate.promise; });
  const second = scheduler.run(1, signal(), async () => { await gate.promise; });
  let thirdRan = false;
  const third = scheduler.run(.5, signal(), async () => { thirdRan = true; });
  await tick(); expect(scheduler.snapshot().devices[0]!.freeUnits).toBe(0); expect(thirdRan).toBe(false);
  gate.resolve(); await Promise.all([first, second, third]);
  expect(thirdRan).toBe(true); expect(scheduler.snapshot().devices[0]!.freeUnits).toBe(2.5);
});

test("Flow holds peak GPU reservation through finally and terminal hooks while CPU progresses", async () => {
  const entered = deferred(), finishCleanup = deferred(), enteredHook = deferred(), finishHook = deferred();
  const seen: { target: string; argv: string[] }[] = [];
  class Effects extends BunEffects {
    override async process(argv: string[]) {
      seen.push({ target: argv[0]!, argv });
      if (argv[0] === "cleanup") { entered.resolve(); await finishCleanup.promise; }
      if (argv[0] === "hook" && argv[1] === "first") { enteredHook.resolve(); await finishHook.promise; }
      return { returncode: 0, stdout: "", stderr: "" };
    }
  }
  const effects = new Effects();
  const scheduler = new Scheduler([{ family: "cuda", index: 2, maxUnits: 3 }], 4);
  const spec = parseSpec(JSON.stringify({
    workloads: {
      small: { target: "small", units: 1 }, gpu: { target: "gpu", units: 3, device_args: ["${{ schedule.device_family }}", "${{ schedule.device_index }}"] },
      cpu: { target: "cpu", units: 0, device_args: ["${{ missing.schedule }}"] },
    },
    events: [{ on: "node_finished", do: [{ type: "execute_command", target: "hook", args: ["${{ node.name }}"] }] }],
    pipeline: { p: { nodes: [
      { name: "first", before_run: [{ type: "execute_workload", workload: "small" }], run: [{ type: "execute_workload", workload: "gpu" }, { type: "execute_workload", workload: "cpu" }], finally: [{ type: "execute_command", target: "cleanup" }] },
      { name: "second", run: [{ type: "execute_workload", workload: "gpu" }] },
      { name: "cpu", run: [{ type: "execute_workload", workload: "cpu" }] },
    ] } },
  }));
  const flow = new Flow(spec, { sys: { cache_dir: "/tmp", models: {} }, session: { working_dir: "/tmp" } }, effects, "master_flow", scheduler);
  await flow.initialize(signal());
  const executing = flow.execute({ pipelineName: "p", payload: {}, metadata: {} }, signal());
  await entered.promise;
  expect(seen.filter(item => item.target === "gpu")).toHaveLength(1);
  expect(seen.some(item => item.target === "cpu")).toBe(true);
  expect(scheduler.snapshot().devices[0]!.freeUnits).toBe(0);
  finishCleanup.resolve(); await enteredHook.promise;
  expect(seen.filter(item => item.target === "gpu")).toHaveLength(1);
  finishHook.resolve();
  expect(await executing).toEqual({ first: "success", second: "success", cpu: "success" });
  expect(seen.filter(item => item.target === "gpu").map(item => item.argv)).toEqual([["gpu", "cuda", "2"], ["gpu", "cuda", "2"]]);
  expect(scheduler.snapshot().devices[0]!.freeUnits).toBe(3);
});

test("concurrent Requests share scheduler capacity, prepare once and isolate dependencies/inputs", async () => {
  const scheduler = new Scheduler([], 2);
  let active = 0, maximum = 0, preparations = 0;
  const seen: string[] = [];
  class Effects extends BunEffects {
    override async process(argv: string[]) {
      if (argv[0] === "prepare") preparations++;
      else { active++; maximum = Math.max(maximum, active); seen.push(argv.slice(1).join(":")); await Bun.sleep(5); active--; }
      return { returncode: 0, stdout: "", stderr: "" };
    }
  }
  const spec = parseSpec(JSON.stringify({ pipeline: { p: { inputs: { label: { type: "string" } }, prepare: [{ type: "execute_command", target: "prepare" }], nodes: [
    { name: "a", run: [{ type: "execute_command", target: "fake", args: ["${{ inputs.label }}", "a"] }] },
    { name: "b", depends_on: ["a"], run: [{ type: "execute_command", target: "fake", args: ["${{ inputs.label }}", "b"] }] },
  ] } } }));
  const flow = new Flow(spec, { sys: { cache_dir: "/tmp", models: {} }, session: { working_dir: "/tmp" } }, new Effects(), "master_flow", scheduler);
  await flow.initialize(signal());
  await Promise.all(["one", "two", "three"].map(label => flow.execute({ pipelineName: "p", payload: { label }, metadata: { requestId: label } }, signal())));
  expect(preparations).toBe(1); expect(maximum).toBe(2);
  for (const label of ["one", "two", "three"]) expect(seen.indexOf(label + ":a")).toBeLessThan(seen.indexOf(label + ":b"));
});

test("GPU probes map memory to legacy four-GiB units without running actual GPU commands", async () => {
  const nvidia = await detectDevices(async argv => argv[0] === "nvidia-smi" ? "0, GPU A, 16384\n1, GPU B, 5120\ninvalid" : null);
  expect(nvidia).toEqual([{ family: "cuda", index: 0, maxUnits: 4 }, { family: "cuda", index: 1, maxUnits: 2 }]);
  const amd = await detectDevices(async argv => argv[0] === "rocm-smi" ? "GPU[1] : VRAM Total Memory (B): 8589934592" : null);
  expect(amd).toEqual([{ family: "rocm", index: 1, maxUnits: 2 }]);
});

test("CLI scheduler config validates capacity and explicit retry opt-in", async () => {
  const env = { MU_SERVER_URL: "http://localhost:3211", MU_WORKER_TOKEN: "secret", MU_UNIT_ID: "cpu" };
  expect((await loadConfig({ device: ["cuda,1,4", "rocm,1,8"], concurrency: "3", "shutdown-timeout": "2", resume: true }, env)).devices).toEqual([{ family: "cuda", index: 1, maxUnits: 4 }, { family: "rocm", index: 1, maxUnits: 8 }]);
  await expect(loadConfig({ "retry-incomplete": true }, env)).rejects.toThrow("--resume");
  await expect(loadConfig({ concurrency: "33" }, env)).rejects.toThrow();
});
