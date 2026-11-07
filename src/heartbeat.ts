import { ApiError, DataCenterConnectionError } from "./api";

export function transientHeartbeatError(error: unknown): boolean {
  return error instanceof DataCenterConnectionError || error instanceof ApiError && (error.status === 408 || error.status === 429 || error.status >= 500 && error.status <= 599);
}
function diagnostic(error: unknown): string {
  if (error instanceof DataCenterConnectionError) return error.message;
  if (error instanceof ApiError) return `POST /api/units/heartbeat: HTTP ${error.status}`;
  // Do not log arbitrary transport messages, response bodies or credentials.
  return "POST /api/units/heartbeat: unexpected response/error";
}
function wait(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Owns one periodic/recovery heartbeat at a time; never retries a claim. */
export class HeartbeatMonitor {
  private controller = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private recovery?: Promise<void>;
  private failure?: {error: unknown; permanent: boolean};
  private stopped = false;
  private abort = () => this.controller.abort(this.parent.reason);

  constructor(
    private send: (signal: AbortSignal) => Promise<void>,
    private intervalMs: number,
    private parent: AbortSignal,
    private warning: (message: string) => void = console.warn,
    private recoveryDelays: readonly number[] = [1000, 2000, 4000],
  ) {
    parent.addEventListener("abort", this.abort, {once: true});
    if (parent.aborted) this.abort();
  }

  start(): void {
    if (this.timer || this.stopped || this.controller.signal.aborted) return;
    this.timer = setInterval(() => {
      if (!this.recovery && !this.failure?.permanent && !this.controller.signal.aborted) void this.attempt();
    }, this.intervalMs);
  }

  private attempt(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      try {
        await this.send(this.controller.signal);
        if (this.failure && !this.failure.permanent) {
          this.failure = undefined;
          this.warning("Worker heartbeat recovered; request claiming may resume");
        }
      } catch (error) {
        if (this.controller.signal.aborted) return;
        this.failure = {error, permanent: !transientHeartbeatError(error)};
        this.warning(`Worker heartbeat failed; new claims paused: ${diagnostic(error)}`);
      }
    })().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  async ensureHealthy(): Promise<void> {
    this.controller.signal.throwIfAborted();
    await this.pending;
    this.controller.signal.throwIfAborted();
    if (this.failure?.permanent) throw this.failure.error;
    if (!this.failure) return;
    if (!this.recovery) {
      this.recovery = this.recover();
      // Install both handlers immediately; concurrent callers share this recovery.
      void this.recovery.then(() => { this.recovery = undefined; }, () => { this.recovery = undefined; });
    }
    await this.recovery;
  }

  private async recover(): Promise<void> {
    for (const [index, delay] of this.recoveryDelays.entries()) {
      this.warning(`Worker heartbeat recovery ${index + 1}/${this.recoveryDelays.length} in ${delay}ms; new claims paused`);
      await wait(delay, this.controller.signal);
      await this.attempt();
      this.controller.signal.throwIfAborted();
      if (this.failure?.permanent) throw this.failure.error;
      if (!this.failure) return;
    }
    this.warning(`Worker heartbeat recovery exhausted after ${this.recoveryDelays.length} attempts`);
    throw this.failure!.error;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    const reason = new Error("Heartbeat monitoring stopped");
    // Preserve normal online -> offline ordering. Cancellation/recovery shutdown
    // aborts promptly; ordinary completion first drains an in-flight heartbeat.
    if (this.recovery || this.parent.aborted) this.controller.abort(reason);
    try {
      await this.pending;
      this.controller.abort(reason);
      await this.recovery?.catch(() => {});
    } finally {
      this.parent.removeEventListener("abort", this.abort);
      this.controller.abort(reason);
    }
  }
}
