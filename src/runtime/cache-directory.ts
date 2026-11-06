import { homedir } from "node:os";
import { posix, win32 } from "node:path";

/** Per-user MU cache, shared by worker and standalone execution. */
export function muCacheDirectory(platform: NodeJS.Platform = process.platform, home = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    const base = local && win32.isAbsolute(local) ? local : win32.join(home, "AppData", "Local");
    return win32.join(base, "mu", "Cache");
  }
  if (platform === "darwin") return posix.join(home, "Library", "Caches", "mu");
  const xdg = env.XDG_CACHE_HOME;
  return posix.join(xdg && posix.isAbsolute(xdg) ? xdg : posix.join(home, ".cache"), "mu");
}
