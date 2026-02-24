# Argument Validation

Argument guards intercept tool calls before policy evaluation and inspect the raw arguments the model supplies. They let you enforce schemas, restrict values to known-safe sets, block forbidden values, scan for PII, and apply any custom logic — all without modifying your tool implementations.

## Overview

Every argument guard is evaluated by `evaluateArgGuards` before the policy engine runs. If any guard returns a violation, the tool call is blocked and a structured list of violations is returned to the caller. Guards are composable: attach as many as needed to a single tool.

Guards target individual fields via dot-path strings (`"query"`, `"config.region"`) or the entire args object via the wildcard `"*"`.

## Basic Usage

Attach guards to a tool using the `argGuards` array on `ToolGuardConfig`:

```typescript
import { createToolGuard } from "ai-tool-guard";
import { allowlist, denylist, piiGuard, zodGuard } from "ai-tool-guard/guards";
import { z } from "zod";

const guard = createToolGuard({
  rules: [{ id: "allow-all", toolPatterns: ["*"], verdict: "allow" }],
});

const wrappedQuery = guard.guardTool("myDbQuery", myDbQueryTool, {
  riskLevel: "high",
  argGuards: [
    zodGuard({ field: "limit", schema: z.number().int().min(1).max(1000) }),
    allowlist("database", ["analytics", "reporting"]),
    piiGuard("query"),
  ],
});
```

When a guard blocks a call, the engine emits a `ToolGuardError` with `code: "arg-guard-failed"` and includes the full violations list. The corresponding `DecisionRecord` carries the same detail.

## Configuration Options

### `zodGuard({ field, schema })`

Validates a single field against any Zod schema. The `schema` can be any `z.ZodType`, including objects, unions, and refinements. When validation fails, the error message includes all Zod issue messages joined with semicolons.

```typescript
import { zodGuard } from "ai-tool-guard/guards";
import { z } from "zod";

// Reject calls where `limit` is not a positive integer under 1000.
zodGuard({
  field: "limit",
  schema: z.number().int().positive().max(1000),
});

// Validate a nested object field.
zodGuard({
  field: "options",
  schema: z.object({
    format: z.enum(["json", "csv"]),
    compress: z.boolean().optional(),
  }),
});
```

### `allowlist(field, allowed)`

Blocks calls where the field value is not present in the provided array. Uses strict equality (`===`).

```typescript
import { allowlist } from "ai-tool-guard/guards";

// Only allow writes to known environments.
allowlist("environment", ["staging", "canary"]);

// Restrict database selection using a dot-path.
allowlist("config.database", ["analytics", "reporting", "logs"]);
```

### `denylist(field, denied)`

Blocks calls where the field value appears in the denied array. The logical inverse of `allowlist`.

```typescript
import { denylist } from "ai-tool-guard/guards";

// Prevent reads from sensitive tables.
denylist("table", ["users_pii", "payment_methods", "audit_log"]);

// Block dangerous SQL operation types.
denylist("operation", ["DROP", "TRUNCATE", "ALTER"]);
```

### `regexGuard(field, pattern, opts?)`

Validates that a string field matches (or does not match) a regular expression.

| Option | Type | Default | Description |
|---|---|---|---|
| `mustMatch` | `boolean` | `true` | When `true`, the value must match the pattern. When `false`, a match is a violation. |
| `message` | `string` | built-in | Custom violation message returned to the caller. |

```typescript
import { regexGuard } from "ai-tool-guard/guards";

// Value must look like a valid S3 bucket name.
regexGuard("bucket", /^[a-z0-9][a-z0-9\-]{1,61}[a-z0-9]$/, {
  mustMatch: true,
  message: 'Invalid S3 bucket name in "bucket".',
});

// Value must NOT contain shell metacharacters.
regexGuard("filename", /[;&|`$<>]/, {
  mustMatch: false,
  message: "Shell metacharacters are not allowed in filenames.",
});
```

`regexGuard` returns a type error if the field value is not a string.

### `piiGuard(field, opts?)`

Scans a string value for common PII patterns. Blocks the call if any pattern is detected, unless the type is listed in `allowedTypes`.

Detected PII types:

| Type | Description |
|---|---|
| `email` | Standard email address format |
| `ssn` | US Social Security Number (`NNN-NN-NNNN`) |
| `credit-card` | Visa, Mastercard, Amex, Discover — with Luhn checksum validation |
| `phone-us` | North American Numbering Plan phone numbers |
| `ip-address` | IPv4 addresses |

```typescript
import { piiGuard } from "ai-tool-guard/guards";

// Reject any PII in a free-text query field.
piiGuard("query");

// Allow email addresses but block all other PII types.
piiGuard("recipient", { allowedTypes: ["email"] });
```

Credit card numbers are validated against the Luhn algorithm before a violation is raised. This eliminates false positives from numeric strings that happen to match the card number format but are not valid card numbers.

### Dot-path Field Access

The `field` string uses dot notation to address nested argument properties:

```typescript
// Accesses args.config.region
allowlist("config.region", ["us-east-1", "eu-west-1"]);

