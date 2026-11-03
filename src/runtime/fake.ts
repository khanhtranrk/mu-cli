import { object } from "../config";
import type { ClaimedRequest } from "../api";
import type { RequestExecutor } from "./types";
export type { RequestExecutor } from "./types";

export function validateEnvelope(source: string, pipelineName: string): void {
  const spec = object(Bun.YAML.parse(source));
  if (spec.expression_engine !== undefined && spec.expression_engine !== "cel-v1") throw new Error("Only cel-v1 Specs are supported");
  const pipeline = object(object(spec.pipeline)[pipelineName]);
  if (!Array.isArray(pipeline.nodes) || pipeline.nodes.length === 0) throw new Error("Pipeline requires nodes");
  const names = new Set<string>();
  for (const raw of pipeline.nodes) {
    const node = object(raw);
    if (typeof node.name !== "string" || !node.name || names.has(node.name)) throw new Error("Node names must be nonempty and unique");
    names.add(node.name);
  }
}

export class FakeExecutor implements RequestExecutor {
  async execute(source: string, request: ClaimedRequest, signal: AbortSignal): Promise<void> {
    validateEnvelope(source, request.pipelineName);
    signal.throwIfAborted();
    const process = Bun.spawn([Bun.which("bun") ?? "bun", "-e", "await Bun.sleep(10);"], {
      stdout: "ignore", stderr: "ignore", stdin: "ignore",
    });
    const abort = () => process.kill();
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) abort();
      const exitCode = await process.exited;
      signal.throwIfAborted();
      if (exitCode !== 0) throw new Error("Fake workload failed");
    } finally { signal.removeEventListener("abort", abort); }
  }
}
