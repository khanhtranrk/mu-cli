#!/usr/bin/env bun
import { mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { DataCenterClient, ApiError } from "./api";
import { loadConfig } from "./config";
import { FakeExecutor } from "./runtime/fake";
import { BunEffects } from "./runtime/effects";
import { SpecExecutor } from "./runtime/spec-executor";
import { parseSpec } from "./spec/parse";
import { Worker } from "./worker";
import { detectDevices } from "./runtime/devices";

const program = new Command();

program
  .name("mu")
  .description("MU CLI v2 — CPU/GPU Spec worker")
  .version("mu-cli 0.4.0-phase4 (cel-v1; CPU/GPU scheduler; S3 artifact integration)")
  .configureHelp({ optionTerm: (o) => o.flags })
  .allowUnknownOption(false)
  .allowExcessArguments(true);

// Helper to convert Commander options to flags format expected by loadConfig
function optionsToFlags(options: Record<string, unknown>): Record<string, string | string[] | boolean> {
  const flags: Record<string, string | string[] | boolean> = {};
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) continue;
    flags[key] = value as string | string[] | boolean;
  }
  return flags;
}

// Define all options at the top level so Commander parses them regardless of position
program
  .option("--config <path>", "Configuration file path (YAML)")
  .option("--server <url>", "Server URL")
  .option("--token <token>", "Worker authentication token")
  .option("--unit-id <id>", "Worker unit ID")
  .option("--spec <slug>", "Spec slug to claim (repeatable)", (value: string, previous: string[] = []) => [...previous, value])
  .option("--workspace <path>", "Workspace directory")
  .option("--max-claim <number>", "Maximum claim size")
  .option("--poll-interval <seconds>", "Polling interval in seconds")
  .option("--heartbeat-interval <seconds>", "Heartbeat interval in seconds")
  .option("--device <spec>", "Device specification FAMILY,INDEX,MAX_UNITS (repeatable)", (value: string, previous: string[] = []) => [...previous, value])
  .option("--concurrency <number>", "Concurrency limit (1-32)")
  .option("--shutdown-timeout <seconds>", "Shutdown timeout in seconds")
  .option("--resume", "Resume recorded work")
  .option("--retry-incomplete", "Retry incomplete actions (requires --resume)")
  .option("--fake", "Fake mode: claim real requests, report simulated results")
  .option("--json", "Output JSON (currently accepted but no distinct JSON payload)")
  .option("--output <path>", "Output file path")
  .option("--force", "Overwrite existing file")
  .action(async (options, cmd) => {
    const args = cmd.args;
    const [group, command] = args;
    const flags = optionsToFlags(options);
    let configured = false;
    
    if (!group || group === "help" || group === "--help") {
      console.log("MU CLI v2 — CPU/GPU Spec worker\nmu worker once|start --spec <slug> [--fake] [options]\nmu worker doctor|info [--json] [options]\nmu config show [options]\nmu config init [--output mu.yaml] [--force]\nmu version\nOptions: --config --server --token --unit-id --spec (repeatable)\n         --workspace --max-claim --poll-interval --heartbeat-interval\n         --device FAMILY,INDEX,MAX_UNITS (repeatable) --concurrency (1-32)\n         --shutdown-timeout --resume [--retry-incomplete]");
      process.exit(0);
    }
    
    if (group === "version") {
      console.log("mu-cli 0.4.0-phase4 (cel-v1; CPU/GPU scheduler; S3 artifact integration)");
      process.exit(0);
    }
    
    if (group === "config" && command === "init") {
      const path = typeof flags.output === "string" ? flags.output : "mu.yaml";
      const file = await open(path, flags.force ? "w" : "wx", 0o600);
      try {
        await file.writeFile("server:\n  url: http://127.0.0.1:3211\nworker:\n  unitId: disposable-cpu\n  specs: [disposable-cpu]\n  maxClaim: 1\nruntime:\n  workspace: .mu\npolling:\n  interval: 15\n  heartbeatInterval: 30\n");
      } finally {
        await file.close();
      }
      process.exit(0);
    }
    
    if (!(group === "worker" && ["once", "start", "doctor", "info"].includes(command ?? "")) && !(group === "config" && command === "show")) {
      console.error("Unknown command; use mu help");
      process.exit(2);
    }
    
    const config = await loadConfig(flags);
    configured = true;
    config.devices ??= config.fake ? [] : await detectDevices();
    
    if (command === "info" || command === "show") {
      console.log(JSON.stringify({ ...config, token: "[REDACTED]", devices: [{ family: "cpu", index: 0 }, ...config.devices] }, null, 2));
      process.exit(0);
    }
    
    await mkdir(config.workspace, { recursive: true, mode: 0o700 });
    const api = new DataCenterClient(config);
    
    if (command === "doctor") {
      const probePath = join(config.workspace, `.probe-${crypto.randomUUID()}`);
      const probe = await open(probePath, "wx", 0o600);
      await probe.close(); await unlink(probePath);
      await api.health();
      if (!config.specs.length) throw new Error("doctor requires --spec to verify token authorization");
      for (const slug of config.specs) parseSpec(await api.spec(slug));
      console.log(JSON.stringify({ ok: true, bun: Bun.version, auth: "spec access verified", runtime: "spec-scheduler", devices: config.devices, concurrency: config.concurrency, claims: 0 }));
      process.exit(0);
    }
    
    const lockPath = join(config.workspace, "worker.lock");
    const lock = await open(lockPath, "wx", 0o600);
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try {
      const executor = config.fake ? new FakeExecutor() : new SpecExecutor(config, new BunEffects());
      const exitCode = await new Worker(config, api, executor).run(command as "once" | "start", controller.signal);
      process.exit(exitCode);
    } finally {
      process.off("SIGINT", stop); process.off("SIGTERM", stop);
      await lock.close(); await unlink(lockPath);
    }
  });

async function runWorker(flags: Record<string, string | string[] | boolean>, mode: "once" | "start"): Promise<void> {
  let configured = false;
  try {
    const config = await loadConfig(flags);
    configured = true;
    config.devices ??= config.fake ? [] : await detectDevices();
    await mkdir(config.workspace, { recursive: true, mode: 0o700 });
    const api = new DataCenterClient(config);
    const lockPath = join(config.workspace, "worker.lock");
    const lock = await open(lockPath, "wx", 0o600);
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try {
      const executor = config.fake ? new FakeExecutor() : new SpecExecutor(config, new BunEffects());
      const exitCode = await new Worker(config, api, executor).run(mode, controller.signal);
      process.exit(exitCode);
    } finally {
      process.off("SIGINT", stop); process.off("SIGTERM", stop);
      await lock.close(); await unlink(lockPath);
    }
  } catch (error) {
    if (error instanceof ApiError) { console.error(error.message); process.exit([401, 403].includes(error.status) ? 3 : 4); }
    console.error(error instanceof Error && !error.message.includes("ENOENT") && !error.message.includes("EEXIST") ? error.message : "Local file unavailable or worker workspace locked");
    process.exit(configured ? 5 : 2);
  }
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  // Override Commander's exit behavior to return exit codes instead of exiting
  program.exitOverride((err) => {
    if (err) {
      throw err;
    }
  });
  
  try {
    await program.parseAsync(args);
    return 0;
  } catch (error) {
    if (error instanceof Error) {
      console.error(error.message);
    }
    return 2;
  }
}

if (import.meta.main) process.exitCode = await main();
