import { object, type WorkerConfig } from "./config";
import { parseArtifacts, type ArtifactMetadata } from "./artifacts";

export interface ClaimedRequest {
  workloadLock?: import("./spec/registry-reference").RegistryLock;
  requestId: string;
  assignmentVersion: number;
  specSlug: string;
  pipelineName: string;
  payload: unknown;
  inputs?: unknown;
  specYaml?: string;
  artifacts: ArtifactMetadata[];
  registryContext?: unknown;
}
export type RequestStatus = "processing" | "process_failed" | "succeeded";
export interface ReportEvent { level: "info" | "warning" | "error"; message: string; details?: object; createdAt: number }
export interface Report {
  pipelineState?: {status: string; outputs: Record<string, unknown>};
  events?: ReportEvent[];
  id: string;
  status?: RequestStatus;
  node_states?: Record<string, { status?: "queue" | "running" | "failed" | "succeeded"; reason?: string; device?: { family: string; index: number }; artifacts?: ArtifactMetadata[]; events?: ReportEvent[]; logs?: string[] }>;
}
export class ApiError extends Error {
  constructor(public readonly status: number, detail?: string) { super(detail ?? `Data Center HTTP ${status}`); }
}

const networkCodes = new Set([
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
  "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT",
  "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID", "ConnectionClosed", "ConnectionRefused", "ConnectionReset",
  "FailedToOpenSocket",
]);
function networkCode(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    const item = current as {code?: unknown; name?: unknown; cause?: unknown};
    if (item.name === "TimeoutError") return "TIMEOUT";
    if (typeof item.code === "string" && networkCodes.has(item.code)) return item.code;
    current = item.cause;
  }
  return "NETWORK_ERROR";
}
export class DataCenterConnectionError extends Error {
  readonly code: string;
  constructor(readonly method: string, readonly path: string, readonly elapsedMs: number, error: unknown) {
    const code = networkCode(error);
    super(`Data Center connection failed; call was not retried (${method} ${path}; elapsed=${elapsedMs}ms; cause=${code})`);
    this.name = "DataCenterConnectionError";
    this.code = code;
  }
}

export class DataCenterClient {
  constructor(private config: WorkerConfig, private transport: typeof fetch = fetch) {}

  private async call(path: string, body?: unknown, assignment?: number, signal?: AbortSignal): Promise<Response> {
    let response: Response;
    const method = body === undefined ? "GET" : "POST", started = Date.now();
    try {
      response = await this.transport(this.config.server + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          "Content-Type": "application/json",
          "X-Mu-Expression-Engines": "cel-v1",
          "X-Mu-Workload-Registry": "1",
          ...(assignment === undefined ? {} : { "X-Mu-Assignment-Version": String(assignment) }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
        redirect: "error",
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw new DataCenterConnectionError(method, path, Date.now() - started, error);
    }
    if (!response.ok) {
      let detail: string | undefined;
      if (response.status === 400 && ["/api/requests/claim", "/api/worker/scope"].includes(path)) {
        // Display only known server messages. Other response text may contain secrets.
        const body = await response.json().catch(() => null) as {error?: unknown} | null;
        const message = body?.error;
        if (typeof message === "string") {
          detail = ["Worker token has no active Specs to claim", "Worker token does not allow this spec", "Requested Spec is unavailable"]
            .find(candidate => message.includes(candidate));
        }
      }
      throw new ApiError(response.status, detail);
    }
    return response;
  }

  async health(): Promise<void> { await this.call("/api/health"); }
  async heartbeat(status: "online" | "offline", signal?: AbortSignal): Promise<void> {
    const started = Date.now();
    try {
      const result = object(await (await this.call("/api/units/heartbeat", {
        unitId: this.config.unitId, unitType: this.config.fake ? "bun-cpu-fake" : this.config.devices?.length ? "bun-gpu" : "bun-cpu", workingDir: this.config.workspace,
        devices: [{ family: "cpu", index: 0, maxUnits: 0 }, ...(this.config.devices ?? [])], status,
      }, undefined, signal)).json());
      if (result.ok !== true) throw new Error("Invalid heartbeat response");
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      // fetch may succeed at headers and fail later while reading the body.
      if (!(error instanceof DataCenterConnectionError) && networkCode(error) !== "NETWORK_ERROR") {
        throw new DataCenterConnectionError("POST", "/api/units/heartbeat", Date.now() - started, error);
      }
      throw error;
    }
  }
  async spec(slug: string): Promise<string> { return (await this.call(`/api/specs/${encodeURIComponent(slug)}`)).text(); }
  async scope(): Promise<string[]> {
    const result: unknown = await (await this.call("/api/worker/scope", {})).json();
    if (!Array.isArray(result) || !result.length || !result.every(slug => typeof slug === "string" && slug)) throw new Error("Invalid worker scope response");
    return result;
  }
  async claim(scope: string | string[] | undefined, maxCount: number): Promise<ClaimedRequest[]> {
    const raw: unknown = await (await this.call("/api/requests/claim", {
      unitId: this.config.unitId, ...(Array.isArray(scope) ? { specSlugs: scope } : { specSlug: scope }), maxCount, expressionEngine: "cel-v1",
    })).json();
    if (!Array.isArray(raw) || raw.length > maxCount) throw new Error("Invalid claim response");
    return raw.map(value => {
      const item = object(value);
      if (typeof item.requestId !== "string" || !item.requestId || typeof item.specSlug !== "string" || !item.specSlug || (typeof scope === "string" && item.specSlug !== scope) || (Array.isArray(scope) && !scope.includes(item.specSlug)) ||
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
