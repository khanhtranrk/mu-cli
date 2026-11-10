export interface ArtifactMetadata {
  id: string;
  artifactId?: string;
  name: string;
  handler: "s3" | "google-drive";
  connectionId: string;
  objectKey: string;
  contentType: string;
  size: number;
  createdAt: number;
  nodeName?: string;
  label?: string;
}

export function parseArtifacts(value: unknown): ArtifactMetadata[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("Invalid artifact metadata array");
  const ids = new Set<string>();
  const allowed = new Set(["artifactId", "id", "name", "handler", "connectionId", "objectKey", "contentType", "size", "createdAt", "nodeName", "label"]);
  return value.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid artifact metadata");
    const item = raw as Record<string, unknown>;
    if (Object.keys(item).some(key => !allowed.has(key)) || ["id", "name", "connectionId", "objectKey", "contentType"].some(key => typeof item[key] !== "string" || !(item[key] as string).trim()) || (item.handler !== "s3" && item.handler !== "google-drive")) throw new Error("Invalid artifact storage metadata");
    if (typeof item.size !== "number" || !Number.isSafeInteger(item.size) || item.size < 0 || typeof item.createdAt !== "number" || !Number.isFinite(item.createdAt) || item.createdAt < 0) throw new Error("Invalid artifact size or creation time");
    if (item.artifactId !== undefined && (typeof item.artifactId !== "string" || !item.artifactId.trim())) throw new Error("Invalid canonical Artifact identity");
    if (["nodeName", "label"].some(key => item[key] !== undefined && typeof item[key] !== "string")) throw new Error("Invalid artifact placement");
    if (ids.has(item.id as string)) throw new Error("Duplicate artifact output key");
    ids.add(item.id as string);
    return { ...item } as unknown as ArtifactMetadata;
  });
}
