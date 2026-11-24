import { expect, test } from "bun:test";
import fixtures from "@mu/spec/fixtures";
import { parsePipeline } from "../src/spec/parse";
import { resolveWorkloadModules } from "../src/spec/workload-modules";

for (const fixture of fixtures) {
  test(fixture.name, () => {
    const read = () => parsePipeline(fixture.source, "example");
    if (fixture.error) {
      expect(read).toThrow(fixture.error);
    } else {
      expect(read().pipelines.example?.context).toEqual(fixture.context);
    }
  });
}

test("resolving an external workload preserves Pipeline scalars", async () => {
  const source = [
    "kind: pipeline",
    "schema_version: 1",
    "context: {on: on}",
    "workloads: {external: {source: module.yaml}}",
  ].join("\n");
  const { spec } = await resolveWorkloadModules(
    source,
    async () => new TextEncoder().encode("workload: {target: echo}"),
    new AbortController().signal,
  );
  expect(spec.pipelines.pipeline?.context).toEqual({ on: "on" });
  expect(spec.workloads?.external?.target).toBe("echo");
});
