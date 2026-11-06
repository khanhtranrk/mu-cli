import { mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import type { Effects, HttpOptions, ProcessResult } from "../engine/ports";
import type { Context } from "../spec/types";

const outputLimit = 16 * 1024 * 1024;

export class BunEffects implements Effects {
  constructor(private transport: typeof fetch = fetch, private warn: (message: string) => void = console.warn) {}

  async withWorkloadLock<T>(cacheDir: string, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    // One per-user cache lock serializes arbitrary installation scripts, even across
    // different module versions/aliases that may modify the same environment.
    const parent = cacheDir, lock = join(parent, "workload-install.lock");
    await this.mkdir(parent);
    const deadline = Date.now() + 30_000;
    while (true) {
      signal.throwIfAborted();
      try { await mkdir(lock); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() >= deadline) throw new Error(`Workload installation lock is busy: ${lock}. If its owner crashed, inspect and remove the stale lock before retrying.`);
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
          const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 100);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
      }
    }
    try {
      await Bun.write(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      signal.throwIfAborted();
      return await run();
    } finally { await rm(lock, { recursive: true, force: true }); }
  }

  path(path: string, cwd: string): string {
    return resolve(cwd, path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
  }
  async exists(path: string, kind: "file" | "folder" | "path"): Promise<boolean> {
    try { const info = await stat(path); return kind === "file" ? info.isFile() : kind === "folder" ? info.isDirectory() : true; }
    catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false; throw error; }
  }
  async mkdir(path: string): Promise<void> { await mkdir(path, { recursive: true }); }
  async writeJson(path: string, value: unknown): Promise<void> {
    await this.mkdir(dirname(path));
    await Bun.write(path, JSON.stringify(value, null, 2) + "\n");
  }
  warning(message: string): void { this.warn(message); }

  async process(argv: string[], env: Record<string, string>, cwd: string, signal: AbortSignal): Promise<ProcessResult> {
    signal.throwIfAborted();
    const child = Bun.spawn(argv, { cwd, env: { ...process.env, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: process.platform !== "win32" });
    const kill = () => {
      try { if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    };
    signal.addEventListener("abort", kill, { once: true });
    const read = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
      const reader = stream.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > outputLimit) { kill(); throw new Error("Process output exceeded 16 MiB per stream"); }
          chunks.push(value);
        }
        return Buffer.concat(chunks).toString("utf8");
      } finally { reader.releaseLock(); }
    };
    try {
      if (signal.aborted) kill();
      const exited = child.exited.then(code => { kill(); return code; });
      const [stdout, stderr, exitCode] = await Promise.all([read(child.stdout), read(child.stderr), exited]);
      signal.throwIfAborted();
      return { returncode: exitCode, stdout, stderr };
    } finally {
      signal.removeEventListener("abort", kill);
      kill();
      await child.exited;
    }
  }

  async inspect(path: string): Promise<Context> {
    const resolved = await realpath(path);
    const source = await open(resolved, "r");
    try {
      const before = await source.stat({ bigint: true });
      if (!before.isFile()) throw new Error("inspect_file requires a regular file");
      const digest = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
      while (true) {
        const { bytesRead } = await source.read(buffer);
        if (!bytesRead) break;
        digest.update(buffer.subarray(0, bytesRead));
      }
      const after = await source.stat({ bigint: true }), current = await stat(resolved, { bigint: true });
      const signature = (info: typeof before) => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
      if (signature(before) !== signature(after) || signature(after) !== signature(current)) throw new Error("File changed during inspection");
      return { path: resolved, name: basename(resolved), size: Number(after.size), contentType: Bun.file(resolved).type || "application/octet-stream", sha256: digest.digest("hex") };
    } finally { await source.close(); }
  }

  async discoverModels(cache: string): Promise<Record<string, string>> {
    const root = join(cache, "models"), result: Record<string, string> = {};
    const candidates: { relative: string; stem: string; name: string; path: string }[] = [];
    if (!await this.exists(root, "folder")) return result;
    for await (const relative of new Bun.Glob("**/*").scan({ cwd: root, onlyFiles: true })) {
      if (!/\.(gguf|safetensor|safetensors)$/i.test(relative)) continue;
      const name = basename(relative), stem = name.replace(/\.[^.]+$/, "");
      candidates.push({ relative, stem, name, path: resolve(root, relative) });
    }
    for (const file of candidates) {
      result[file.relative] = file.path;
      result[file.relative.replace(/\.[^.]+$/, "")] = file.path;
      if (candidates.filter(other => other.stem === file.stem).length === 1) result[file.stem] = file.path;
      if (candidates.filter(other => other.name === file.name).length === 1) result[file.name] = file.path;
    }
    return result;
  }

  async http(options: HttpOptions, signal: AbortSignal): Promise<Context> {
    if (options.bodyFile === undefined) return this.transfer(options, signal);
    const source = await open(options.bodyFile, "r");
    try {
      const before = await source.stat({ bigint: true });
      if (!before.isFile()) throw new Error("HTTP body_file must be a regular file");
      const result = await this.transfer(options, signal, { body: Bun.file(source.fd), size: Number(before.size) });
      const after = await source.stat({ bigint: true }), current = await stat(options.bodyFile, { bigint: true });
      const signature = (info: typeof before) => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
      if (signature(before) !== signature(after) || signature(after) !== signature(current)) throw new Error("Upload source changed during transfer");
      return result;
    } finally { await source.close(); }
  }

  private async transfer(options: HttpOptions, signal: AbortSignal, upload?: { body: Blob; size: number }): Promise<Context> {
    if (!Number.isFinite(options.timeout) || options.timeout <= 0) throw new Error("HTTP timeout must be positive");
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(options.timeout * 1000)]);
    const headers = new Headers({ "User-Agent": "mu/0.4.0", ...options.headers });
    let body: string | Blob | undefined;
    if (options.bodyFile !== undefined) {
      if (!upload) throw new Error("Upload source unavailable");
      headers.delete("Transfer-Encoding"); headers.set("Content-Length", String(upload.size));
      if (!headers.has("Content-Type")) headers.set("Content-Type", "application/octet-stream");
      body = upload.body;
    } else if (options.body != null) body = JSON.stringify(options.body);
    let url = new URL(options.url), method = options.method;
    let response: Response | undefined;
    for (let redirects = 0; redirects <= 10; redirects++) {
      response = await this.transport(url, { method, headers, body, signal: timeout, redirect: "manual" });
      if (![301, 302, 303, 307, 308].includes(response.status) || !response.headers.has("location")) break;
      const status = response.status;
      const next = new URL(response.headers.get("location")!, url);
      await response.body?.cancel(); response = undefined;
      if (!["http:", "https:"].includes(next.protocol) || next.username || next.password) throw new Error("Invalid HTTP redirect");
      if (next.origin !== url.origin) for (const name of ["Authorization", "Cookie", "X-Mu-Assignment-Version"]) headers.delete(name);
      if (([301, 302].includes(status) && method === "POST") || (status === 303 && method !== "HEAD")) {
        method = "GET"; body = undefined; headers.delete("Content-Length"); headers.delete("Content-Type");
      }
      url = next;
    }
    if (!response) throw new Error("HTTP redirect limit exceeded");
    const result: Context = { status_code: response.status, headers: Object.fromEntries(response.headers), body: null };
    if (options.responseFile !== undefined && response.ok) {
      await this.mkdir(dirname(options.responseFile));
      const temporary = join(dirname(options.responseFile), `.mu-download-${crypto.randomUUID()}`);
      const file = await open(temporary, "wx", 0o600);
      let size = 0;
      const digest = createHash("sha256");
      try {
        if (response.body) for await (const chunk of response.body) { await file.writeFile(chunk); size += chunk.byteLength; digest.update(chunk); }
        const length = response.headers.get("content-length");
        if (length !== null && !response.headers.has("content-encoding") && Number(length) !== size) throw new Error("Incomplete HTTP download");
        if (options.expectedSize !== undefined && size !== options.expectedSize) throw new Error("Artifact size mismatch");
        if (options.expectedSha256 !== undefined && digest.digest("hex") !== options.expectedSha256) throw new Error("Artifact SHA-256 mismatch");
        timeout.throwIfAborted();
        await file.sync(); await file.close();
        await rename(temporary, options.responseFile);
        result.response_file = options.responseFile; result.size = size;
      } finally { await file.close(); await rm(temporary, { force: true }); }
    } else {
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      if (reader) try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > outputLimit) { await reader.cancel(); throw new Error("HTTP response exceeded 16 MiB; use response_file"); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(response.headers.get("content-type") ?? "")?.[1] ?? "utf-8";
      const text = new TextDecoder(charset as ConstructorParameters<typeof TextDecoder>[0]).decode(Buffer.concat(chunks));
      if (text) { try { result.body = JSON.parse(text); } catch { result.body = text; } }
    }
    return result;
  }
}
