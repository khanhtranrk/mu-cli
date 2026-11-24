import { AssignmentLostError } from "./api";
import { HeartbeatMonitor } from "./heartbeat";
import { resolveRunDirectory, runDirectoryOptions, verifyRunDirectory } from "./run-directory";
import {parsePipeline, parseSpec, parseYamlMapping} from "./spec/parse";
import type { WorkerConfig } from "./config";
import type { DataCenterClient, ClaimedRequest, Report } from "./api";
import type { RequestExecutor } from "./runtime/types";
import { StateStore, type Checkpoint } from "./state";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { RecoveryError } from "./engine/checkpoint";

export class Worker {
  private store: StateStore;
  private sources = new Map<string, string>();
  private seen = new Set<string>();
  constructor(private config: WorkerConfig, private api: DataCenterClient, private executor: RequestExecutor) {
    const scope = createHash("sha256").update(config.server + "\n" + config.unitId).digest("hex");
    this.store = new StateStore(join(config.workspace, scope));
  }

  private async deliver(state: Checkpoint): Promise<void> {
    if (!state.report) throw new Error("Checkpoint has no report");
    try { await this.api.report(state.report, state.request); }
    catch (error) {
      if (error instanceof AssignmentLostError) {
        await this.store.save({ ...state, phase: "revoked" });
        return;
      }
      const status = (error as {status?: number}).status;
      if (state.report.status !== "succeeded" || !state.report.pipelineState || status === undefined || status < 400 || status >= 500) throw error;
      state = {...state, report: {id: state.request.requestId, status: "process_failed", events: [{level: "error", message: "Request output report was rejected", createdAt: Date.now()}]}};
      await this.store.save(state);
      try { await this.api.report(state.report!, state.request); }
      catch (retryError) {
        if (!(retryError instanceof AssignmentLostError)) throw retryError;
        await this.store.save({ ...state, phase: "revoked" });
        return;
      }
    }
    await this.store.save({ ...state, phase: "reported" });
  }

  private async recover(signal: AbortSignal): Promise<{ failed: boolean; resumed: boolean }> {
    const resumable: Checkpoint[] = [];
    for (const state of await this.store.load()) {
      this.seen.add(state.request.requestId + ":" + state.request.assignmentVersion);
      if (state.phase === "reported" || state.phase === "revoked") continue;
      if (state.phase === "terminal") { await this.deliver(state); continue; }
      try { await this.api.verifyAssignment(state.request, signal); }
      catch (error) {
        if (!(error instanceof AssignmentLostError)) throw error;
        await this.store.save({ ...state, phase: "revoked" });
        continue;
      }
      if (state.reporting === "spec" && state.execution && state.execution.version !== 2) throw new RecoveryError("Execution contract changed; reset old checkpoints in MasterFlow");
      if (state.reporting === "spec" && state.execution?.stage === "finishing") {
        const pipeline = state.execution.context.pipeline as {status: string; outputs?: Record<string, unknown>; events?: Report["events"]};
        const report: Report = {id: state.request.requestId, status: pipeline.status === "success" ? "succeeded" : "process_failed", ...(pipeline.events ? {events: pipeline.events} : {}), ...(pipeline.status === "success" ? {pipelineState: {status: "success", outputs: pipeline.outputs ?? {}}} : {})};
        const terminal: Checkpoint = {...state, phase: "terminal", report};
        await this.store.save(terminal); await this.deliver(terminal); continue;
      }
      if (state.reporting === "spec") {
        if (state.execution?.stage === "finished") { await this.store.save({ ...state, phase: "reported" }); continue; }
        if (state.source !== undefined || state.execution) {
          if (!this.config.resume) throw new RecoveryError("Unfinished Spec assignment found; use --resume to continue persisted nodes");
          if (this.executor.reporting !== "spec" || !state.source || state.execution?.version !== 2 || state.execution.stage !== "nodes") throw new RecoveryError("Unknown intake/prepare/lifecycle outcome; inspect/reset the request in MasterFlow");
          if (Object.values(state.execution.states).includes("running") && !this.config.retryIncomplete) throw new RecoveryError("Incomplete nodes require --resume --retry-incomplete; their external effects may repeat");
          if (!this.config.specs.includes(state.request.specSlug)) throw new RecoveryError("Recovered assignment requires its --spec filter");
          const source = state.request.specYaml ?? this.sources.get(state.request.specSlug) ?? await this.api.spec(state.request.specSlug);
          if (source !== state.source) throw new RecoveryError("Remote Spec changed since checkpoint; inspect/reset the request");
          const currentDirectory = resolveRunDirectory(this.config, state.request.specSlug, source);
          const savedDirectory = state.runDirectory ?? resolveRunDirectory({...this.config, runDirectoryScope: "spec-version", runDirectoryName: undefined}, state.request.specSlug, state.source);
          verifyRunDirectory(currentDirectory, savedDirectory);
          this.sources.set(state.request.specSlug, source);
          resumable.push(state);
          continue;
        }
        await this.store.save({ ...state, phase: "reported" });
        console.warn("Recovered an unfinished Spec assignment without replaying actions or reports; inspect/reset it in MasterFlow");
        continue;
      }
      state.phase = "terminal";
      state.report = { id: state.request.requestId, status: "process_failed" };
      await this.store.save(state);
      await this.deliver(state);
    }
    const outcomes = await Promise.allSettled(resumable.map(state => this.execute(state.request, signal, state)));
    const error = outcomes.find(result => result.status === "rejected");
    if (error?.status === "rejected") throw error.reason;
    return { failed: outcomes.some(result => result.status === "fulfilled" && !result.value), resumed: resumable.length > 0 };
  }

