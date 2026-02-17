# Quick Start

Get your first guarded tool running in 5 minutes.

## Complete example

The following example shows a minimal but complete integration of `ai-tool-guard` with the Vercel AI SDK.

```ts
import { createToolGuard, defaultPolicy } from "ai-tool-guard";
import { generateText, tool } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

// 1. Define your tools as usual with the Vercel AI SDK.
const getWeather = tool({
  description: "Get the weather for a city",
  parameters: z.object({ city: z.string() }),
  execute: async ({ city }) => `Weather in ${city}: sunny, 72°F`,
});

const deleteUser = tool({
  description: "Delete a user account",
  parameters: z.object({ userId: z.string() }),
  execute: async ({ userId }) => `User ${userId} deleted`,
});

// 2. Create a guard with policy rules.
const guard = createToolGuard({
  rules: defaultPolicy(),
  onApprovalRequired: async (token) => {
    console.log(`Approval needed for ${token.toolName}:`, token.originalArgs);
    return { approved: true, approvedBy: "admin" };
  },
  onDecision: (record) => {
    console.log(`[${record.verdict}] ${record.toolName}: ${record.reason}`);
  },
});

// 3. Wrap tools with per-tool risk levels.
const tools = guard.guardTools({
  getWeather: { tool: getWeather, riskLevel: "low" },
  deleteUser: { tool: deleteUser, riskLevel: "high" },
});

// 4. Use with AI SDK as normal.
const result = await generateText({
  model: openai("gpt-4o"),
  tools,
  prompt: "What's the weather in Tokyo?",
});
```

## Step-by-step walkthrough

### Step 1 — Define tools

Define your tools exactly as you would without `ai-tool-guard`, using the Vercel AI SDK's `tool()` function. The guard wraps your tools non-destructively; your `execute` implementations remain unchanged.

### Step 2 — Create a guard instance

`createToolGuard()` accepts a configuration object with three main properties:

**`rules`**

A list of policy rules that determine what happens when a tool is called. `defaultPolicy()` provides a sensible baseline with the following behaviour:

| Risk level | Default verdict |
|------------|-----------------|
| `low` | Allow immediately |
| `medium` | Require human approval |
| `high` | Deny |
| `critical` | Deny |

You can replace or extend `defaultPolicy()` with your own rules. See [Policy Engine](../guides/policy-engine.md) for details.

**`onApprovalRequired`**

An async callback invoked when a tool call requires approval before execution. The callback receives an approval token containing the tool name and original arguments. It must return an object with `{ approved: boolean, approvedBy: string }`. Return `{ approved: false }` to deny the call at runtime.

This callback is your integration point for external approval systems — a Slack notification, an internal dashboard, or any other human-in-the-loop mechanism.

**`onDecision`**

A synchronous callback invoked after every policy evaluation. The decision record includes the tool name, the verdict (`allow`, `deny`, or `approve`), the reason string from the matching rule, and the sanitized arguments. Use this for audit logging, metrics, or debugging.

### Step 3 — Wrap tools with risk levels

`guard.guardTools()` accepts a map of named tool entries. Each entry pairs a tool definition with a `riskLevel` string that is used during policy evaluation.

```ts
const tools = guard.guardTools({
  getWeather: { tool: getWeather, riskLevel: "low" },
  deleteUser: { tool: deleteUser, riskLevel: "high" },
});
```

The object returned by `guardTools()` is a plain `Record<string, Tool>` that is fully compatible with the `tools` parameter of `generateText()`, `streamText()`, and other Vercel AI SDK functions. No adapter or conversion step is required.

### Step 4 — Use with the AI SDK as normal

Pass the wrapped tools to any Vercel AI SDK call. The guard middleware runs transparently inside each tool's `execute` function. From the SDK's perspective, the tools look identical to unguarded ones.

```ts
const result = await generateText({
  model: openai("gpt-4o"),
  tools,
  prompt: "What's the weather in Tokyo?",
});
```

## What just happened?

When the model invoked `getWeather` with `{ city: "Tokyo" }`, the following pipeline ran inside the guarded execute function:

**Injection detection**
The raw arguments were scanned for prompt injection patterns before any policy rule was evaluated. Arguments that trigger injection heuristics are rejected before they reach your `execute` implementation.

**Policy evaluation**
The rule list was evaluated in order. The first rule matching the tool name and risk level determined the verdict.

**Verdict for `getWeather` (low risk)**
`defaultPolicy()` maps `low` to `allow`, so the call was permitted immediately and forwarded to your `execute` function without interruption.

**Verdict for `deleteUser` (high risk)**
Had the model attempted to call `deleteUser`, `defaultPolicy()` would have mapped `high` to `deny`. The call would have been blocked and a denial reason returned to the model rather than executing the deletion.

**Decision record emitted**
`onDecision` was called with the verdict, tool name, reason string, and sanitized arguments. This fires for every tool call regardless of outcome, giving you a complete audit trail.

**OpenTelemetry spans**
If `@opentelemetry/api` is present in your project, `ai-tool-guard` automatically emits spans for each policy evaluation. No additional configuration is required.

## Next steps

- [Core Concepts](concepts.md) — understand the mental model behind guards, rules, and verdicts
- [Policy Engine](../guides/policy-engine.md) — write custom rules tailored to your application
- [Argument Validation](../guides/argument-validation.md) — validate and sanitize tool inputs before execution
- [Approval Workflows](../guides/approval-workflows.md) — implement human-in-the-loop approval for sensitive operations