// Accesses args.user.email
piiGuard("user.email", { allowedTypes: ["email"] });
```

Traversal stops safely if any intermediate property is `null` or not an object. In that case the guard receives `undefined`. Most built-in guards treat `undefined` as a pass for optional fields; `zodGuard` applies the Zod schema and may reject it depending on whether the schema marks the field as required.

### Wildcard Field `"*"`

Setting `field: "*"` passes the entire `args` object — rather than a single field — to the `validate` function. Use this for cross-field rules or full-args inspection:

```typescript
import type { ArgGuard } from "ai-tool-guard";

const noEmptyArgs: ArgGuard = {
  field: "*",
  validate(args) {
    if (!args || Object.keys(args as object).length === 0) {
      return "Tool called with no arguments.";
    }
    return null;
  },
};
```

### Custom `ArgGuard` Interface

Implement `ArgGuard` directly for any logic not covered by the built-ins:

```typescript
import type { ArgGuard, PolicyContext } from "ai-tool-guard";

const domainAllowlistGuard: ArgGuard = {
  field: "url",
  async validate(value: unknown, ctx: PolicyContext): Promise<string | null> {
    if (typeof value !== "string") return null;
    const url = new URL(value);
    const allowed = (ctx.userAttributes.allowedDomains as string[]) ?? [];
    if (!allowed.includes(url.hostname)) {
      return `Domain "${url.hostname}" is not in your approved list.`;
    }
    return null;
  },
};
```

The `validate` function signature is:

```typescript
validate(value: unknown, ctx: PolicyContext): string | null | Promise<string | null>
```

Return a non-null string to block the call with that message. Return `null` to pass.

### `evaluateArgGuards(guards, ctx)`

The runner function that executes all guards and collects results:

```typescript
import { evaluateArgGuards } from "ai-tool-guard/guards";

const result = await evaluateArgGuards(guards, ctx);
// result.passed    — true if no violations
// result.violations — Array<{ field: string; message: string }>
```

Guards are always run to completion — all guards are evaluated even after a violation is found, so a single call can surface multiple violations at once.

## Advanced Examples

### Securing a Database Query Tool

Layer multiple guards to enforce types, restrict targets, and prevent PII leakage in query text:

```typescript
import { createToolGuard } from "ai-tool-guard";
import {
  allowlist,
  denylist,
  piiGuard,
  regexGuard,
  zodGuard,
} from "ai-tool-guard/guards";
import { z } from "zod";

const guard = createToolGuard();

const wrappedDbQuery = guard.guardTool("dbQuery", dbQueryTool, {
  riskLevel: "high",
  riskCategories: ["data-read"],
  argGuards: [
    // Only allow queries against known read replicas.
    allowlist("database", ["analytics_ro", "reporting_ro"]),

    // Restrict result size to prevent unbounded reads.
    zodGuard({
      field: "limit",
      schema: z.number().int().min(1).max(500),
    }),

    // Block queries that reference internal schema tables.
    denylist("table", ["pg_catalog", "information_schema"]),

    // Ensure query strings don't accidentally carry PII
    // (e.g., a user email embedded in a search filter).
    piiGuard("query"),

    // Prevent SQL comment injection.
    regexGuard("query", /--/, {
      mustMatch: false,
      message: "SQL comments are not permitted in query arguments.",
    }),
  ],
});
```

### Context-Aware Guard Using User Attributes

Guards receive the full `PolicyContext`, including `userAttributes`. Use this to apply per-tenant restrictions:

```typescript
import type { ArgGuard } from "ai-tool-guard";

const tenantScopedRegionGuard: ArgGuard = {
  field: "region",
  validate(value, ctx) {
    const allowed = ctx.userAttributes.allowedRegions as string[] | undefined;
    if (!allowed) return null; // No restriction configured for this tenant.
    if (!allowed.includes(value as string)) {
      return `Region "${value}" is not permitted for your account.`;
    }
    return null;
  },
};
```

### Cross-Field Validation with the Wildcard Guard

Use `field: "*"` when a rule requires inspecting multiple arguments together:

```typescript
import type { ArgGuard } from "ai-tool-guard";

const exportSizeGuard: ArgGuard = {
  field: "*",
  validate(args) {
    const a = args as { limit?: number; includeAttachments?: boolean };
    if (a.includeAttachments && (a.limit ?? 0) > 100) {
      return (
        "Cannot export more than 100 records when includeAttachments is true."
      );
    }
    return null;
  },
};
```

## How It Works

1. `evaluateArgGuards` iterates over the guards array in declaration order.
2. For each guard, the field value is extracted from `ctx.args` using dot-path traversal, or the entire `args` object is passed for `"*"`.
3. `guard.validate(value, ctx)` is called and awaited.
4. Any non-null return value is recorded as a `{ field, message }` violation.
5. After all guards run, the result is `{ passed: boolean, violations: Array<{ field: string; message: string }> }`.
6. If `passed` is `false`, the engine blocks the call, emits a denied `DecisionRecord`, and throws `ToolGuardError`.

!!! note "Guards do not short-circuit"
    All guards always run to completion. This means a single blocked call can report violations from multiple guards simultaneously, which is useful for surfacing all problems to the caller in one round trip.

## Related

- [API Reference — Guards](../api/guards.md)
- [Injection Detection](injection-detection.md)
- [Output Filtering](output-filtering.md)
- [Decision Records](decision-records.md)
