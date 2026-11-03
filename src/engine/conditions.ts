import { isDeepStrictEqual } from "node:util";
import { render } from "../spec/expressions";
import { mapping, type Condition, type Context, type States } from "../spec/types";
import type { Effects } from "./ports";
import { argumentText } from "./argv";

export async function condition(item: Condition | undefined | null, context: Context, states: States, effects: Effects, signal: AbortSignal): Promise<boolean> {
  if (item == null) return true;
  let expected: unknown = item.expected ?? true;
  if (Object.hasOwn(item, "expected")) expected = item.expected;
  let value: unknown;
  const cwd = String(mapping(context.session).working_dir);
  switch (item.operator) {
    case "and":
    case "or": {
      value = item.operator === "and";
      for (const child of item.props ?? []) {
        const result = await condition(child, context, states, effects, signal);
        if (item.operator === "and" && !result) { value = false; break; }
        if (item.operator === "or" && result) { value = true; break; }
      }
      break;
    }
    case "cel":
      value = render(item.expression, context);
      if (typeof value !== "boolean" || typeof expected !== "boolean") throw new Error("CEL condition must evaluate to boolean");
      break;
    case "file_exists":
    case "folder_exists":
    case "path_exists":
      value = await effects.exists(effects.path(String(render(item.path, context)), cwd), item.operator === "file_exists" ? "file" : item.operator === "folder_exists" ? "folder" : "path");
      break;
    case "exit_code": {
      const argv = render(item.target, context);
      if (!Array.isArray(argv) || !argv.length) throw new Error("exit_code.target must be a nonempty argv list");
      expected = item.expected ?? 0;
      if (typeof expected !== "number" || !Number.isInteger(expected)) throw new Error("exit_code.expected must be an integer");
      try { value = (await effects.process(argv.map(value => argumentText(value)), {}, cwd, signal)).returncode; }
      catch { signal.throwIfAborted(); return false; }
      break;
    }
    case "action_state":
    case "node_state": {
      const keys = render(item.target, context);
      if (!Array.isArray(keys) || !keys.length || !keys.every(key => typeof key === "string" && key)) throw new Error("State condition requires nonempty string keys");
      value = context[item.operator === "action_state" ? "actions" : "node"] ?? {};
      for (const key of keys) {
        if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, key)) return false;
        value = (value as Context)[key];
      }
      break;
    }
    case "node_status":
      value = states[item.node ?? String(mapping(context.node ?? {}).name ?? "")];
      expected = item.expected ?? "success";
      if (expected === "succeeded") expected = "success";
      break;
    default: throw new Error("Unknown condition operator");
  }
  return isDeepStrictEqual(value, expected);
}
