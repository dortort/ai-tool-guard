# Output Filtering

Output filters run after a tool executes and before the result is returned to the model. They give you egress control over what the model sees: secrets can be redacted, PII can be removed, and specific categories of output can be blocked entirely. Filters compose into a chain, each receiving the output of the previous one.

## Overview

Register filters via the `outputFilters` array on `ToolGuardConfig`. The chain runs in declaration order. Each filter can return one of three verdicts:

- **`pass`** — Output is clean; pass it to the next filter unchanged (or return it if this is the last filter).
- **`redact`** — Output was modified; the transformed output continues through the chain.
- **`block`** — Output is suppressed entirely. Execution short-circuits; no further filters run.

Redacted field names are accumulated across all filters and recorded in the `DecisionRecord.redactions` array for audit purposes.

## Basic Usage

```typescript
import { createToolGuard } from "ai-tool-guard";
import { piiOutputFilter, secretsFilter } from "ai-tool-guard/guards";

const guard = createToolGuard();

const wrappedUserLookup = guard.guardTool("userLookup", userLookupTool, {
  riskLevel: "high",
  riskCategories: ["data-read", "pii"],
  outputFilters: [
    secretsFilter(),        // Strip secrets first.
    piiOutputFilter(),      // Then strip remaining PII.
  ],
});
```

## Configuration Options

### `secretsFilter(extraRules?)`

Redacts common secrets from string output using pattern matching. The built-in rules cover the most prevalent secret formats:

| Rule Name | Pattern |
|---|---|
| `aws-key` | `AKIA...` and `ASIA...` IAM key prefixes (20-char) |
| `github-token` | `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` tokens |
| `jwt` | Three-segment base64url JWT (`eyJ...`) |
| `generic-api-key` | `api_key`, `apikey`, `secret_key` assignments with long values |
| `bearer-token` | `Bearer <token>` authorization headers |
| `private-key` | PEM-encoded RSA and EC private key blocks |

Matched content is replaced with `[REDACTED]` by default.

```typescript
import { secretsFilter } from "ai-tool-guard/guards";
import type { RedactionRule } from "ai-tool-guard/guards";

// Use with no arguments for default rules only.
secretsFilter();

// Extend with project-specific secret patterns.
const customRule: RedactionRule = {
  name: "stripe-key",
  pattern: /sk_(live|test)_[A-Za-z0-9]{24,}/g,
  replacement: "[STRIPE KEY REDACTED]",
};
secretsFilter([customRule]);
```

### `piiOutputFilter(opts?)`

Redacts PII from string output. By default all four PII types are active. Pass `allowedTypes` to suppress redaction for specific types.

| Type | Replacement |
|---|---|
| `email` | `[EMAIL REDACTED]` |
| `ssn` | `[SSN REDACTED]` |
| `phone` | `[PHONE REDACTED]` |
| `credit-card` | `[CARD REDACTED]` (Luhn-validated matches only) |

```typescript
import { piiOutputFilter } from "ai-tool-guard/guards";

// Redact all PII types.
piiOutputFilter();

// Allow emails through but redact everything else.
piiOutputFilter({ allowedTypes: ["email"] });
```

Credit card redaction uses Luhn validation to confirm a match is a real card number before redacting it. This prevents over-redaction of numeric strings that pattern-match but are not valid card numbers.

### `customFilter(name, fn)`

Create a filter from any function. Use this for domain-specific logic, content classification, size limiting, or any check that the built-in filters do not cover.

```typescript
import { customFilter } from "ai-tool-guard/guards";
import type { OutputFilterResult, PolicyContext } from "ai-tool-guard";

const sizeLimitFilter = customFilter(
  "size-limit",
  async (result: unknown, ctx: PolicyContext): Promise<OutputFilterResult> => {
    const serialized = JSON.stringify(result);
    if (serialized.length > 100_000) {
      return { verdict: "block", output: null };
    }
    return { verdict: "pass", output: result };
  },
);
```

The function signature is:

```typescript
fn(result: unknown, ctx: PolicyContext): Promise<OutputFilterResult>
```

`ctx` gives you access to `toolName`, `args`, `userAttributes`, and conversation context — useful for applying different redaction rules based on the caller's role or the tool being called.

### `runOutputFilters(filters, result, ctx)`

The chain runner. Typically called internally by the guard engine, but exposed for testing and custom integration:

```typescript
import { runOutputFilters } from "ai-tool-guard/guards";

const chainResult = await runOutputFilters(
  [secretsFilter(), piiOutputFilter()],
  rawToolOutput,
  ctx,
);

// chainResult.output         — final (possibly redacted) value
// chainResult.redactedFields — e.g. ["secrets-filter:aws-key", "pii-output-filter:email"]
// chainResult.blocked        — true if any filter returned "block"
// chainResult.blockedBy      — name of the filter that blocked (if blocked)
```

