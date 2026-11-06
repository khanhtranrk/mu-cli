import { expect, test } from "bun:test";
import { muCacheDirectory } from "../src/runtime/cache-directory";

test("Linux MU cache honors absolute XDG paths and rejects empty/relative overrides", () => {
  expect(muCacheDirectory("linux", "/home/dev", {XDG_CACHE_HOME: "/mnt/cache"})).toBe("/mnt/cache/mu");
  for (const value of [undefined, "", "relative", "~/cache"]) {
    expect(muCacheDirectory("linux", "/home/dev", {XDG_CACHE_HOME: value})).toBe("/home/dev/.cache/mu");
  }
});

test("macOS uses Library/Caches regardless of XDG", () => {
  expect(muCacheDirectory("darwin", "/Users/dev", {XDG_CACHE_HOME: "/other"})).toBe("/Users/dev/Library/Caches/mu");
});

test("Windows uses local app data with a per-user fallback", () => {
  expect(muCacheDirectory("win32", "C:/Users/dev", {LOCALAPPDATA: "D:/Local"})).toBe("D:\\Local\\mu\\Cache");
  for (const value of [undefined, "", "relative"]) {
    expect(muCacheDirectory("win32", "C:/Users/dev", {LOCALAPPDATA: value})).toBe("C:\\Users\\dev\\AppData\\Local\\mu\\Cache");
  }
});
