#!/usr/bin/env bun
import { addWorkloadCommand } from "./workload-command";
import { Command, CommanderError } from "commander";
import { mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { DataCenterClient, ApiError } from "./api";
import { loadConfig } from "./config";
import { FakeExecutor } from "./runtime/fake";
import { BunEffects } from "./runtime/effects";
import { SpecExecutor } from "./runtime/spec-executor";
import { resolveRunDirectory } from "./run-directory";
import { Worker } from "./worker";
import { detectDevices } from "./runtime/devices";

type Flags = Record<string, string | string[] | boolean>;

// Commander owns syntax; loadConfig retains configuration precedence and validation.
function options(command: Command): Command {
  const repeat = (value: string, previous: string[] = []) => [...previous, value];
  return command
    .option("--config <path>", "Configuration YAML path")
    .option("--server <url>", "Data Center HTTP site origin")
    .option("--token <token>", "Worker token (prefer MU_WORKER_TOKEN)")
    .option("--unit-id <id>", "Worker unit identity")
    .option("--spec <slug>", "Authorized Spec slug (repeatable)", repeat)
    .option("--workspace <path>", "Worker state directory")
    .option("--run-directory-scope <scope>", "Run directory scope: spec-version (default) or spec")
    .option("--run-directory-name <name>", "Shared run directory name (requires scope spec)")
    .option("--max-claim <count>", "Batch limit (integer 1–100)")
    .option("--poll-interval <seconds>", "Positive polling interval")
    .option("--heartbeat-interval <seconds>", "Positive heartbeat interval")
    .option("--device <family,index,max_units>", "GPU capacity (repeatable; cuda/rocm/nvidia)", repeat)
    .option("--concurrency <count>", "Concurrent nodes (integer 1–32)")
    .option("--shutdown-timeout <seconds>", "Positive shutdown budget")
    .option("--resume", "Resume recorded work")
    .option("--retry-incomplete", "Retry incomplete work; requires --resume")
    .option("--fake", "Claim real requests and simulate results without Spec actions")
    .option("--json", "JSON output (info/show/doctor already use JSON)")
    .option("--output <path>", "Configuration init destination (default: mu.yaml)")
    .option("--force", "Overwrite configuration on init");
}

export async function main(args = Bun.argv.slice(2)): Promise<number> {
  let result = 0;
  const program = new Command().name("mu").description("MU CLI v2 — CPU/GPU worker and local workloads").exitOverride().addHelpCommand(true);
  const route = (command: Command, run: (flags: Flags) => Promise<number>) => {
    options(command).action(async (parsed: Flags) => {
      const flags = Object.fromEntries(Object.entries(parsed).map(([key, value]) =>
        [key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`), value]));
      result = await run(flags);
    });
  };
  addWorkloadCommand(program, code => { result = code; });
  const worker = program.command("worker").description("Execute and inspect authorized server work");
  route(worker.command("once").description("Drain one batch"), flags => runWorker("once", flags));
  route(worker.command("start").description("Continuously claim and execute work"), flags => runWorker("start", flags));
  route(worker.command("doctor").description("Check workspace, health and scoped Spec access"), flags => runWorker("doctor", flags));
  route(worker.command("info").description("Print resolved configuration and devices"), flags => runWorker("info", flags));
  const config = program.command("config").description("Manage worker configuration");
  route(config.command("init").description("Write example YAML"), initConfig);
  route(config.command("show").description("Print resolved configuration"), flags => runWorker("show", flags));
  program.command("version").description("Print CLI version and capabilities").action(() => {
    console.log("mu-cli 0.4.0-phase4 (cel-v1; CPU/GPU scheduler; S3 artifact integration; workload modules; standalone workload exec; registry workloads)");
  });
  program.action(() => program.outputHelp());
  try { await program.parseAsync(args, { from: "user" }); }
  catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 2;
    console.error(error instanceof Error ? error.message : "CLI failed");
    return 2;
  }
  return result;
}

async function initConfig(flags: Flags): Promise<number> {
  try {
    const path = typeof flags.output === "string" ? flags.output : "mu.yaml";
    const file = await open(path, flags.force ? "w" : "wx", 0o600);
    try { await file.writeFile("server:\n  url: http://127.0.0.1:3211\nworker:\n  unitId: disposable-cpu\n  specs: [disposable-cpu]\n  maxClaim: 1\nruntime:\n  workspace: .mu\n  runDirectoryScope: spec-version\npolling:\n  interval: 15\n  heartbeatInterval: 30\n"); }
    finally { await file.close(); }
    return 0;
  } catch { console.error("Local file unavailable"); return 2; }
}

async function runWorker(command: "once" | "start" | "doctor" | "info" | "show", flags: Flags): Promise<number> {
  let configured = false;
  try {
    const config = await loadConfig(flags);
    configured = true;
    config.devices ??= config.fake ? [] : await detectDevices();
    if (command === "info" || command === "show") {
      console.log(JSON.stringify({ ...config, token: "[REDACTED]", devices: [{ family: "cpu", index: 0 }, ...config.devices] }, null, 2));
      return 0;
    }
    await mkdir(config.workspace, { recursive: true, mode: 0o700 });
    const api = new DataCenterClient(config);
    if (command === "doctor") {
      const probePath = join(config.workspace, `.probe-${crypto.randomUUID()}`);
      const probe = await open(probePath, "wx", 0o600);
      await probe.close(); await unlink(probePath);
      await api.health();
      if (!config.specs.length) throw new Error("doctor requires --spec to verify token authorization");
      const runDirectories: Record<string, ReturnType<typeof resolveRunDirectory>> = {};
      for (const slug of config.specs) {
        const source = await api.spec(slug);
        await new SpecExecutor(config, new BunEffects()).validate(source, slug, AbortSignal.timeout(30_000));
        runDirectories[slug] = resolveRunDirectory(config, slug, source);
      }
      console.log(JSON.stringify({ ok: true, bun: Bun.version, auth: "spec access verified", runtime: "spec-scheduler", devices: config.devices, concurrency: config.concurrency, runDirectoryScope: config.runDirectoryScope, runDirectoryName: config.runDirectoryName, runDirectories, claims: 0 }));
      return 0;
    }
    const lockPath = join(config.workspace, "worker.lock");
    const lock = await open(lockPath, "wx", 0o600);
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try {
      const executor = config.fake ? new FakeExecutor() : new SpecExecutor(config, new BunEffects());
      return await new Worker(config, api, executor).run(command as "once" | "start", controller.signal);
    }
    finally {
      try {
        try { await lock.close(); } finally { await unlink(lockPath); }
      } finally {
        process.off("SIGINT", stop); process.off("SIGTERM", stop);
      }
    }
  } catch (error) {
    if (error instanceof ApiError) { console.error(error.message); return [401, 403].includes(error.status) ? 3 : 4; }
    console.error(error instanceof Error && !error.message.includes("ENOENT") && !error.message.includes("EEXIST") ? error.message : "Local file unavailable or worker workspace locked");
    return configured ? 5 : 2;
  }
}

if (import.meta.main) process.exitCode = await main();
