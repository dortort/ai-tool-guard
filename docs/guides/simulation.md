# Simulation and Dry-Run

## Overview

ai-tool-guard provides two mechanisms for evaluating policies without executing real tools:

- **Global dry-run mode** — configure a `ToolGuard` instance with `dryRun: true` to intercept all tool calls and return a safe placeholder instead of running the underlying `execute()` function.
- **Batch simulation** — use the standalone `simulate()` function to replay a recorded trace of tool calls through a policy configuration, producing a full `SimulationResult` with per-call decisions and summary statistics.

These features are designed for policy testing before deployment, regression testing after policy changes, and analyzing audit traces to understand what would have been blocked.

---

## Basic Usage

### Global Dry-Run

Set `dryRun: true` on `createToolGuard`. All tools wrapped by this guard will return `{ dryRun: true, toolName, args }` instead of executing.

```typescript
import { createToolGuard } from 'ai-tool-guard';

const guard = createToolGuard({
  rules: [...],
  dryRun: true,
});

const tools = guard.guardTools({
  deleteRecord: { tool: deleteRecordTool, riskLevel: 'critical' },
});

// Safe to call — no deletion happens.
const result = await tools.deleteRecord.execute({ id: '123' }, execOptions);
// result => { dryRun: true, toolName: 'deleteRecord', args: { id: '123' } }
```

Policy evaluation still runs in dry-run mode. `DecisionRecord`s are produced and passed to `onDecision`, and OTel spans are emitted. The only thing skipped is the actual `execute()` call.

### Batch Simulation

Use `simulate()` to evaluate a recorded trace against a policy without any live tool calls:

```typescript
import { simulate } from 'ai-tool-guard/policy';
import type { RecordedToolCall } from 'ai-tool-guard/policy';

const trace: RecordedToolCall[] = [
  { toolName: 'readFile', args: { path: '/etc/passwd' } },
  { toolName: 'writeFile', args: { path: '/tmp/out.txt', content: 'hello' } },
  { toolName: 'deleteRecord', args: { id: '42' }, userAttributes: { role: 'admin' } },
];

const result = await simulate(trace, {
  rules: [
    {
      id: 'block-sensitive-reads',
      toolPatterns: ['readFile'],
      verdict: 'deny',
      condition: (ctx) => String(ctx.args.path).startsWith('/etc/'),
    },
  ],
});

console.log(result.summary);
// { total: 3, allowed: 2, denied: 1, requireApproval: 0 }

for (const { toolCall, decision } of result.blocked) {
  console.log(`Blocked: ${toolCall.toolName} — ${decision.reason}`);
}
```

---

## `RecordedToolCall`

A `RecordedToolCall` represents one entry in a simulation trace:

```typescript
interface RecordedToolCall {
  /** Name of the tool that was (or would be) called. */
  toolName: string;
  /** Arguments the model supplied. */
  args: Record<string, unknown>;
  /** Optional override for user attributes during simulation. */
  userAttributes?: Record<string, unknown>;
}
```

The `userAttributes` field lets you replay the same tool call under different identity contexts — for example, to verify that an admin role bypasses a restriction that blocks regular users.

---

## `SimulationResult`

`simulate()` returns a `SimulationResult`:

```typescript
interface SimulationResult {
  /** Full decision records for every tool call in the trace, in order. */
  decisions: DecisionRecord[];
  /** Aggregate counts. */
  summary: {
    total: number;
    allowed: number;
    denied: number;
    requireApproval: number;
  };
  /**
   * Tool calls that would not have been allowed outright.
   * Includes both "deny" and "require-approval" verdicts.
   */
  blocked: Array<{
    toolCall: RecordedToolCall;
    decision: DecisionRecord;
  }>;
}
```

Every element in `decisions` corresponds to the `RecordedToolCall` at the same index in the input trace. The `blocked` array is a filtered view containing only the non-`allow` decisions, paired with their originating tool call for convenient reporting.

---

## `simulate()` Function Signature

