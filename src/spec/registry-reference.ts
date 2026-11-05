export interface RegistryReference { slug: string; version?: string }
export const workloadSlug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const workloadVersion = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
export function registryReference(value: unknown): RegistryReference | null {
  if (typeof value === "string") {
    const text = value.startsWith("mu://") ? value.slice(5) : value;
    const parts = text.split("@");
    if (parts.length > 2 || text.length > 165 || (parts[0]?.length ?? 0) > 100 || (parts[1]?.length ?? 0) > 64 || !workloadSlug.test(parts[0] ?? "") || (parts[1] !== undefined && !workloadVersion.test(parts[1]))) throw new Error("Expected workload-name or workload-name@MAJOR.MINOR.PATCH");
    return {slug: parts[0]!, ...(parts[1] === undefined ? {} : {version: parts[1]})};
  }
  if (value && typeof value === "object" && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, "registry")) {
    const item = value as Record<string, unknown>;
    if (Object.keys(item).some(key => !["registry", "version"].includes(key)) || typeof item.registry !== "string" || (item.registry.length > 100 || !workloadSlug.test(item.registry)) || (Object.prototype.hasOwnProperty.call(item, "version") && (typeof item.version !== "string" || (item.version.length > 64 || !workloadVersion.test(item.version))))) throw new Error("Invalid registry workload declaration; registry/source/inline forms cannot be mixed");
    return {slug: item.registry, ...(item.version === undefined ? {} : {version: item.version as string})};
  }
  return null;
}
export function referenceKey(ref: RegistryReference): string { return ref.slug + (ref.version ? "@" + ref.version : ""); }
export interface RegistryPin {alias: string; reference: string; slug: string; version: string; versionId: string; sha256: string; formatVersion: 1}
export interface RegistryLock {yamlSha256: string; pins: RegistryPin[]}
export interface RegistryModule {registry: string; slug: string; version: string; versionId: string; sha256: string; formatVersion: 1; yaml: string}
export function workloadSourceKind(source: string): "registry" | "source" {
  if (source.startsWith("mu://")) {registryReference(source); return "registry";}
  if (/^https:/i.test(source) || /^[./~]/.test(source) || /[/\\]/.test(source) || /\.(yaml|yml|json)$/i.test(source)) return "source";
  registryReference(source); return "registry";
}
