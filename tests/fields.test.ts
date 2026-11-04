import { expect, test } from "bun:test";
import { resolveFields, validateFields } from "../src/spec/fields";
import { parseSpec } from "../src/spec/parse";
import type { Field } from "../src/spec/types";

const resolve = (field: Field, supplied: Record<string, unknown> = {}, context = {}) => resolveFields({ x: field }, supplied, context, "test");

for (const [type, value, wrong] of [
  ["string", "hello", 1], ["number", 2.5, "2.5"], ["boolean", false, 0],
  ["array", [1, { nested: true }], {}], ["object", { nested: [1, null] }, []],
  ["artifact", { artifactId: "opaque", metadata: { tags: [] } }, "id"],
] as const) test(`Field ${type}: strict literal, expression, override and null validation`, () => {
  const field: Field = { type, value };
  expect(resolve(field)).toEqual({ x: value });
  expect(resolve({ type, value: "${{ source }}" }, {}, { source: value })).toEqual({ x: value });
  expect(resolve({ type, value: "${{ missing }}", default: wrong }, { x: value })).toEqual({ x: value });
  expect(() => resolve({ type, value: wrong })).toThrow(`must be ${type}`);
  expect(() => resolve({ type, default: value }, { x: null })).toThrow("explicit null");
  expect(() => resolve({ type, value: "${{ null }}", default: value })).toThrow("explicit null");
  expect(resolve({ type, default: value })).toEqual({ x: value });
  expect(() => resolve({ type })).toThrow("requires");
});

test("Field presence, defaults and CEL conditionals preserve literal caller JSON", () => {
  expect(resolve({ type: "object", value: { nested: ["${{ flag ? with.name : 'fallback' }}"] } }, {}, { flag: true, with: { name: "${{ do_not_evaluate }}" } })).toEqual({ x: { nested: ["${{ do_not_evaluate }}"] } });
  expect(resolve({ type: "number", default: "${{ flag ? 10 : 20 }}" }, {}, { flag: false })).toEqual({ x: 20 });
  expect(() => resolve({ type: "string", value: "${{ with.missing }}", default: "fallback" }, {}, { with: {} })).toThrow();
  expect(() => resolve({ type: "string", value: null, default: "fallback" })).toThrow("explicit null");
  expect(resolve({ type: "object" }, { x: { nested: ["${{ missing }}", null] } })).toEqual({ x: { nested: ["${{ missing }}", null] } });
});

test("Field declaration errors include paths and reject unknown or absent types", () => {
  for (const declaration of [{}, { type: "integer" }, { type: null }, null, { type: "string", nullable: true }]) {
    expect(() => validateFields({ x: declaration }, "pipeline.p.inputs")).toThrow("pipeline.p.inputs.x");
  }
});

test("all input owners reject params with a migration path", () => {
  for (const [spec, path] of [
    [{ pipeline: { p: { params: {} } } }, "pipeline.p.params"],
    [{ pipeline: { p: { nodes: [{ name: "n", params: {} }] } } }, "pipeline.p.nodes.n.params"],
    [{ workloads: { w: { target: "bun", params: {} } } }, "workloads.w.params"],
    [{ routines: { r: { actions: [], params: {} } } }, "routines.r.params"],
  ] as const) expect(() => parseSpec(JSON.stringify(spec))).toThrow(path);
  expect(() => parseSpec(JSON.stringify({ workloads: { w: { target: "bun", args: [] } } }))).toThrow("workloads.w.args");
});
