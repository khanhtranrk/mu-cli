import { homedir } from "node:os";
import { join } from "node:path";
import { mapping } from "./spec/types";
import { RegistryClient } from "./runtime/registry-client";
/** Profiles contain environment variable names, never credential plaintext. */
export async function registryProfile(name?: string, env = process.env): Promise<RegistryClient> {
  const path = env.MU_PROFILES_FILE ?? join(homedir(), ".config", "mu", "profiles.json");
  const file = Bun.file(path);
  if (!await file.exists()) throw new Error("Registry profile missing; configure profiles.json and a workload:read token environment variable");
  if (file.size > 64 * 1024) throw new Error("Profile file exceeds 64 KiB");
  const data = mapping(await file.json(), "profiles"), profiles = mapping(data.profiles, "profiles");
  const selected = name ?? env.MU_PROFILE ?? data.defaultProfile;
  if (typeof selected !== "string" || !Object.hasOwn(profiles, selected)) throw new Error("Select an existing registry profile with --profile");
  const profile = mapping(profiles[selected], "registry profile");
  if (Object.keys(profile).some(k => !["server", "tokenEnv"].includes(k)) || typeof profile.server !== "string" || typeof profile.tokenEnv !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(profile.tokenEnv)) throw new Error("Profile requires server and tokenEnv; do not store plaintext credentials");
  const token = env[profile.tokenEnv];
  if (typeof token !== "string" || !/^mu_workload_v1_[a-f0-9]{64}$/.test(token)) throw new Error("Registry profile requires a dedicated workload:read credential in its tokenEnv variable");
  return new RegistryClient(profile.server, token);
}
