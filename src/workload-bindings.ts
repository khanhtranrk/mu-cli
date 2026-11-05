import { jsonValue } from "./spec/expressions";
import { mapping, type Context } from "./spec/types";

export interface BindingFlags { with?: string[]; withJson?: string[] }
function validKey(key: string): void {
  if (!key.trim() || ["__proto__", "prototype", "constructor", "__mu_expression_engine"].includes(key)) throw new Error(`Invalid binding key: ${key}`);
}
/** CLI data is literal; only module-owned Field expressions are evaluated. */
export function workloadBindings(flags: BindingFlags, file: unknown = {}): Context {
  const base = mapping(jsonValue(file), "--with-file JSON root");
  for (const key of Object.keys(base)) validKey(key);
  const result: Context = { ...base }, seen = new Set<string>();
  for (const [items, json] of [[flags.with ?? [], false], [flags.withJson ?? [], true]] as const) {
    for (const item of items) {
      const split = item.indexOf("=");
      if (split < 0) throw new Error("Bindings require key=value");
      const key = item.slice(0, split), raw = item.slice(split + 1);
      validKey(key);
      if (seen.has(key)) throw new Error(`Duplicate binding flag: ${key}`);
      seen.add(key);
      let value: unknown = raw;
      if (json) {
        try { value = JSON.parse(raw); } catch { throw new Error(`--with-json ${key}: invalid JSON`); }
      }
      result[key] = jsonValue(value);
    }
  }
  return mapping(jsonValue(result), "workload bindings");
}
