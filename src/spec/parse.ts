import { validatePreparation } from "./preparation";
import { registryReference } from "./registry-reference";
import { isScalar, parseDocument, Scalar, visit } from "yaml";
import { validateWorkloadSource } from "./workload-source";
import { validateFields } from "./fields";
import { validateTemplates } from "./expressions";
import { mapping, nodeContextValues, type Spec } from "./types";

const has = (value: object, key: string) => Object.hasOwn(value, key);
const defaultValue = <Value>(value: unknown, fallback: Value) => value === undefined ? fallback : value;
const templateValue = (value: unknown) => typeof value === "string" && value.trim().startsWith("${{") && value.trim().endsWith("}}");
const renderedMapping = (value: unknown, label: string) => { if (!templateValue(value)) mapping(value, label); };
const renderedList = (value: unknown, label: string) => { if (!templateValue(value)) list(value, label); };
const text = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
};
const list = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${label} must be a list`);
  return value;
};
const literalName = (value: unknown, label: string) => {
  const name = text(value, label);
  if (/[{}]/.test(name)) throw new Error(`${label} must be a literal name`);
  return name;
};

function inputs(item: Record<string, unknown>, label: string): void {
  if (has(item, "params")) throw new Error(`${label}.params was removed; use inputs Field declarations`);
  validateFields(defaultValue(item.inputs, {}), label + ".inputs");
}

function condition(value: unknown, label: string): void {
  if (value == null) return;
  const item = mapping(value, label);
  const operator = item.operator;
  if (operator === "and" || operator === "or") list(defaultValue(item.props, []), label + ".props").forEach(child => condition(child, label + ".props"));
  else if (operator === "cel") {
    const source = text(item.expression, label + ".expression").trim();
    if (!source.startsWith("${{") || !source.endsWith("}}")) throw new Error(`${label}: CEL condition requires a whole-value template`);
    if (has(item, "expected") && typeof item.expected !== "boolean") throw new Error(`${label}.expected must be boolean`);
  } else if (["file_exists", "folder_exists", "path_exists"].includes(String(operator))) text(item.path, label + ".path");
  else if (operator === "exit_code") {
    if (!templateValue(item.target) && !list(item.target, label + ".target").length) throw new Error(`${label}.target cannot be empty`);
    if (has(item, "expected") && (typeof item.expected !== "number" || !Number.isInteger(item.expected))) throw new Error(`${label}.expected must be an integer`);
  } else if (operator === "action_state" || operator === "node_state") {
    if (!templateValue(item.target)) {
      const target = list(item.target, label + ".target");
      if (!target.length || !target.every(key => typeof key === "string" && key)) throw new Error(`${label}.target requires string keys`);
    }
    if (!has(item, "expected")) throw new Error(`${label}.expected is required`);
  } else if (operator === "node_status") {
    if (item.node !== undefined) text(item.node, label + ".node");
  } else throw new Error(`${label}: unknown condition operator`);
}

export function parseYamlMapping(source: string): Record<string, unknown> {
  const document = parseDocument(source, { uniqueKeys: true, version: "1.1", schema: "yaml-1.1" });
  if (document.errors.length) throw new Error("Invalid Spec YAML/JSON");
  visit(document, { Pair(_key, pair) {
    if (isScalar(pair.key) && pair.key.source === "on" && typeof pair.key.value === "boolean") pair.key = new Scalar("on");
  } });
  const root = mapping(document.toJS({ maxAliasCount: 100 }), "Spec");
  return root;
}

export function parseSpec(source: string, options: { allowExternal?: boolean; modulePreparation?: boolean } = {}): Spec {
  const root = parseYamlMapping(source);
  if (root.expression_engine !== undefined && root.expression_engine !== "cel-v1") throw new Error("expression_engine: only cel-v1 is supported");
  if (has(root, "prepare") || has(root, "master-flow")) throw new Error("Root prepare/master-flow removed; use entries.master_flow and pipeline prepare");
  validateTemplates(root);
  const workloads = mapping(defaultValue(root.workloads, {}), "workloads");
  const routines = mapping(defaultValue(root.routines, {}), "routines");
  const pipelines = mapping(defaultValue(root.pipeline, {}), "pipeline");

  function common(item: Record<string, unknown>, label: string, nodeScope = false): void {
    if (has(item, "ignore_error") && typeof item.ignore_error !== "boolean") throw new Error(`${label}.ignore_error must be boolean`);
    if (item.context !== undefined) {
      renderedMapping(item.context, label + ".context");
      if (!templateValue(item.context)) {
        const context = mapping(item.context);
        if (nodeScope) nodeContextValues(context, label + ".context");
        else if (["CreationSpace", "Session", "Request", "__mu_expression_engine"].some(key => has(context, key))) throw new Error(`${label}.context cannot override captured Registry scopes`);
      }
    }
    for (const key of ["skip_if", "precondition", "postcondition"]) condition(item[key], label + "." + key);
  }

  function actions(value: unknown, label: string, allowWorkload = false, allowEnsure = false): void {
    list(defaultValue(value, []), label).forEach((raw, index) => {
      const item = mapping(raw, `${label}[${index}]`);
      const path = `${label}[${index}]`;
      common(item, path);
      if (has(item, "action") || has(item, "save_response_to_context")) throw new Error(`${path}: removed action declaration key`);
      const type = item.type;
      if (has(item, "save_state")) throw new Error(`${path}.save_state was removed; use save_to`);
      if (has(item, "save_to")) {
        if (!["execute_workload", "execute_command", "send_http_request", "send_notification", "inspect_file", "execute_routine", "report_request", "report_node", "upload_artifact", "download_artifact", "parallel"].includes(String(type))) throw new Error(`${path}: save_to not supported`);
        text(item.save_to, path + ".save_to");
      }
      if (type === "parallel" || type === "installation_group") {
        actions(item.actions, path + ".actions");
      } else if (type === "ensure_workload") {
        if (!allowEnsure) throw new Error(`${path}: ensure_workload only allowed in pipeline prepare`);
        const name = literalName(item.workload, path + ".workload");
        if (!has(workloads, name)) throw new Error(`${path}: undefined workload ${name}`);
        if (Object.keys(item).some(key => !["type", "workload", "context", "skip_if", "precondition", "postcondition", "ignore_error"].includes(key))) throw new Error(`${path}: unsupported ensure_workload property`);
      } else if (type === "execute_workload" || type === "execute_routine") {
        const key = type === "execute_workload" ? "workload" : "routine";
        const name = literalName(item[key], path + "." + key);
        if (type === "execute_workload" && !allowWorkload) throw new Error(`${path}: execute_workload only allowed in node before_run/run/after_run`);
        if (!has(type === "execute_workload" ? workloads : routines, name)) throw new Error(`${path}: undefined ${key} ${name}`);
        if (type === "execute_workload") {
          if (has(item, "args")) throw new Error(`${path}.args was removed; use with for the Workload CEL context`);
          renderedMapping(defaultValue(item.with, {}), path + ".with");
        }
        else {
          if (has(item, "args") || has(item, "inputs")) throw new Error(`${path}: invoke Routine with with`);
          renderedMapping(defaultValue(item.with, {}), path + ".with");
        }
      } else if (type === "execute_command") {
        text(item.target, path + ".target"); renderedList(defaultValue(item.args, []), path + ".args"); renderedMapping(defaultValue(item.env, {}), path + ".env");
      } else if (type === "create_dir" || type === "write_json") text(item.path, path + ".path");
      else if (type === "report_request" || type === "report_node") {
        if (has(item, "request_status") || has(item, "request_events")) throw new Error(`${path}: use report_request with status/events for request reporting`);
        if (has(item, "status")) throw new Error(`${path}.status is owned by the worker`);
        if (has(item, "events")) renderedList(item.events, path + ".events");
      } else if (type === "upload_artifact" || type === "download_artifact") {
        if (type === "upload_artifact") {
          text(item.artifact_id, path + ".artifact_id");
          if (has(item, "node_name")) throw new Error(`${path}.node_name was removed from artifact uploads`);
        }
        else if (!has(item, "artifact")) throw new Error(`${path}.artifact is required`);
        text(item.target, path + ".target");
      } else if (type === "inspect_file") text(item.target, path + ".target");
      else if (type === "send_notification") {
        text(item.title, path + ".title"); text(item.message, path + ".message");
        if (has(item, "tags") && typeof item.tags !== "string") throw new Error(`${path}.tags must be a string`);
      }
      else if (type === "send_http_request") {
        text(item.url, path + ".url"); renderedMapping(defaultValue(item.header, {}), path + ".header");
        if (has(item, "body") && has(item, "body_file")) throw new Error(`${path}: body and body_file are mutually exclusive`);
        for (const key of ["body_file", "response_file"]) if (has(item, key)) text(item[key], path + "." + key);
        if (has(item, "timeout") && !templateValue(item.timeout) && (typeof item.timeout !== "number" || !Number.isFinite(item.timeout) || item.timeout <= 0)) throw new Error(`${path}.timeout must be positive`);
      } else throw new Error(`${path}: unknown action type`);
    });
  }

  function events(value: unknown, label: string, nodeScope = false): void {
    for (const raw of list(defaultValue(value, []), label)) {
      const hook = mapping(raw, label);
      const allowed = nodeScope ? ["node_started", "node_finished"] : ["node_started", "node_finished", "pipeline_started", "pipeline_finished"];
      if (!allowed.includes(String(hook.on))) throw new Error(`${label}: invalid event name`);
      actions(list(hook.do, label + ".do"), label + ".do");
    }
  }

  for (const [name, raw] of Object.entries(workloads)) {
    literalName(name, "workload name");
    if (registryReference(raw)) { if (!options.allowExternal) throw new Error(`workloads.${name}: registry workload requires resolution`); continue; }
    const item = mapping(raw, "workload " + name);
    if (has(item, "source")) {
      validateWorkloadSource(item, `workloads.${name}`);
      if (!options.allowExternal) throw new Error(`workloads.${name}: external workload requires resolution`);
      continue;
    }
    if (has(item, "installation")) throw new Error("installation belongs to a workload module, not an inline declaration");
    if (has(item, "sha256")) throw new Error(`workloads.${name}.sha256 requires source`);
    inputs(item, `workloads.${name}`);
    if (has(item, "outputs")) validateFields(item.outputs, `workloads.${name}.outputs`);
    if (has(item, "args")) throw new Error(`workloads.${name}.args was removed; use argv`);
    text(item.target, `workloads.${name}.target`);
    renderedList(defaultValue(item.argv, []), `workloads.${name}.argv`); renderedList(defaultValue(item.device_args, []), `workloads.${name}.device_args`);
    renderedMapping(defaultValue(item.env, {}), `workloads.${name}.env`);
    if (item.units !== undefined && (typeof item.units !== "number" || !Number.isFinite(item.units) || item.units < 0)) throw new Error(`workloads.${name}.units must be finite and non-negative`);
  }
  const routineEdges = new Map<string, string[]>();
  for (const [name, raw] of Object.entries(routines)) {
    literalName(name, "routine name");
    const item = mapping(raw, "routine " + name);
    inputs(item, `routines.${name}`);
    if (has(item, "returns")) throw new Error("Routine returns was removed; use outputs");
    if (has(item, "outputs")) validateFields(item.outputs, `routines.${name}.outputs`);
    const children = list(item.actions, `routines.${name}.actions`);
    actions(children, `routines.${name}.actions`);
    routineEdges.set(name, children.map(child => mapping(child)).filter(child => child.type === "execute_routine").map(child => String(child.routine)));
  }
  checkCycles(routineEdges, "routine");
  for (const [name, raw] of Object.entries(mapping(defaultValue(root.entries, {}), "entries"))) {
    if (!["direct_flow", "master_flow"].includes(name)) throw new Error("Unknown entry name");
    const entry = mapping(raw, `entries.${name}`);
    for (const phase of ["initialization", "finalization"]) actions(entry[phase], `entries.${name}.${phase}`);
  }
  events(root.events, "events");
  for (const [name, raw] of Object.entries(pipelines)) {
    const item = mapping(raw, `pipeline.${name}`);
    inputs(item, `pipeline.${name}`);
    if (has(item, "outputs")) validateFields(item.outputs, `pipeline.${name}.outputs`);
    if (item.context !== undefined) common({ context: item.context }, `pipeline.${name}`);
    actions(item.prepare, `pipeline.${name}.prepare`, false, true); events(item.events, `pipeline.${name}.events`);
    const edges = new Map<string, string[]>();
    for (const rawNode of list(defaultValue(item.nodes, []), `pipeline.${name}.nodes`)) {
      const node = mapping(rawNode, "node");
      const nodeName = literalName(node.name, "node.name");
      if (edges.has(nodeName)) throw new Error("Node names must be unique");
      const dependencies = list(defaultValue(node.depends_on, []), "depends_on").map(dependency => literalName(dependency, "depends_on"));
      edges.set(nodeName, dependencies);
      common(node, `node.${nodeName}`, true);
      inputs(node, `pipeline.${name}.nodes.${nodeName}`);
      if (has(node, "outputs")) validateFields(node.outputs, `node.${nodeName}.outputs`);
      for (const phase of ["before_run", "run", "after_run", "finally"]) actions(node[phase], `node.${nodeName}.${phase}`, phase !== "finally");
      events(node.events, `node.${nodeName}.events`, true);
    }
    checkCycles(edges, `pipeline.${name} dependency`);
  }
  validatePreparation(root, options.modulePreparation);
  return { ...root, pipeline: pipelines } as unknown as Spec;
}

function checkCycles(edges: Map<string, string[]>, label: string): void {
  const visited = new Set<string>(), visiting = new Set<string>();
  function visit(name: string): void {
    if (visiting.has(name)) throw new Error(`${label} cycle at ${name}`);
    if (visited.has(name)) return;
    if (!edges.has(name)) throw new Error(`${label}: unknown dependency ${name}`);
    visiting.add(name);
    for (const dependency of edges.get(name)!) visit(dependency);
    visiting.delete(name); visited.add(name);
  }
  for (const name of edges.keys()) visit(name);
}
