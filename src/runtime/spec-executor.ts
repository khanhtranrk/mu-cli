import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClaimedRequest } from "../api";
import type { WorkerConfig } from "../config";
import { Flow, nodeUnits } from "../engine/flow";
import type { Effects } from "../engine/ports";
import { parseSpec } from "../spec/parse";
import type { RequestExecutor } from "./types";

export class SpecExecutor implements RequestExecutor {
  readonly reporting = "spec";
  private flows = new Map<string, { source: string; flow: Flow }>();
  constructor(private config: WorkerConfig, private effects: Effects) {}

  async prepare(source: string, slug: string, signal: AbortSignal): Promise<void> {
    if (this.flows.has(slug)) return;
    const spec = parseSpec(source);
    for (const pipeline of Object.values(spec.pipeline)) for (const node of pipeline.nodes ?? []) {
      if (nodeUnits(spec, node) > 0) throw new Error("Phase 2 supports CPU-only Specs; GPU admission requires Phase 3");
    }
    const scope = createHash("sha256").update(this.config.server + "\n" + this.config.unitId + "\n" + slug).digest("hex");
    const cwd = join(this.config.workspace, "runs", scope), cache = join(homedir(), ".cache");
    await this.effects.mkdir(join(cwd, "cache")); await this.effects.mkdir(join(cwd, "output"));
    const base = {
      sys: { cache_dir: cache, models: await this.effects.discoverModels(cache) },
      session: {
        working_dir: cwd, output_dir: join(cwd, "output"), cache_dir: join(cwd, "cache"),
        unit_name: this.config.unitId, unit_id: this.config.unitId, unit_type: "bun-cpu",
        server: this.config.server, token: this.config.token,
      },
    };
    const flow = new Flow(spec, base, this.effects);
    this.flows.set(slug, { source, flow });
    await flow.initialize(signal);
  }

  async execute(source: string, request: ClaimedRequest, signal: AbortSignal): Promise<void> {
    await this.prepare(source, request.specSlug, signal);
    const prepared = this.flows.get(request.specSlug)!;
    if (source !== prepared.source) throw new Error("Spec changed within the current worker invocation");
    await prepared.flow.execute({
      pipelineName: request.pipelineName, payload: request.payload,
      metadata: { requestId: request.requestId, specSlug: request.specSlug, assignmentVersion: request.assignmentVersion, artifacts: request.artifacts, registryContext: request.registryContext ?? {} },
      registryContext: request.registryContext,
    }, signal);
  }

  async finalize(failed: boolean): Promise<void> {
    let error: unknown;
    const cleanup = AbortSignal.timeout(30_000);
    for (const { flow } of this.flows.values()) {
      try { await flow.finalize(failed, cleanup); }
      catch (caught) { error ??= caught; }
    }
    this.flows.clear();
    if (error) throw error;
  }
}
