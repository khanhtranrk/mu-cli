import { homedir } from "node:os";
import { join } from "node:path";
import { Actions, workloadInputs } from "../engine/actions";
import type { Effects } from "../engine/ports";
import { Scheduler, type Device } from "../scheduler/scheduler";
import { resolveWorkloadModules, type ModuleLoader } from "../spec/workload-modules";
import { jsonValue } from "../spec/expressions";
import { mapping, type Context } from "../spec/types";

export class WorkloadExecutionError extends Error {}
export interface StandaloneOptions {
  source: string;
  sha256?: string;
  cwd: string;
  bindings: Context;
  devices: Device[];
}

/** Small local orchestrator; Actions owns preparation and subprocess semantics. */
export async function executeStandaloneWorkload(options: StandaloneOptions, effects: Effects, load: ModuleLoader, signal: AbortSignal): Promise<Context> {
  signal.throwIfAborted();
  const bindings = mapping(jsonValue(options.bindings), "workload bindings");
  const declaration = { source: options.source, ...(options.sha256 === undefined ? {} : { sha256: options.sha256 }) };
  const { spec } = await resolveWorkloadModules(JSON.stringify({ workloads: { standalone: declaration }, pipeline: {} }), load, signal);
  const workload = spec.workloads!.standalone!;
  if (!await effects.exists(options.cwd, "folder")) throw new Error("--cwd must name an existing directory");
  const cache = join(homedir(), ".cache");
  const context: Context = {
    sys: { cache_dir: cache, models: await effects.discoverModels(cache) },
    session: { working_dir: options.cwd, output_dir: options.cwd, cache_dir: join(cache, "mu", "standalone") },
    actions: {},
  };
  // No installer effects before Field/type checks. The same resolver is used by Actions.
  workloadInputs(workload, context, bindings, "standalone");
  const scheduler = new Scheduler(options.devices, 1, message => effects.warning(message));
  const actions = new Actions(spec, effects, false);
  try {
    await effects.mkdir(String(mapping(context.session).cache_dir));
    await actions.run({ type: "ensure_workload", workload: "standalone" }, context, {}, signal);
    mapping(context.sys).models = await effects.discoverModels(cache);
    await scheduler.run(workload.units ?? 0, signal, async device => {
      context.node = { name: "standalone", status: "running", total_units: workload.units ?? 0, actions: {}, device: { family: device?.family ?? "cpu", index: device ? String(device.index) : null } };
      await actions.run({ type: "execute_workload", workload: "standalone", save_to: "result" }, context, {}, signal, bindings);
    });
    const result = mapping(mapping(mapping(context.node).actions).result);
    return mapping(result.outputs ?? {});
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new WorkloadExecutionError(error instanceof Error ? error.message : "Workload execution failed");
  }
}
