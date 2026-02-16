/**
 * Minimal glob matcher for tool name patterns.
 * Supports `*` (match any sequence) and `?` (match single char).
 */
export function matchGlob(pattern: string, value: string): boolean {
  const regex = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".") +
      "$",
  );
  return regex.test(value);
}
