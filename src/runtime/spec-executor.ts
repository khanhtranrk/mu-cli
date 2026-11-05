import { resolveRunDirectory, verifyRunDirectoryContainment } from "../run-directory";
import {reportingAction} from "../engine/reporting-actions";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClaimedRequest } from "../api";
import type { WorkerConfig } from "../config";
import { Flow } from "../engine/flow";
import type { Effects } from "../engine/ports";
import { resolveWorkloadModules, sha256, type ModuleSnapshot, type ModuleLoader } from "../spec/workload-modules";
import { workloadLoader } from "./workload-loader";
import type { RequestExecutor } from "./types";
import { Scheduler } from "../scheduler/scheduler";
import { RecoveryError, type ExecutionPersistence, type ExecutionSnapshot } from "../engine/checkpoint";
import { mapping, type Context } from "../spec/types";

export class SpecExecutor implements RequestExecutor {
  readonly reporting = "spec";
  readonly concurrent = true;
  private scheduler: Scheduler;
  private preparations = new Map<string, Promise<void>>();
  private flows = new Map<string, { source: string; flow: Flow; modules: ModuleSnapshot[] }>();
  private resolutions = new Map<string, ReturnType<typeof resolveWorkloadModules>>();
  private loadModule: ModuleLoader;
  private key(source: string, slug: string, restored?: ExecutionSnapshot): string {
    return slug + ":" + sha256(source) + (restored ? ":restore:" + sha256(JSON.stringify(restored.workloadModules ?? [])) : "");
  }
  private resolve(source: string, slug: string, signal: AbortSignal, restored?: ExecutionSnapshot) {
    const key = this.key(source, slug, restored);
    if (!this.resolutions.has(key)) this.resolutions.set(key, resolveWorkloadModules(source, this.loadModule, signal, restored ? restored.workloadModules ?? [] : undefined));
    return this.resolutions.get(key)!;
  }
  async validate(source: string, slug: string, signal: AbortSignal): Promise<void> { await this.resolve(source, slug, signal); }
  constructor(private config: WorkerConfig, private effects: Effects, loadModule?: ModuleLoader) {
    this.loadModule = loadModule ?? workloadLoader(config.workloadBaseDir);
    this.scheduler = new Scheduler(config.devices ?? [], config.concurrency ?? 32, message => effects.warning(message));
  }

  async prepare(source: string, slug: string, signal: AbortSignal, restored?: ExecutionSnapshot): Promise<void> {
    const key = this.key(source, slug, restored);
    if (!this.preparations.has(key)) this.preparations.set(key, this.prepareFlow(source, slug, signal, restored));
    return this.preparations.get(key)!;
  }

  private async prepareFlow(source: string, slug: string, signal: AbortSignal, restored?: ExecutionSnapshot): Promise<void> {
    const flowKey = this.key(source, slug, restored);
    if (this.flows.has(flowKey)) return;
    const { spec, modules } = await this.resolve(source, slug, signal, restored);
    const cwd = resolveRunDirectory(this.config, slug, source).path, cache = join(homedir(), ".cache");
    await verifyRunDirectoryContainment(this.config.workspace, cwd);
    await this.effects.mkdir(join(cwd, "cache")); await this.effects.mkdir(join(cwd, "output"));
    const base = {
      sys: { cache_dir: cache, models: await this.effects.discoverModels(cache) },
      session: {
        working_dir: cwd, output_dir: join(cwd, "output"), cache_dir: join(cwd, "cache"),
        unit_name: this.config.unitId, unit_id: this.config.unitId, unit_type: this.config.devices?.length ? "bun-gpu" : "bun-cpu",
        server: this.config.server, token: this.config.token,
      },
    };
    const flow = new Flow(spec, base, this.effects, "master_flow", this.scheduler, (this.config.shutdownTimeout ?? 30) * 1000);
    this.flows.set(flowKey, { source, flow, modules });
    if (restored) flow.restore(restored);
    else await flow.initialize(signal);
  }

  async execute(source: string, request: ClaimedRequest, signal: AbortSignal, persistence?: ExecutionPersistence): Promise<void> {
    const snapshot = persistence?.snapshot ? this.hydrate(persistence.snapshot) : undefined;
    if (snapshot && (snapshot.version !== 2 || snapshot.stage !== "nodes" || snapshot.pipelineName !== request.pipelineName)) throw new RecoveryError("Cannot resume unknown lifecycle/prepare outcome; reset the request in MasterFlow");
    if (snapshot) {
      if (mapping(snapshot.base.session).working_dir !== resolveRunDirectory(this.config, request.specSlug, source).path) throw new RecoveryError("Run directory changed since checkpoint; restore the original configuration before --resume");
      const metadata = mapping(snapshot.context.request);
      if (metadata.requestId !== request.requestId || metadata.specSlug !== request.specSlug || metadata.assignmentVersion !== request.assignmentVersion) throw new RecoveryError("Checkpoint assignment does not match request");
    }
    const reportContext = {session: {server: this.config.server, token: this.config.token, working_dir: this.config.workspace}, request: {...request}};
    try { await this.prepare(source, request.specSlug, signal, snapshot); }
    catch (error) {
      await reportingAction("report_request", {status: "process_failed", events: [{level: "error", message: "Request initialization failed", details: {message: error instanceof Error ? error.message : "Initialization failed"}, createdAt: Date.now()}]}, reportContext, this.effects, AbortSignal.timeout(10000), true);
      throw error;
    }
    const prepared = this.flows.get(this.key(source, request.specSlug, snapshot))!;
    if (source !== prepared.source) throw new Error("Spec changed within the current worker invocation");
    if (snapshot) prepared.flow.restore(snapshot);
    await prepared.flow.execute({
      pipelineName: request.pipelineName, payload: request.inputs ?? request.payload,
      metadata: { requestId: request.requestId, specSlug: request.specSlug, assignmentVersion: request.assignmentVersion, artifacts: request.artifacts, registryContext: request.registryContext ?? {} },
      registryContext: request.registryContext,
    }, signal, persistence ? {
      snapshot, retryIncomplete: persistence.retryIncomplete,
      save: value => persistence.save(this.sanitize({ ...value, workloadModules: prepared.modules })),
    } : undefined);
  }

  private sanitize(snapshot: ExecutionSnapshot): ExecutionSnapshot {
    const result = structuredClone(snapshot);
    for (const context of [result.base, result.prepared, result.context, ...Object.values(result.nodeContexts ?? {})]) if (context && context.session) delete mapping(context.session).token;
    return result;
  }

  private hydrate(snapshot: ExecutionSnapshot): ExecutionSnapshot {
    const result = structuredClone(snapshot);
    for (const context of [result.base, result.prepared, result.context, ...Object.values(result.nodeContexts ?? {})]) {
      if (context && context.session) {
        const session: Context = mapping(context.session);
        if (session.server !== this.config.server || session.unit_id !== this.config.unitId) throw new RecoveryError("Checkpoint worker identity does not match configuration");
        session.token = this.config.token;
      }
    }
    return result;
  }

  async finalize(failed: boolean): Promise<void> {
    let error: unknown;
    const cleanup = AbortSignal.timeout((this.config.shutdownTimeout ?? 30) * 1000);
    for (const { flow } of this.flows.values()) {
      try { await flow.finalize(failed, cleanup); }
      catch (caught) { error ??= caught; }
    }
    this.flows.clear();
    this.preparations.clear();
    this.resolutions.clear();
    if (error) throw error;
  }
}
