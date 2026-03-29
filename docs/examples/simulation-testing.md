# Simulation & Testing

This example shows how to use the `simulate` function to validate policy rules against recorded tool call traces without executing any tools. This is useful for CI/CD pipelines, policy change review, and debugging unexpected denials.

---

## Scenario

You maintain a set of policy rules for an AI assistant. Before deploying a policy change, you want to replay historical tool call traces through the new rules and verify that the right calls are allowed, denied, or sent to approval.

---

## Recording tool call traces

A `RecordedToolCall` captures the tool name, arguments, and optional user attributes. You can build these from production logs, test fixtures, or manual definitions.

```ts title="lib/traces.ts"
import type { RecordedToolCall } from "ai-tool-guard/policy";

// A representative trace of tool calls from a typical user session.
export const sessionTrace: RecordedToolCall[] = [
  {
    toolName: "searchProducts",
    args: { query: "running shoes", limit: 10 },
  },
  {
    toolName: "getProductDetails",
    args: { productId: "prod-123" },
  },
  {
    toolName: "addToCart",
    args: { productId: "prod-123", quantity: 1 },
  },
  {
    toolName: "processPayment",
    args: { cartId: "cart-456", paymentMethod: "credit_card" },
    userAttributes: { role: "customer", plan: "free" },
  },
  {
    toolName: "deleteProduct",
    args: { productId: "prod-123" },
    userAttributes: { role: "admin" },
  },
];
```

---

## Running a simulation

Pass the trace and your policy rules to `simulate`. No tools are executed -- the function evaluates each call through the policy engine in dry-run mode and returns a structured result.

```ts title="scripts/simulate-policy.ts"
import { simulate } from "ai-tool-guard/policy";
import { allow, deny, requireApproval } from "ai-tool-guard/policy";
import { sessionTrace } from "../lib/traces";

const result = await simulate(sessionTrace, {
  rules: [
    // Read operations are always allowed.
    allow({
      tools: ["searchProducts", "getProductDetails"],
      description: "Read-only product tools are open to all users.",
      priority: 10,
    }),

    // Cart operations require a logged-in user.
    allow({
      tools: "addToCart",
      description: "Cart operations allowed for authenticated users.",
      condition: (ctx) => !!ctx.userAttributes["role"],
      priority: 10,
    }),

    // Payment requires approval.
    requireApproval({
      tools: "processPayment",
      description: "Payments require human approval.",
      priority: 20,
    }),

    // Destructive operations denied unless admin.
    deny({
      tools: "deleteProduct",
      description: "Only admins may delete products.",
      condition: (ctx) => ctx.userAttributes["role"] !== "admin",
      priority: 30,
    }),
    allow({
      tools: "deleteProduct",
      description: "Admins may delete products.",
      condition: (ctx) => ctx.userAttributes["role"] === "admin",
      priority: 25,
    }),
  ],
  defaultRiskLevel: "medium",
});

// --- Analyze results ---
console.log("Simulation summary:");
console.log(`  Total calls:       ${result.summary.total}`);
console.log(`  Allowed:           ${result.summary.allowed}`);
console.log(`  Denied:            ${result.summary.denied}`);
console.log(`  Require approval:  ${result.summary.requireApproval}`);
```

Output:

```
Simulation summary:
  Total calls:       5
  Allowed:           3
  Denied:            0
  Require approval:  1
```

!!! note "`deleteProduct` is allowed, not denied"
    The admin user's `deleteProduct` call matches the `allow` rule (priority 25) because the `deny` rule's condition (`role !== "admin"`) is false. The simulation confirms the policy works as intended for admin users.

---

## Inspecting blocked calls

The `blocked` array contains every call that was denied or sent to approval, paired with its decision record. Use this to debug unexpected policy behavior.

```ts title="scripts/inspect-blocked.ts"
// ... continuing from above ...

if (result.blocked.length > 0) {
  console.log("\nBlocked calls:");
  for (const { toolCall, decision } of result.blocked) {
    console.log(`  ${toolCall.toolName}:`);
    console.log(`    Verdict:  ${decision.verdict}`);
    console.log(`    Reason:   ${decision.reason}`);
    console.log(`    Rule:     ${decision.matchedRules[0] ?? "default"}`);
    console.log(`    Dry-run:  ${decision.dryRun}`);
  }
}
```

Output:

```
Blocked calls:
  processPayment:
    Verdict:  require-approval
    Reason:   Payments require human approval.
    Rule:     require-approval-1
    Dry-run:  true
```

---

## Using per-tool configs

Pass `toolConfigs` to assign risk levels and categories to specific tools. The simulation uses these when evaluating risk-level-scoped rules.

```ts title="scripts/simulate-with-configs.ts"
import { simulate, defaultPolicy } from "ai-tool-guard/policy";
import type { ToolGuardConfig } from "ai-tool-guard";

const toolConfigs: Record<string, ToolGuardConfig> = {
  searchProducts: { riskLevel: "low", riskCategories: ["data-read"] },
  getProductDetails: { riskLevel: "low", riskCategories: ["data-read"] },
  addToCart: { riskLevel: "medium", riskCategories: ["data-write"] },
  processPayment: { riskLevel: "high", riskCategories: ["payment"] },
  deleteProduct: { riskLevel: "critical", riskCategories: ["data-delete"] },
};

// Use the built-in default policy: low=allow, medium=approval, high/critical=deny.
const result = await simulate(
  [
    { toolName: "searchProducts", args: { query: "shoes" } },
    { toolName: "processPayment", args: { cartId: "c-1" } },
    { toolName: "deleteProduct", args: { productId: "p-1" } },
  ],
  { rules: defaultPolicy() },
  toolConfigs,
);

console.log(result.summary);
// { total: 3, allowed: 1, denied: 1, requireApproval: 1 }
//
// searchProducts (low)    → allow
// processPayment (high)   → deny
// deleteProduct (critical) → deny
```

---

## CI/CD integration

Run simulations as part of your CI pipeline to catch policy regressions before deployment.

```ts title="scripts/ci-policy-check.ts"
import { simulate, allow, deny } from "ai-tool-guard/policy";

// Load traces from a fixture file or production log export.
const traces = [
  { toolName: "readData", args: {} },
  { toolName: "writeData", args: { value: "test" } },
  { toolName: "deleteData", args: { id: "1" } },
];

const result = await simulate(traces, {
  rules: [
    allow({ tools: ["readData", "writeData"], priority: 10 }),
    deny({ tools: "deleteData", priority: 20 }),
  ],
});

// Assert expected outcomes.
const deleteDecision = result.decisions.find(
  (d) => d.toolName === "deleteData",
);

if (deleteDecision?.verdict !== "deny") {
  console.error("FAIL: deleteData should be denied by policy.");
  process.exit(1);
}

if (result.summary.denied !== 1) {
  console.error(`FAIL: expected 1 denial, got ${result.summary.denied}.`);
  process.exit(1);
}

console.log("PASS: All policy assertions met.");
```

Add to your CI configuration:

```yaml title=".github/workflows/ci.yml"
- name: Policy regression check
  run: npx tsx scripts/ci-policy-check.ts
```

---

## Related

- [Simulation & Dry-Run Guide](../guides/simulation.md) -- configuration reference and advanced patterns.
- [Policy Engine](../guides/policy-engine.md) -- rule matching, priority, and condition predicates.
- [Preset Policies](../guides/preset-policies.md) -- `defaultPolicy()` and `readOnlyPolicy()`.
- [Decision Records](../guides/decision-records.md) -- `DecisionRecord` structure returned by simulation.
