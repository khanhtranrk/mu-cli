import { render } from "../spec/expressions";
import { applyContext, mapping, nodeContextValues, type Context, type Node, type NodeStatus, type Spec, type States } from "../spec/types";
import { Actions, errorValue } from "./actions";
import { condition } from "./conditions";
import { requestScopes } from "./context";
import { resolveFields } from "../spec/fields";
import type { Effects } from "./ports";
import { Scheduler, type Device } from "../scheduler/scheduler";
import { RecoveryError, type ExecutionPersistence, type ExecutionSnapshot } from "./checkpoint";

export interface PipelineRequest { pipelineName: string; payload: unknown; metadata: Context; registryContext?: unknown }

export class Flow {
  private actions: Actions;
  private base: Context;
  private prepared = new Map<string, Context>();
  private preparationErrors = new Map<string, unknown>();
  private preparing = new Map<string, Promise<Context>>();
  private initialized = false;
  private failed = false;

  constructor(private spec: Spec, base: Context, private effects: Effects, private entry: "direct_flow" | "master_flow" = "master_flow", private scheduler = new Scheduler([], 32, message => effects.warning(message)), private shutdownTimeout = 30_000) {
    this.base = structuredClone(base);
    requestScopes(this.base);
    this.base.entry = { name: entry, status: "running" };
    this.actions = new Actions(spec, effects);
  }

  restore(snapshot: ExecutionSnapshot): void {
    if (snapshot.version !== 1 || snapshot.stage !== "nodes") throw new RecoveryError("Recovery requires a node-boundary checkpoint; lifecycle/prepare outcomes are unknown");
    const definition = this.spec.pipeline[snapshot.pipelineName];
    if (!Object.hasOwn(this.spec.pipeline, snapshot.pipelineName) || !definition || !snapshot.prepared) throw new RecoveryError("Invalid checkpoint pipeline/preparation");
    for (const [name, status] of Object.entries(mapping(snapshot.states))) {
      const node = definition.nodes?.find(item => item.name === name);
      if (!node || !["running", "success", "failed"].includes(String(status))) throw new RecoveryError("Invalid checkpoint node state");
      if (status !== "failed" && (node.depends_on ?? []).some(dependency => snapshot.states[dependency] !== "success") && !(status === "success" && node.ignore_error)) throw new RecoveryError("Invalid checkpoint dependency state");
    }
    if (!this.initialized) { this.base = structuredClone(snapshot.base); this.initialized = true; }
    if (snapshot.prepared && !this.prepared.has(snapshot.pipelineName)) this.prepared.set(snapshot.pipelineName, structuredClone(snapshot.prepared));
  }

