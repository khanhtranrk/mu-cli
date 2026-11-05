import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { moduleByteLimit, type ModuleLoader } from "../spec/workload-modules";

/** Explicit I/O adapter. No worker headers, cookies, or authentication are forwarded. */
export function workloadLoader(baseDir?: string, transport: typeof fetch = fetch, timeoutMs = 30_000): ModuleLoader {
  return async (source, signal) => {
    signal.throwIfAborted();
    if (!/^https:/i.test(source)) {
      if (!isAbsolute(source) && !baseDir) throw new Error("Relative workload source requires an explicit workloadBaseDir for a server-provided Spec");
      const file = await open(isAbsolute(source) ? source : resolve(baseDir!, source), constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > moduleByteLimit) throw new Error("Workload source must be a regular file no larger than 1 MiB");
        const bytes = Buffer.alloc(moduleByteLimit + 1);
        let size = 0;
        while (size < bytes.length) {
          signal.throwIfAborted();
          const { bytesRead } = await file.read(bytes, size, bytes.length - size);
          if (!bytesRead) break;
          size += bytesRead;
        }
        if (size > moduleByteLimit) throw new Error("Workload module size limit exceeded");
        signal.throwIfAborted();
        return bytes.subarray(0, size);
      } finally { await file.close(); }
    }
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    let url = new URL(source);
    for (let redirects = 0; redirects <= 5; redirects++) {
      bounded.throwIfAborted();
      if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Workload redirects require HTTPS without credentials or fragment");
      const response = await transport(url, { redirect: "manual", credentials: "omit", signal: bounded, headers: { Accept: "application/yaml, text/yaml, text/plain" } });
      if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.has("location")) {
        await response.body?.cancel();
        url = new URL(response.headers.get("location")!, url);
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Workload source HTTP ${response.status}`); }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        if (reader) while (true) {
          const { value, done } = await reader.read();
          bounded.throwIfAborted();
          if (done) break;
          size += value.byteLength;
          if (size > moduleByteLimit) throw new Error("Workload module size limit exceeded");
          chunks.push(value);
        }
      } finally { await reader?.cancel(); reader?.releaseLock(); }
      bounded.throwIfAborted();
      return Buffer.concat(chunks);
    }
    throw new Error("Workload source redirect limit exceeded");
  };
}
