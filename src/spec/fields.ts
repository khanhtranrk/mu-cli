import { jsonValue, render } from "./expressions";
import { mapping, type Context, type Field, type Fields } from "./types";

const types = ["string", "number", "boolean", "array", "object", "artifact"];

export function validateFields(value: unknown, label: string): void {
  for (const [name, raw] of Object.entries(mapping(value, label))) {
    const path = `${label}.${name}`;
    if (["__proto__", "constructor", "prototype"].includes(name)) throw new Error(`${path}: invalid Field name`);
    const field = mapping(raw, path);
    if (!types.includes(String(field.type))) throw new Error(`${path}.type: invalid Field type`);
    for (const key of Object.keys(field)) if (!["type", "value", "default"].includes(key)) throw new Error(`${path}.${key}: unknown Field property`);
  }
}

function validateValue(value: unknown, field: Field, path: string): unknown {
  const result = jsonValue(value);
  const valid = field.type === "array" ? Array.isArray(result)
    : field.type === "object" || field.type === "artifact" ? result !== null && typeof result === "object" && !Array.isArray(result)
    : typeof result === field.type;
  if (!valid) throw new Error(`${path} must be ${field.type}${result === null ? " (explicit null is not allowed)" : ""}`);
  return result;
}

/** Supplied data is already evaluated/literal. Only Spec-owned value/default declarations render. */
export function resolveFields(schema: Fields = {}, supplied: unknown, context: Context, label: string): Context {
  validateFields(schema, label + ".inputs");
  const input = mapping(supplied, label + " inputs");
  const result: Context = {};
  for (const name of Object.keys(input)) if (!Object.hasOwn(schema, name)) throw new Error(`${label}: unknown input ${name}`);
  for (const [name, field] of Object.entries(schema)) {
    let value: unknown;
    if (Object.hasOwn(input, name)) value = input[name];
    else if (Object.hasOwn(field, "value")) value = render(field.value, context);
    else if (Object.hasOwn(field, "default")) value = render(field.default, context);
    else throw new Error(`${label}.inputs.${name} requires an input value or default`);
    result[name] = validateValue(value, field, `${label}.inputs.${name}`);
  }
  return result;
}