  async initialize(signal: AbortSignal): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    try { await this.actions.runAll(this.spec.entries?.[this.entry]?.initialization, this.base, {}, signal); }
    catch (error) { this.failed = true; throw error; }
  }

  async finalize(failed: boolean, signal: AbortSignal): Promise<void> {
    if (!this.initialized) return;
    this.initialized = false;
    const entry = mapping(this.base.entry);
    entry.status = failed || this.failed ? "failed" : "success";
    let error: unknown;
    for (const action of this.spec.entries?.[this.entry]?.finalization ?? []) {
      try { await this.actions.run(action, this.base, {}, signal); }
      catch (caught) { error ??= caught; entry.status = "failed"; }
    }
    if (error) throw error;
  }

  private async emit(name: string, pipelineName: string, context: Context, states: States, signal: AbortSignal, options: {
    node?: Node; status?: NodeStatus; error?: Context | null; skipped?: boolean; blocked?: boolean; ignoredError?: string | null;
  } = {}): Promise<void> {
    const pipeline = this.spec.pipeline[pipelineName];
    const status = options.status ?? "running";
    const event: Context = { name, pipeline: { name: pipelineName, ...(options.node ? {} : { status }) }, error: options.error ?? null };
    if (options.node) event.node = { ...mapping(context.node ?? {}), name: options.node.name, status, skipped: options.skipped ?? false, blocked: options.blocked ?? false, ignored_error: options.ignoredError ?? null };
    for (const hooks of [this.spec.events, pipeline?.events, options.node?.events]) {
      for (const hook of hooks ?? []) {
        if (hook.on !== name) continue;
        const local = structuredClone(context);
        local.event = structuredClone(event); local.actions = {};
        if (options.node) local.node = structuredClone(event.node);
        try { await this.actions.runAll(hook.do, local, { ...states }, signal); }
        catch { this.effects.warning(`Lifecycle hook ${name} failed`); }
      }
    }
  }

  private async executeNode(node: Node, pipelineName: string, context: Context, states: States, signal: AbortSignal, device?: Device): Promise<{ status: NodeStatus; context: Context }> {
    const local = structuredClone(context);
    local.node = { name: node.name, status: "running", total_units: nodeUnits(this.spec, node), device: { family: device?.family ?? "cpu", index: device ? String(device.index) : null } };
    await this.emit("node_started", pipelineName, local, states, signal, { node });
    let status: NodeStatus = "success", error: unknown, skipped = false;
    try {
      signal.throwIfAborted();
      Object.assign(mapping(local.node), nodeContextValues(render(node.context ?? {}, local), `node.${node.name}.context`));
      mapping(local.node).inputs = resolveFields(node.inputs, {}, local, "node " + node.name);
      if (node.skip_if && await condition(node.skip_if, local, states, this.effects, signal)) skipped = true;
      else {
        if (!await condition(node.precondition, local, states, this.effects, signal)) throw new Error("Node precondition failed");
        for (const phase of [node.before_run, node.run, node.after_run]) await this.actions.runAll(phase, local, states, signal);
      }
      if (!await condition(node.postcondition, local, states, this.effects, signal)) throw new Error("Node postcondition failed");
    } catch (caught) { status = "failed"; error = caught; }
    const finalStates = { ...states, [node.name]: status };
    const cleanupSignal = signal.aborted ? AbortSignal.timeout(this.shutdownTimeout) : signal;
    for (const action of node.finally ?? []) {
      mapping(local.node).status = status;
      try { await this.actions.run(action, local, finalStates, cleanupSignal); }
      catch (caught) { status = "failed"; error = caught; finalStates[node.name] = status; }
    }
    let ignoredError: string | null = null;
    if (status === "failed" && node.ignore_error && !signal.aborted) {
      ignoredError = String(errorValue(error).message); status = "success"; error = undefined;
    }
    mapping(local.node).status = status;
    await this.emit("node_finished", pipelineName, local, { ...states, [node.name]: status }, signal, {
      node, status, error: error ? errorValue(error) : null, skipped, ignoredError,
    });
    return { status, context: local };
  }

  async execute(request: PipelineRequest, signal: AbortSignal, persistence?: ExecutionPersistence): Promise<States> {
    if (!this.initialized) throw new Error("Flow must initialize before execution");
    const name = request.pipelineName;
    let context = structuredClone(this.base);
    context.request = structuredClone(request.metadata); context.pipeline_name = name;
    requestScopes(context, request.registryContext);
    const restored = persistence?.snapshot;
    if (restored && (restored.version !== 1 || restored.stage !== "nodes" || restored.pipelineName !== name)) throw new RecoveryError("Checkpoint is not a resumable node boundary");
    const states: States = structuredClone(restored?.states ?? {});
    const nodeContexts = structuredClone(restored?.nodeContexts ?? {});
    if (Object.values(states).includes("running") && !persistence?.retryIncomplete) throw new RecoveryError("Checkpoint contains incomplete nodes; use --resume --retry-incomplete only if repeating their effects is acceptable");
    if (persistence?.retryIncomplete) for (const [node, status] of Object.entries(states)) if (status !== "success") delete states[node];
    const settled = new Set(Object.entries(states).filter(([, status]) => status !== "running").map(([node]) => node));
    let stage: ExecutionSnapshot["stage"] = "intake";
    const scope = new AbortController();
    const executionSignal = AbortSignal.any([signal, scope.signal]);
    let saving = Promise.resolve();
    const checkpoint = async () => {
      if (!persistence) return;
      const snapshot: ExecutionSnapshot = {
        version: 1, stage, pipelineName: name, base: structuredClone(this.base),
        ...(this.prepared.has(name) ? { prepared: structuredClone(this.prepared.get(name)!) } : {}),
        context: structuredClone(context), states: structuredClone(states), nodeContexts: structuredClone(nodeContexts),
      };
      saving = saving.then(() => persistence.save(snapshot));
      try { await saving; }
      catch (error) { scope.abort(error); throw error; }
    };
    let pipelineError: unknown;
    const running = new Set<Promise<void>>();
    try {
      const definition = this.spec.pipeline[name];
      if (!Object.hasOwn(this.spec.pipeline, name) || !definition) throw new Error("Unknown pipeline " + name);
      const validate = (base: Context) => {
        const local = structuredClone(base);
        requestScopes(local, request.registryContext); local.request = structuredClone(request.metadata); local.pipeline_name = name;
        applyContext(local, render(definition.context ?? {}, local));
        local.inputs = resolveFields(definition.inputs, request.payload, local, "pipeline " + name);
        local.pipeline = { name, inputs: structuredClone(local.inputs) };
        return local;
      };
      if (!restored) {
        await checkpoint();
        await this.emit("pipeline_started", name, context, states, executionSignal);
        validate(this.prepared.get(name) ?? this.base);
        if (this.preparationErrors.has(name)) throw this.preparationErrors.get(name);
        if (!this.prepared.has(name)) {
          if (!this.preparing.has(name)) {
            const preparing = (async () => {
              try {
                const prepared = structuredClone(this.base);
                await this.actions.runAll(definition.prepare, prepared, {}, executionSignal);
                mapping(prepared.sys).models = await this.effects.discoverModels(String(mapping(prepared.sys).cache_dir));
                this.prepared.set(name, prepared);
                return prepared;
              } catch (caught) { this.preparationErrors.set(name, caught); throw caught; }
            })();
            this.preparing.set(name, preparing);
          }
          await this.preparing.get(name);
        }
        context = validate(this.prepared.get(name)!);
      } else {
        context = structuredClone(restored.context);
        const metadata = mapping(context.request);
        if (metadata.requestId !== request.metadata.requestId || metadata.assignmentVersion !== request.metadata.assignmentVersion || metadata.specSlug !== request.metadata.specSlug) throw new RecoveryError("Checkpoint assignment does not match request");
        for (const [node, status] of Object.entries(states)) if (!(definition.nodes ?? []).some(item => item.name === node) || !["success", "failed", "running"].includes(status)) throw new RecoveryError("Invalid checkpoint node state");
        for (const node of definition.nodes ?? []) if (states[node.name] === "success" && node.postcondition && !node.ignore_error) {
          const completedContext = nodeContexts[node.name];
          const checking = completedContext ? structuredClone(completedContext) : undefined;
          if (checking) mapping(checking.node).status = "running";
          if (!checking || !await condition(node.postcondition, checking, { ...states, [node.name]: "running" }, this.effects, executionSignal)) throw new RecoveryError("Completed node postcondition no longer holds; restore outputs or reset the request");
        }
      }
      stage = "nodes"; await checkpoint();
      const pending = new Map((definition.nodes ?? []).filter(node => !states[node.name]).map(node => [node.name, node]));
      let runnerError: unknown;
      while (pending.size || running.size) {
        let progressed = false;
        for (const [nodeName, node] of pending) {
          if (executionSignal.aborted) break;
          if ((node.depends_on ?? []).some(dependency => !settled.has(dependency))) continue;
          const blocked = (node.depends_on ?? []).some(dependency => states[dependency] !== "success");
          if (blocked) {
            const status = node.ignore_error ? "success" : "failed";
            const detail = "Dependency failed";
            const local = { ...context, node: { name: nodeName, status, total_units: nodeUnits(this.spec, node) } };
            states[nodeName] = "running"; await checkpoint();
            await this.emit("node_finished", name, local, { ...terminalStates(states), [nodeName]: status }, executionSignal, {
              node, status, blocked: true, error: status === "failed" ? { type: "DependencyError", message: detail } : null,
              ignoredError: status === "success" ? detail : null,
            });
            states[nodeName] = status; await checkpoint(); settled.add(nodeName);
          } else {
            const task = this.scheduler.run(nodeUnits(this.spec, node), executionSignal, async device => {
              executionSignal.throwIfAborted();
              states[nodeName] = "running"; await checkpoint();
              const result = await this.executeNode(node, name, context, terminalStates(states), executionSignal, device);
              if (!executionSignal.aborted) { states[nodeName] = result.status; nodeContexts[nodeName] = result.context; await checkpoint(); settled.add(nodeName); }
            }).catch(error => { runnerError ??= error; scope.abort(error); }).finally(() => { running.delete(task); });
            running.add(task);
          }
          pending.delete(nodeName); progressed = true;
        }
        if (running.size) await Promise.race(running);
        else if (executionSignal.aborted) break;
        else if (!progressed && pending.size) throw new Error("Dependency graph cannot progress");
      }
      if (runnerError) throw runnerError;
      executionSignal.throwIfAborted();
      if (Object.values(states).includes("failed")) throw new Error("One or more nodes failed");
    } catch (caught) {
      if (running.size) { scope.abort(caught); await Promise.allSettled(running); }
      if (caught instanceof RecoveryError) throw caught;
      pipelineError = caught; this.failed = true;
    }
    if (!executionSignal.aborted) {
      stage = "finishing"; await checkpoint();
      await this.emit("pipeline_finished", name, context, states, executionSignal, { status: pipelineError ? "failed" : "success", error: pipelineError ? errorValue(pipelineError) : null });
      stage = "finished"; await checkpoint();
    }
    if (pipelineError) throw pipelineError;
    return states;
  }
}

export function nodeUnits(spec: Spec, node: Node): number {
  return Math.max(0, ...[node.before_run, node.run, node.after_run].flatMap(actions => (actions ?? []).filter(action => action.type === "execute_workload").map(action => spec.workloads?.[action.workload!]?.units ?? 0)));
}

function terminalStates(states: States): States {
  return Object.fromEntries(Object.entries(states).filter(([, status]) => status !== "running"));
}
