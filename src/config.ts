import { resolve } from "node:path";

export interface WorkerConfig {
  server: string;
  token: string;
  unitId: string;
  specs: string[];
  workspace: string;
  maxClaim: number;
  pollInterval: number;
  heartbeatInterval: number;
  fake: boolean;
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value as Record<string, unknown>;
}

export async function loadConfig(flags: Record<string, string | string[] | boolean>, env = process.env): Promise<WorkerConfig> {
  const path = flags.config ?? env.MU_CONFIG ?? "mu.yaml";
  if (typeof path !== "string") throw new Error("config must be a path");
  const file = Bun.file(path);
  let data: Record<string, unknown> = {};
  if (await file.exists()) {
    try { data = object(Bun.YAML.parse(await file.text())); }
    catch { throw new Error("Invalid configuration YAML/object"); }
  }
  else if (flags.config || env.MU_CONFIG) throw new Error("Configuration file not found");
  const section = (name: string) => data[name] === undefined ? {} : object(data[name]);
  const server = section("server"), worker = section("worker"), runtime = section("runtime"), polling = section("polling");
  const required = (value: unknown, name: string): string => {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
    return value;
  };
  const positive = (value: unknown, name: string): number => {
    const number = typeof value === "string" ? Number(value) : value;
    if (typeof number !== "number" || !Number.isFinite(number) || number <= 0) throw new Error(`${name} must be positive`);
    return number;
  };
  let url: URL;
  try { url = new URL(required(flags.server ?? env.MU_SERVER_URL ?? server.url, "server.url")); }
  catch { throw new Error("server.url must be an HTTP site origin"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("server.url must be an HTTP site origin");
  const specs = flags.spec ?? worker.specs ?? [];
  if (!Array.isArray(specs) || !specs.every(value => typeof value === "string" && value.trim())) throw new Error("worker.specs must be a string array");
  const maxClaim = positive(flags["max-claim"] ?? worker.maxClaim ?? 1, "maxClaim");
  if (!Number.isInteger(maxClaim) || maxClaim > 100) throw new Error("maxClaim must be an integer from 1 to 100");
  return {
    server: url.origin,
    token: required(flags.token ?? env.MU_WORKER_TOKEN, "MU_WORKER_TOKEN"),
    unitId: required(flags["unit-id"] ?? env.MU_UNIT_ID ?? worker.unitId, "worker.unitId"),
    specs: specs as string[],
    workspace: resolve(required(flags.workspace ?? runtime.workspace ?? ".mu", "runtime.workspace")),
    maxClaim,
    pollInterval: positive(flags["poll-interval"] ?? polling.interval ?? 15, "pollInterval"),
    heartbeatInterval: positive(flags["heartbeat-interval"] ?? polling.heartbeatInterval ?? 30, "heartbeatInterval"),
    fake: flags.fake === true,
  };
}
