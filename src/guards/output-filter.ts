/**
 * Output filtering / egress controls (#10).
 *
 * Controls what comes back from tool execution: PII minimization,
 * secrets stripping, data classification, and selective disclosure.
 */

import type { OutputFilter, OutputFilterResult, PolicyContext } from "../types.js";

// ---------------------------------------------------------------------------
// Built-in output filters
// ---------------------------------------------------------------------------

/** Pattern-based redaction rules. */
export interface RedactionRule {
  /** Human-readable name. */
  name: string;
  /** Regex to match sensitive content. */
  pattern: RegExp;
  /** Replacement string. Default: "[REDACTED]". */
  replacement?: string;
}

/** Common secret patterns for output redaction. */
const SECRET_PATTERNS: RedactionRule[] = [
  { name: "aws-key", pattern: /(?:AKIA|ASIA)[A-Z0-9]{16}/g },
  { name: "github-token", pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/g },
  { name: "jwt", pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  { name: "generic-api-key", pattern: /(?:api[_-]?key|apikey|secret[_-]?key)\s*[:=]\s*['"]?[A-Za-z0-9_\-/.]{20,}['"]?/gi },
  { name: "bearer-token", pattern: /Bearer\s+[A-Za-z0-9_\-/.]{20,}/g },
  { name: "private-key", pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC )?PRIVATE KEY-----/g },
];

/**
 * Create a filter that redacts secrets from string output.
 */
export function secretsFilter(
  extraRules?: RedactionRule[],
): OutputFilter {
  const rules = [...SECRET_PATTERNS, ...(extraRules ?? [])];

  return {
    name: "secrets-filter",
    async filter(result: unknown): Promise<OutputFilterResult> {
      const { output, redactedFields } = redactValue(result, rules);
      return {
        verdict: redactedFields.length > 0 ? "redact" : "pass",
        output,
        redactedFields,
      };
    },
  };
}

/**
 * Create a filter that redacts PII from string output.
 */
export function piiOutputFilter(
  opts?: { allowedTypes?: string[] },
): OutputFilter {
  const allowed = new Set(opts?.allowedTypes ?? []);
  const piiRules: RedactionRule[] = [];

  if (!allowed.has("email")) {
    piiRules.push({
      name: "email",
      pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
      replacement: "[EMAIL REDACTED]",
    });
  }
  if (!allowed.has("ssn")) {
    piiRules.push({
      name: "ssn",
      pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
      replacement: "[SSN REDACTED]",
    });
  }
  if (!allowed.has("phone")) {
    piiRules.push({
      name: "phone",
      pattern: /\b\(?[2-9]\d{2}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
      replacement: "[PHONE REDACTED]",
    });
  }
  if (!allowed.has("credit-card")) {
    piiRules.push({
      name: "credit-card",
      pattern: /\b(?:\d[ -]*?){13,19}\b/g,
      replacement: "[CARD REDACTED]",
    });
  }

  return {
    name: "pii-output-filter",
    async filter(result: unknown): Promise<OutputFilterResult> {
      const { output, redactedFields } = redactValue(result, piiRules);
      return {
        verdict: redactedFields.length > 0 ? "redact" : "pass",
        output,
        redactedFields,
      };
    },
  };
}

/**
 * Create a custom filter from a function.
 */
export function customFilter(
  name: string,
  fn: (result: unknown, ctx: PolicyContext) => Promise<OutputFilterResult>,
): OutputFilter {
  return { name, filter: fn };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface OutputFilterChainResult {
  /** The final (possibly filtered) output. */
  output: unknown;
  /** All fields that were redacted across all filters. */
  redactedFields: string[];
  /** Whether any filter blocked the output entirely. */
  blocked: boolean;
  /** If blocked, the name of the blocking filter. */
  blockedBy?: string;
}

/**
 * Run a chain of output filters on a tool result.
 */
export async function runOutputFilters(
  filters: OutputFilter[],
  result: unknown,
  ctx: PolicyContext,
): Promise<OutputFilterChainResult> {
  let current = result;
  const allRedacted: string[] = [];

  for (const filter of filters) {
    const filterResult = await filter.filter(current, ctx);

    if (filterResult.verdict === "block") {
      return {
        output: null,
        redactedFields: allRedacted,
        blocked: true,
        blockedBy: filter.name,
      };
    }

    current = filterResult.output;
    if (filterResult.redactedFields) {
      allRedacted.push(
        ...filterResult.redactedFields.map((f) => `${filter.name}:${f}`),
      );
    }
  }

  return {
    output: current,
    redactedFields: allRedacted,
    blocked: false,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function redactValue(
  value: unknown,
  rules: RedactionRule[],
): { output: unknown; redactedFields: string[] } {
  const redactedFields: string[] = [];

  if (typeof value === "string") {
    let text = value;
    for (const rule of rules) {
      // Reset lastIndex for global regex.
      rule.pattern.lastIndex = 0;
      if (rule.pattern.test(text)) {
        redactedFields.push(rule.name);
        rule.pattern.lastIndex = 0;
        text = text.replace(rule.pattern, rule.replacement ?? "[REDACTED]");
      }
    }
    return { output: text, redactedFields };
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => {
      const r = redactValue(item, rules);
      redactedFields.push(...r.redactedFields);
      return r.output;
    });
    return { output: items, redactedFields };
  }

  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      const r = redactValue(val, rules);
      redactedFields.push(...r.redactedFields);
      result[key] = r.output;
    }
    return { output: result, redactedFields };
  }

  return { output: value, redactedFields };
}
