import {test,expect} from "bun:test";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {Worker} from "../src/worker";
import {DataCenterClient} from "../src/api";

test("a successful heartbeat after a transient failure permits the next claim without replaying the Request",async()=>{
 const workspace=await mkdtemp(join(tmpdir(),"mu-heartbeat-regression-"));
 const controller=new AbortController();let online=0,claims=0,executions=0;
 const config={server:"http://localhost:3211",token:"secret",unitId:"cpu",specs:["demo"],workspace,maxClaim:1,pollInterval:.005,heartbeatInterval:.005,fake:true};
 const transport=(async(url:any,init:any)=>{
  const path=new URL(String(url)).pathname;const body=init.body?JSON.parse(init.body):{};
  if(path.endsWith("heartbeat")&&body.status==="online"){
   online++;if(online===2)throw Object.assign(new Error("private transport message"),{code:"ECONNRESET"});
  }
  if(path.endsWith("claim")){
   claims++;if(claims>1){controller.abort();return Response.json([]);}
   return Response.json([{requestId:"r1",assignmentVersion:1,specSlug:"demo",pipelineName:"cpu",payload:{},artifacts:[]}]);
  }
  if(path.startsWith("/api/specs/"))return new Response("pipelines: {cpu: {nodes: []}}");
  return Response.json({ok:true});
 }) as typeof fetch;
 try{
  const executor={async execute(){executions++;const deadline=Date.now()+1000;while(online<3){if(Date.now()>deadline)throw new Error("Fixture deadline");await Bun.sleep(2);}}};
  await expect(new Worker(config,new DataCenterClient(config,transport),executor).run("start",controller.signal)).resolves.toBe(130);
  expect(claims).toBe(2);expect(executions).toBe(1);
 }finally{await rm(workspace,{recursive:true,force:true});}
});

