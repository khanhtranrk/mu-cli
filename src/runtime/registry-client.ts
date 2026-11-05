import { mapping } from "../spec/types";
import { referenceKey, workloadVersion, type RegistryLock, type RegistryModule, type RegistryPin, type RegistryReference } from "../spec/registry-reference";
import { sha256 } from "../spec/workload-modules";
export interface RegistryScope {specSlug?: string; yamlSha256?: string; requestId?: string; assignmentVersion?: number}
export class RegistryClient {
  readonly origin: string;
  constructor(server: string, private token: string, private transport: typeof fetch = fetch) {
    const url = new URL(server);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Registry server must be an HTTP site origin");
    this.origin = url.origin;
  }
  private async call(operation: string, params: Record<string, string>, signal: AbortSignal, assignmentVersion?: number) {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    const response = await this.transport(this.origin + "/api/workloads/" + operation + "?" + new URLSearchParams(params), {headers: {Authorization: "Bearer " + this.token, ...(assignmentVersion === undefined ? {} : {"X-Mu-Assignment-Version": String(assignmentVersion)})}, signal: bounded, redirect: "error", credentials: "omit"});
    if (!response.ok) {await response.body?.cancel(); throw new Error(`Registry HTTP ${response.status}; check credential and dependency lock`);}
    const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {if (reader) while (true) {const {value, done} = await reader.read(); bounded.throwIfAborted(); if (done) break; size += value.byteLength; if (size > 2 * 1024 * 1024) throw new Error("Registry response size limit exceeded"); chunks.push(value);}}
    finally {await reader?.cancel(); reader?.releaseLock();}
    const result = mapping(JSON.parse(Buffer.concat(chunks).toString("utf8")), "registry response");
    if (result.registry !== this.origin) throw new Error("Registry origin mismatch");
    return result;
  }
  async specLock(source: string, slug: string, signal: AbortSignal): Promise<RegistryLock> {
    const result = await this.call("spec-lock", {specSlug: slug, yamlSha256: sha256(source)}, signal);
    const lock = mapping(result.lock, "workload lock");
    if (lock.yamlSha256 !== sha256(source) || !Array.isArray(lock.pins)) throw new Error("Missing or stale workload dependency lock");
    return lock as unknown as RegistryLock;
  }
  async read(ref: RegistryReference, signal: AbortSignal, pin?: RegistryPin, scope: RegistryScope = {}): Promise<RegistryModule> {
    const params: Record<string, string> = {slug: ref.slug};
    if (pin) {params.versionId = pin.versionId; params.version = pin.version;}
    else if (ref.version) params.version = ref.version;
    if (scope.requestId) params.requestId = scope.requestId;
    else if (scope.specSlug) {params.specSlug = scope.specSlug; params.yamlSha256 = scope.yamlSha256!;}
    const result = await this.call(pin ? "version" : "resolve", params, signal, scope.assignmentVersion);
    if (result.slug !== ref.slug || typeof result.version !== "string" || result.version.length > 64 || !workloadVersion.test(result.version) || typeof result.versionId !== "string" || !result.versionId || result.versionId.length > 160 || typeof result.yaml !== "string" || typeof result.sha256 !== "string" || result.formatVersion !== 1 || (ref.version && result.version !== ref.version) || (pin && (result.versionId !== pin.versionId || result.version !== pin.version || result.sha256 !== pin.sha256)) || Buffer.byteLength(result.yaml) > 256 * 1024 || sha256(result.yaml) !== result.sha256) throw new Error(`Registry content mismatch: ${referenceKey(ref)}`);
    return result as unknown as RegistryModule;
  }
}
