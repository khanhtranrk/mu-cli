import { expect, test } from "bun:test";
import { parsePipeline } from "../src/spec/parse";

const header = "kind: pipeline\nschema_version: 1\n";

test("validates one root pipeline using its catalog name", () => {
  const parsed = parsePipeline(header + "nodes:\n  - name: first\n", "render");
  expect(Object.keys(parsed.pipelines)).toEqual(["render"]);
  expect(parsed.pipelines.render?.nodes).toEqual([{name: "first"}]);
});

test("rejects ambiguous formats and invalid pipeline dependencies", () => {
  expect(() => parsePipeline("kind: pipeline\nschema_version: 2", "render")).toThrow("schema_version");
  for (const field of ["entries", "pipelines", "pipeline"]) {
    expect(() => parsePipeline(header + field + ": {}\n", "render")).toThrow("Unknown Pipeline field");
  }
  expect(() => parsePipeline(header + "nodes:\n  - name: first\n    depends_on: [missing]\n", "render")).toThrow("unknown dependency");
});

test("resolves a pipeline and its external workload using the catalog name", async () => {
  const { resolveWorkloadModules } = await import("../src/spec/workload-modules");
  const result = await resolveWorkloadModules(
    header + 'workloads:\n  echo:\n    source: "./echo.yaml"\n',
    async () => new TextEncoder().encode("workload:\n  target: echo\n"),
    new AbortController().signal,
    undefined,
    undefined,
    "render",
  );
  expect(Object.keys(result.spec.pipelines)).toEqual(["render"]);
  expect(result.spec.workloads?.echo?.target).toBe("echo");
  expect(result.modules.map(module => module.name)).toEqual(["echo"]);
});
