import { render } from "../spec/expressions";
import { applyContext, mapping, type Action, type Context, type Spec, type States } from "../spec/types";
import { resolveFields } from "../spec/fields";
import { condition } from "./conditions";
import type { Effects, HttpOptions } from "./ports";
import { reportingAction } from "./reporting-actions";
import { argumentText } from "./argv";

export function errorValue(error: unknown): Context {
  return { type: "RuntimeError", message: error instanceof Error ? error.message : "Execution failed" };
}

function strings(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(mapping(value)).map(([key, child]) => [key, String(child)]));
}

function environment(value: unknown): Record<string, string> {
  const entries = mapping(value, "env");
  if (Object.values(entries).some(child => typeof child !== "string")) throw new Error("Environment values must be strings");
  return entries as Record<string, string>;
}

export class Actions {
  constructor(private spec: Spec, private effects: Effects) {}

  async runAll(actions: Action[] = [], context: Context, states: States, signal: AbortSignal): Promise<void> {
    for (const action of actions) await this.run(action, context, states, signal);
  }

  async run(action: Action, context: Context, states: States, signal: AbortSignal): Promise<void> {
    applyContext(context, render(action.context ?? {}, context));
    if (action.skip_if && await condition(action.skip_if, context, states, this.effects, signal)) return;
    if (!await condition(action.precondition, context, states, this.effects, signal)) return;
    const values = mapping(render(Object.fromEntries(Object.entries(action).filter(([key]) => !["context", "skip_if", "precondition", "postcondition", "body", "content"].includes(key))), context));
    const key = values.save_to;
    if (key !== undefined && (typeof key !== "string" || !key.trim())) throw new Error("save_to must resolve to a nonempty name");
    if (key !== undefined) mapping(context.actions ?? {}, "context.actions");
    const result: Context = { success: false, error: null };
    if (action.type === "execute_command") Object.assign(result, { returncode: null, stdout: "", stderr: "" });
    if (action.type === "send_http_request") Object.assign(result, { status_code: null, headers: {}, body: null });
    const save = () => {
      if (typeof key === "string") {
        const actions = mapping(context.node && !context.routine ? mapping(context.node).actions ?? {} : context.actions ?? {});
        if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Invalid save_to name");
        actions[key] = structuredClone(result);
        if (context.node && !context.routine) mapping(context.node).actions = actions;
        else context.actions = actions;
      }
    };
    const cwd = String(mapping(context.session).working_dir);
    try {
      signal.throwIfAborted();
      switch (action.type) {
        case "report_request":
        case "report_node":
        case "upload_artifact":
        case "download_artifact":
          Object.assign(result, await reportingAction(action.type, values, context, this.effects, signal)); break;
        case "execute_command": {
          if (typeof values.target !== "string" || !values.target || !Array.isArray(values.args ?? [])) throw new Error("Command requires target and argv list");
          Object.assign(result, await this.effects.process([values.target, ...(values.args as unknown[] ?? []).map(value => argumentText(value))], environment(values.env ?? {}), cwd, signal));
          if (result.returncode !== 0) throw new Error(`Command exited with status ${result.returncode}`);
          break;
        }
        case "execute_workload": {
          const workload = this.spec.workloads![action.workload!]!;
          const local = structuredClone(context);
          delete local.with;
          local.inputs = {};
          const invocation = { ...local, with: mapping(values.with === undefined ? {} : values.with, "execute_workload.with") };
          local.inputs = resolveFields(workload.inputs, {}, invocation, "workload " + action.workload);
          delete (local as Context).schedule;
          const placement = mapping(mapping(context.node ?? {}).device ?? {});
          const gpu = (workload.units ?? 0) > 0 && placement.family !== "cpu" && placement.index != null;
          const target = render(workload.target, local), args = render(workload.argv ?? [], local);
          if (typeof target !== "string" || !target || !Array.isArray(args)) throw new Error("Workload requires target and argv list");
          if (gpu) {
            (local as Context).schedule = { device_family: placement.family, device_index: placement.index };
            const deviceArgs = render(workload.device_args ?? [], local);
            if (!Array.isArray(deviceArgs)) throw new Error("device_args must resolve to a list");
            args.push(...deviceArgs);
          }
          const process = await this.effects.process([target, ...args.map(value => argumentText(value))], environment(render(workload.env ?? {}, local)), cwd, signal);
          if (process.returncode !== 0) throw new Error(`Workload exited with status ${process.returncode}`);
          local.result = process;
          result.outputs = resolveFields(workload.outputs, {}, local, "workload outputs");
          break;
        }
        case "execute_routine": {
          const declaration = this.spec.routines![action.routine!]!;
          const local = structuredClone(context);
          local.inputs = resolveFields(declaration.inputs, {}, {...context, with: mapping(values.with ?? {})}, "routine " + action.routine);
          local.routine = {name: action.routine};
          local.actions = {};
          await this.runAll(declaration.actions, local, states, signal);
          result.outputs = resolveFields(declaration.outputs, {}, local, "routine outputs");
          break;
        }
        case "create_dir":
          await this.effects.mkdir(this.effects.path(String(values.path), ".")); break;
        case "write_json":
          await this.effects.writeJson(this.effects.path(String(values.path), "."), render(Object.hasOwn(action, "content") ? action.content : {}, context, true)); break;
        case "inspect_file":
          Object.assign(result, await this.effects.inspect(this.effects.path(String(values.target), cwd))); break;
        case "send_http_request": {
          const url = new URL(String(values.url));
          if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("HTTP action requires an HTTP(S) URL without credentials");
          const headers = strings(values.header ?? {});
          const timeout = values.timeout ?? 30;
          if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) throw new Error("HTTP timeout must be a positive number");
          const session = mapping(context.session), request = mapping(context.request ?? {});
          if (typeof session.server === "string" && new URL(session.server).origin === url.origin && request.assignmentVersion !== undefined) {
            for (const key of Object.keys(headers)) if (key.toLowerCase() === "x-mu-assignment-version") delete headers[key];
            headers["X-Mu-Assignment-Version"] = String(request.assignmentVersion);
          }
          const body = Object.hasOwn(action, "body") ? render(action.body, context, true) : undefined;
          if (typeof session.server === "string" && new URL(session.server).origin === url.origin && url.pathname === "/api/requests/report" && body && typeof body === "object") {
            const report = mapping(body);
            if (report.status !== undefined || report.pipelineState !== undefined || Object.values(mapping(report.node_states ?? {})).some(value => mapping(value).status !== undefined || mapping(value).outputs !== undefined)) throw new Error("Lifecycle status and Outputs are owned by the worker");
          }
          const options: HttpOptions = {
            url: url.href, method: String(values.method ?? "get").toUpperCase(), headers,
            timeout,
            ...(Object.hasOwn(action, "body") ? { body } : {}),
            ...(values.body_file === undefined ? {} : { bodyFile: this.effects.path(String(values.body_file), cwd) }),
            ...(values.response_file === undefined ? {} : { responseFile: this.effects.path(String(values.response_file), cwd) }),
          };
          Object.assign(result, await this.effects.http(options, signal));
          if (Number(result.status_code) >= 300) throw new Error(`HTTP ${result.status_code}`);
          break;
        }
      }
      result.success = true; save();
      if (!await condition(action.postcondition, context, states, this.effects, signal)) throw new Error("Action postcondition failed");
    } catch (error) {
      delete result.outputs;
      result.success = false; result.error = errorValue(error); save();
      if (action.ignore_error === true && !signal.aborted) { this.effects.warning("Ignored action failure"); return; }
      throw error;
    }
  }
}
