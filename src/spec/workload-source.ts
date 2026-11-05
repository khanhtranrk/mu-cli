/** Pure validation shared by structural parsing and module resolution. */
export function validateWorkloadSource(item: Record<string, unknown>, path: string): void {
  if (Object.keys(item).some(key => !["source", "sha256"].includes(key))) throw new Error(`${path}: source cannot be combined with inline workload properties`);
  const source = item.source;
  if (typeof source !== "string" || !source.trim() || /[{}\x00-\x1f]/.test(source)) throw new Error(`${path}.source: expected a static local path or HTTPS URL`);
  if (/^[a-z][a-z\d+.-]*:/i.test(source)) {
    let url: URL;
    try { url = new URL(source); } catch { throw new Error(`${path}.source: invalid URL`); }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error(`${path}.source: expected HTTPS without credentials or fragment`);
  } else if (source.startsWith("//")) throw new Error(`${path}.source: protocol-relative URLs are not supported`);
  if (Object.hasOwn(item, "sha256") && (typeof item.sha256 !== "string" || !/^[a-f\d]{64}$/i.test(item.sha256))) throw new Error(`${path}.sha256: expected 64 hexadecimal characters`);
}
