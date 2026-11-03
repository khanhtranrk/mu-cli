import type { ClaimedRequest } from "../api";

export interface RequestExecutor {
  readonly reporting?: "spec";
  prepare?(source: string, slug: string, signal: AbortSignal): Promise<void>;
  execute(spec: string, request: ClaimedRequest, signal: AbortSignal): Promise<void>;
  finalize?(failed: boolean): Promise<void>;
}
