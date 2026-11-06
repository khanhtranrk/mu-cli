import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.skipIf(process.platform !== "linux" || process.arch !== "x64")("release binary runs its embedded supervisor without external Bun", async () => {
  const root = await mkdtemp(join(tmpdir(), "mu-release-regression-"));
  try {
    const binary=join(root,"mu-cli-linux-x64");
    const build=Bun.spawn([process.execPath,"build","--compile","--target=bun-linux-x64","./src/index.ts","--outfile",binary],{cwd:join(import.meta.dir,".."),stdout:"pipe",stderr:"pipe"});
    const [code,stdout,stderr]=await Promise.all([build.exited,new Response(build.stdout).text(),new Response(build.stderr).text()]);
    expect(code,stdout+stderr).toBe(0);
    const smoke=Bun.spawn([process.execPath,join(import.meta.dir,"../scripts/smoke-compiled.ts"),binary],{stdout:"pipe",stderr:"pipe"});
    const [smokeCode,smokeOut,smokeErr]=await Promise.all([smoke.exited,new Response(smoke.stdout).text(),new Response(smoke.stderr).text()]);
    expect(smokeCode,smokeOut+smokeErr).toBe(0);
    expect(smokeOut).toContain("Compiled release smoke passed");
  } finally {await rm(root,{recursive:true,force:true});}
},30_000);
