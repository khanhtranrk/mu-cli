import { createHash } from "node:crypto";
import { parseSpec, parseYamlMapping } from "./parse";
import { mapping, type Spec, type Action } from "./types";
import { validateWorkloadSource } from "./workload-source";

export const moduleByteLimit = 1024 * 1024;
export interface ModuleSnapshot { name: string; source: string; sha256: string; bytes: string }
export interface ResolvedModule { spec: Spec; prepare: Action[]; sha256: string }
// Runtime metadata cannot be supplied through YAML or collide with user declarations.
export const workloadModules = new WeakMap<Spec, Map<string, ResolvedModule>>();
export type ModuleLoader = (source: string, signal: AbortSignal) => Promise<Uint8Array>;
export const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

export async function resolveWorkloadModules(source: string, load: ModuleLoader, signal: AbortSignal, pinned?: ModuleSnapshot[]): Promise<{ spec: Spec; modules: ModuleSnapshot[] }> {
  const root = parseYamlMapping(source);
  // Structural checks happen before any source is fetched. No process effects here.
  const structural = parseSpec(source, { allowExternal: true });
  const declarations = mapping(root.workloads ?? {}, "workloads");
  const modules: ModuleSnapshot[] = [], scopes = new Map<string, ResolvedModule>();
  const externals = Object.entries(declarations).filter(([, raw]) => Object.hasOwn(mapping(raw), "source"));
  if (externals.length > 64) throw new Error("External workload limit exceeded (64)");
  if (pinned !== undefined && (!Array.isArray(pinned) || pinned.length !== externals.length || new Set(pinned.map(item => item?.name)).size !== pinned.length)) throw new Error("Invalid pinned workload module manifest");
  if (!externals.length) return { spec: structural, modules: [] };
  let total = 0;
  for (const [name, raw] of externals) {
    signal.throwIfAborted();
    const declaration = mapping(raw);
    validateWorkloadSource(declaration, `workloads.${name}`);
    const location = declaration.source as string;
    const saved = pinned?.find(item => item.name === name);
    if (pinned !== undefined && (!saved || saved.source !== location || typeof saved.bytes !== "string" || saved.bytes.length > Math.ceil(moduleByteLimit / 3) * 4 || !/^[a-f\d]{64}$/.test(saved.sha256))) throw new Error(`Invalid pinned workload module ${name}`);
    const bytes = saved ? Buffer.from(saved.bytes, "base64") : await load(location, signal);
    signal.throwIfAborted();
    total += bytes.byteLength;
    if (bytes.byteLength > moduleByteLimit || total > 8 * moduleByteLimit) throw new Error("Workload module size limit exceeded");
    const hash = sha256(bytes);
    if (saved && (hash !== saved.sha256 || Buffer.from(bytes).toString("base64") !== saved.bytes)) throw new Error(`Pinned workload ${name}: SHA-256/content mismatch`);
    if (declaration.sha256 !== undefined && hash !== (declaration.sha256 as string).toLowerCase()) throw new Error(`Workload ${name}: SHA-256 mismatch`);
    const module = parseYamlMapping(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (Object.keys(module).some(key => !["routines", "prepare", "workload"].includes(key))) throw new Error(`Workload module ${name}: only routines, prepare and workload are allowed; nested imports are unsupported`);
    const workload = mapping(module.workload, `module ${name}.workload`);
    if (Object.hasOwn(workload, "source")) throw new Error(`Workload module ${name}: nested imports are unsupported`);
    const scoped = parseSpec(JSON.stringify({ routines: module.routines === undefined ? {} : module.routines, workloads: { module: workload }, pipeline: { module: { prepare: module.prepare === undefined ? [] : module.prepare } } }));
    // Modules cannot recursively ensure other workloads, even in preparation.
    if (scoped.pipeline.module!.prepare?.some(action => action.type === "ensure_workload")) throw new Error(`Workload module ${name}: nested ensure_workload is unsupported`);
    scopes.set(name, { spec: scoped, prepare: scoped.pipeline.module!.prepare ?? [], sha256: hash });
    Object.defineProperty(declarations, name, { value: scoped.workloads!.module, enumerable: true, configurable: true, writable: true });
    modules.push({ name, source: location, sha256: hash, bytes: Buffer.from(bytes).toString("base64") });
  }
  const spec = parseSpec(JSON.stringify(root));
  workloadModules.set(spec, scopes);
  return { spec, modules };
}
