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
  .allowUnknownOption(true)
  .passThroughOptions();

// Manual option parsing (preserved from original for exact compatibility)
function parseOptions(args: string[]): Record<string, string | string[] | boolean> {
  const flags: Record<string, string | string[] | boolean> = {};
  const booleans = new Set(["fake", "json", "force", "resume", "retry-incomplete"]);
  const values = new Set(["config", "server", "token", "unit-id", "spec", "workspace", "max-claim", "poll-interval", "heartbeat-interval", "output", "device", "concurrency", "shutdown-timeout"]);
  
  for (let index = 0; index < args.length; index++) {
    const option = args[index]!;
    const name = option.slice(2);
    if (!option.startsWith("--")) throw new Error("Expected an option");
    if (booleans.has(name)) { flags[name] = true; continue; }
    if (!values.has(name)) throw new Error("Unknown option");
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error("Option requires a value");
    if (name === "spec" || name === "device") flags[name] = [...(flags[name] as string[] ?? []), value];
    else flags[name] = value;
  }
  return flags;
}

// Main CLI logic using Commander for routing only
async function runCLI(args: string[]): Promise<number> {
  const [group, command, ...options] = args;
  
  if (!group || group === "help" || group === "--help") {
    program.help();
    return 0;
  }
  
  if (group === "version") {
    console.log("mu-cli 0.4.0-phase4 (cel-v1; CPU/GPU scheduler; S3 artifact integration)");
    return 0;
  }
  
  let configured = false;
  
  try {
    const flags = parseOptions(options);
    
    if (group === "config" && command === "init") {
      const path = typeof flags.output === "string" ? flags.output : "mu.yaml";
      const file = await open(path, flags.force ? "w" : "wx", 0o600);
      try {
        await file.writeFile("server:\n  url: http://127.0.0.1:3211\nworker:\n  unitId: disposable-cpu\n  specs: [disposable-cpu]\n  maxClaim: 1\nruntime:\n  workspace: .mu\npolling:\n  interval: 15\n  heartbeatInterval: 30\n");
      } finally {
        await file.close();
      }
      return 0;
    }
    
    if (!(group === "worker" && ["once", "start", "doctor", "info"].includes(command ?? "")) && !(group === "config" && command === "show")) {
      console.error("Unknown command; use mu help");
      return 2;
    }
    
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
      for (const slug of config.specs) parseSpec(await api.spec(slug));
      console.log(JSON.stringify({ ok: true, bun: Bun.version, auth: "spec access verified", runtime: "spec-scheduler", devices: config.devices, concurrency: config.concurrency, claims: 0 }));
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
    } finally {
      process.off("SIGINT", stop); process.off("SIGTERM", stop);
      await lock.close(); await unlink(lockPath);
    }
  } catch (error) {
    if (error instanceof ApiError) { console.error(error.message); return [401, 403].includes(error.status) ? 3 : 4; }
    console.error(error instanceof Error && !error.message.includes("ENOENT") && !error.message.includes("EEXIST") ? error.message : "Local file unavailable or worker workspace locked");
    return configured ? 5 : 2;
  }
}

// Set up Commander for help generation only
program
  .command("worker")
  .description("Worker commands")
  .addHelpText("after", "\n  Subcommands:\n    once    Execute one batch of work and exit\n    start   Start worker and repeat claim cycles\n    doctor  Check workspace, health and scoped Spec access\n    info    Print resolved configuration and devices, token redacted\n\n  Options: --config --server --token --unit-id --spec (repeatable)\n           --workspace --max-claim --poll-interval --heartbeat-interval\n           --device FAMILY,INDEX,MAX_UNITS (repeatable) --concurrency (1-32)\n           --shutdown-timeout --resume [--retry-incomplete] --fake")
  .action(() => {
    // Handled by runCLI
  });

program
  .command("config")
  .description("Configuration management")
  .addHelpText("after", "\n  Subcommands:\n    init   Write example configuration file [--output mu.yaml] [--force]\n    show   Print resolved configuration, token redacted\n\n  Options: --config --server --token --unit-id --spec (repeatable)\n           --workspace --max-claim --poll-interval --heartbeat-interval\n           --device FAMILY,INDEX,MAX_UNITS (repeatable) --concurrency (1-32)\n           --shutdown-timeout --fake")
  .action(() => {
    // Handled by runCLI
  });

export async function main(args = process.argv.slice(2)): Promise<number> {
  // Check for help/version first before using Commander
  if (args.length === 0 || args[0] === "help" || args[0] === "--help") {
    program.help();
    return 0;
  }
  if (args[0] === "version") {
    console.log("mu-cli 0.4.0-phase4 (cel-v1; CPU/GPU scheduler; S3 artifact integration)");
    return 0;
  }
  
  // Use manual CLI logic for all other commands
  return runCLI(args);
}

if (import.meta.main) process.exitCode = await main();
