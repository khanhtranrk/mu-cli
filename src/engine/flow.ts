import { render } from "../spec/expressions";
import { applyContext, mapping, type Context, type Node, type NodeStatus, type Spec, type States } from "../spec/types";
import { Actions, errorValue } from "./actions";
import { condition } from "./conditions";
import { paramsFor, requestScopes } from "./context";
import type { Effects } from "./ports";

export interface PipelineRequest { pipelineName: string; payload: unknown; metadata: Context; registryContext?: unknown }

export class Flow {
  private actions: Actions;
  private base: Context;
  private prepared = new Map<string, Context>();
  private preparationErrors = new Map<string, unknown>();
  private initialized = false;
  private failed = false;

  constructor(private spec: Spec, base: Context, private effects: Effects, private entry: "direct_flow" | "master_flow" = "master_flow") {
    this.base = structuredClone(base);
    requestScopes(this.base);
    this.base.entry = { name: entry, status: "running" };
    this.actions = new Actions(spec, effects);
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

  private async executeNode(node: Node, pipelineName: string, context: Context, states: States, signal: AbortSignal): Promise<NodeStatus> {
    const local = structuredClone(context);
    local.node = { name: node.name, status: "running", total_units: nodeUnits(this.spec, node), device: { family: "cpu", index: null } };
    await this.emit("node_started", pipelineName, local, states, signal, { node });
    let status: NodeStatus = "success", error: unknown, skipped = false;
    try {
      signal.throwIfAborted();
      applyContext(local, render(node.context ?? {}, local));
      if (node.skip_if && await condition(node.skip_if, local, states, this.effects, signal)) skipped = true;
      else {
        if (!await condition(node.precondition, local, states, this.effects, signal)) throw new Error("Node precondition failed");
        for (const phase of [node.before_run, node.run, node.after_run]) await this.actions.runAll(phase, local, states, signal);
      }
      if (!await condition(node.postcondition, local, states, this.effects, signal)) throw new Error("Node postcondition failed");
    } catch (caught) { status = "failed"; error = caught; }
    const finalStates = { ...states, [node.name]: status };
    const cleanupSignal = signal.aborted ? AbortSignal.timeout(30_000) : signal;
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
    return status;
  }

  async execute(request: PipelineRequest, signal: AbortSignal): Promise<States> {
    if (!this.initialized) throw new Error("Flow must initialize before execution");
    const name = request.pipelineName;
    let context = structuredClone(this.base);
    context.request = structuredClone(request.metadata); context.pipeline_name = name;
    requestScopes(context, request.registryContext);
    const states: States = {};
    await this.emit("pipeline_started", name, context, states, signal);
    let pipelineError: unknown;
    try {
      const definition = this.spec.pipeline[name];
      if (!Object.hasOwn(this.spec.pipeline, name) || !definition) throw new Error("Unknown pipeline " + name);
      const validate = (base: Context) => {
        const local = structuredClone(base);
        requestScopes(local, request.registryContext); local.request = structuredClone(request.metadata); local.pipeline_name = name;
        applyContext(local, render(definition.context ?? {}, local));
        paramsFor(definition.params, request.payload, local, "pipeline " + name);
        return local;
      };
      validate(this.prepared.get(name) ?? this.base);
      if (this.preparationErrors.has(name)) throw this.preparationErrors.get(name);
      if (!this.prepared.has(name)) {
        try {
          const prepared = structuredClone(this.base);
          await this.actions.runAll(definition.prepare, prepared, {}, signal);
          mapping(prepared.sys).models = await this.effects.discoverModels(String(mapping(prepared.sys).cache_dir));
          this.prepared.set(name, prepared);
        } catch (caught) { this.preparationErrors.set(name, caught); throw caught; }
      }
      context = validate(this.prepared.get(name)!);
      context.params = paramsFor(definition.params, request.payload, context, "pipeline " + name);
      const pending = new Map((definition.nodes ?? []).map(node => [node.name, node]));
      while (pending.size) {
        let progressed = false;
        for (const [nodeName, node] of pending) {
          if ((node.depends_on ?? []).some(dependency => !states[dependency])) continue;
          const blocked = (node.depends_on ?? []).some(dependency => states[dependency] !== "success");
          if (blocked || signal.aborted) {
            const status = blocked && node.ignore_error && !signal.aborted ? "success" : "failed";
            const detail = signal.aborted ? "Execution interrupted" : "Dependency failed";
            const local = { ...context, node: { name: nodeName, status, total_units: nodeUnits(this.spec, node) } };
            states[nodeName] = status;
            await this.emit("node_finished", name, local, states, signal, {
              node, status, blocked: true, error: status === "failed" ? { type: "DependencyError", message: detail } : null,
              ignoredError: status === "success" ? detail : null,
            });
          } else states[nodeName] = await this.executeNode(node, name, context, states, signal);
          pending.delete(nodeName); progressed = true;
        }
        if (!progressed) throw new Error("Dependency graph cannot progress");
      }
      if (Object.values(states).includes("failed")) throw new Error("One or more nodes failed");
    } catch (caught) { pipelineError = caught; this.failed = true; }
    await this.emit("pipeline_finished", name, context, states, signal, { status: pipelineError ? "failed" : "success", error: pipelineError ? errorValue(pipelineError) : null });
    if (pipelineError) throw pipelineError;
    return states;
  }
}

export function nodeUnits(spec: Spec, node: Node): number {
  return Math.max(0, ...[node.before_run, node.run, node.after_run].flatMap(actions => (actions ?? []).filter(action => action.type === "execute_workload").map(action => spec.workloads?.[action.workload!]?.units ?? 0)));
}
