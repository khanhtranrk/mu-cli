import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { WorkerConfig } from "./config";
import { RecoveryError } from "./engine/checkpoint";

export type RunDirectoryScope = "spec-version" | "spec";
export interface RunDirectory {
  scope: RunDirectoryScope;
  name?: string;
  path: string;
}

export function runDirectoryOptions(scope: unknown, name?: unknown): { runDirectoryScope: RunDirectoryScope; runDirectoryName?: string } {
  const selected = scope === undefined ? "spec-version" : scope;
  if (selected !== "spec-version" && selected !== "spec") throw new Error("runDirectoryScope must be spec-version or spec");
  if (name !== undefined) {
    if (selected !== "spec") throw new Error("runDirectoryName requires runDirectoryScope: spec");
    // A portable single component; leading underscores are reserved for automatic names.
    if (typeof name !== "string" || !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9_-])?$/.test(name)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/.test(name)) {
      throw new Error("runDirectoryName must be 1–64 lowercase ASCII letters/digits, dots, hyphens or underscores; start with a letter/digit, do not end with a dot, and avoid reserved device names");
    }
  }
  return { runDirectoryScope: selected, ...(name === undefined ? {} : { runDirectoryName: name as string }) };
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function resolveRunDirectory(config: Pick<WorkerConfig, "workspace" | "server" | "unitId" | "runDirectoryScope" | "runDirectoryName">, slug: string, source: string): RunDirectory {
  const options = runDirectoryOptions(config.runDirectoryScope, config.runDirectoryName);
  const worker = config.server + "\n" + config.unitId;
  const path = options.runDirectoryScope === "spec-version"
    ? join(config.workspace, "runs", hash(worker + "\n" + slug + "\n" + source))
    : join(config.workspace, "runs", hash(worker), options.runDirectoryName ?? "__spec-" + hash(slug));
  const within = relative(resolve(config.workspace), resolve(path));
  if (isAbsolute(within) || within === ".." || within.startsWith(".." + sep)) throw new Error("Run directory must stay inside the workspace");
  return { scope: options.runDirectoryScope, ...(options.runDirectoryName === undefined ? {} : { name: options.runDirectoryName }), path: resolve(path) };
}

export function verifyRunDirectory(current: RunDirectory, saved: RunDirectory): void {
  if (current.scope !== saved.scope || current.name !== saved.name || current.path !== saved.path) {
    throw new RecoveryError("Run directory scope, name or path changed since checkpoint; restore the original configuration before --resume, or inspect/reset the request in MasterFlow");
  }
}

/** Resolve existing ancestors too, so a pre-existing symlink cannot redirect outside the workspace. */
async function canonicalDestination(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalDestination(parent), relative(parent, path));
  }
}
export async function verifyRunDirectoryContainment(workspace: string, path: string): Promise<void> {
  const root = await canonicalDestination(resolve(workspace));
  // Check both subdirectories as well as the run root before creating/using them.
  for (const target of [path, join(path, "cache"), join(path, "output")]) {
    const within = relative(root, await canonicalDestination(resolve(target)));
    if (isAbsolute(within) || within === ".." || within.startsWith(".." + sep)) throw new Error("Run directory must stay inside the workspace (including symlinks)");
  }
}
