/** Preparation-only orchestration contract. Kept identical to MasterFlow's shared validator. */
type Mapping = Record<string, any>;
function object(value: unknown): value is Mapping { return value !== null && typeof value === "object" && !Array.isArray(value); }
export function resourceKeys(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 64 || value.some(key => typeof key !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(key)) || new Set(value).size !== value.length) throw new Error("resources requires 1–64 unique static resource names (letters, digits, dot, underscore, hyphen)");
  return value;
}
export function validatePreparation(spec: Mapping, module = false, installation?: unknown): { resources?: string[]; grouped: boolean } {
  let resources: string[] | undefined;
  if (installation !== undefined) {
    if (!module || !object(installation) || Object.keys(installation).some(k => k !== "resources")) throw new Error("Invalid module installation declaration");
    resources = resourceKeys(installation.resources);
  }
  const routines = spec.routines ?? {};
  const summaries = new Map<string, boolean>();
  function walk(value: unknown, preparation: boolean, parallel: boolean, group: boolean, stack: string[], guarded = false): boolean {
    if (value === undefined) return false;
    if (!Array.isArray(value)) throw new Error("actions must be a list");
    let grouped = false;
    for (const action of value) {
      if (!object(action)) throw new Error("action must be a mapping");
      if (action.type === "parallel" || action.type === "installation_group") {
        const isGroup = action.type === "installation_group";
        if (!preparation || !module) throw new Error(`${action.type} only allowed in workload-module preparation`);
        if ((isGroup && group) || (!isGroup && parallel)) throw new Error(`Nested ${action.type} is unsupported`);
        if (Object.keys(action).some(k => !["type", "actions", ...(isGroup ? ["resources"] : ["save_to"])].includes(k))) throw new Error(`Unsupported ${action.type} property`);
        if (!Array.isArray(action.actions) || !action.actions.length || action.actions.length > 64) throw new Error(`${action.type}.actions requires 1–64 actions`);
        if (isGroup) { resourceKeys(action.resources); if (resources) throw new Error("Cannot combine module installation.resources and installation_group"); }
        grouped = walk(action.actions, preparation, parallel || !isGroup, group || isGroup, stack, guarded) || grouped || isGroup;
      } else if (action.type === "execute_routine") {
        if (stack.includes(action.routine)) throw new Error("Routine cycle in preparation");
        if (!object(routines[action.routine])) throw new Error(`Undefined routine ${action.routine}`);
        // Routine conditions/context run outside its body, so require an enclosing group in guarded mode.
        if (guarded && !group && Object.keys(action).some(k => !["type", "routine", "with", "save_to"].includes(k))) throw new Error("Unguarded routine condition/context in grouped preparation");
        const key = JSON.stringify([action.routine, preparation, parallel, group, guarded]);
        if (!summaries.has(key)) summaries.set(key, walk(routines[action.routine].actions, preparation, parallel, group, [...stack, action.routine], guarded));
        grouped = summaries.get(key)! || grouped;
      } else {
        if (preparation && module && action.type === "ensure_workload") throw new Error("Nested ensure_workload is unsupported");
        if (guarded && !group) throw new Error("All grouped preparation effects must be inside installation_group");
      }
    }
    return grouped;
  }
  let grouped = false;
  for (const pipeline of Object.values(spec.pipelines ?? {}) as Mapping[]) {
    grouped = walk(pipeline.prepare, true, false, false, []) || grouped;
    for (const node of pipeline.nodes ?? []) {
      for (const phase of ["before_run", "run", "after_run", "finally"]) walk(node[phase], false, false, false, []);
      for (const hook of node.events ?? []) walk(hook.do, false, false, false, []);
    }
    for (const hook of pipeline.events ?? []) walk(hook.do, false, false, false, []);
  }
  for (const entry of Object.values(spec.entries ?? {}) as Mapping[]) for (const phase of ["initialization", "finalization"]) walk(entry[phase], false, false, false, []);
  for (const hook of spec.events ?? []) walk(hook.do, false, false, false, []);
  // Validate otherwise-unused routines too, including indirect cycles and nested scopes.
  for (const name of Object.keys(routines)) walk(routines[name].actions, module, false, false, [name]);
  if (grouped) for (const pipeline of Object.values(spec.pipelines ?? {}) as Mapping[]) walk(pipeline.prepare, true, false, false, [], true);
  return { resources, grouped };
}