```typescript
async function simulate(
  trace: RecordedToolCall[],
  options: GuardOptions,
  toolConfigs?: Record<string, ToolGuardConfig>,
): Promise<SimulationResult>
```

| Parameter | Type | Description |
|---|---|---|
| `trace` | `RecordedToolCall[]` | Ordered list of tool calls to evaluate. |
| `options` | `GuardOptions` | Policy configuration: rules, backend, risk level defaults, etc. |
| `toolConfigs` | `Record<string, ToolGuardConfig>` | Optional per-tool risk level and category overrides, keyed by tool name. |

All evaluations run with `dryRun: true` internally. The `options.dryRun` flag does not need to be set explicitly.

!!! note
    `simulate()` runs evaluations sequentially in trace order, not in parallel. This matches the serial execution model of a single-threaded agent and ensures that stateful policy rules (e.g., ones that accumulate failure counts) behave consistently.

---

## Use Cases

### Testing a Policy Before Deployment

Write a simulation test that asserts expected verdicts for known tool call patterns:

```typescript
import { simulate } from 'ai-tool-guard/policy';
import { productionPolicyOptions } from './policy-config.js';

const result = await simulate(
  [
    { toolName: 'executeSQL', args: { query: 'DROP TABLE users;' } },
    { toolName: 'executeSQL', args: { query: 'SELECT * FROM orders WHERE id = 1;' } },
  ],
  productionPolicyOptions,
  {
    executeSQL: { riskLevel: 'high', riskCategories: ['data-delete', 'data-read'] },
  },
);

// Assert the destructive query is blocked.
const [dropDecision, selectDecision] = result.decisions;
console.assert(dropDecision.verdict === 'deny');
console.assert(selectDecision.verdict === 'allow');
```

### Comparing Two Policy Configurations

Run the same trace through two different policy configurations and compare their outputs:

```typescript
import { simulate } from 'ai-tool-guard/policy';

const [resultA, resultB] = await Promise.all([
  simulate(productionTrace, policyConfigV1),
  simulate(productionTrace, policyConfigV2),
]);

const v1Denials = resultA.summary.denied;
const v2Denials = resultB.summary.denied;

console.log(`Policy V1 denied: ${v1Denials}`);
console.log(`Policy V2 denied: ${v2Denials}`);
console.log(`Delta: ${v2Denials - v1Denials} (${v2Denials > v1Denials ? 'stricter' : 'more permissive'})`);
```

### Audit Analysis

Replay a recorded production trace to understand which calls would have been blocked by a new policy:

```typescript
import { simulate } from 'ai-tool-guard/policy';
import type { RecordedToolCall } from 'ai-tool-guard/policy';

// Load trace from audit log (e.g., written by onDecision callback).
const auditLog = JSON.parse(fs.readFileSync('audit.json', 'utf-8'));
const trace: RecordedToolCall[] = auditLog.map((entry: any) => ({
  toolName: entry.toolName,
  args: entry.args,
  userAttributes: entry.attributes,
}));

const result = await simulate(trace, newPolicyOptions);

console.log(`Replayed ${result.summary.total} calls.`);
console.log(`New policy would have blocked ${result.blocked.length} of them.`);

for (const { toolCall, decision } of result.blocked) {
  console.log(`  ${toolCall.toolName}: ${decision.reason}`);
}
```

---

## How It Works

1. `simulate()` iterates over the trace array sequentially.
2. For each `RecordedToolCall`, it constructs a `PolicyContext` with `dryRun: true` and the call's `userAttributes` (defaulting to `{}`).
3. It calls the internal `evaluatePolicy()` function with the context, the `GuardOptions`, and any per-tool config from `toolConfigs`.
4. The resulting `DecisionRecord` is collected. If the verdict is not `allow`, the call is also added to the `blocked` array.
5. After processing all calls, the summary counts are computed from the collected `decisions` array.

No approval handlers, rate limiters, injection detectors, or output filters run during simulation. Only the policy engine is invoked.

---

## Related

- [Policy Engine](policy-engine.md)
- [API Reference — Policy](../api/policy.md)
