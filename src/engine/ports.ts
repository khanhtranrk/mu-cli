import type { Context } from "../spec/types";

export interface ProcessResult { returncode: number | null; stdout: string; stderr: string }
export interface HttpOptions {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
  bodyFile?: string;
  responseFile?: string;
  timeout: number;
  expectedSize?: number;
  expectedSha256?: string;
}
export interface Effects {
  withWorkloadLock?<T>(cacheDir: string, signal: AbortSignal, run: () => Promise<T>): Promise<T>;
  process(argv: string[], env: Record<string, string>, cwd: string, signal: AbortSignal): Promise<ProcessResult>;
  http(options: HttpOptions, signal: AbortSignal): Promise<Context>;
  path(path: string, cwd: string): string;
  exists(path: string, kind: "file" | "folder" | "path"): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  writeJson(path: string, value: unknown): Promise<void>;
  inspect(path: string): Promise<Context>;
  discoverModels(cache: string): Promise<Record<string, string>>;
  warning(message: string): void;
}
