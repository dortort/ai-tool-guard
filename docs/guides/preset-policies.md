# Preset Policies

`ai-tool-guard` ships two preset policy functions and three builder functions that cover the most common access control patterns. Presets produce a `PolicyRule[]` array compatible with the `rules` option of `createToolGuard()` and can be composed freely.

## Overview

| Function | Purpose |
|---|---|
| `defaultPolicy()` | Risk-tier-based allow/approve/deny baseline. |
| `readOnlyPolicy(patterns)` | Allow specific read tools; deny everything else. |
| `allow(opts)` | Builder: create an allow rule. |
| `deny(opts)` | Builder: create a deny rule. |
| `requireApproval(opts)` | Builder: create a require-approval rule. |

## Basic Usage

### `defaultPolicy()`

Returns three rules that map each risk tier to a sensible default verdict:

| Risk level | Verdict |
|---|---|
| `low` | `allow` |
| `medium` | `require-approval` |
| `high` | `deny` |
| `critical` | `deny` |

```ts
import { createToolGuard, defaultPolicy } from "ai-tool-guard";

const guard = createToolGuard({
  rules: defaultPolicy(),
  onApprovalRequired: async (token) => {
    // Implement your approval channel here.
    return { approved: true, approvedBy: "ops-team" };
  },
});
```

All three rules use `priority: 0` and `toolPatterns: ["*"]`, so they act as a global baseline. Higher-priority custom rules take precedence due to escalation semantics.

### `readOnlyPolicy(readToolPatterns)`

Allows the tools whose names match any of the supplied glob patterns and denies every other tool call. Useful for read-only agents that must never write or delete data.

```ts
import { createToolGuard, readOnlyPolicy } from "ai-tool-guard";

const guard = createToolGuard({
  rules: readOnlyPolicy(["read*", "get*", "list*", "search*", "db.query"]),
});
```

The function produces two rules:

1. An `allow` rule at `priority: 10` matching the supplied patterns.
2. A `deny` rule at `priority: 0` matching `"*"` (catch-all).

Because the allow rule has higher priority, matching tools pass through before the catch-all deny is reached.

## Configuration Options

### `SimpleRuleOptions`

All three builder functions accept the same options object:

| Property | Type | Required | Description |
|---|---|---|---|
| `tools` | `string \| string[]` | Yes | Tool name glob pattern(s). A single string is treated as a one-element array. |
| `riskLevels` | `RiskLevel[]` | No | Restrict the rule to specific risk tiers. |
| `condition` | `(ctx: PolicyContext) => boolean \| Promise<boolean>` | No | Optional async predicate. |
| `description` | `string` | No | Human-readable description written to `DecisionRecord.reason`. |
| `priority` | `number` | No | Evaluation order. Higher values are evaluated first. Default `0`. |

Each builder auto-generates a stable `id` with a prefix indicating the verdict (`allow-N`, `deny-N`, `require-approval-N`).

## Advanced Examples

### Admin vs. Viewer Policies

Compose builders to produce role-specific policy bundles and select the right one at runtime:

```ts
import { allow, deny, requireApproval } from "ai-tool-guard";
import type { PolicyRule } from "ai-tool-guard";

function adminPolicy(): PolicyRule[] {
  return [
    allow({
      tools: "*",
      riskLevels: ["low", "medium"],
      description: "Admins may use low and medium risk tools freely.",
      priority: 10,
    }),
    requireApproval({
      tools: "*",
      riskLevels: ["high"],
      description: "High-risk tools require a second admin to approve.",
      priority: 10,
    }),
    deny({
      tools: "*",
      riskLevels: ["critical"],
      description: "Critical tools are blocked for everyone, including admins.",
      priority: 20,
    }),
  ];
}

function viewerPolicy(): PolicyRule[] {
  return [
    allow({
      tools: ["read*", "get*", "list*", "search*"],
      description: "Viewers may use read-only tools.",
      priority: 10,
    }),
    deny({
      tools: "*",
      description: "All other tools are denied for viewers.",
      priority: 0,
    }),
  ];
}

// Select the policy based on the current user's role.
const userRole = await resolveRole();
const rules = userRole === "admin" ? adminPolicy() : viewerPolicy();

const guard = createToolGuard({ rules });
```

### Environment-Specific Policies

Different environments often need different guard postures. Use environment variables to select a policy bundle:

```ts
import { defaultPolicy, allow, deny, requireApproval } from "ai-tool-guard";
import type { PolicyRule } from "ai-tool-guard";

function policyForEnvironment(env: string): PolicyRule[] {
  if (env === "production") {
    // Production: tight defaults, everything high-risk requires approval.
    return [
      ...defaultPolicy(),
      requireApproval({
        tools: "*",
        riskLevels: ["high"],
        description: "High-risk tools always require approval in production.",
        priority: 5,
      }),
    ];
  }

  if (env === "staging") {
    // Staging: allow high-risk tools so QA can test them without approval friction.
    return [
      allow({ tools: "*", riskLevels: ["low", "medium", "high"], priority: 5 }),
      deny({ tools: "*", riskLevels: ["critical"], priority: 10 }),
    ];
  }

  // Development: permit everything.
  return [allow({ tools: "*", description: "Allow all tools in development.", priority: 0 })];
}

const guard = createToolGuard({
  rules: policyForEnvironment(process.env.NODE_ENV ?? "development"),
});
```

### Extending `defaultPolicy()`

Add custom rules on top of the baseline by spreading the preset and appending higher-priority overrides:

```ts
import { defaultPolicy, deny, requireApproval } from "ai-tool-guard";

const rules = [
  // Override: always deny file-system tools, regardless of risk level.
  deny({
    tools: ["fs.*", "*File", "*Directory"],
    description: "Filesystem access is never permitted.",
    priority: 100,
  }),
  // Override: payment tools always require approval, even if marked low-risk.
  requireApproval({
    tools: "payment.*",
    description: "Payment tools always require explicit approval.",
    priority: 100,
  }),
  // Baseline for everything else.
  ...defaultPolicy(),
];
```

## How It Works

The builder functions (`allow`, `deny`, `requireApproval`) are thin wrappers around the `PolicyRule` interface. Each call increments a module-level counter to generate a unique `id` with a readable prefix. The auto-generated ID is recorded in `DecisionRecord.matchedRules` so you can trace which builder call produced a given decision.

`defaultPolicy()` and `readOnlyPolicy()` call these builders internally and return plain `PolicyRule[]` arrays — there is no special runtime type and no class hierarchy. This means the output can be spread, filtered, or sorted alongside rules you write by hand.

!!! note "Priority gaps leave room for overrides"
    The built-in presets use `priority: 0` (`defaultPolicy`) and `priority: 0` / `priority: 10` (`readOnlyPolicy`). This intentional gap means any rule you add at `priority: 5` or above will be evaluated before the preset catch-alls, giving you fine-grained override capability without having to replace the entire preset.

## Related

- [Policy Engine](policy-engine.md) — how rules are evaluated, matched, and escalated.
- [API Reference](../api/policy.md) — full type documentation for `PolicyRule` and builder signatures.
