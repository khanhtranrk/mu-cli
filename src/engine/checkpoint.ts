import type { Context, States } from "../spec/types";

export interface ExecutionSnapshot {
  version: 2;
  stage: "intake" | "nodes" | "finishing" | "finished";
  pipelineName: string;
  base: Context;
  prepared?: Context;
  context: Context;
  states: States;
  nodeContexts?: Record<string, Context>;
}
export interface ExecutionPersistence {
  snapshot?: ExecutionSnapshot;
  retryIncomplete?: boolean;
  save(snapshot: ExecutionSnapshot): Promise<void>;
}
export class RecoveryError extends Error {}
