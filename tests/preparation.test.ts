import { test, expect } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunEffects } from "../src/runtime/effects";
import { Actions } from "../src/engine/actions";
import { resolveWorkloadModules } from "../src/spec/workload-modules";
import { parseSpec } from "../src/spec/parse";
const signal = () => new AbortController().signal;
const command = (code: string) => ({type: "execute_command" as const, target: process.execPath, args: ["-e", code]});
const group = (key: string, actions: unknown[]) => ({type: "installation_group", resources: [key], actions});
async function until(predicate: () => Promise<boolean> | boolean, limit = 5000) {
  const deadline = Date.now() + limit;
  while (!await predicate()) { if (Date.now() > deadline) throw new Error("Timed out awaiting fixture"); await Bun.sleep(10); }
}
async function resolveModule(module: unknown) {
  return (await resolveWorkloadModules(JSON.stringify({workloads: {test: {source: "/module.yaml"}}, pipeline: {}}), async () => Buffer.from(JSON.stringify(module)), signal())).spec;
}
const workload = {target: "echo", argv: ["ok"]};

test("parallel groups join, isolate results and allow a free branch while another resource is held", async () => {
  const root = await mkdtemp(join(tmpdir(), "mu-groups-")); const effects = new BunEffects(undefined, () => {});
  let held = false, release!: () => void;
  const blocker = effects.withWorkloadLock(root, signal(), async () => { held = true; await new Promise<void>(r => release = r); }, {resources: ["runtime"]});
  try {
    await until(() => held);
    const spec = await resolveModule({workload, prepare: [{type:"parallel",save_to:"joined",actions:[
      group("runtime", [command(`await Bun.write(${JSON.stringify(join(root,"runtime"))},'yes')`)]),
      group("model", [{...command(`await Bun.write(${JSON.stringify(join(root,"model"))},'yes')`),save_to:"private"}]),
    ]}, group("after", [command(`await Bun.write(${JSON.stringify(join(root,"after"))},'yes')`)])]});
    const context = {sys:{cache_dir:root},session:{working_dir:root},actions:{}};
    let done = false;
    const execution = new Actions(spec,effects).run({type:"ensure_workload",workload:"test"},context,{},signal()).then(() => done=true);
    await until(() => Bun.file(join(root,"model")).exists());
    expect(done).toBe(false); expect(await Bun.file(join(root,"runtime")).exists()).toBe(false); expect(await Bun.file(join(root,"after")).exists()).toBe(false);
    release(); await blocker; await execution;
    expect(await Bun.file(join(root,"after")).exists()).toBe(true); expect(context.actions).toEqual({});
  } finally { release(); await blocker; await rm(root,{recursive:true,force:true}); }
});

test("parallel failure cancels sibling installer and releases its lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "mu-group-failure-")); const effects = new BunEffects(undefined, () => {});
  try {
    const spec = await resolveModule({workload, prepare:[{type:"parallel",actions:[
      group("slow",[command(`await Bun.write(${JSON.stringify(join(root,"pid"))},String(process.pid));await Bun.sleep(60000)`)]),
      group("fail",[command(`while(!await Bun.file(${JSON.stringify(join(root,"pid"))}).exists()) await Bun.sleep(10);process.exit(7)`)]),
    ]}]});
    await expect(new Actions(spec,effects).run({type:"ensure_workload",workload:"test"},{sys:{cache_dir:root},session:{working_dir:root}}, {},signal())).rejects.toThrow("status 7");
    const pid=Number(await readFile(join(root,"pid"),"utf8")); expect(() => process.kill(pid,0)).toThrow();
    await effects.withWorkloadLock(root,signal(),async()=>{}, {resources:["slow"]});
  } finally {await rm(root,{recursive:true,force:true});}
});

test("global fallback and scoped locks exclude each other; multi-key acquisition waits and cancels", async () => {
  const root=await mkdtemp(join(tmpdir(),"mu-gate-")); const effects=new BunEffects(undefined,()=>{});
  try {
    for (const [first,second] of [[undefined,["a"]],[["a"],undefined],[["z"],["a","z"]]] as const) {
      let held=false,entered=false,release!:()=>void;
      const owner=effects.withWorkloadLock(root,signal(),async()=>{held=true;await new Promise<void>(r=>release=r);},{resources:first ? [...first] : undefined});
      await until(()=>held); const controller=new AbortController();
      const waiter=effects.withWorkloadLock(root,controller.signal,async()=>{entered=true;},{resources:second ? [...second] : undefined});
      void waiter.catch(()=>{}); await Bun.sleep(150); expect(entered).toBe(false);
      controller.abort(new Error("cancel wait")); await expect(waiter).rejects.toThrow(); release(); await owner;
      await effects.withWorkloadLock(root,signal(),async()=>{}, {resources:["a","z"]});
    }
  } finally {await rm(root,{recursive:true,force:true});}
});