## `OutputFilterResult`

Each filter returns:

```typescript
interface OutputFilterResult {
  verdict: "pass" | "redact" | "block";
  output: unknown;             // The (possibly transformed) value.
  redactedFields?: string[];   // Names of redacted patterns.
}
```

When the chain completes, `runOutputFilters` returns an `OutputFilterChainResult`:

```typescript
interface OutputFilterChainResult {
  output: unknown;
  redactedFields: string[];  // Prefixed with filter name: "secrets-filter:aws-key".
  blocked: boolean;
  blockedBy?: string;        // Filter name, if blocked.
}
```

## Redaction Mechanics

The internal `redactValue` function applies rules recursively across the full output structure:

- **Strings** — each pattern is tested and matched substrings are replaced in-place.
- **Arrays** — each element is processed independently and recursively.
- **Objects** — each property value is processed recursively; keys are not inspected.
- **Other types** — numbers, booleans, and `null` pass through unchanged.

For rules with a `validate` function (currently credit-card Luhn validation), a replacer function is used so that each regex match is individually validated before replacement. Only matches that pass validation are redacted.

!!! note "Global flag required for pattern rules"
    Patterns used in `SecretRule` and the built-in PII rules are compiled with the `g` (global) flag. If you supply custom `RedactionRule` patterns without the `g` flag, only the first match per string will be replaced. Always use `g` in `RedactionRule.pattern`.

## Advanced Examples

### Blocking Output Above a Size Threshold

Prevent large tool results from being fed back to the model, which could exhaust context or be used for exfiltration:

```typescript
import { createToolGuard } from "ai-tool-guard";
import { customFilter, secretsFilter } from "ai-tool-guard/guards";

const guard = createToolGuard();

const wrappedFileTool = guard.guardTool("readFile", readFileTool, {
  riskLevel: "medium",
  outputFilters: [
    secretsFilter(),
    customFilter("size-guard", async (result) => {
      const size = JSON.stringify(result).length;
      if (size > 50_000) {
        return {
          verdict: "block",
          output: null,
          // blockedBy will be set to "size-guard" in the chain result.
        };
      }
      return { verdict: "pass", output: result };
    }),
  ],
});
```

### Domain-Specific Redaction with Custom Rules

Extend `secretsFilter` with patterns specific to your infrastructure:

```typescript
import { secretsFilter } from "ai-tool-guard/guards";
import type { RedactionRule } from "ai-tool-guard/guards";

const internalTokenRule: RedactionRule = {
  name: "internal-service-token",
  pattern: /svc_[A-Za-z0-9]{32}/g,
  replacement: "[SERVICE TOKEN REDACTED]",
};

const dbConnectionStringRule: RedactionRule = {
  name: "db-connection-string",
  pattern: /postgresql:\/\/[^\s"']+/g,
  replacement: "[DB URL REDACTED]",
};

const filter = secretsFilter([internalTokenRule, dbConnectionStringRule]);
```

### Role-Based Redaction with a Custom Filter

Use `ctx.userAttributes` to apply different redaction based on who is calling:

```typescript
import { customFilter } from "ai-tool-guard/guards";

const roleBasedPiiFilter = customFilter(
  "role-based-pii",
  async (result, ctx) => {
    const role = ctx.userAttributes.role as string | undefined;
    if (role === "admin") {
      // Admins see the raw output.
      return { verdict: "pass", output: result };
    }
    // All other roles get PII stripped.
    const { piiOutputFilter, runOutputFilters } = await import("ai-tool-guard/guards");
    const inner = await runOutputFilters([piiOutputFilter()], result, ctx);
    return {
      verdict: inner.redactedFields.length > 0 ? "redact" : "pass",
      output: inner.output,
      redactedFields: inner.redactedFields,
    };
  },
);
```

## How It Works

1. After a tool executes successfully, the guard engine calls `runOutputFilters(filters, rawResult, ctx)`.
2. The runner iterates over `filters` in order, passing the current output to each `filter.filter(current, ctx)`.
3. If a filter returns `verdict: "block"`, the runner immediately returns `{ output: null, blocked: true, blockedBy: filter.name }`. No further filters run.
4. If a filter returns `verdict: "redact"`, its `output` becomes the input for the next filter and its `redactedFields` are prefixed with the filter name and appended to `allRedacted`.
5. If a filter returns `verdict: "pass"`, its `output` (unchanged or transformed) becomes the input for the next filter.
6. After all filters complete, the final `output` is returned to the caller and `allRedacted` is written to `DecisionRecord.redactions`.

## Related

- [API Reference — Guards](../api/guards.md)
- [Argument Validation](argument-validation.md)
- [Decision Records](decision-records.md)
- [Injection Detection](injection-detection.md)
