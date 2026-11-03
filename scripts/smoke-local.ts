import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference, type UserIdentity } from "convex/server";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArtifacts } from "../src/artifacts";

type AdminClient = ConvexHttpClient & { setAdminAuth(key: string, identity?: Partial<UserIdentity>): void };
const query = <Result>(name: string) => makeFunctionReference<"query", Record<string, never> | Record<string, unknown>, Result>(name);
const mutation = (name: string) => makeFunctionReference<"mutation">(name);

async function smoke(): Promise<void> {
  const envPath = process.argv[2];
  if (!envPath) throw new Error("Pass the local MasterFlow .env.local path");
  const env = Object.fromEntries((await Bun.file(envPath).text()).split("\n").filter(line => line.includes("=") && !line.trimStart().startsWith("#")).map(line => {
    const separator = line.indexOf("="); return [line.slice(0, separator).trim(), line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "")];
  }));
  const backend = new URL(env.CONVEX_SELF_HOSTED_URL ?? "");
  const site = new URL(process.argv[3] ?? "http://127.0.0.1:3211");
  for (const target of [backend, site]) if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || target.username || target.password || target.search || target.hash || target.pathname !== "/") throw new Error("This smoke harness only accepts local loopback HTTP origins");
  if (!env.CONVEX_SELF_HOSTED_ADMIN_KEY || env.CONVEX_DEPLOY_KEY || env.CONVEX_DEPLOYMENT?.startsWith("prod:")) throw new Error("Local self-hosted admin configuration is required; no production deploy keys");
  const client = new ConvexHttpClient(backend.origin, { logger: false }) as AdminClient;
  client.setAdminAuth(env.CONVEX_SELF_HOSTED_ADMIN_KEY);
  const settings = await client.query(query<{ page: { ownerId: string }[] }>("_system/cli/tableData"), { table: "storageSettings", order: "desc", paginationOpts: { numItems: 1, cursor: null } });
  const issuer = await client.query(query<{ value: string } | null>("_system/cli/queryEnvironmentVariables:get"), { name: "CLERK_JWT_ISSUER_DOMAIN" });
  if (!settings.page[0]?.ownerId || !issuer?.value) throw new Error("Local owner identity is unavailable");
  client.setAdminAuth(env.CONVEX_SELF_HOSTED_ADMIN_KEY, { subject: settings.page[0].ownerId, issuer: issuer.value });
  const storage = await client.query(query<{ isOwner: boolean; defaultConnectionId?: string; connections: { connectionId: string; enabled: boolean }[] }>("storage:list"), {});
  if (!storage.isOwner || !storage.connections.some(connection => connection.enabled && connection.connectionId === storage.defaultConnectionId)) throw new Error("An enabled default storage connection is required");
  const slug = "mu-v2-smoke-" + crypto.randomUUID(), unitId = slug;
  const token = randomBytes(32).toString("hex");
  const workspace = await mkdtemp(join(tmpdir(), "mu-live-smoke-"));
  let specId: string | undefined, tokenId: string | undefined, requestId: string | undefined;
  let primaryError: unknown;
  console.log(`target: dev (local self-hosted ${backend.origin}, HTTP ${site.origin}); disposable ${slug}`);
  try {
    specId = await client.mutation(mutation("specs:create"), { slug, name: "Disposable MU CLI v2 smoke", description: "CPU-only worker/artifact integration verification", yaml: await Bun.file(join(import.meta.dir, "../examples/cpu-artifacts/spec.yaml")).text() }) as string;
    tokenId = await client.mutation(mutation("unitTokens:create"), { name: slug, unitId, specSlugs: [slug], tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: Date.now() + 3600_000 }) as string;
    requestId = await client.mutation(mutation("requests:create"), { specSlug: slug, pipelineName: "demo", payload: { message: "MU CLI v2 Phase 4 CPU smoke" } }) as string;
    const configPath = join(workspace, "config.json");
    await Bun.write(configPath, JSON.stringify({ server: { url: site.origin }, worker: { unitId, specs: [slug], maxClaim: 1 }, runtime: { workspace, devices: [], concurrency: 2 } }));
    const child = Bun.spawn(["bun", join(import.meta.dir, "../src/index.ts"), "worker", "once", "--config", configPath], { env: { ...process.env, MU_WORKER_TOKEN: token }, stdout: "pipe", stderr: "pipe" });
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const exit = await child.exited; await output;
    if (exit !== 0) throw new Error(`CPU worker exited ${exit}; inspect the disposable Request`);
    const rows = await client.query(query<{ _id: string; status: string; nodeStates: Record<string, { status: string }> }[]>("requests:list"), { specSlug: slug });
    const request = rows.find(row => row._id === requestId);
    if (request?.status !== "succeeded" || request.nodeStates.publish?.status !== "succeeded" || request.nodeStates.verify?.status !== "succeeded") throw new Error("Server request/node reports did not complete");
    const artifacts = parseArtifacts(await client.query(query<unknown>("artifactStore:list"), { requestId }));
    if (artifacts.length !== 1 || artifacts[0]?.id !== "result" || artifacts[0]?.nodeName !== "publish") throw new Error("Artifact output projection mismatch");
    const files: string[] = [];
    for await (const file of new Bun.Glob("runs/**/requests/*/result.json").scan({ cwd: workspace })) files.push(file);
    if (files.length !== 1) throw new Error("CPU workload output missing");
    const original = await Bun.file(join(workspace, files[0]!)).bytes();
    const downloaded = await Bun.file(join(workspace, files[0]!.replace(/result\.json$/, "downloaded.json"))).bytes();
    if (!Buffer.from(original).equals(Buffer.from(downloaded)) || original.byteLength !== artifacts[0]!.size) throw new Error("Downloaded bytes differ from CPU output");
    console.log(JSON.stringify({ ok: true, requestId, requestStatus: request.status, nodes: 2, artifacts: 1, bytes: original.byteLength, verified: "byte-for-byte", gpu: false }));
  } catch (error) { primaryError = error; }
  finally {
    const cleanupErrors: string[] = [];
    for (const [name, id] of [["requests:remove", requestId], ["specs:remove", specId], ["unitTokens:revoke", tokenId]] as const) {
      if (id) try { await client.mutation(mutation(name), { id }); } catch { cleanupErrors.push(name); }
    }
    await rm(workspace, { recursive: true, force: true });
    console.log(JSON.stringify({ cleanup: cleanupErrors.length ? cleanupErrors : "request soft-deleted, spec archived, token revoked", slug, physicalBytes: "retained; no purge" }));
    if (cleanupErrors.length) primaryError ??= new Error("Disposable-record cleanup incomplete; inspect the printed slug");
  }
  if (primaryError) throw primaryError;
}

try { await smoke(); }
catch (error) { console.error(error instanceof Error && !/https?:\/\//.test(error.message) ? error.message : "Local smoke failed; inspect disposable records without publishing credentials or signed URLs"); process.exitCode = 1; }
