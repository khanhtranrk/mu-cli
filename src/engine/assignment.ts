import { AsyncLocalStorage } from "node:async_hooks";

export const assignmentContext = new AsyncLocalStorage<{ requestId: string; assignmentKey: string }>();

export function assignmentKey(requestId: unknown): string | undefined {
  const assignment = assignmentContext.getStore();
  return assignment && assignment.requestId === requestId ? assignment.assignmentKey : undefined;
}
