/** Run against the actual release artifact, without Bun or other tools on PATH. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const binary = resolve(process.argv[2] ?? (() => { throw new Error("Usage: bun scripts/smoke-compiled.ts <binary>"); })());
const root = await mkdtemp(join(tmpdir(), "mu-compiled-smoke-"));
const emptyPath = join(root, "empty-path"); await mkdir(emptyPath);
const env = { ...process.env, PATH: emptyPath, XDG_CACHE_HOME: root, MU_WORKLOAD_LOCK_WAIT_MS: "5000" };
const children = new Set<ReturnType<typeof Bun.spawn>>();
function spawn(args: string[]) {
  const child = Bun.spawn([binary, ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  children.add(child); void child.exited.then(() => children.delete(child)); return child;
}
async function outcome(child: ReturnType<typeof spawn>) {
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}
async function moduleFile(name: string, prepare: unknown[], installation?: unknown) {
  const path = join(root, name + ".yaml");
  await Bun.write(path, JSON.stringify({ ...(installation ? { installation } : {}), prepare,
    workload: { target: "/bin/echo", units: 0, argv: ["compiled-ok"], outputs: { message: { type: "string", value: "${{ result.stdout }}" } } } }));
  return path;
}
const marker = (path: string) => ({type:"execute_command", target:"/bin/sh", args:["-c", 'printf ready > "$1"', "installer", path]});
async function success(path: string) {
  const result = await outcome(spawn(["workload", "exec", path, "--json"]));
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {success:true, outputs:{message:"compiled-ok\n"}});
  assert(!result.stderr.includes("too many arguments"));
}
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  // A bounded test must fail instead of leaving a broken release job hanging.
  timer = setTimeout(() => { for (const child of children) child.kill("SIGKILL"); }, 20_000);
  const help = await outcome(spawn(["--help"])); assert.equal(help.code, 0); assert(help.stdout.includes("workload"));
  const sequential = join(root,"sequential-ready");
  await success(await moduleFile("sequential", [marker(sequential)]));
  assert.equal(await readFile(sequential,"utf8"),"ready");
  const left = join(root,"left-ready"), right = join(root,"right-ready");
  await success(await moduleFile("parallel", [{type:"parallel", actions:[
    {type:"installation_group", resources:["compiled-left"], actions:[marker(left)]},
    {type:"installation_group", resources:["compiled-right"], actions:[marker(right)]},
  ]}]));
  assert.equal(await readFile(left,"utf8"),"ready"); assert.equal(await readFile(right,"utf8"),"ready");
  const pidFile = join(root,"installer-pid");
  const slow = await moduleFile("cancel", [{type:"execute_command",target:"/bin/sh",args:["-c",'printf "%s" "$$" > "$1"; exec /bin/sleep 60',"installer",pidFile]}], {resources:["compiled-cancel"]});
  const child=spawn(["workload","exec",slow,"--json"]);
  const result=outcome(child);
  const deadline=Date.now()+5000;
  while(!await Bun.file(pidFile).exists()) { assert(Date.now()<deadline,"Compiled installer did not start"); await Bun.sleep(10); }
  const pid=Number(await readFile(pidFile,"utf8"));
  child.kill("SIGINT"); const cancelled=await result;
  assert.equal(cancelled.code,130,cancelled.stdout+cancelled.stderr); assert.equal(JSON.parse(cancelled.stdout).success,false);
  assert.throws(()=>process.kill(pid,0),"Installer survived cancellation");
  await success(await moduleFile("after-cancel", [marker(join(root,"after-cancel-ready"))], {resources:["compiled-cancel"]}));
  console.log("Compiled release smoke passed: help, sequential/parallel preparation, cancellation and lock reuse; PATH contains no Bun.");
} finally {
  if(timer) clearTimeout(timer);
  for(const child of children) child.kill("SIGKILL");
  await Promise.allSettled([...children].map(child=>child.exited));
  await rm(root,{recursive:true,force:true});
}
