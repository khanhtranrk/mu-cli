/** Dedicated lock owner: parent EOF cancels and joins installers before releasing locks. */
import { dlopen, read } from "bun:ffi";
import { open, mkdir, realpath, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { BunEffects } from "./effects";

if (import.meta.main) {
  const controller = new AbortController();
  const active = new Set<Promise<void>>();
  const calls = new Map<number, AbortController>();
  let acquired = false;
  const files: Awaited<ReturnType<typeof open>>[] = [];
  const send = (value: unknown) => { if (!controller.signal.aborted) process.stdout.write(JSON.stringify(value) + "\n"); };
  const input = createInterface({ input: process.stdin });
  const iterator = input[Symbol.asyncIterator]();
  const abort = () => controller.abort(new Error("Installation owner disconnected"));
  input.on("close", abort);
  process.stdout.on("error", abort);
  process.stdin.on("error", abort);
  process.on("SIGTERM", abort);
  process.on("SIGINT", abort);
  let library: ReturnType<typeof dlopen> | undefined;
  try {
    const first = await iterator.next();
    if (first.done) throw new Error("Missing installation lock configuration");
    const config = JSON.parse(first.value);
    if (!["linux", "darwin"].includes(process.platform)) throw new Error("Workload installation locks currently require Linux or macOS on a local filesystem");
    library = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
      flock: { args: ["i32", "i32"], returns: "i32" },
      [process.platform === "darwin" ? "__error" : "__errno_location"]: { args: [], returns: "ptr" },
    });
    const flock = library.symbols.flock! as unknown as (fd: number, operation: number) => number;
    await mkdir(config.cacheDir, { recursive: true });
    const cache = await realpath(config.cacheDir);
    try {
      await lstat(join(cache, "workload-install.lock"));
      throw new Error("Legacy workload-install.lock exists. Stop older workers and inspect its owner before removing a confirmed stale lock; mixed-version installers are unsupported.");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const root = join(cache, ".workload-locks");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const started = Date.now(); let lastNotice = 0;
    const acquire = async (name: string, shared: boolean, label: string) => {
      const file = await open(join(root, name), "a+", 0o600); files.push(file);
      while (true) {
        controller.signal.throwIfAborted();
        if (flock(file.fd, (shared ? 1 : 2) | 4) === 0) return;
        const errnoPointer = (library!.symbols[process.platform === "darwin" ? "__error" : "__errno_location"] as unknown as () => number)();
        const errno = read.i32(errnoPointer);
        if (![11, 35, 4].includes(errno)) throw new Error(`OS installation lock failed (errno ${errno})`);
        const elapsed = Date.now() - started;
        if (config.waitMs !== undefined && elapsed >= config.waitMs) throw new Error(`Workload installation lock wait timed out after ${config.waitMs}ms (${label})`);
        if (!lastNotice || Date.now() - lastNotice >= 5000) {
          send({ warning: `Waiting for workload preparation: ${config.workload ?? "workload"}; resource=${label}; elapsed=${elapsed}ms` }); lastNotice = Date.now();
        }
        await new Promise<void>(resolve => { const timer = setTimeout(done, 100); function done() { clearTimeout(timer); controller.signal.removeEventListener("abort", done); resolve(); } controller.signal.addEventListener("abort", done, { once: true }); if (controller.signal.aborted) done(); });
      }
    };
    // Consume parent input concurrently so EOF cancels even during lock acquisition.
    const commands = (async () => {
      for await (const line of { [Symbol.asyncIterator]: () => iterator }) {
        const message = JSON.parse(line);
        if (message.type === "cancel") { calls.get(message.id)?.abort(new Error("Installer branch cancelled")); continue; }
        if (!acquired) throw new Error("Installation command received before lock acquisition");
        if (message.type !== "process") throw new Error("Invalid installation supervisor command");
        const call = new AbortController(); calls.set(message.id, call);
        const task = (async () => {
          try {
            const result = await new BunEffects().process(message.argv, message.env, message.cwd, AbortSignal.any([controller.signal, call.signal]));
            send({ id: message.id, result });
          } catch (error) { send({ id: message.id, error: error instanceof Error ? error.message : "Installer failed" }); }
        })();
        active.add(task); void task.finally(() => { active.delete(task); calls.delete(message.id); });
      }
      abort();
    })();
    // Observe input errors without leaving acquisition running forever.
    void commands.catch(abort);
    await acquire("gate", Boolean(config.resources), "cache gate");
    for (const resource of [...(config.resources ?? [])].sort()) {
      await acquire(createHash("sha256").update(resource).digest("hex"), false, resource);
    }
    controller.signal.throwIfAborted(); acquired = true; send({ ready: true });
    await commands;
  } catch (error) {
    if (!controller.signal.aborted) { send({ error: error instanceof Error ? error.message : "Installation supervisor failed" }); process.exitCode = 1; }
  } finally {
    abort(); input.close(); process.stdin.destroy();
    await Promise.allSettled(active);
    for (const file of files.reverse()) await file.close();
    library?.close();
  }
}
