import { mkdir, open, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ClaimedRequest, Report } from "./api";
import type { ExecutionSnapshot } from "./engine/checkpoint";

import type { RunDirectory } from "./run-directory";

export interface Checkpoint {
  runDirectory?: RunDirectory;
  request: ClaimedRequest;
  phase: "claimed" | "executing" | "terminal" | "reported";
  report?: Report;
  reporting?: "spec";
  source?: string;
  execution?: ExecutionSnapshot;
}

export class StateStore {
  constructor(private directory: string) {}
  async save(state: Checkpoint): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const name = createHash("sha256").update(state.request.requestId).digest("hex") + ".json";
    const destination = join(this.directory, name);
    const file = await open(destination + ".tmp", "w", 0o600);
    try { await file.writeFile(JSON.stringify(state)); await file.sync(); }
    finally { await file.close(); }
    await rename(destination + ".tmp", destination);
    const directory = await open(this.directory, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async load(): Promise<Checkpoint[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const states: Checkpoint[] = [];
    for (const name of await readdir(this.directory)) {
      if (name.endsWith(".json")) states.push(await Bun.file(join(this.directory, name)).json() as Checkpoint);
    }
    return states;
  }
}
