# Policy — `ai-tool-guard/policy`

The policy module provides the rule evaluation engine, ergonomic rule builders,
preset bundles, and a simulation runner for dry-run analysis.

```ts
import {
  evaluatePolicy,
  allow,
  deny,
  requireApproval,
  defaultPolicy,
  readOnlyPolicy,
  simulate,
} from "ai-tool-guard/policy";
```

---

## Functions

### `evaluatePolicy`

```ts
async function evaluatePolicy(
  ctx: PolicyContext,
  options: GuardOptions,
  toolConfig?: { riskLevel?: RiskLevel; riskCategories?: RiskCategory[] },
): Promise<DecisionRecord>
```

Evaluate a tool call against the configured policy rules and/or external backend.

**Evaluation order:**

1. If a `PolicyBackend` is configured, delegate to it first.
2. Evaluate built-in `PolicyRule` entries in descending priority order.
3. Merge results using severity escalation: `deny` > `require-approval` > `allow`.
4. If no rule matches, default to `"allow"`.

The result is always a full `DecisionRecord` regardless of verdict.

**Parameters**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `ctx` | `PolicyContext` | Yes | Tool call context: name, args, user attributes, conversation |
| `options` | `GuardOptions` | Yes | Guard configuration containing rules and/or backend |
| `toolConfig` | `{ riskLevel?: RiskLevel; riskCategories?: RiskCategory[] }` | No | Per-tool risk metadata used when evaluating risk-level-based rules |

**Returns** `Promise<DecisionRecord>`

---

### `allow`

```ts
function allow(opts: {
  tools: string | string[];
  riskLevels?: RiskLevel[];
  condition?: (ctx: PolicyContext) => boolean | Promise<boolean>;
  description?: string;
  priority?: number;
}): PolicyRule
```

Create a `PolicyRule` with verdict `"allow"`.

**Parameters**

| Field | Type | Required | Description |
|---|---|---|---|
| `tools` | `string \| string[]` | Yes | Tool name glob pattern(s). Use `"*"` for all tools. |
| `riskLevels` | `RiskLevel[]` | No | Restrict to tools with these risk levels |
| `condition` | `(ctx: PolicyContext) => boolean \| Promise<boolean>` | No | Predicate for attribute-based matching |
| `description` | `string` | No | Human-readable description recorded in the decision |
| `priority` | `number` | No | Higher values are evaluated first. Default: `0` |

**Returns** `PolicyRule`

---

### `deny`

```ts
function deny(opts: {
  tools: string | string[];
  riskLevels?: RiskLevel[];
  condition?: (ctx: PolicyContext) => boolean | Promise<boolean>;
  description?: string;
  priority?: number;
}): PolicyRule
```

Create a `PolicyRule` with verdict `"deny"`. Same options shape as `allow()`.

**Returns** `PolicyRule`

---

### `requireApproval`

```ts
function requireApproval(opts: {
  tools: string | string[];
  riskLevels?: RiskLevel[];
  condition?: (ctx: PolicyContext) => boolean | Promise<boolean>;
  description?: string;
  priority?: number;
}): PolicyRule
```

Create a `PolicyRule` with verdict `"require-approval"`. Same options shape as
`allow()`.

**Returns** `PolicyRule`

---

### `defaultPolicy`

```ts
function defaultPolicy(): PolicyRule[]
```

Return a preset rule bundle with three rules:

- `allow` all tools with `riskLevel: "low"`
- `requireApproval` for tools with `riskLevel: "medium"`
- `deny` tools with `riskLevel: "high"` or `"critical"`

All three rules use `tools: "*"` and `priority: 0`.

**Returns** `PolicyRule[]`

**Example**

```ts
const guard = createToolGuard({
  rules: defaultPolicy(),
  onApprovalRequired: async (token) => handleApproval(token),
});
```

---

### `readOnlyPolicy`

```ts
function readOnlyPolicy(readToolPatterns: string[]): PolicyRule[]
```

Return a two-rule bundle that allows a specified set of read-only tools and denies
everything else.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `readToolPatterns` | `string[]` | Yes | Glob patterns for tools that should be allowed |

**Returns** `PolicyRule[]` — `[allow({ tools: readToolPatterns, priority: 10 }), deny({ tools: "*", priority: 0 })]`

