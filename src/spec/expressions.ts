import { Environment, type ASTNode } from "@marcbachmann/cel-js";

const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const calls = new Set(["has", "size", "string", "int", "double", "bool"]);
const methods = new Set(["size", "contains", "startsWith", "endsWith"]);
const options = { homogeneousAggregateLiterals: false, limits: { maxAstNodes: 256, maxDepth: 32, maxListElements: 128, maxMapEntries: 128, maxCallArguments: 8 } };
type Budget = { expressions: number; nodes: number };

export function jsonValue(value: unknown, celResult = false): unknown {
  let nodes = 0;
  function visit(item: unknown, depth: number): unknown {
    if (++nodes > 4096 || depth > 16) throw new Error("JSON structure limit exceeded");
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "bigint" && celResult) {
      if (item > BigInt(Number.MAX_SAFE_INTEGER) || item < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error("Unsafe integer");
      return Number(item);
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item))) throw new Error("Unsafe JSON number");
      return item;
    }
    if (Array.isArray(item)) {
      if (item.length > 128) throw new Error("Collection limit exceeded");
      return item.map(child => visit(child, depth + 1));
    }
    if (item instanceof Map || (item && typeof item === "object" && [null, Object.prototype].includes(Object.getPrototypeOf(item)))) {
      const entries = item instanceof Map ? [...item.entries()] : Object.entries(item);
      if (entries.length > 128) throw new Error("Collection limit exceeded");
      const result: Record<string, unknown> = {};
      for (const [key, child] of entries) {
        if (typeof key !== "string" || forbidden.has(key) || key.length > 160) throw new Error("Invalid JSON map key");
        result[key] = visit(child, depth + 1);
      }
      return result;
    }
    throw new Error("Expected JSON data");
  }
  const result = visit(value, 0);
  if (new TextEncoder().encode(JSON.stringify(result)).length > 32768) throw new Error("JSON value byte limit exceeded");
  return result;
}

function celValue(value: unknown): unknown {
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (Array.isArray(value)) return value.map(celValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, celValue(child)]));
  return value;
}

function inspect(node: ASTNode, budget: Budget): void {
  if (++budget.nodes > 8192) throw new Error("CEL work limit exceeded");
  if (node.op === "call" && !calls.has(node.args[0])) throw new Error("Unsupported CEL function");
  if (node.op === "rcall" && !methods.has(node.args[0])) throw new Error("Unsupported CEL method");
  function walk(value: unknown): void {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object" && "op" in value && "args" in value) inspect(value as ASTNode, budget);
  }
  walk(node.args);
}

function closing(text: string, start: number): number {
  let depth = 0, quote = "", triple = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index]!;
    if (quote) {
      if (char === "\\") { index++; continue; }
      if (triple ? text.slice(index, index + 3) === quote.repeat(3) : char === quote) {
        if (triple) index += 2;
        quote = "";
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char; triple = text.slice(index, index + 3) === char.repeat(3);
      if (triple) index += 2;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") { while (index < text.length && text[index] !== "\n") index++; continue; }
    if (char === "{") depth++;
    else if (char === "}" && depth) depth--;
    else if (char === "}" && text[index + 1] === "}") return index;
  }
  throw new Error("Unclosed CEL template");
}

function template(text: string, evaluate: (source: string) => unknown): unknown {
  const parts: { expression: boolean; value: unknown }[] = [];
  let literal = "";
  for (let index = 0; index < text.length;) {
    const escaped = text.startsWith("$${{", index);
    if (escaped || text.startsWith("${{", index)) {
      const start = index + (escaped ? 4 : 3);
      let end: number;
      try { end = closing(text, start); }
      catch (error) { if (!escaped) throw error; literal += text.slice(index + 1); break; }
      if (escaped) literal += text.slice(index + 1, end + 2);
      else {
        if (literal) parts.push({ expression: false, value: literal });
        literal = "";
        parts.push({ expression: true, value: evaluate(text.slice(start, end).trim()) });
      }
      index = end + 2;
    } else literal += text[index++];
  }
  if (literal) parts.push({ expression: false, value: literal });
  const meaningful = parts.filter(part => part.expression || String(part.value).trim());
  if (meaningful.length === 1 && meaningful[0]!.expression) return meaningful[0]!.value;
  return parts.map(part => {
    if (!part.expression || part.value === null || ["string", "number", "boolean"].includes(typeof part.value)) return String(part.value);
    throw new Error("List/map requires a whole-value template");
  }).join("");
}

function parseExpression(source: string, environment: Environment, budget: Budget) {
  if (source.length > 2048 || ++budget.expressions > 192) throw new Error("CEL expression/work limit exceeded");
  const parsed = environment.parse(source);
  inspect(parsed.ast, budget);
  return parsed;
}

export function render(value: unknown, context: Record<string, unknown>, payloadKeys = false): unknown {
  const budget = { expressions: 0, nodes: 0 };
  const environment = Object.keys(context).reduce((current, root) => current.registerVariable(root, "dyn"), new Environment(options));
  const converted = celValue(context) as Record<string, unknown>;
  function visit(item: unknown, depth: number): unknown {
    if (depth > 64) throw new Error("Template depth limit exceeded");
    if (typeof item === "string") return template(item, source => {
      const parsed = parseExpression(source, environment, budget);
      const checked = parsed.check();
      if (!checked.valid) throw checked.error;
      return jsonValue(parsed(converted), true);
    });
    if (Array.isArray(item)) return item.map(child => visit(child, depth + 1));
    if (item && typeof item === "object") {
      const result: Record<string, unknown> = {};
      for (const [rawKey, child] of Object.entries(item)) {
        const key = payloadKeys ? visit(rawKey, depth + 1) : rawKey;
        if (typeof key !== "string" || (payloadKeys && !key.trim()) || forbidden.has(key) || Object.hasOwn(result, key)) throw new Error("Invalid or duplicate rendered payload key");
        result[key] = visit(child, depth + 1);
      }
      return result;
    }
    return item;
  }
  return visit(value, 0);
}

export function validateTemplates(value: unknown): void {
  const total = { expressions: 0, nodes: 0 };
  const environment = new Environment(options);
  function visit(item: unknown, depth: number): void {
    if (depth > 64) throw new Error("Spec syntax depth limit exceeded");
    if (typeof item === "string") {
      const budget = { expressions: 0, nodes: 0 };
      template(item, source => { parseExpression(source, environment, budget); return ""; });
      total.expressions += budget.expressions; total.nodes += budget.nodes;
      if (total.expressions > 4096 || total.nodes > 262144) throw new Error("Spec syntax work limit exceeded");
    } else if (Array.isArray(item)) item.forEach(child => visit(child, depth + 1));
    else if (item && typeof item === "object") Object.entries(item).forEach(([key, child]) => {
      if (forbidden.has(key)) throw new Error("Invalid Spec map key");
      visit(key, depth + 1); visit(child, depth + 1);
    });
  }
  visit(value, 0);
}
