export type Context = Record<string, unknown>;
export type NodeStatus = "running" | "success" | "failed";
export type States = Record<string, NodeStatus>;
export interface Field { type: "string" | "number" | "boolean" | "array" | "object" | "artifact"; value?: unknown; default?: unknown }
export type Fields = Record<string, Field>;
export interface Condition {
  operator: "and" | "or" | "cel" | "file_exists" | "folder_exists" | "path_exists" | "exit_code" | "action_state" | "node_state" | "node_status";
  expected?: unknown;
  props?: Condition[];
  expression?: string;
  path?: string;
  target?: unknown[] | string;
  node?: string;
}
export interface Common {
  context?: Context | string;
  skip_if?: Condition;
  precondition?: Condition;
  postcondition?: Condition;
  ignore_error?: boolean;
}
export interface Action extends Common {
  type: "execute_command" | "execute_workload" | "execute_routine" | "create_dir" | "write_json" | "inspect_file" | "report_request" | "report_node" | "upload_artifact" | "download_artifact" | "send_http_request";
  target?: string;
  args?: unknown[] | Context | string;
  env?: Record<string, unknown> | string;
  with?: Context | string;
  workload?: string;
  routine?: string;
  path?: string;
  content?: unknown;
  url?: string;
  method?: string;
  header?: Record<string, unknown> | string;
  body?: unknown;
  body_file?: string;
  response_file?: string;
  timeout?: number | string;
  save_to?: string;
  artifact?: unknown;
  status?: string;
  events?: unknown;
  artifact_id?: string;
  connection_id?: string;
  content_type?: string;
  node_name?: string;
  label?: string;
  sha256?: string;
}
export interface EventHook { on: "pipeline_started" | "pipeline_finished" | "node_started" | "node_finished"; do: Action[] }
export interface Node extends Common {
  outputs?: Fields;
  inputs?: Fields;
  name: string;
  depends_on?: string[];
  before_run?: Action[];
  run?: Action[];
  after_run?: Action[];
  finally?: Action[];
  events?: EventHook[];
}
export interface Pipeline { outputs?: Fields; inputs?: Fields; context?: Context | string; prepare?: Action[]; nodes?: Node[]; events?: EventHook[] }
export interface Workload { outputs?: Fields; inputs?: Fields; target: string; argv?: unknown[] | string; env?: Record<string, unknown> | string; device_args?: unknown[] | string; units?: number }
export interface Routine { inputs?: Fields; actions: Action[]; outputs?: Fields }
export interface Lifecycle { initialization?: Action[]; finalization?: Action[] }
export interface Spec {
  expression_engine?: "cel-v1";
  pipeline: Record<string, Pipeline>;
  workloads?: Record<string, Workload>;
  routines?: Record<string, Routine>;
  entries?: Partial<Record<"direct_flow" | "master_flow", Lifecycle>>;
  events?: EventHook[];
}

export function mapping(value: unknown, label = "value"): Context {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a mapping`);
  return value as Context;
}

export function applyContext(target: Context, values: unknown): void {
  const additions = mapping(values, "context");
  if (["CreationSpace", "Session", "Request", "__mu_expression_engine", "__proto__", "constructor", "prototype"].some(key => Object.hasOwn(additions, key))) throw new Error("context cannot override captured Registry scopes or internal keys");
  Object.assign(target, additions);
}

// Node-owned data cannot replace execution metadata or reserved runtime namespaces.
const reservedNodeFields = new Set([
  "name", "status", "inputs", "outputs", "actions", "state", "total_units", "device",
  "skipped", "blocked", "ignored_error", "__mu_expression_engine", "__proto__", "constructor", "prototype",
]);

export function nodeContextValues(value: unknown, label: string): Context {
  const values = mapping(value, label);
  for (const key of Object.keys(values)) {
    if (reservedNodeFields.has(key)) throw new Error(`${label}.${key}: reserved Node field`);
  }
  return values;
}
