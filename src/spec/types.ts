export type Context = Record<string, unknown>;
export type NodeStatus = "running" | "success" | "failed";
export type States = Record<string, NodeStatus>;
export interface Parameter { type?: "string" | "number" | "boolean" | "array" | "object"; default?: unknown }
export type Parameters = Record<string, Parameter>;
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
  save_state?: string;
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
  name: string;
  depends_on?: string[];
  before_run?: Action[];
  run?: Action[];
  after_run?: Action[];
  finally?: Action[];
  events?: EventHook[];
}
export interface Pipeline { params?: Parameters; context?: Context | string; prepare?: Action[]; nodes?: Node[]; events?: EventHook[] }
export interface Workload { params?: Parameters; target: string; args?: unknown[] | string; env?: Record<string, unknown> | string; device_args?: unknown[] | string; units?: number }
export interface Routine { params?: Parameters; actions: Action[]; returns?: unknown }
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
