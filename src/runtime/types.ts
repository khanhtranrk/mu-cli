import type { ClaimedRequest } from "../api";
import type { ExecutionPersistence } from "../engine/checkpoint";

export interface RequestExecutor {
  readonly reporting?: "spec";
  validate?(source: string, slug: string, signal: AbortSignal): Promise<void>;
  prepare?(source: string, slug: string, signal: AbortSignal): Promise<void>;
  readonly concurrent?: boolean;
  execute(spec: string, request: ClaimedRequest, signal: AbortSignal, persistence?: ExecutionPersistence): Promise<void>;
  finalize?(failed: boolean): Promise<void>;
}
