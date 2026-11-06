import { registryReference, workloadSourceKind } from "../spec/registry-reference";
import type { RegistryResolution } from "../spec/workload-modules";
import { muCacheDirectory } from "./cache-directory";
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
  registry?: RegistryResolution;
}

/** Small local orchestrator; Actions owns preparation and subprocess semantics. */
export async function executeStandaloneWorkload(options: StandaloneOptions, effects: Effects, load: ModuleLoader, signal: AbortSignal): Promise<Context> {
  signal.throwIfAborted();
  const bindings = mapping(jsonValue(options.bindings), "workload bindings");
  const ref = workloadSourceKind(options.source) === "registry" ? registryReference(options.source) : null;
  const declaration = ref ? {registry: ref.slug, ...(ref.version ? {version: ref.version} : {})} : { source: options.source, ...(options.sha256 === undefined ? {} : { sha256: options.sha256 }) };
  if (ref && options.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(options.sha256)) throw new Error("Invalid registry SHA-256");
  const registry = options.registry ? {...options.registry, read: async (...args: Parameters<RegistryResolution["read"]>) => {const result = await options.registry!.read(...args); if (options.sha256 !== undefined && result.sha256 !== options.sha256.toLowerCase()) throw new Error("Registry workload SHA-256 mismatch"); return result;}} : undefined;
  const { spec } = await resolveWorkloadModules(JSON.stringify({ workloads: { standalone: declaration }, pipeline: {} }), load, signal, undefined, registry);
  const workload = spec.workloads!.standalone!;
  if (!await effects.exists(options.cwd, "folder")) throw new Error("--cwd must name an existing directory");
  const cache = muCacheDirectory();
  const context: Context = {
    sys: { cache_dir: cache, models: await effects.discoverModels(cache) },
    session: { working_dir: options.cwd, output_dir: options.cwd, cache_dir: join(cache, "standalone") },
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
