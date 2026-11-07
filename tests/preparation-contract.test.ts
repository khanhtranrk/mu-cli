import { test, expect } from "bun:test";
import cases from "./fixtures/preparation.json";
import { resolveWorkloadModules } from "../src/spec/workload-modules";
for (const entry of cases) test(`preparation contract: ${entry.name}`,async()=>{
 const result=resolveWorkloadModules(JSON.stringify({workloads:{test:{source:"/module.yaml"}},pipelines:{}}),async()=>Buffer.from(JSON.stringify(entry.module)),new AbortController().signal);
 if(entry.valid) expect((await result).spec.workloads!.test).toBeDefined(); else await expect(result).rejects.toThrow();
});
