/**
 * Produce a deterministic SHA-256 hex digest of the given value.
 * Used for approval token payload hashing and MCP schema fingerprinting.
 */
export async function sha256(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Canonical JSON stringify (sorted keys) for reproducible hashing. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      return Object.keys(val as Record<string, unknown>)
        .sort()
        .reduce(
          (sorted, k) => {
            sorted[k] = (val as Record<string, unknown>)[k];
            return sorted;
          },
          {} as Record<string, unknown>,
        );
    }
    return val;
  });
}