  private async execute(request: ClaimedRequest, signal: AbortSignal, recovered?: Checkpoint): Promise<boolean> {
    const stop = new AbortController();
    const execution = AbortSignal.any([signal, stop.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let checking: Promise<void> | undefined;
    const scheduleCheck = () => {
      if (execution.aborted) return;
      timer = setTimeout(() => {
        checking = this.api.verifyAssignment(request, execution).catch(error => {
          if (error instanceof AssignmentLostError) stop.abort(error);
        }).finally(scheduleCheck);
      }, 5_000);
    };
    try {
      if (this.executor.reporting === "spec" && !recovered) await this.api.verifyAssignment(request, execution);
      scheduleCheck();
      const result = await this.executeAssignment(request, execution, signal, recovered);
      if (execution.reason instanceof AssignmentLostError) throw execution.reason;
      return result;
    } catch (error) {
      if (!(error instanceof AssignmentLostError) && !(execution.reason instanceof AssignmentLostError)) throw error;
      const state = (await this.store.load()).find(row => row.request.requestId === request.requestId);
      await this.store.save({ ...state, request, phase: "revoked" });
      return false;
    } finally {
      stop.abort();
      clearTimeout(timer);
      await checking;
    }
  }

  private async executeAssignment(request: ClaimedRequest, signal: AbortSignal, workerSignal: AbortSignal, recovered?: Checkpoint): Promise<boolean> {
    const state: Checkpoint = { ...recovered, request, phase: "executing", ...(this.executor.reporting ? { reporting: this.executor.reporting } : {}) };
    state.source ??= this.sources.get(request.specSlug);
    await this.store.save(state);
    if (this.executor.reporting !== "spec") await this.api.report({ id: request.requestId, status: "processing" }, request);
    let failed = false;
    let reportFailure: unknown;
    let writes = Promise.resolve();
    try {
      signal.throwIfAborted();
      const source = request.specYaml ?? this.sources.get(request.specSlug) ?? await this.api.spec(request.specSlug);
      if (request.yamlSha256 !== undefined && request.yamlSha256 !== createHash("sha256").update(source).digest("hex")) {
        throw new Error("Claimed YAML SHA-256 mismatch");
      }
      if (request.executionSha256 !== undefined) {
        const lock = request.workloadLock;
        const pins = lock?.pins.slice().sort((left, right) => left.alias < right.alias ? -1 : left.alias > right.alias ? 1 : 0)
          .map(pin => [pin.alias, pin.reference, pin.slug, pin.version, pin.versionId, pin.sha256, pin.formatVersion]) ?? [];
        const identity = JSON.stringify([1, source, lock?.yamlSha256 ?? null, pins]);
        if (request.executionSha256 !== createHash("sha256").update(identity).digest("hex")) {
          throw new Error("Claimed execution SHA-256 mismatch");
        }
      }
      if (this.executor.reporting === "spec") {
        state.source = source;
        state.runDirectory = resolveRunDirectory(this.config, request.specSlug, source);
        await this.store.save(state);
      }
      if (this.executor.reporting !== "spec" && request.specYaml) {
        const definition = parseYamlMapping(source).kind === "pipeline"
          ? parsePipeline(source, request.specSlug)
          : parseSpec(source);
        if (Object.keys(definition.pipelines[request.pipelineName]?.outputs ?? {}).length) {
          throw new Error("Fake execution cannot publish declared Outputs");
        }
      }
      await this.executor.execute(source, request, signal, this.executor.reporting === "spec" ? {
        snapshot: recovered?.execution, retryIncomplete: this.config.retryIncomplete,
        save: snapshot => {
          const saved: Checkpoint = { ...state, source, execution: snapshot };
          writes = writes.then(async () => { await this.store.save(saved); Object.assign(state, saved); });
          return writes;
        },
      } : undefined, workerSignal);
    } catch (error) { failed = true; reportFailure = error; }
    await writes;
    if (reportFailure instanceof AssignmentLostError) throw reportFailure;
    if (signal.reason instanceof AssignmentLostError) throw signal.reason;
    if (this.executor.reporting === "spec" && signal.aborted && state.execution?.stage === "nodes") return false;
    if (this.executor.reporting === "spec" && state.execution?.stage !== "finished") {
      const pipeline = state.execution?.context.pipeline as {status?: string; outputs?: Record<string, unknown>; events?: Report["events"]} | undefined;
      const status = (reportFailure as {status?: number} | undefined)?.status;
      const permanent = status !== undefined && status >= 400 && status < 500;
      const succeeded = state.execution?.stage === "finishing" && pipeline?.status === "success" && !permanent;
      const report: Report = {id: request.requestId, status: succeeded ? "succeeded" : "process_failed", ...(permanent ? {events: [{level: "error" as const, message: "Request output report was rejected", createdAt: Date.now()}]} : pipeline?.events ? {events: pipeline.events} : {}), ...(succeeded ? {pipelineState: {status: "success", outputs: pipeline?.outputs ?? {}}} : {})};
      const terminal: Checkpoint = {...state, phase: "terminal", report};
      await this.store.save(terminal); await this.deliver(terminal);
      return succeeded;
    }
    const report: Report = { id: request.requestId, status: failed ? "process_failed" : "succeeded", ...(!failed && request.specYaml && this.executor.reporting !== "spec" ? {pipelineState: {status: "success", outputs: {}}} : {}) };
    const terminal: Checkpoint = this.executor.reporting === "spec" ? { ...state, phase: "reported", report } : { ...state, phase: "terminal", report };
    await this.store.save(terminal);
    if (this.executor.reporting !== "spec") await this.deliver(terminal);
    return !failed;
  }

  async run(mode: "once" | "start", signal: AbortSignal): Promise<number> {
    runDirectoryOptions(this.config.runDirectoryScope, this.config.runDirectoryName);
    if (!this.config.fake && this.executor.reporting !== "spec") throw new Error("Fake execution requires --fake");
    await this.api.health();
    await this.api.heartbeat("online");
    const heartbeat = new HeartbeatMonitor(signal => this.api.heartbeat("online", signal), this.config.heartbeatInterval * 1000, signal);
    heartbeat.start();
    let failed = false;
    let completed = false;
    let primaryError: unknown;
    try {
      const recovery = await this.recover(signal);
      failed ||= recovery.failed;
      if (mode === "once" && this.config.resume) { completed = true; return signal.aborted ? 130 : failed ? 6 : 0; }
      do {
        const batch: ClaimedRequest[] = [];
        const specs = this.config.specs;
        const scope = specs.length > 1 ? specs : specs[0];
        if (!signal.aborted) {
          await heartbeat.ensureHealthy();
          const claimed = await this.api.claim(scope, this.config.maxClaim - batch.length);
          for (const request of claimed) {
            const assignment = request.requestId + ":" + request.assignmentVersion;
            if (this.seen.has(assignment)) throw new Error("Data Center returned a duplicate assignment; refusing repeated execution");
            this.seen.add(assignment);
            const source = request.specYaml ?? this.sources.get(request.specSlug);
            await this.store.save({ request, phase: "claimed", source, ...(this.executor.reporting === "spec" && source !== undefined ? {runDirectory: resolveRunDirectory(this.config, request.specSlug, source)} : {}), ...(this.executor.reporting ? { reporting: this.executor.reporting } : {}) });
          }
          batch.push(...claimed);
        }
        await heartbeat.ensureHealthy();
        if (this.executor.concurrent) {
          const results = await Promise.allSettled(batch.map(request => this.execute(request, signal)));
          const error = results.find(result => result.status === "rejected");
          if (error?.status === "rejected") throw error.reason;
          failed ||= results.some(result => result.status === "fulfilled" && !result.value);
        } else for (const request of batch) if (!await this.execute(request, signal)) failed = true;
        await heartbeat.ensureHealthy();
        if (mode === "once" || signal.aborted) break;
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timeout); signal.removeEventListener("abort", done); resolve(); };
          const timeout = setTimeout(done, this.config.pollInterval * 1000);
          signal.addEventListener("abort", done, { once: true });
          if (signal.aborted) done();
        });
      } while (!signal.aborted);
      completed = true;
      return signal.aborted ? 130 : failed ? 6 : 0;
    } catch (error) {
      primaryError = error;
      if (signal.aborted) return 130;
      throw error;
    } finally {
      await heartbeat.stop();
      let cleanupError: unknown;
      try { await this.executor.finalize?.(!completed || failed || signal.aborted); }
      catch (error) { cleanupError = error; }
      try { await this.api.heartbeat("offline"); }
      catch (error) { cleanupError ??= error; }
      if (cleanupError) {
        if (!primaryError && !failed && !signal.aborted) throw cleanupError;
        console.warn("Worker cleanup failed; original execution outcome retained");
      }
    }
  }
}
