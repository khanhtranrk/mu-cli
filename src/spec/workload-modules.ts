import { validatePreparation } from "./preparation";
import { registryReference, referenceKey, workloadVersion, type RegistryLock, type RegistryModule, type RegistryReference, type RegistryPin } from "./registry-reference";
import { createHash } from "node:crypto";
import { parseSpec, parseYamlMapping } from "./parse";
import { mapping, type Spec, type Action } from "./types";
import { validateWorkloadSource } from "./workload-source";

export const moduleByteLimit = 1024 * 1024;
export interface ModuleSnapshot { name: string; source: string; sha256: string; bytes: string; registry?: Omit<RegistryModule, "yaml"> }
export interface ResolvedModule { spec: Spec; prepare: Action[]; sha256: string; resources?: string[]; grouped: boolean }
// Runtime metadata cannot be supplied through YAML or collide with user declarations.
export const workloadModules = new WeakMap<Spec, Map<string, ResolvedModule>>();
export type ModuleLoader = (source: string, signal: AbortSignal) => Promise<Uint8Array>;
export const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

export interface RegistryResolution {
  origin: string;
  lock?: RegistryLock;
  read(ref: RegistryReference, signal: AbortSignal, pin?: RegistryPin): Promise<RegistryModule>;
}
export function hasRegistryReferences(source: string): boolean {return Object.values(mapping(parseYamlMapping(source).workloads ?? {})).some(value => registryReference(value) !== null);}
export async function resolveWorkloadModules(source: string, load: ModuleLoader, signal: AbortSignal, pinned?: ModuleSnapshot[], registry?: RegistryResolution): Promise<{ spec: Spec; modules: ModuleSnapshot[] }> {
  const root = parseYamlMapping(source);
  // Structural checks happen before any source is fetched. No process effects here.
  const structural = parseSpec(source, { allowExternal: true });
  const declarations = mapping(root.workloads ?? {}, "workloads");
  const modules: ModuleSnapshot[] = [], scopes = new Map<string, ResolvedModule>();
  const externals = Object.entries(declarations).filter(([, raw]) => registryReference(raw) !== null || Object.hasOwn(mapping(raw), "source"));
  if (externals.length > 64) throw new Error("External workload limit exceeded (64)");
  if (pinned !== undefined && (!Array.isArray(pinned) || pinned.length !== externals.length || new Set(pinned.map(item => item?.name)).size !== pinned.length)) throw new Error("Invalid pinned workload module manifest");
  if (!externals.length) return { spec: structural, modules: [] };
  const refs = externals.filter(([, raw]) => registryReference(raw));
  if (registry?.lock) {
    const lock = registry.lock;
    if (lock.yamlSha256 !== sha256(source) || !Array.isArray(lock.pins) || lock.pins.length !== refs.length || new Set(lock.pins.map(p => p.alias)).size !== refs.length) throw new Error("Missing or stale workload dependency lock");
  }
  let total = 0;
  for (const [name, raw] of externals) {
    signal.throwIfAborted();
    const ref = registryReference(raw);
    const declaration = ref ? {source: "mu://" + referenceKey(ref)} : mapping(raw);
    if (!ref) validateWorkloadSource(declaration, `workloads.${name}`);
    const location = declaration.source as string;
    const pin = registry?.lock?.pins.find(p => p.alias === name);
    if (ref && (!registry || (registry.lock && (!pin || pin.reference !== referenceKey(ref) || pin.slug !== ref.slug || (ref.version && pin.version !== ref.version))))) throw new Error(`Missing or mismatched registry dependency ${name}`);
    const saved = pinned?.find(item => item.name === name);
    if (pinned !== undefined && (!saved || saved.source !== location || typeof saved.bytes !== "string" || saved.bytes.length > Math.ceil(moduleByteLimit / 3) * 4 || !/^[a-f\d]{64}$/.test(saved.sha256))) throw new Error(`Invalid pinned workload module ${name}`);
    let provenance = saved?.registry;
    let bytes: Uint8Array;
    if (saved) bytes = Buffer.from(saved.bytes, "base64");
    else if (ref) {const result = await registry!.read(ref, signal, pin); const {yaml, ...metadata} = result; provenance = metadata; bytes = Buffer.from(yaml, "utf8");}
    else bytes = await load(location, signal);
    if (ref && (!provenance || provenance.registry !== registry!.origin || provenance.slug !== ref.slug || typeof provenance.versionId !== "string" || !provenance.versionId || typeof provenance.version !== "string" || provenance.version.length > 64 || !workloadVersion.test(provenance.version) || !/^[a-f0-9]{64}$/.test(provenance.sha256) || provenance.formatVersion !== 1 || (ref.version && provenance.version !== ref.version) || (pin && (pin.versionId !== provenance.versionId || pin.sha256 !== provenance.sha256 || pin.version !== provenance.version || pin.formatVersion !== provenance.formatVersion)))) throw new Error(`Registry provenance mismatch for ${name}`);
    if (ref && bytes.byteLength > 256 * 1024) throw new Error("Registry module size limit exceeded");
    signal.throwIfAborted();
    total += bytes.byteLength;
    if (bytes.byteLength > moduleByteLimit || total > 8 * moduleByteLimit) throw new Error("Workload module size limit exceeded");
    const hash = sha256(bytes);
    if (ref && hash !== provenance!.sha256) throw new Error(`Registry workload ${name}: SHA-256 mismatch`);
    if (saved && (hash !== saved.sha256 || Buffer.from(bytes).toString("base64") !== saved.bytes)) throw new Error(`Pinned workload ${name}: SHA-256/content mismatch`);
    if (declaration.sha256 !== undefined && hash !== (declaration.sha256 as string).toLowerCase()) throw new Error(`Workload ${name}: SHA-256 mismatch`);
    const module = parseYamlMapping(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (Object.keys(module).some(key => !["routines", "prepare", "workload", "installation"].includes(key))) throw new Error(`Workload module ${name}: only routines, prepare, installation and workload are allowed; nested imports are unsupported`);
    const workload = mapping(module.workload, `module ${name}.workload`);
    if (Object.hasOwn(workload, "source")) throw new Error(`Workload module ${name}: nested imports are unsupported`);
    const scoped = parseSpec(JSON.stringify({ routines: module.routines === undefined ? {} : module.routines, workloads: { module: workload }, pipeline: { module: { prepare: module.prepare === undefined ? [] : module.prepare } } }), { modulePreparation: true });
    // Modules cannot recursively ensure other workloads, even in preparation.
    if (scoped.pipeline.module!.prepare?.some(action => action.type === "ensure_workload")) throw new Error(`Workload module ${name}: nested ensure_workload is unsupported`);
    const installation = validatePreparation(scoped, true, module.installation);
    scopes.set(name, { spec: scoped, prepare: scoped.pipeline.module!.prepare ?? [], sha256: hash, ...installation });
    Object.defineProperty(declarations, name, { value: scoped.workloads!.module, enumerable: true, configurable: true, writable: true });
    modules.push({ name, source: location, sha256: hash, bytes: Buffer.from(bytes).toString("base64"), ...(provenance ? {registry: provenance} : {}) });
  }
  const spec = parseSpec(JSON.stringify(root));
  workloadModules.set(spec, scopes);
  return { spec, modules };
}
