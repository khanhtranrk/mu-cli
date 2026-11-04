import { mapping, type Context } from "../spec/types";
import type { Effects, HttpOptions } from "./ports";

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} requires a nonempty string`);
  return value;
}
function events(value: unknown): unknown[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("events must be an array");
  return value.map(raw => {
    const event = mapping(raw, "event");
    if (Object.keys(event).some(key => !["level", "message", "details", "createdAt"].includes(key)) || !["info", "warning", "error"].includes(String(event.level)) || typeof event.message !== "string") throw new Error("Invalid event");
    if (event.details !== undefined) mapping(event.details, "event.details");
    const createdAt = event.createdAt ?? Date.now();
    if (typeof createdAt !== "number" || !Number.isFinite(createdAt) || createdAt < 0) throw new Error("Invalid event timestamp");
    return { ...event, createdAt };
  });
}
const statuses = ["waiting", "possessed", "processing", "process_failed", "succeeded"];

export async function reportingAction(type: string, values: Context, context: Context, effects: Effects, signal: AbortSignal): Promise<Context> {
  const session = mapping(context.session), request = mapping(context.request), node = mapping(context.node ?? {});
  const requestId = text(request.requestId, "requestId");
  if (!Number.isSafeInteger(request.assignmentVersion) || Number(request.assignmentVersion) < 1) throw new Error("Missing assignment version");
  const server = new URL(text(session.server, "session.server"));
  if (!["http:", "https:"].includes(server.protocol) || server.username || server.password) throw new Error("Invalid server URL");
  const headers = { Authorization: `Bearer ${text(session.token, "session.token")}`, "Content-Type": "application/json", "X-Mu-Assignment-Version": String(request.assignmentVersion) };
  const timeout = values.timeout ?? 120;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) throw new Error("Invalid timeout");
  const call = async (path: string, body?: unknown, retry = false): Promise<Context> => {
    for (let attempt = 0; ; attempt++) {
      let response: Context;
      try { response = await effects.http({ url: new URL(path, server).href, method: body === undefined ? "GET" : "POST", headers, body, timeout }, signal); }
      catch (error) { if (retry && attempt === 0 && !signal.aborted) continue; throw error; }
      const status = Number(response.status_code);
      if (status >= 200 && status < 300) return mapping(response.body);
      if (retry && attempt === 0 && [500, 502, 503, 504].includes(status)) continue;
      throw new Error(`Data Center HTTP ${status}`);
    }
  };
  if (type === "report_node") {
    const body: Context = { id: requestId };
    if (values.request_status !== undefined) {
      if (!statuses.slice(2).includes(String(values.request_status))) throw new Error("Invalid request status");
      body.status = values.request_status;
    }
    if (values.request_events !== undefined) body.events = events(values.request_events);
    const update: Context = {};
    if (values.status !== undefined) {
      if (!["queue", "running", "failed", "succeeded"].includes(String(values.status))) throw new Error("Invalid node status");
      update.status = values.status;
    }
    if (values.events !== undefined) update.events = events(values.events);
    if (Object.keys(update).length) body.node_states = { [text(node.name, "node.name")]: update };
    await call("/api/requests/report", body);
    return {};
  }
  const artifactId = text(values.artifact_id, "artifact_id");
  const target = effects.path(text(values.target, "target"), text(session.working_dir, "working_dir"));
  if (type === "upload_artifact") {
    const source = await effects.inspect(target);
    const contentType = values.content_type ?? source.contentType ?? "application/octet-stream";
    const upload = await call("/api/requests/artifacts/upload-url", { requestId, artifactId, size: source.size, sha256: source.sha256, contentType, ...(values.connection_id === undefined ? {} : { connectionId: text(values.connection_id, "connection_id") }) });
    if (upload.method !== "PUT") throw new Error("Invalid upload method");
    const url = storageUrl(upload.uploadUrl);
    const uploadHeaders = mapping(upload.headers);
    if (Object.entries(uploadHeaders).some(([key, value]) => typeof value !== "string" || ["authorization", "cookie", "x-mu-assignment-version"].includes(key.toLowerCase()))) throw new Error("Invalid storage headers");
    const response = await effects.http({ url, method: "PUT", headers: uploadHeaders as Record<string, string>, bodyFile: target, timeout }, signal);
    if (Number(response.status_code) < 200 || Number(response.status_code) >= 300) throw new Error(`Storage HTTP ${response.status_code}`);
    const after = await effects.inspect(target);
    if (after.size !== source.size || after.sha256 !== source.sha256) throw new Error("Upload source changed during transfer");
    const nodeName = values.node_name ?? node.name;
    const completed = await call("/api/requests/artifacts/complete", { requestId, uploadId: text(upload.uploadId, "uploadId"), name: source.name, ...(nodeName === undefined ? {} : { nodeName: text(nodeName, "node_name") }), ...(values.label === undefined ? {} : { label: text(values.label, "label") }) }, true);
    return { artifact: mapping(completed.artifact) };
  }
  const download = await call(`/api/requests/artifacts/download-url?requestId=${encodeURIComponent(requestId)}&artifactId=${encodeURIComponent(artifactId)}`);
  const sha256 = values.sha256 ?? download.sha256;
  if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Artifact requires an expected SHA-256; supply sha256 for legacy files");
  if (values.sha256 !== undefined && download.sha256 !== undefined && values.sha256 !== download.sha256) throw new Error("Artifact SHA-256 metadata mismatch");
  if (!Number.isSafeInteger(download.size) || Number(download.size) < 0) throw new Error("Invalid artifact size");
  const options: HttpOptions = { url: storageUrl(download.url), method: "GET", headers: {}, responseFile: target, timeout, expectedSize: Number(download.size), expectedSha256: sha256 };
  const response = await effects.http(options, signal);
  if (Number(response.status_code) < 200 || Number(response.status_code) >= 300) throw new Error(`Storage HTTP ${response.status_code}`);
  const file = await effects.inspect(target);
  if (file.size !== download.size || file.sha256 !== sha256) throw new Error("Artifact integrity mismatch");
  return file;
}
function storageUrl(value: unknown): string {
  const url = new URL(text(value, "storage URL"));
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid storage URL");
  return url.href;
}
