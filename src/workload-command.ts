import { resolve } from "node:path";
import { Command } from "commander";
import { workloadBindings } from "./workload-bindings";
import { BunEffects } from "./runtime/effects";
import { detectDevices } from "./runtime/devices";
import { executeStandaloneWorkload, WorkloadExecutionError } from "./runtime/workload-executor";
import { workloadLoader } from "./runtime/workload-loader";
import { validateDevices } from "./scheduler/scheduler";

class LocalEffects extends BunEffects {
  override async process(argv: string[], env: Record<string, string>, cwd: string, signal: AbortSignal) {
    const result = await super.process(argv, env, cwd, signal);
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return result;
  }
}

export function addWorkloadCommand(program: Command, finish: (code: number) => void): void {
  const repeat = (value: string, previous: string[] = []) => [...previous, value];
  const group = program.command("workload").description("Run workload modules locally without a server");
  group.command("exec <source>").description("Prepare and execute a local or HTTPS workload module")
    .option("--with <key=value>", "Literal string binding (repeatable)", repeat)
    .option("--with-json <key=value>", "Strict JSON binding (repeatable)", repeat)
    .option("--with-file <path>", "Read bindings from a JSON object file; flags override keys")
    .option("--sha256 <digest>", "Optional SHA-256 of raw module bytes")
    .option("--cwd <path>", "Process working directory (default: caller cwd)")
    .option("--device <family,index,max_units>", "GPU capacity (repeatable; otherwise auto-detect)", repeat)
    .option("--json", "Write one result object to stdout; process logs go to stderr")
    .action(async (source: string, flags) => {
      const caller = process.cwd(), controller = new AbortController();
      const stop = () => controller.abort(new Error("Workload execution interrupted"));
      process.on("SIGINT", stop); process.on("SIGTERM", stop);
      try {
        const load = workloadLoader(caller);
        let file: unknown = {};
        if (flags.withFile !== undefined) {
          try { file = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await load(resolve(caller, flags.withFile), controller.signal))); }
          catch (error) { throw new Error(`--with-file: ${error instanceof Error ? error.message : "invalid JSON"}`); }
        }
        const bindings = workloadBindings(flags, file);
        const devices = flags.device === undefined ? await detectDevices(undefined, controller.signal) : validateDevices(flags.device.map((value: string) => {
          const [family, index, maxUnits, extra] = value.split(",");
          if (!index || !maxUnits || extra !== undefined) throw new Error("--device requires FAMILY,INDEX,MAX_UNITS");
          return {family: family === "nvidia" ? "cuda" : family, index: Number(index), maxUnits: Number(maxUnits)};
        }));
        const outputs = await executeStandaloneWorkload({source, sha256: flags.sha256, cwd: resolve(caller, flags.cwd ?? "."), bindings, devices}, new LocalEffects(), load, controller.signal);
        if (flags.json) console.log(JSON.stringify({success: true, outputs}));
        else console.log(`Workload succeeded\n${JSON.stringify(outputs, null, 2)}`);
        finish(0);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Workload execution failed";
        const code = controller.signal.aborted ? 130 : error instanceof WorkloadExecutionError ? 6 : 2;
        if (flags.json) console.log(JSON.stringify({success: false, error: {message}, exitCode: code}));
        else console.error(message);
        finish(code);
      } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
    });
}
