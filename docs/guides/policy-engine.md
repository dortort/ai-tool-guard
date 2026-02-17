# Policy Engine

The policy engine is the core decision-making component of `ai-tool-guard`. It evaluates every tool call against a set of rules and an optional external backend, producing a `DecisionRecord` that explains why a call was allowed, denied, or sent for approval.

## Overview

When a guarded tool is invoked, the engine runs the following pipeline:

1. Resolve the tool's `riskLevel` (from per-tool config or `defaultRiskLevel`).
2. If a `PolicyBackend` is configured, delegate to it first.
3. Evaluate the built-in `PolicyRule` list in priority order.
4. Merge results using escalation semantics: `deny` > `require-approval` > `allow`.
5. Return a `DecisionRecord` capturing the verdict, matched rules, duration, and reason.

The default verdict when no rule matches is `"allow"`.

## Basic Usage

Pass an array of `PolicyRule` objects (or use a preset such as `defaultPolicy()`) when creating your guard:

```ts
import { createToolGuard, defaultPolicy } from "ai-tool-guard";

const guard = createToolGuard({
  rules: defaultPolicy(),
  onDecision: (record) => {
    console.log(`[${record.verdict}] ${record.toolName} — ${record.reason}`);
  },
});
```

Rules can also be written by hand:

```ts
import { createToolGuard } from "ai-tool-guard";
import type { PolicyRule } from "ai-tool-guard";

const rules: PolicyRule[] = [
  {
    id: "deny-delete-tools",
    description: "Block all deletion tools unconditionally.",
    toolPatterns: ["*delete*", "*remove*", "*drop*"],
    verdict: "deny",
    priority: 100,
  },
  {
    id: "allow-reads",
    description: "Allow all read-only tools.",
    toolPatterns: ["read*", "get*", "list*", "search*"],
    verdict: "allow",
    priority: 10,
  },
];

const guard = createToolGuard({ rules });
```

## Configuration Options

### `PolicyRule`

| Property | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | Yes | Stable identifier included in `DecisionRecord.matchedRules`. |
| `toolPatterns` | `string[]` | Yes | Glob patterns matched against the tool name. |
| `verdict` | `DecisionVerdict` | Yes | One of `"allow"`, `"deny"`, or `"require-approval"`. |
| `riskLevels` | `RiskLevel[]` | No | When set, the rule only applies to tools at these risk levels. |
| `condition` | `(ctx: PolicyContext) => boolean \| Promise<boolean>` | No | Predicate for attribute- or context-based matching. Supports async. |
| `priority` | `number` | No | Evaluation order. Higher values are evaluated first. Default `0`. |
| `description` | `string` | No | Human-readable description recorded in `DecisionRecord.reason`. |

### Glob Pattern Matching

Tool names are matched against each pattern in `toolPatterns` using a minimal glob matcher. The pattern is anchored at both ends.

| Wildcard | Matches |
|---|---|
| `*` | Any sequence of characters, including the empty string. |
| `?` | Exactly one character. |

```ts
"*"          // matches every tool name
"db.*"       // matches "db.query", "db.insert", "db.delete"
"read*"      // matches "readFile", "readStream" but not "canRead"
"*File"      // matches "readFile", "writeFile", "deleteFile"
"get?sers"   // matches "getUsers"; the ? substitutes exactly one character
```

!!! tip "Dot characters are literal"
    The dot (`.`) in a glob pattern matches a literal dot, not any character. Use `db.*` to match namespaced tool names such as `db.query` without matching `dbquery`.

### Risk Level Filtering

When `riskLevels` is set on a rule, the rule is skipped for tools that do not match one of the listed levels:

```ts
const rules: PolicyRule[] = [
  {
    id: "approve-medium-risk",
    toolPatterns: ["*"],
    riskLevels: ["medium"],
    verdict: "require-approval",
    priority: 0,
  },
];
```

If `riskLevels` is omitted, the rule applies to tools at any risk level.

### Priority and Escalation

Rules are sorted by `priority` in descending order before evaluation. All matching rules are collected, and the most restrictive verdict wins across all matches:

```
deny  >  require-approval  >  allow
```

A high-priority `allow` rule does **not** suppress a lower-priority `deny` rule if both match. The engine accumulates every match and selects the strictest outcome.

