/**
 * Argument-level guardrails (#8).
 *
 * Provides schema validation, field-level allow/deny lists, regex/PII
 * scanning, and semantic validators for tool arguments.
 */

import type { z } from "zod";
import type { ArgGuard, PolicyContext, ZodArgGuard } from "../types.js";

// ---------------------------------------------------------------------------
// Built-in argument guard factories
// ---------------------------------------------------------------------------

/**
 * Create an ArgGuard from a Zod schema for a specific field.
 */
export function zodGuard(config: ZodArgGuard): ArgGuard {
  return {
    field: config.field,
    validate(value: unknown) {
      const result = config.schema.safeParse(value);
      if (!result.success) {
        const issues = result.error.issues
          .map((i) => i.message)
          .join("; ");
        return `Validation failed for "${config.field}": ${issues}`;
      }
      return null;
    },
  };
}

/**
 * Allowlist guard: value must be one of the allowed values.
 */
export function allowlist(
  field: string,
  allowed: readonly unknown[],
): ArgGuard {
  return {
    field,
    validate(value: unknown) {
      if (!allowed.includes(value)) {
        return `Value for "${field}" is not in the allowlist.`;
      }
      return null;
    },
  };
}

/**
 * Denylist guard: value must NOT be one of the denied values.
 */
export function denylist(
  field: string,
  denied: readonly unknown[],
): ArgGuard {
  return {
    field,
    validate(value: unknown) {
      if (denied.includes(value)) {
        return `Value for "${field}" is in the denylist.`;
      }
      return null;
    },
  };
}

/**
 * Regex guard: string value must match (or must NOT match) a pattern.
 */
export function regexGuard(
  field: string,
  pattern: RegExp,
  opts?: { mustMatch?: boolean; message?: string },
): ArgGuard {
  const mustMatch = opts?.mustMatch ?? true;
  return {
    field,
    validate(value: unknown) {
      if (typeof value !== "string") {
        return `Expected string for "${field}", got ${typeof value}.`;
      }
      const matches = pattern.test(value);
      if (mustMatch && !matches) {
        return (
          opts?.message ??
          `Value for "${field}" does not match required pattern.`
        );
      }
      if (!mustMatch && matches) {
        return (
          opts?.message ??
          `Value for "${field}" matches a forbidden pattern.`
        );
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// PII detection guard
// ---------------------------------------------------------------------------

/** Common PII patterns. */
const PII_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  {
    name: "email",
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
  },
  { name: "ssn", pattern: /\b\d{3}-\d{2}-\d{4}\b/ },
  {
    name: "credit-card",
    pattern: /\b(?:\d[ -]*?){13,19}\b/,
  },
  { name: "phone-us", pattern: /\b\(?[2-9]\d{2}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/ },
  { name: "ip-address", pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/ },
];

/**
 * PII scanner guard: checks string fields for common PII patterns.
 */
export function piiGuard(
  field: string,
  opts?: { allowedTypes?: string[] },
): ArgGuard {
  const allowed = new Set(opts?.allowedTypes ?? []);
  return {
    field,
    validate(value: unknown) {
      if (typeof value !== "string") return null;

      for (const { name, pattern } of PII_PATTERNS) {
        if (allowed.has(name)) continue;
        if (pattern.test(value)) {
          return `Potential PII detected in "${field}": ${name}`;
        }
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// Runner: evaluate all arg guards for a tool call
// ---------------------------------------------------------------------------

/** Result of evaluating argument guards. */
export interface ArgGuardResult {
  passed: boolean;
  violations: Array<{ field: string; message: string }>;
}

/**
 * Evaluate all argument guards against the tool call context.
 */
export async function evaluateArgGuards(
  guards: ArgGuard[],
  ctx: PolicyContext,
): Promise<ArgGuardResult> {
  const violations: ArgGuardResult["violations"] = [];

  for (const guard of guards) {
    const value =
      guard.field === "*" ? ctx.args : getNestedValue(ctx.args, guard.field);
    const message = await guard.validate(value, ctx);
    if (message) {
      violations.push({ field: guard.field, message });
    }
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}

/** Access a nested value via dot-path (e.g. "user.email"). */
function getNestedValue(
  obj: Record<string, unknown>,
  path: string,
): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
