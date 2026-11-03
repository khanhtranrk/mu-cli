import { jsonValue, render } from "../spec/expressions";
import { mapping, type Context, type Parameters } from "../spec/types";

export function paramsFor(schema: Parameters = {}, supplied: unknown, context: Context, label: string): Context {
  const input = mapping(supplied, label + " args");
  const result: Context = {};
  for (const [name, declaration] of Object.entries(schema)) {
    const provided = Object.hasOwn(input, name);
    if (!provided && !Object.hasOwn(declaration, "default")) throw new Error(`${label} requires parameter ${name}`);
    const value = provided ? jsonValue(input[name]) : render(declaration.default, context);
    const kind = declaration.type;
    const valid = kind === undefined || (kind === "array" ? Array.isArray(value) : kind === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) : typeof value === kind);
    if (!valid) throw new Error(`${label}.${name} must be ${kind}`);
    result[name] = value;
  }
  for (const name of Object.keys(input)) if (!Object.hasOwn(schema, name)) throw new Error(`${label}: unknown parameter ${name}`);
  return result;
}

export function requestScopes(context: Context, captured: unknown = {}): void {
  const snapshots = mapping(captured, "registryContext");
  for (const scope of ["CreationSpace", "Session", "Request"]) context[scope] = { Registry: structuredClone(mapping(snapshots[scope] === undefined ? {} : snapshots[scope], `registryContext.${scope}`)) };
}
