import type { Device } from "../scheduler/scheduler";
import { validateDevices } from "../scheduler/scheduler";
import { BunEffects } from "./effects";

export type Probe = (argv: string[]) => Promise<string | null>;
export async function detectDevices(probe: Probe = async argv => {
  if (!Bun.which(argv[0]!)) return null;
  try {
    const result = await new BunEffects().process(argv, {}, process.cwd(), signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000));
    return result.returncode === 0 ? result.stdout : null;
  } catch { if (signal?.aborted) throw signal.reason; return null; }
}, signal?: AbortSignal): Promise<Device[]> {
  signal?.throwIfAborted();
  const nvidia = await probe(["nvidia-smi", "--query-gpu=index,name,memory.total", "--format=csv,noheader,nounits"]);
  const devices: Device[] = [];
  for (const line of nvidia?.split("\n") ?? []) {
    const fields = line.split(",").map(value => value.trim());
    if (fields.length < 3 || !/^\d+$/.test(fields[0]!)) continue;
    const memory = Number(fields.at(-1));
    if (Number.isFinite(memory) && memory > 0) devices.push({ family: "cuda", index: Number(fields[0]), maxUnits: Math.ceil(memory / 4096) });
  }
  if (devices.length) return validateDevices(devices);
  signal?.throwIfAborted();
  const amd = await probe(["rocm-smi", "--showproductname", "--showmeminfo", "vram"]);
  for (const match of amd?.matchAll(/GPU\[(\d+)\].*?(?:VRAM\s+)?Total Memory\s*\(B\)\s*:\s*([\d,]+)/gi) ?? []) {
    const memory = Number(match[2]!.replaceAll(",", ""));
    if (Number.isFinite(memory) && memory > 0) devices.push({ family: "rocm", index: Number(match[1]), maxUnits: Math.ceil(memory / (4 * 1024 ** 3)) });
  }
  return validateDevices(devices);
}
