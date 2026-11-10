import { expect, test } from "bun:test";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArtifacts, type ArtifactMetadata } from "../src/artifacts";
import { parseSpec } from "../src/spec/parse";
import { BunEffects } from "../src/runtime/effects";
import { DataCenterClient } from "../src/api";
import type { WorkerConfig } from "../src/config";
import { Actions } from "../src/engine/actions";
import type { Context } from "../src/spec/types";

const artifact: ArtifactMetadata = { id: "input-key", name: "input.json", handler: "s3", connectionId: "storage", objectKey: "objects/file", contentType: "application/json", size: 12, createdAt: 1, nodeName: "source" };

test("artifact metadata preserves output keys and rejects removed legacy shapes and duplicate keys", () => {
  expect(parseArtifacts([artifact])).toEqual([artifact]);
  const drive: ArtifactMetadata = { ...artifact, handler: "google-drive", objectKey: "drive-file-id" };
  expect(parseArtifacts([drive])).toEqual([drive]);
  for (const value of [[{ ...artifact, handler: "convex" }], [{ ...artifact, storageId: "old" }], [artifact, artifact], [{ ...artifact, artifactId: 17 }], [{ ...artifact, size: -1 }], [{ ...artifact, objectKey: undefined }], { input: "path" }]) expect(() => parseArtifacts(value)).toThrow();
});

test("claim validates and preserves copied/shared artifact inputs without fetching or executing them", async () => {
  const config: WorkerConfig = { server: "http://localhost", unitId: "unit", token: "token", specs: ["demo"], workspace: "/tmp", maxClaim: 1, pollInterval: 1, heartbeatInterval: 1, fake: false };
  const transport = (async () => Response.json([{ requestId: "r", specSlug: "demo", pipelineName: "p", assignmentVersion: 1, payload: {}, artifacts: [artifact] }])) as unknown as typeof fetch;
  expect((await new DataCenterClient(config, transport).claim("demo", 1))[0]?.artifacts).toEqual([artifact]);
  const malformed = (async () => Response.json([{ requestId: "r", specSlug: "demo", pipelineName: "p", assignmentVersion: 1, artifacts: [] }])) as unknown as typeof fetch;
  await expect(new DataCenterClient(config, malformed).claim("demo", 1)).rejects.toThrow("assignment");
});

test("CPU artifact example uses existing Spec syntax and only zero-unit workloads", async () => {
  const spec = parseSpec(await Bun.file(join(import.meta.dir, "../examples/cpu-artifacts/spec.yaml")).text());
  expect(Object.values(spec.workloads ?? {}).every(workload => workload.units === 0)).toBe(true);
  expect(spec.pipelines.demo?.nodes?.map(node => node.name)).toEqual(["publish", "verify"]);
});

test("body_file binds the opened file, detects replacement and does not report upload success", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mu-upload-change-"));
  const path = join(directory, "source"), replacement = join(directory, "replacement");
  try {
    await Bun.write(path, "original"); await Bun.write(replacement, "replaced");
    let sent: string | undefined;
    const transport = (async (_url: unknown, options?: RequestInit) => {
      await rename(replacement, path);
      sent = await (options!.body as Blob).text();
      return new Response(null);
    }) as typeof fetch;
    await expect(new BunEffects(transport).http({ url: "http://storage/put", method: "PUT", headers: {}, bodyFile: path, timeout: 1 }, new AbortController().signal)).rejects.toThrow("changed");
    expect(sent).toBe("original"); expect(await Bun.file(path).text()).toBe("replaced");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("unresolved redirect is a failed action and cannot overwrite an existing downloaded file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mu-redirect-"));
  const destination = join(directory, "existing");
  try {
    await Bun.write(destination, "keep");
    const transport = (async () => new Response("redirect missing Location", { status: 302 })) as unknown as typeof fetch;
    const actions = new Actions({ pipelines: {} }, new BunEffects(transport));
    const context: Context = { session: { working_dir: directory } };
    await expect(actions.run({ type: "send_http_request", url: "http://storage/", response_file: destination, save_to: "download" }, context, {}, new AbortController().signal)).rejects.toThrow("HTTP 302");
    expect(await Bun.file(destination).text()).toBe("keep");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("artifact transfer failures identify the stage in worker logs without leaking response details", async () => {
  const { reportingAction } = await import("../src/engine/reporting-actions");
  const context = {
    session: { server: "https://masterflow.example", token: "private-token", working_dir: "/tmp" },
    request: { requestId: "request-a", assignmentVersion: 1 },
  };
  const signal = new AbortController().signal;
  const publicReason = "Artifact operation refused. Check assignment, upload session and storage configuration.";
  for (const stage of ["upload-url", "complete", "storage GET"]) {
    const logs: string[] = [];
    const effects = new BunEffects((async () => { throw new Error("Unexpected fetch"); }) as unknown as typeof fetch, log => logs.push(log));
    effects.inspect = async () => ({ name: "source.json", size: 3, sha256: "a".repeat(64) });
    effects.http = async ({ url }) => {
      const endpoint = new URL(url).pathname;
      if (endpoint.endsWith(stage)) return { status_code: 400, body: { error: stage === "complete" ? publicReason : "https://example.invalid/?ticket=private-ticket" } };
      if (endpoint.endsWith("upload-url")) return { status_code: 200, body: { method: "PUT", uploadUrl: "https://storage.example/upload", headers: {}, uploadId: "receipt" } };
      if (endpoint.endsWith("download-url")) return { status_code: 200, body: { url: "https://storage.example/download?ticket=private-ticket", size: 3, sha256: "a".repeat(64) } };
      return { status_code: endpoint === "/download" ? 502 : 200 };
    };
    const download = stage === "storage GET";
    await expect(reportingAction(download ? "download_artifact" : "upload_artifact", {
      target: "file.json", artifact_id: "file", artifact: { artifactId: "file-id" },
    }, context, effects, signal)).rejects.toThrow(stage);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('request="request-a"');
    expect(logs[0]).toContain(download ? "Storage HTTP 502" : "Data Center HTTP 400");
    if (stage === "complete") expect(logs[0]).toContain(publicReason);
    expect(logs[0]).not.toContain("private-");
    expect(logs[0]).not.toContain("https://");
  }
});
