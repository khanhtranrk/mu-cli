import { mapping, type Context } from "../spec/types";

export function requestScopes(context: Context, captured: unknown = {}): void {
  const snapshots = mapping(captured, "registryContext");
  for (const scope of ["CreationSpace", "Session", "Request"]) context[scope] = { Registry: structuredClone(mapping(snapshots[scope] === undefined ? {} : snapshots[scope], `registryContext.${scope}`)) };
}