import {HeartbeatMonitor,transientHeartbeatError} from "../src/heartbeat";
import {ApiError,DataCenterConnectionError} from "../src/api";
function deferred<T=void>() {let resolve!: (value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
const networkFailure=()=>new DataCenterConnectionError("POST","/api/units/heartbeat",12,Object.assign(new Error("SECRET must never appear"),{code:"ECONNRESET"}));

async function monitorFixture(send: (signal:AbortSignal)=>Promise<void>,delays:readonly number[]=[1,2,4]) {
 const controller=new AbortController(), failed=deferred(), warnings:string[]=[];
 const monitor=new HeartbeatMonitor(send,1,controller.signal,message=>{warnings.push(message);if(message.includes("heartbeat failed"))failed.resolve();},delays);
 monitor.start();await failed.promise;return {monitor,controller,warnings};
}

test("recovery pauses admission, coalesces concurrent checks and never overlaps heartbeats",async()=>{
 let calls=0,active=0,maximum=0;
 const {monitor,warnings}=await monitorFixture(async()=>{calls++;active++;maximum=Math.max(maximum,active);try{await Bun.sleep(3);if(calls<=2)throw networkFailure();}finally{active--;}});
 try{
  await Promise.all([monitor.ensureHealthy(),monitor.ensureHealthy()]);
  expect(calls).toBe(3);expect(maximum).toBe(1);expect(active).toBe(0);
  expect(warnings.filter(x=>x.includes("Worker heartbeat recovery "))).toHaveLength(2);
  expect(warnings.some(x=>x.includes("heartbeat recovered"))).toBe(true);
  expect(warnings.join("\n")).not.toContain("SECRET");
 }finally{await monitor.stop();}
});

for(const status of [408,429,500,503,599]) test(`HTTP ${status} heartbeat can recover`,async()=>{
 let calls=0;const {monitor}=await monitorFixture(async()=>{if(++calls===1)throw new ApiError(status);});
 try{await monitor.ensureHealthy();expect(calls).toBe(2);}finally{await monitor.stop();}
});

for(const error of [new ApiError(400),new ApiError(401),new ApiError(403),new Error("SECRET invalid response")])test(`permanent heartbeat failure is not retried: ${error instanceof ApiError?error.status:"invalid response"}`,async()=>{
 let calls=0;const {monitor,warnings}=await monitorFixture(async()=>{calls++;throw error;});
 try{
  await Bun.sleep(5);await expect(monitor.ensureHealthy()).rejects.toBe(error);
  expect(calls).toBe(1);expect(warnings.join("\n")).not.toContain("SECRET");
 }finally{await monitor.stop();}
});

test("exhausted recovery has a finite attempt budget and stops background work",async()=>{
 let calls=0;const error=networkFailure();const {monitor,warnings}=await monitorFixture(async()=>{calls++;throw error;});
 await expect(monitor.ensureHealthy()).rejects.toBe(error);await monitor.stop();
 expect(calls).toBe(4);expect(warnings.at(-1)).toContain("exhausted after 3 attempts");
 await Bun.sleep(5);expect(calls).toBe(4);
});

test("cancellation interrupts backoff immediately without sending another heartbeat",async()=>{
 let calls=0;const {monitor,controller}=await monitorFixture(async()=>{calls++;throw networkFailure();},[60_000]);
 try{
  const healthy=monitor.ensureHealthy();void healthy.catch(()=>{});
  await Bun.sleep(3);controller.abort(new Error("user interrupted"));
  await expect(healthy).rejects.toThrow("user interrupted");expect(calls).toBe(1);
 }finally{await monitor.stop();}
});

test("cancellation aborts an in-flight recovery heartbeat and joins it before shutdown",async()=>{
 let calls=0,aborted=false;const started=deferred();
 const {monitor,controller}=await monitorFixture(async signal=>{
  if(++calls===1)throw networkFailure();started.resolve();
  await new Promise<void>((_resolve,reject)=>{const abort=()=>{aborted=true;reject(signal.reason);};signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();});
 });
 const healthy=monitor.ensureHealthy();void healthy.catch(()=>{});await started.promise;controller.abort(new Error("cancel in flight"));
 await expect(healthy).rejects.toThrow("cancel in flight");await monitor.stop();expect(aborted).toBe(true);expect(calls).toBe(2);
});

test("permanent errors arising during recovery stay fatal",async()=>{
 let calls=0;const fatal=new ApiError(403);
 const {monitor}=await monitorFixture(async()=>{if(++calls===1)throw networkFailure();throw fatal;});
 try{await expect(monitor.ensureHealthy()).rejects.toBe(fatal);await Bun.sleep(5);await expect(monitor.ensureHealthy()).rejects.toBe(fatal);expect(calls).toBe(2);}finally{await monitor.stop();}
});

test("API connection diagnostics preserve safe method/path/time/code and never retry claim",async()=>{
 let calls=0;const token="PRIVATE_WORKER_TOKEN";
 const config={server:"http://localhost:3211",token,unitId:"cpu",specs:["demo"],workspace:"/tmp",maxClaim:1,pollInterval:1,heartbeatInterval:30,fake:true};
 const api=new DataCenterClient(config,(async()=>{calls++;throw new Error(`PRIVATE ${token}`,{cause:Object.assign(new Error("private upstream"),{code:"ECONNRESET"})});}) as typeof fetch);
 try{await api.claim("demo",1);throw new Error("Expected failure");}catch(error){
  expect(error).toBeInstanceOf(DataCenterConnectionError);
  const detail=error as DataCenterConnectionError;
  expect(detail.method).toBe("POST");expect(detail.path).toBe("/api/requests/claim");expect(detail.elapsedMs).toBeGreaterThanOrEqual(0);expect(detail.code).toBe("ECONNRESET");
  expect(detail.message).not.toContain(token);expect(detail.message).not.toContain("private upstream");expect(calls).toBe(1);
 }
});

test("API heartbeat cancellation reaches fetch and is not misclassified as network failure",async()=>{
 const controller=new AbortController(),started=deferred();let observed:AbortSignal|undefined;
 const config={server:"http://localhost:3211",token:"secret",unitId:"cpu",specs:["demo"],workspace:"/tmp",maxClaim:1,pollInterval:1,heartbeatInterval:30,fake:true};
 const api=new DataCenterClient(config,(async(_url,init)=>{observed=init!.signal!;started.resolve();return await new Promise<Response>((_r,reject)=>{observed!.addEventListener("abort",()=>reject(observed!.reason),{once:true});});}) as typeof fetch);
 const call=api.heartbeat("online",controller.signal);void call.catch(()=>{});await started.promise;
 const reason=new Error("cancel API");controller.abort(reason);await expect(call).rejects.toBe(reason);expect(observed!.aborted).toBe(true);
 expect(transientHeartbeatError(reason)).toBe(false);
});

test("a heartbeat transport failure while reading the response body is recoverable",async()=>{
 const config={server:"http://localhost:3211",token:"secret",unitId:"cpu",specs:["demo"],workspace:"/tmp",maxClaim:1,pollInterval:1,heartbeatInterval:30,fake:true};
 const api=new DataCenterClient(config,(async()=>new Response(new ReadableStream({start(controller){controller.error(Object.assign(new Error("SECRET body failed"),{code:"ECONNRESET"}));}}))) as typeof fetch);
 try{await api.heartbeat("online");throw new Error("Expected failure");}catch(error){expect(error).toBeInstanceOf(DataCenterConnectionError);expect(transientHeartbeatError(error)).toBe(true);expect((error as Error).message).not.toContain("SECRET");}
});

test("worker recovers a pending heartbeat at the batch boundary before the next claim",async()=>{
 const workspace=await mkdtemp(join(tmpdir(),"mu-heartbeat-boundary-"));
 const controller=new AbortController();const secondHeartbeat=deferred();let online=0,claims=0,executions=0,completed=false,failedAt=0,nextClaimAt=0;
 const config={server:"http://localhost:3211",token:"secret",unitId:"cpu",specs:["demo"],workspace,maxClaim:1,pollInterval:.001,heartbeatInterval:.1,fake:true};
 const transport=(async(url:any,init:any)=>{
  const path=new URL(String(url)).pathname,body=init.body?JSON.parse(init.body):{};
  if(path.endsWith("heartbeat")&&body.status==="online"){
   online++;
   if(online===2){await secondHeartbeat.promise;failedAt=Date.now();throw Object.assign(new Error("temporary"),{code:"ECONNRESET"});}
   if(online>2)expect(completed).toBe(true);
  }
  if(path.endsWith("report")&&body.status==="succeeded"){completed=true;secondHeartbeat.resolve();}
  if(path.endsWith("claim")){
   if(++claims===2){nextClaimAt=Date.now();controller.abort();return Response.json([]);}
   return Response.json([{requestId:"r1",assignmentVersion:1,specSlug:"demo",pipelineName:"cpu",payload:{},artifacts:[]}]);
  }
  if(path.startsWith("/api/specs/"))return new Response("pipelines: {cpu: {nodes: []}}");
  return Response.json({ok:true});
 }) as typeof fetch;
 try{
  const executor={async execute(){executions++;const deadline=Date.now()+1000;while(online<2){if(Date.now()>deadline)throw new Error("Fixture deadline");await Bun.sleep(2);}}};
  expect(await new Worker(config,new DataCenterClient(config,transport),executor).run("start",controller.signal)).toBe(130);
  expect(claims).toBe(2);expect(executions).toBe(1);expect(nextClaimAt-failedAt).toBeGreaterThanOrEqual(900);
 }finally{controller.abort();secondHeartbeat.resolve();await rm(workspace,{recursive:true,force:true});}
});

test("a permanent heartbeat error stops the worker before another claim and retains its HTTP status",async()=>{
 const workspace=await mkdtemp(join(tmpdir(),"mu-heartbeat-fatal-"));let online=0,claims=0,executions=0,offline=0;
 const config={server:"http://localhost:3211",token:"secret",unitId:"cpu",specs:["demo"],workspace,maxClaim:1,pollInterval:.005,heartbeatInterval:.005,fake:true};
 const api=new DataCenterClient(config,(async(url:any,init:any)=>{
  const path=new URL(String(url)).pathname,body=init.body?JSON.parse(init.body):{};
  if(path.endsWith("heartbeat")){if(body.status==="online"&&++online>1)return new Response(null,{status:403});if(body.status==="offline")offline++;}
  if(path.endsWith("claim")){claims++;return Response.json([{requestId:"r1",assignmentVersion:1,specSlug:"demo",pipelineName:"cpu",payload:{},artifacts:[]}]);}
  if(path.startsWith("/api/specs/"))return new Response("pipelines: {cpu: {nodes: []}}");
  return Response.json({ok:true});
 }) as typeof fetch);
 try{
  const executor={async execute(){executions++;const deadline=Date.now()+1000;while(online<2){if(Date.now()>deadline)throw new Error("Fixture deadline");await Bun.sleep(2);}}};
  await expect(new Worker(config,api,executor).run("start",new AbortController().signal)).rejects.toMatchObject({status:403});
  expect(claims).toBe(1);expect(executions).toBe(1);expect(online).toBe(2);expect(offline).toBe(1);
 }finally{await rm(workspace,{recursive:true,force:true});}
});

test("normal shutdown drains the online heartbeat before offline cleanup, while keeping cancellation available",async()=>{
 const started=deferred(),finish=deferred();let signal:AbortSignal|undefined,calls=0,stopped=false;
 const monitor=new HeartbeatMonitor(async current=>{calls++;signal=current;started.resolve();await finish.promise;},1,new AbortController().signal,()=>{});
 monitor.start();await started.promise;
 const stopping=monitor.stop().then(()=>{stopped=true;});await Bun.sleep(3);
 expect(stopped).toBe(false);expect(signal!.aborted).toBe(false);
 finish.resolve();await stopping;expect(stopped).toBe(true);expect(calls).toBe(1);
});
