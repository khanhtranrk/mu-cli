export function argumentText(value: unknown, nested = false): string {
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "string") {
    if (!nested) return value;
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    const escaped = value.replace(/\\/g, "\\\\").replaceAll(quote, "\\" + quote).replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
    return quote + escaped + quote;
  }
  if (Array.isArray(value)) return "[" + value.map(child => argumentText(child, true)).join(", ") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value).map(([key, child]) => `${argumentText(key, true)}: ${argumentText(child, true)}`).join(", ") + "}";
  return String(value);
}
