import { object, type WorkerConfig } from "./config";
import { parseArtifacts, type ArtifactMetadata } from "./artifacts";

export interface ClaimedRequest {
  requestId: string;
  assignmentVersion: number;
  specSlug: string;
  pipelineName: string;
  payload: unknown;
  artifacts: ArtifactMetadata[];
  registryContext?: unknown;
}
export type RequestStatus = "processing" | "process_failed" | "succeeded";
export interface ReportEvent { level: "info" | "warning" | "error"; message: string; details?: object; createdAt: number }
export interface Report {
  events?: ReportEvent[];
  id: string;
  status?: RequestStatus;
  node_states?: Record<string, { status?: "queue" | "running" | "failed" | "succeeded"; reason?: string; device?: { family: string; index: number }; artifacts?: ArtifactMetadata[]; events?: ReportEvent[]; logs?: string[] }>;
}
export class ApiError extends Error {
  constructor(public readonly status: number) { super(`Data Center HTTP ${status}`); }
}

export class DataCenterClient {
  constructor(private config: WorkerConfig, private transport: typeof fetch = fetch) {}

  private async call(path: string, body?: unknown, assignment?: number): Promise<Response> {
    let response: Response;
    try {
      response = await this.transport(this.config.server + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          "Content-Type": "application/json",
          "X-Mu-Expression-Engines": "cel-v1",
          ...(assignment === undefined ? {} : { "X-Mu-Assignment-Version": String(assignment) }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
    } catch { throw new Error("Data Center connection failed; call was not retried"); }
    if (!response.ok) throw new ApiError(response.status);
    return response;
  }

  async health(): Promise<void> { await this.call("/api/health"); }
  async heartbeat(status: "online" | "offline"): Promise<void> {
    const result = object(await (await this.call("/api/units/heartbeat", {
      unitId: this.config.unitId, unitType: this.config.fake ? "bun-cpu-fake" : this.config.devices?.length ? "bun-gpu" : "bun-cpu", workingDir: this.config.workspace,
      devices: [{ family: "cpu", index: 0 }, ...(this.config.devices ?? []).map(({ family, index }) => ({ family, index }))], status,
    })).json());
    if (result.ok !== true) throw new Error("Invalid heartbeat response");
  }
  async spec(slug: string): Promise<string> { return (await this.call(`/api/specs/${encodeURIComponent(slug)}`)).text(); }
  async claim(specSlug: string, maxCount: number): Promise<ClaimedRequest[]> {
    const raw: unknown = await (await this.call("/api/requests/claim", {
      unitId: this.config.unitId, specSlug, maxCount, expressionEngine: "cel-v1",
    })).json();
    if (!Array.isArray(raw) || raw.length > maxCount) throw new Error("Invalid claim response");
    return raw.map(value => {
      const item = object(value);
      if (typeof item.requestId !== "string" || !item.requestId || item.specSlug !== specSlug ||
          typeof item.pipelineName !== "string" || !item.pipelineName ||
          !Number.isSafeInteger(item.assignmentVersion) || Number(item.assignmentVersion) < 1 || !Object.hasOwn(item, "payload")) throw new Error("Invalid claimed assignment");
      return { ...item, artifacts: parseArtifacts(item.artifacts) } as unknown as ClaimedRequest;
    });
  }
  async report(report: Report, assignment: number): Promise<void> {
    const result = object(await (await this.call("/api/requests/report", report, assignment)).json());
    if (result.ok !== true) throw new Error("Invalid report response");
  }
  async verifyAssignment(request: ClaimedRequest): Promise<void> {
    await this.report({ id: request.requestId }, request.assignmentVersion);
  }
}