**Example**

```ts
const guard = createToolGuard({
  rules: readOnlyPolicy(["db.query", "fs.read*"]),
});
```

---

### `simulate`

```ts
async function simulate(
  trace: RecordedToolCall[],
  options: GuardOptions,
  toolConfigs?: Record<string, ToolGuardConfig>,
): Promise<SimulationResult>
```

Run a dry-run policy evaluation over a recorded trace of tool calls. No tools are
executed. Every call produces a `DecisionRecord` with `dryRun: true`.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `trace` | `RecordedToolCall[]` | Yes | Sequence of recorded tool calls to evaluate |
| `options` | `GuardOptions` | Yes | The policy configuration to evaluate against |
| `toolConfigs` | `Record<string, ToolGuardConfig>` | No | Per-tool risk metadata for the simulation |

**Returns** `Promise<SimulationResult>`

**Example**

```ts
const result = await simulate(recordedCalls, { rules: defaultPolicy() });
console.log(result.summary);
// { total: 10, allowed: 7, denied: 2, requireApproval: 1 }
```

---

## Interfaces

### `PolicyRule`

Atomic unit of the built-in policy engine.

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | Yes | Stable identifier used in `DecisionRecord.matchedRules` |
| `description` | `string` | No | Human-readable explanation shown in decision records |
| `toolPatterns` | `string[]` | Yes | Glob patterns matched against `PolicyContext.toolName` |
| `riskLevels` | `RiskLevel[]` | No | If set, rule only matches tools with one of these risk levels |
| `verdict` | `DecisionVerdict` | Yes | Action to take: `"allow"`, `"deny"`, or `"require-approval"` |
| `condition` | `(ctx: PolicyContext) => boolean \| Promise<boolean>` | No | Optional async predicate; rule skipped when it returns `false` |
| `priority` | `number` | No | Evaluation order; higher = evaluated first. Default: `0` |

---

### `PolicyBackend`

Adapter interface for delegating decisions to an external policy engine such as
OPA or Cedar.

```ts
interface PolicyBackend {
  name: string;
  evaluate(ctx: PolicyContext): Promise<PolicyBackendResult>;
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Unique name used in logging and tracing |
| `evaluate` | `(ctx: PolicyContext) => Promise<PolicyBackendResult>` | Yes | Evaluate a tool invocation and return a verdict |

---

### `PolicyBackendResult`

Result returned by `PolicyBackend.evaluate()`.

| Field | Type | Required | Description |
|---|---|---|---|
| `verdict` | `DecisionVerdict` | Yes | The verdict from the external engine |
| `reason` | `string` | Yes | Human-readable explanation |
| `matchedRules` | `string[]` | Yes | Rule IDs or names that matched in the external engine |
| `attributes` | `Record<string, unknown>` | No | Additional attributes merged into the `DecisionRecord` |

---

### `PolicyContext`

Context passed into every policy evaluation.

| Field | Type | Required | Description |
|---|---|---|---|
| `toolName` | `string` | Yes | Name of the tool being invoked |
| `args` | `Record<string, unknown>` | Yes | Arguments the model wants to pass |
| `userAttributes` | `Record<string, unknown>` | Yes | Caller-supplied attributes (user id, roles, tenant, etc.) |
| `conversation` | `ConversationContext` | No | Conversation-level metadata for contextual policies |
| `dryRun` | `boolean` | No | When `true`, the engine is in simulation mode |

---

### `RecordedToolCall`

A captured tool call used as input to `simulate()`.

| Field | Type | Required | Description |
|---|---|---|---|
| `toolName` | `string` | Yes | Name of the tool |
| `args` | `Record<string, unknown>` | Yes | Arguments of the call |
| `userAttributes` | `Record<string, unknown>` | No | User attribute overrides for this simulation entry |

---

### `SimulationResult`

Aggregate output of `simulate()`.

| Field | Type | Description |
|---|---|---|
| `decisions` | `DecisionRecord[]` | All decision records produced, one per recorded call |
| `summary` | `{ total: number; allowed: number; denied: number; requireApproval: number }` | Counts by verdict |
| `blocked` | `Array<{ toolCall: RecordedToolCall; decision: DecisionRecord }>` | Calls that would have been denied or required approval |
