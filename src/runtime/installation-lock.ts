import { fileURLToPath } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import type { ProcessResult } from "../engine/ports";
import { resourceKeys } from "../spec/preparation";

interface Pending { resolve(value: ProcessResult): void; reject(error: unknown): void; cleanup(): void }
interface Installer { process(argv: string[], env: Record<string, string>, cwd: string, signal: AbortSignal): Promise<ProcessResult> }
export const installationOwner = new AsyncLocalStorage<Installer>();

export async function withInstallationLock<T>(cacheDir: string, signal: AbortSignal, run: () => Promise<T>, warning: (message: string) => void, options?: { resources?: string[]; workload?: string }): Promise<T> {
  signal.throwIfAborted();
  if (installationOwner.getStore()) throw new Error("Nested installation locks are unsupported");
  if (options?.resources !== undefined) resourceKeys(options.resources);
  const raw = process.env.MU_WORKLOAD_LOCK_WAIT_MS;
  const waitMs = raw === undefined ? undefined : Number(raw);
  if (waitMs !== undefined && (!raw?.trim() || !Number.isSafeInteger(waitMs) || waitMs <= 0)) throw new Error("MU_WORKLOAD_LOCK_WAIT_MS must be a positive integer");
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("installation-supervisor.ts", import.meta.url))], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const pending = new Map<number, Pending>(); let next = 0, ready = false;
  let resolveReady!: () => void, rejectReady!: (error: unknown) => void;
  const acquired = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let stopping = false;
  const stop = () => { if (!stopping) { stopping = true; child.stdin.end(); } };
  signal.addEventListener("abort", stop, { once: true });
  const diagnostics = new Response(child.stderr).text();
  const reader = (async () => {
    try {
      for await (const line of createInterface({ input: Readable.fromWeb(child.stdout as any) })) {
        const message = JSON.parse(line);
        if (message.warning) warning(message.warning);
        else if (message.ready) { ready = true; resolveReady(); }
        else if (message.id !== undefined) {
          const call = pending.get(message.id); pending.delete(message.id); call?.cleanup();
          if (message.error) call?.reject(new Error(message.error)); else call?.resolve(message.result);
        } else if (message.error) throw new Error(message.error);
      }
      const code = await child.exited;
      if (!ready || code !== 0 || pending.size) throw new Error(`Installation supervisor exited (${code}): ${(await diagnostics).slice(0, 2000)}`);
    } catch (error) { rejectReady(error); for (const call of pending.values()) { call.cleanup(); call.reject(error); } pending.clear(); throw error; }
  })();
  // Reader may reject before acquisition is awaited; retain it for cleanup below.
  void reader.catch(() => {});
  try {
    child.stdin.write(JSON.stringify({ cacheDir, ...options, waitMs }) + "\n");
    if (signal.aborted) stop();
    await acquired; signal.throwIfAborted();
    return await installationOwner.run({ process: (argv, env, cwd, callSignal) => new Promise<ProcessResult>((resolve, reject) => {
      if (callSignal.aborted) { reject(callSignal.reason); return; }
      const id = ++next;
      const abort = () => { if (!stopping) child.stdin.write(JSON.stringify({ type: "cancel", id }) + "\n"); };
      pending.set(id, { resolve, reject: error => reject(callSignal.aborted ? callSignal.reason : error), cleanup: () => callSignal.removeEventListener("abort", abort) });
      child.stdin.write(JSON.stringify({ type: "process", id, argv, env, cwd }) + "\n");
      callSignal.addEventListener("abort", abort, { once: true });
      if (callSignal.aborted) abort();
    }) }, run);
  } finally {
    signal.removeEventListener("abort", stop); stop();
    await child.exited;
    await reader;
  }
}
