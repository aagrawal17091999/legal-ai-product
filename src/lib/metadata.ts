/**
 * Normalize a jsonb column (may be array of strings or array of {name: ...}
 * objects from the extraction pipeline) into a flat string[]. Returns [] for
 * nulls / non-arrays so downstream .some() checks are safe.
 */
export function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v === "string" && v.trim()) {
      out.push(v.trim());
    } else if (v && typeof v === "object" && "name" in v) {
      const name = (v as Record<string, unknown>).name;
      if (typeof name === "string" && name.trim()) out.push(name.trim());
    }
  }
  return out;
}