!!! info "All matched rules are recorded"
    `DecisionRecord.matchedRules` lists every rule that matched, not only the one that determined the final verdict. This gives you a complete audit trail even when escalation occurs across multiple rules.

## Advanced Examples

### Role-Based Access Control

Use `userAttributes` combined with a `condition` predicate to restrict tools based on the caller's role:

```ts
import { createToolGuard } from "ai-tool-guard";
import type { PolicyRule } from "ai-tool-guard";

const rules: PolicyRule[] = [
  {
    id: "deny-admin-tools-for-non-admins",
    description: "Block billing and admin tools for callers without the admin role.",
    toolPatterns: ["billing.*", "admin.*"],
    verdict: "deny",
    priority: 50,
    condition: (ctx) => {
      const roles = ctx.userAttributes["roles"] as string[] | undefined;
      return !roles?.includes("admin");
    },
  },
  {
    id: "allow-admin-tools-for-admins",
    description: "Admins may use billing and admin tools.",
    toolPatterns: ["billing.*", "admin.*"],
    verdict: "allow",
    priority: 60,
    condition: (ctx) => {
      const roles = ctx.userAttributes["roles"] as string[] | undefined;
      return roles?.includes("admin") ?? false;
    },
  },
];

const guard = createToolGuard({
  rules,
  resolveUserAttributes: async () => {
    return { roles: await getCurrentUserRoles() };
  },
});
```

### Time-Based Restrictions

Async conditions let you query external data sources, including time-sensitive business logic:

```ts
import type { PolicyRule } from "ai-tool-guard";

const businessHoursOnly: PolicyRule = {
  id: "business-hours-only",
  description: "Block payment tools outside of UTC 09:00–17:00.",
  toolPatterns: ["payment.*", "charge*", "refund*"],
  verdict: "deny",
  priority: 80,
  condition: async (_ctx) => {
    const hour = new Date().getUTCHours();
    // Return true (condition met → rule fires) when outside business hours.
    return hour < 9 || hour >= 17;
  },
};
```

### Conversation-Aware Escalation

Rules can inspect the conversation context to tighten policy after repeated failures in a session:

```ts
import type { PolicyRule } from "ai-tool-guard";

const escalateAfterFailures: PolicyRule = {
  id: "escalate-on-repeated-failures",
  description: "Require approval for any tool after 3 prior failures in a session.",
  toolPatterns: ["*"],
  verdict: "require-approval",
  priority: 200,
  condition: (ctx) => {
    return (ctx.conversation?.priorFailures ?? 0) >= 3;
  },
};
```

## How It Works

The evaluation function `evaluatePolicy` (in `src/policy/engine.ts`) runs in this sequence:

1. **Risk resolution** — The tool's `riskLevel` is taken from `ToolGuardConfig.riskLevel`, falling back to `GuardOptions.defaultRiskLevel`, then to `"low"` if neither is set.

2. **External backend** — If `GuardOptions.backend` is configured, `backend.evaluate(ctx)` is called and its result seeds the initial `verdict`, `reason`, `matchedRules`, and `attributes` fields on the record.

3. **Built-in rules** — The rules array is sorted by `priority` descending. Each rule is tested in turn: glob match against `toolName`, then risk level filter, then the optional async `condition` predicate. Every matching rule is collected.

4. **Escalation merge** — The built-in rules result is compared to the backend result. If the rules verdict is stricter, it replaces the backend verdict. Matched rule IDs from both sources are merged into `DecisionRecord.matchedRules`.

5. **DecisionRecord construction** — A complete record is assembled with a unique `id`, ISO-8601 `timestamp`, final `verdict`, human-readable `reason`, merged `attributes`, `evalDurationMs`, and `dryRun` flag.

!!! warning "The default verdict is allow"
    If no rule matches and no backend is configured, the verdict is `"allow"`. Deploy `defaultPolicy()` or an explicit catch-all deny rule to avoid unintentional permissiveness in production environments.

## Related

- [Preset Policies](preset-policies.md) — ready-made rule bundles for common scenarios.
- [External Backends](external-backends.md) — delegate decisions to OPA, Cedar, or a custom service.
- [API Reference](../api/policy.md) — full type documentation for `PolicyRule`, `PolicyContext`, and `DecisionRecord`.
