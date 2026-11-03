export interface Device { family: string; index: number; maxUnits: number }
interface Job {
  units: number;
  signal: AbortSignal;
  run(device?: Device): Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  abort(): void;
}

export function validateDevices(value: unknown): Device[] {
  if (!Array.isArray(value)) throw new Error("runtime.devices must be an array");
  const keys = new Set<string>();
  return value.map(raw => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid device");
    const device = raw as Device;
    if (!["cuda", "rocm"].includes(device.family) || !Number.isSafeInteger(device.index) || device.index < 0 || !Number.isFinite(device.maxUnits) || device.maxUnits <= 0) throw new Error("Device requires cuda/rocm family, nonnegative integer index and positive maxUnits");
    const key = device.family + ":" + device.index;
    if (keys.has(key)) throw new Error("Duplicate device " + key);
    keys.add(key);
    return { family: device.family, index: device.index, maxUnits: device.maxUnits };
  });
}

export class Scheduler {
  private queue: Job[] = [];
  private active = 0;
  private free: number[];
  readonly devices: Device[];
  constructor(devices: Device[] = [], readonly concurrency = 32, private warning: (message: string) => void = () => {}) {
    this.devices = validateDevices(devices);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error("concurrency must be an integer from 1 to 32");
    this.free = this.devices.map(device => device.maxUnits);
  }

  snapshot() { return { active: this.active, queued: this.queue.length, devices: this.devices.map((device, index) => ({ ...device, freeUnits: this.free[index]! })) }; }

  run<Result>(units: number, signal: AbortSignal, operation: (device?: Device) => Promise<Result>): Promise<Result> {
    if (!Number.isFinite(units) || units < 0) return Promise.reject(new Error("units must be finite and nonnegative"));
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<Result>((resolve, reject) => {
      const job: Job = {
        units, signal, run: operation, resolve: value => resolve(value as Result), reject,
        abort: () => {
          const index = this.queue.indexOf(job);
          if (index !== -1) { this.queue.splice(index, 1); reject(signal.reason); this.pump(); }
        },
      };
      signal.addEventListener("abort", job.abort, { once: true });
      this.queue.push(job); this.pump();
    });
  }

  private pump(): void {
    for (let index = 0; index < this.queue.length && this.active < this.concurrency;) {
      const job = this.queue[index]!;
      let selected = -1;
      const fitting = this.devices.map((device, deviceIndex) => ({ device, deviceIndex })).filter(item => item.device.maxUnits >= job.units);
      if (job.units > 0 && fitting.length) {
        for (const { deviceIndex } of fitting) {
          if (this.free[deviceIndex]! >= job.units && (selected < 0 || this.free[deviceIndex]! < this.free[selected]!)) selected = deviceIndex;
        }
        if (selected < 0) { index++; continue; }
      }
      this.queue.splice(index, 1);
      job.signal.removeEventListener("abort", job.abort);
      this.active++;
      if (selected >= 0) this.free[selected]! -= job.units;
      const device = this.devices[selected];
      const release = () => {
        if (selected >= 0) this.free[selected] = Math.min(this.devices[selected]!.maxUnits, this.free[selected]! + job.units);
        this.active--; this.pump();
      };
      Promise.resolve().then(() => {
        job.signal.throwIfAborted();
        if (!device && job.units > 0) this.warning(`No GPU fits ${job.units} units; using CPU`);
        return job.run(device);
      }).then(value => { release(); job.resolve(value); }, error => { release(); job.reject(error); });
    }
  }
}