test("worker SIGKILL does not release resource until its surviving installer is stopped", async () => {
  const root=await mkdtemp(join(tmpdir(),"mu-crash-"));
  const scripts = ["pid", "pid2"].map(name => `await Bun.write(${JSON.stringify(root + "/")}+${JSON.stringify(name)},String(process.pid));await Bun.sleep(60000)`);
  const source = `import {BunEffects} from ${JSON.stringify(new URL("../src/runtime/effects.ts",import.meta.url).pathname)}; const e=new BunEffects();await e.withWorkloadLock(${JSON.stringify(root)},new AbortController().signal,()=>Promise.all(${JSON.stringify(scripts)}.map(code=>e.process([process.execPath,'-e',code],{},${JSON.stringify(root)},new AbortController().signal))),{resources:['runtime']});`;
  const owner=Bun.spawn([process.execPath,"-e",source],{stdout:"ignore",stderr:"pipe"});
  try {
    await until(async()=>await Bun.file(join(root,"pid")).exists() && await Bun.file(join(root,"pid2")).exists()); const pids=await Promise.all(["pid","pid2"].map(async name=>Number(await readFile(join(root,name),"utf8"))));
    owner.kill("SIGKILL");await owner.exited;
    await new BunEffects().withWorkloadLock(root,signal(),async()=>{for(const pid of pids) expect(()=>process.kill(pid,0)).toThrow();},{resources:["runtime"]});
  } finally {owner.kill();await owner.exited;await rm(root,{recursive:true,force:true});}
});

test("optional timeout and legacy artifacts fail clearly without stealing locks", async () => {
  const root=await mkdtemp(join(tmpdir(),"mu-timeout-")); const effects=new BunEffects(undefined,()=>{});let held=false,release!:()=>void;
  const owner=effects.withWorkloadLock(root,signal(),async()=>{held=true;await new Promise<void>(r=>release=r);});
  try {
    await until(()=>held);process.env.MU_WORKLOAD_LOCK_WAIT_MS="120";
    await expect(effects.withWorkloadLock(root,signal(),async()=>{})).rejects.toThrow("timed out");
    delete process.env.MU_WORKLOAD_LOCK_WAIT_MS;release();await owner;
    await effects.mkdir(join(root,"workload-install.lock"));
    await expect(effects.withWorkloadLock(root,signal(),async()=>{})).rejects.toThrow("Legacy");
    expect(await effects.exists(join(root,"workload-install.lock"),"folder")).toBe(true);
  } finally {delete process.env.MU_WORKLOAD_LOCK_WAIT_MS;release();await owner;await rm(root,{recursive:true,force:true});}
});

test("default lock wait survives a legitimate installation lasting more than 30 seconds", async () => {
  const root=await mkdtemp(join(tmpdir(),"mu-long-install-")); const effects=new BunEffects(undefined,()=>{}); let held=false;
  try {
    const owner=effects.withWorkloadLock(root,signal(),async()=>{held=true;await Bun.sleep(30_500);});
    await until(()=>held); const started=Date.now();
    await effects.withWorkloadLock(root,signal(),async()=>{expect(Date.now()-started).toBeGreaterThan(30_000);});await owner;
  } finally {await rm(root,{recursive:true,force:true});}
},35_000);

test("parallel execution isolates branch results and publishes only its own result", async()=>{
 const effects=new BunEffects();const actions=new Actions({pipeline:{}},effects);const context={session:{working_dir:process.cwd()},actions:{}};
 await actions.run({type:"parallel",save_to:"join",actions:[{...command("console.log('a')"),save_to:"a"},{...command("console.log('b')"),save_to:"b"}]},context,{},signal());
 expect(Object.keys(context.actions)).toEqual(["join"]);
});

test("new preparation actions are rejected in ordinary Spec nodes",()=>{
 expect(()=>parseSpec(JSON.stringify({pipeline:{p:{nodes:[{name:"n",run:[{type:"parallel",actions:[command("0")]}]}]}}}))).toThrow("workload-module preparation");
});

test("parallel under a single global module lock cancels sibling process requests independently",async()=>{
 const root=await mkdtemp(join(tmpdir(),"mu-parallel-global-"));
 try{
  const spec=await resolveModule({workload,prepare:[{type:"parallel",actions:[
   command(`await Bun.write(${JSON.stringify(join(root,"pid"))},String(process.pid));await Bun.sleep(60000)`),
   command(`while(!await Bun.file(${JSON.stringify(join(root,"pid"))}).exists())await Bun.sleep(10);process.exit(8)`),
  ]}]});
  await expect(new Actions(spec,new BunEffects()).run({type:"ensure_workload",workload:"test"},{sys:{cache_dir:root},session:{working_dir:root}}, {},signal())).rejects.toThrow("status 8");
  const pid=Number(await readFile(join(root,"pid"),"utf8"));expect(()=>process.kill(pid,0)).toThrow();
 }finally{await rm(root,{recursive:true,force:true});}
});
