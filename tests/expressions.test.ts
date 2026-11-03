import { expect, test } from "bun:test";
import vectors from "./fixtures/cel-v1.json";
import { jsonValue, render, validateTemplates } from "../src/spec/expressions";
import { parseSpec } from "../src/spec/parse";
import { paramsFor } from "../src/engine/context";
import { argumentText } from "../src/engine/argv";

for (const item of vectors.cases) test(`CEL conformance: ${item.name}`, () => {
  if ("error" in item) expect(() => render(item.template, vectors.context)).toThrow();
  else expect(render(item.template, vectors.context)).toEqual(item.expected);
});

test("CEL render limits remain distinct from whole Spec syntax work", () => {
  expect(() => validateTemplates(Array.from({ length: 300 }, () => "${{ params.value }}"))).not.toThrow();
  expect(() => render(Array.from({ length: 193 }, () => "${{ 1 }}"), {})).toThrow("limit");
  expect(() => validateTemplates(Array.from({ length: 4097 }, () => "${{ 1 }}"))).toThrow("limit");
  expect(() => validateTemplates({ "${{ params.a + }}": 1 })).toThrow();
  expect(() => render("${{ [1].filter(x,true) }}", {})).toThrow();
  expect(() => jsonValue(JSON.parse('{"__proto__": 1}'))).toThrow();
});

test("payload keys render recursively, structural keys stay literal, and collisions fail", () => {
  const context = { params: { key: "dynamic", value: { ok: true } } };
  expect(render({ "${{ params.key }}": "${{ params.value }}" }, context)).toEqual({ "${{ params.key }}": { ok: true } });
  expect(render({ "${{ params.key }}": "${{ params.value }}" }, context, true)).toEqual({ dynamic: { ok: true } });
  expect(() => render({ dynamic: 1, "${{ params.key }}": 2 }, context, true)).toThrow("duplicate");
  expect(() => render({ "${{ 1 }}": 1 }, context, true)).toThrow();
});

test("parameter resolution is strict, defaults use caller context, supplied values stay literal", () => {
  expect(paramsFor({ value: { type: "string" }, count: { type: "number", default: "${{ params.count }}" } }, { value: "${{ 1 + 1 }}" }, { params: { count: 2 } }, "test")).toEqual({ value: "${{ 1 + 1 }}", count: 2 });
  expect(() => paramsFor({ n: { type: "number" } }, { n: true }, {}, "test")).toThrow();
  expect(() => paramsFor({ n: { type: "number" } }, { n: "1" }, {}, "test")).toThrow();
  expect(() => paramsFor({ n: { type: "string" } }, {}, {}, "test")).toThrow("requires");
  expect(() => paramsFor({}, { extra: 1 }, {}, "test")).toThrow("unknown");
  expect(() => paramsFor({ a: { default: 1 }, b: { default: "${{ params.a }}" } }, {}, {}, "test")).toThrow();
});

test("argv conversion preserves legacy JSON boolean/null/collection text", () => {
  expect([true, false, null, { enabled: true }, [1, "two", null]].map(value => argumentText(value))).toEqual(["True", "False", "None", "{'enabled': True}", "[1, 'two', None]"]);
});

test("Spec validation accepts JSON/YAML and empty pipelines", () => {
  expect(parseSpec("pipeline: {p: {nodes: []}}").pipeline.p?.nodes).toEqual([]);
  expect(parseSpec('{"pipeline":{"p":{"nodes":[]}}}').pipeline.p?.nodes).toEqual([]);
  expect(() => parseSpec("pipeline: {}\npipeline: {}\n")).toThrow();
  expect(() => parseSpec("expression_engine: python-format-v1\npipeline: {}")).toThrow("cel-v1");
  expect(() => parseSpec("prepare: []")).toThrow("removed");
});

test("YAML preserves legacy scalar resolution, merge keys and literal lifecycle on keys", () => {
  const spec = parseSpec("defaults: &defaults\n  params: {enabled: {type: boolean, default: yes}}\nevents:\n  - on: pipeline_started\n    do: []\npipeline:\n  p:\n    <<: *defaults\n    nodes: []\n");
  expect(spec.events?.[0]?.on).toBe("pipeline_started");
  expect(spec.pipeline.p?.params?.enabled?.default).toBe(true);
});

test("declarations reject graph cycles, routine cycles, invalid hooks and workload placement before side effects", () => {
  const parse = (spec: unknown) => parseSpec(JSON.stringify(spec));
  expect(() => parse({ pipeline: { p: { nodes: [{ name: "a", depends_on: ["b"] }, { name: "b", depends_on: ["a"] }] } } })).toThrow("cycle");
  expect(() => parse({ pipeline: { p: { nodes: [{ name: "a", depends_on: ["missing"] }] } } })).toThrow("unknown");
  expect(() => parse({ routines: { r: { actions: [{ type: "execute_routine", routine: "r" }] } } })).toThrow("cycle");
  expect(() => parse({ workloads: { w: { target: "bun" } }, routines: { r: { actions: [{ type: "execute_workload", workload: "w" }] } } })).toThrow("only allowed");
  expect(() => parse({ events: [{ on: "action", do: [] }] })).toThrow("event");
  expect(() => parse({ pipeline: { p: { nodes: [{ name: "a", events: [{ on: "pipeline_started", do: [] }] }] } } })).toThrow("event");
  expect(() => parse({ pipeline: { p: { nodes: [{ name: "a", run: { workload: "w" } }] } } })).toThrow("list");
  expect(() => parse({ pipeline: { p: { context: { Request: {} } } } })).toThrow("Registry");
  expect(() => parse({ pipeline: { p: { nodes: [{ name: "a", precondition: { operator: "not" } }] } } })).toThrow("operator");
});

test("HTTP header and timeout whole-value templates validate without runtime inputs", () => {
  expect(() => parseSpec(JSON.stringify({ pipeline: { p: { nodes: [{ name: "n", run: [{ type: "send_http_request", url: "${{ params.url }}", header: "${{ params.headers }}", timeout: "${{ params.timeout }}" }] }] } } }))).not.toThrow();
});

test("explicit null action lists, args and schemas do not silently become defaults", () => {
  for (const value of [
    { pipeline: null }, { events: null }, { pipeline: { p: { params: null } } },
    { pipeline: { p: { nodes: [{ name: "n", run: null }] } } },
    { pipeline: { p: { nodes: [{ name: "n", run: [{ type: "execute_command", target: "bun", args: null }] }] } } },
  ]) expect(() => parseSpec(JSON.stringify(value))).toThrow();
});
