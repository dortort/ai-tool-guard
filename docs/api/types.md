# All Types — `ai-tool-guard`

This page documents every exported type and interface from `src/types.ts`,
organized by domain. All of these are re-exported from the root `ai-tool-guard`
path.

```ts
import type {
  RiskLevel,
  RiskCategory,
  DecisionVerdict,
  DecisionRecord,
  PolicyContext,
  ConversationContext,
  PolicyRule,
  PolicyBackend,
  PolicyBackendResult,
  ToolGuardConfig,
  ArgGuard,
  ZodArgGuard,
  OutputFilterVerdict,
  OutputFilter,
  OutputFilterResult,
  ApprovalToken,
  ApprovalResolution,
  ApprovalHandler,
  RateLimitConfig,
  RateLimitState,
  InjectionDetectorConfig,
  McpToolFingerprint,
  McpDriftResult,
  McpDriftChange,
  OtelConfig,
  GuardOptions,
} from "ai-tool-guard";
```

---

## Risk

### `RiskLevel`

```ts
type RiskLevel = "low" | "medium" | "high" | "critical";
```

Assigned to tools or tool calls to indicate their potential impact. Used by
built-in policy rules to match calls and by `DecisionRecord` for audit.

| Value | Typical use |
|---|---|
| `"low"` | Read-only, idempotent, no side effects |
| `"medium"` | Writes to non-critical data, reversible |
| `"high"` | Irreversible writes, sensitive data access |
| `"critical"` | Payments, authentication, mass data operations |

---

### `RiskCategory`

```ts
type RiskCategory =
  | "data-read"
  | "data-write"
  | "data-delete"
  | "network"
  | "filesystem"
  | "authentication"
  | "payment"
  | "pii"
  | "custom";
```

Human-readable classification tags attached to tools for audit trails and
policy targeting. Multiple categories can be combined on a single tool.

---

## Decision

### `DecisionVerdict`

```ts
type DecisionVerdict = "allow" | "deny" | "require-approval";
```

The outcome of a policy evaluation.

| Value | Meaning |
|---|---|
| `"allow"` | The tool call may proceed |
| `"deny"` | The tool call is blocked; `ToolGuardError` with code `"policy-denied"` is thrown |
| `"require-approval"` | The call is paused pending human approval |

---

### `DecisionRecord`

Structured record produced for every policy evaluation. Emitted to
`GuardOptions.onDecision` and attached to `ToolGuardError.decision`.

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | Yes | Unique correlation ID (generated per evaluation) |
| `timestamp` | `string` | Yes | ISO-8601 timestamp of when the decision was made |
| `verdict` | `DecisionVerdict` | Yes | Final verdict |
| `toolName` | `string` | Yes | Name of the tool under evaluation |
| `matchedRules` | `string[]` | Yes | IDs of all policy rules that matched |
| `riskLevel` | `RiskLevel` | Yes | Effective risk level of the tool |
| `riskCategories` | `RiskCategory[]` | Yes | Risk categories that applied |
| `attributes` | `Record<string, unknown>` | Yes | Merged user and backend attributes consumed during evaluation |
| `reason` | `string` | Yes | Human-readable explanation of the verdict |
| `redactions` | `string[]` | No | Fields that were redacted in the output, if any |
| `evalDurationMs` | `number` | Yes | Time spent in policy evaluation in milliseconds |
| `dryRun` | `boolean` | Yes | Whether this was a simulation (dry-run) evaluation |

---

## Policy

### `PolicyContext`

Context passed into every policy evaluation. Constructed by `ToolGuard` for each
tool invocation.

| Field | Type | Required | Description |
|---|---|---|---|
| `toolName` | `string` | Yes | Name of the tool being invoked |
| `args` | `Record<string, unknown>` | Yes | Arguments the model wants to pass |
| `userAttributes` | `Record<string, unknown>` | Yes | Caller-supplied attributes resolved by `GuardOptions.resolveUserAttributes` |
| `conversation` | `ConversationContext` | No | Conversation-level metadata resolved by `GuardOptions.resolveConversationContext` |
| `dryRun` | `boolean` | No | When `true`, the engine is in simulation mode and tools are not executed |

---

### `ConversationContext`

Conversation-level metadata available to context-aware policies. Useful for
detecting escalating risk within a session (e.g., repeated failures, recent
approvals).

| Field | Type | Required | Description |
|---|---|---|---|
| `sessionId` | `string` | No | Unique conversation or session identifier |
| `riskScore` | `number` | No | Cumulative risk score for the conversation |
| `priorFailures` | `number` | No | Count of prior tool failures in this conversation |
| `recentApprovals` | `string[]` | No | Tool names approved earlier in this conversation |
| `metadata` | `Record<string, unknown>` | No | Arbitrary key-value bag for application-specific state |

---

### `PolicyRule`

Atomic unit of the built-in policy engine. For external DSL backends use
`PolicyBackend` instead.

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | Yes | Stable identifier used in `DecisionRecord.matchedRules` |
| `description` | `string` | No | Human-readable description recorded in the decision reason |
| `toolPatterns` | `string[]` | Yes | Glob patterns matched against `PolicyContext.toolName` (e.g. `"db.*"`, `"*"`) |
| `riskLevels` | `RiskLevel[]` | No | When set, the rule only matches tools whose effective risk level is in this list |
| `verdict` | `DecisionVerdict` | Yes | Action to take when this rule matches |
| `condition` | `(ctx: PolicyContext) => boolean \| Promise<boolean>` | No | Optional async predicate; the rule is skipped when it returns `false` |
| `priority` | `number` | No | Evaluation order: higher values are evaluated first. Default: `0` |

---

### `PolicyBackend`

Adapter interface for delegating policy decisions to an external engine such as
OPA (Open Policy Agent) or Cedar.

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Unique backend name used in logging and tracing |
| `evaluate` | `(ctx: PolicyContext) => Promise<PolicyBackendResult>` | Yes | Evaluate a tool invocation and return a verdict with explanation |

---

### `PolicyBackendResult`

The result returned by `PolicyBackend.evaluate()`.

| Field | Type | Required | Description |
|---|---|---|---|
| `verdict` | `DecisionVerdict` | Yes | The verdict from the external engine |
| `reason` | `string` | Yes | Human-readable explanation of the verdict |
| `matchedRules` | `string[]` | Yes | Rule IDs or names that matched within the external engine |
| `attributes` | `Record<string, unknown>` | No | Additional metadata merged into `DecisionRecord.attributes` |

---

## Tools

### `ToolGuardConfig`

Per-tool metadata attached via `ToolGuard.guardTool()` or `ToolGuard.guardTools()`.

| Field | Type | Required | Description |
|---|---|---|---|
| `riskLevel` | `RiskLevel` | No | Risk level of this tool |
| `riskCategories` | `RiskCategory[]` | No | Classification tags for audit and explainability |
| `rateLimit` | `RateLimitConfig` | No | Per-tool rate limit (overrides `GuardOptions.defaultRateLimit`) |
| `maxConcurrency` | `number` | No | Per-tool concurrency cap (overrides `GuardOptions.defaultMaxConcurrency`) |
| `argGuards` | `ArgGuard[]` | No | Argument-level validators run before policy evaluation |
| `outputFilters` | `OutputFilter[]` | No | Output filters applied after tool execution |
| `requireApproval` | `boolean` | No | When `true`, forces approval even if the policy verdict is `"allow"` |
| `mcpFingerprint` | `string` | No | Expected schema hash; execution is blocked when the computed hash differs |

---

## Guards

### `ArgGuard`

Interface for argument-level validators. Each guard targets a single field (or
all fields via `"*"`) and returns a failure message or `null`.

| Field | Type | Required | Description |
|---|---|---|---|
| `field` | `string` | Yes | Dot-path to the target argument field (e.g. `"user.email"`) or `"*"` for the whole args object |
| `validate` | `(value: unknown, ctx: PolicyContext) => string \| null \| Promise<string \| null>` | Yes | Validation function; return a string to deny with that reason, or `null` to pass |

---

### `ZodArgGuard`

Convenience shape for creating an `ArgGuard` backed by a Zod schema. Pass to
`zodGuard()` to produce an `ArgGuard`.

| Field | Type | Required | Description |
|---|---|---|---|
| `field` | `string` | Yes | Dot-path to the target argument field |
| `schema` | `z.ZodType` | Yes | Zod schema to validate the field value against |

---

## Output

### `OutputFilterVerdict`

```ts
type OutputFilterVerdict = "pass" | "redact" | "block";
```

Verdict returned by an `OutputFilter`.

| Value | Meaning |
|---|---|
| `"pass"` | Output is unchanged and safe to return |
| `"redact"` | Output has been modified (sensitive fields replaced) |
| `"block"` | Output must be suppressed entirely; `ToolGuardError` with code `"output-blocked"` is thrown |

---

### `OutputFilter`

Interface for output egress controls. Filters run sequentially after tool
execution and before the result is returned to the AI model.

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Identifier used in logging and `OutputFilterChainResult.blockedBy` |
| `filter` | `(result: unknown, ctx: PolicyContext) => Promise<OutputFilterResult>` | Yes | Inspect or transform the tool result |

---

### `OutputFilterResult`

Returned by `OutputFilter.filter()`.

| Field | Type | Required | Description |
|---|---|---|---|
| `verdict` | `OutputFilterVerdict` | Yes | Outcome: `"pass"`, `"redact"`, or `"block"` |
| `output` | `unknown` | Yes | The (possibly transformed) output to pass to the next filter or return |
| `redactedFields` | `string[]` | No | Names of fields that were redacted (recorded in the decision) |

---

## Approval

### `ApprovalToken`

Correlation token created by `ApprovalManager` and sent to the `ApprovalHandler`.

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | Yes | Randomly generated unique token ID |
| `payloadHash` | `string` | Yes | SHA-256 hash of the canonical `{ toolName, args }` payload for tamper detection |
| `toolName` | `string` | Yes | Name of the tool awaiting approval |
| `originalArgs` | `Record<string, unknown>` | Yes | Deep clone of the tool arguments at request time |
| `createdAt` | `string` | Yes | ISO-8601 timestamp of token creation |
| `ttlMs` | `number` | No | Token TTL in milliseconds; token is invalid if `elapsed > ttlMs` |

---

### `ApprovalResolution`

The response returned by the `ApprovalHandler` to `ApprovalManager`.

| Field | Type | Required | Description |
|---|---|---|---|
| `approved` | `boolean` | Yes | Whether the tool call is approved |
| `patchedArgs` | `Record<string, unknown>` | No | Partial argument overrides; merged with `originalArgs` when provided ("approve with edits") |
| `approvedBy` | `string` | No | Identity of the approver for audit records |
| `reason` | `string` | No | Human-readable reason for denial when `approved` is `false` |

---

### `ApprovalHandler`

```ts
type ApprovalHandler = (token: ApprovalToken) => Promise<ApprovalResolution>;
```

Callback type the consumer implements. Receives an `ApprovalToken` representing
the pending tool call, presents it to a human or automated approver, and resolves
with the decision.

---

## Rate Limiting

### `RateLimitConfig`

Configuration for per-tool rate limiting.

| Field | Type | Required | Description |
|---|---|---|---|
| `maxCalls` | `number` | Yes | Maximum calls allowed within the window |
| `windowMs` | `number` | Yes | Sliding window duration in milliseconds |
| `strategy` | `"reject" \| "queue"` | No | Backpressure strategy when limit is hit. `"reject"` returns immediately; `"queue"` blocks until a slot is available. Default: `"reject"` |

---

### `RateLimitState`

Internal sliding-window state maintained by `RateLimiter` for each tool.

| Field | Type | Description |
|---|---|---|
| `timestamps` | `number[]` | Unix timestamps (ms) of recent call acquisitions within the current window |
| `activeCalls` | `number` | Current count of in-flight calls for concurrency tracking |

---

## Injection

### `InjectionDetectorConfig`

Configuration for prompt injection detection.

| Field | Type | Required | Description |
|---|---|---|---|
| `threshold` | `number` | No | Suspicion score at or above which a call is flagged. Range 0–1. Default: `0.5` |
| `action` | `"downgrade" \| "deny" \| "log"` | No | Action taken when injection is suspected. `"downgrade"` converts the verdict to `"require-approval"`, `"deny"` blocks the call, `"log"` records but allows. Default: `"log"` |
| `detect` | `(args: Record<string, unknown>) => number \| Promise<number>` | No | Custom detector function; overrides the built-in heuristic. Return a suspicion score 0–1. |

---

## MCP

### `McpToolFingerprint`

Pinned schema fingerprint for a single MCP tool.

| Field | Type | Required | Description |
|---|---|---|---|
| `toolName` | `string` | Yes | Name of the tool |
| `serverId` | `string` | Yes | Identifier of the MCP server |
| `schemaHash` | `string` | Yes | SHA-256 hex hash of the canonicalized `{ toolName, schema }` object |
| `pinnedAt` | `string` | Yes | ISO-8601 timestamp of when the fingerprint was created |
| `environment` | `string` | No | Environment tag such as `"production"` or `"staging"` |

---

### `McpDriftResult`

Aggregate result returned by `detectDrift()`.

| Field | Type | Description |
|---|---|---|
| `drifted` | `boolean` | `true` when at least one tool has changed or is not pinned |
| `changes` | `McpDriftChange[]` | Detailed records for each changed or unpinned tool |

---

### `McpDriftChange`

Detail record for a single tool that has drifted from its pinned fingerprint.

| Field | Type | Description |
|---|---|---|
| `toolName` | `string` | Name of the changed tool |
| `serverId` | `string` | MCP server identifier |
| `expectedHash` | `string` | Pinned hash, or `"(not pinned)"` for tools without a stored fingerprint |
| `actualHash` | `string` | Currently computed hash |
| `remediation` | `string` | Human-readable description of what changed and recommended action |

---

## OTel

### `OtelConfig`

Configuration for the OpenTelemetry integration.

| Field | Type | Required | Description |
|---|---|---|---|
| `enabled` | `boolean` | No | Set to `false` to disable tracing entirely and use no-op spans. Default: `true` when `@opentelemetry/api` is available |
| `tracerName` | `string` | No | Tracer name registered with the OTel provider. Default: `"ai-tool-guard"` |
| `defaultAttributes` | `Record<string, string>` | No | Attributes merged into every span emitted by span helper functions |

---

## Top-level

### `GuardOptions`

The main configuration object passed to `createToolGuard()`. Controls all aspects
of the guard pipeline.

| Field | Type | Required | Description |
|---|---|---|---|
| `rules` | `PolicyRule[]` | No | Built-in policy rules evaluated for every tool call |
| `backend` | `PolicyBackend` | No | External policy backend (OPA, Cedar, custom); takes priority over built-in rules |
| `defaultRiskLevel` | `RiskLevel` | No | Fallback risk level for tools without explicit `ToolGuardConfig.riskLevel`. Default: `"low"` |
| `onApprovalRequired` | `ApprovalHandler` | No | Callback invoked when a policy verdict or tool config requires human approval |
| `injectionDetection` | `InjectionDetectorConfig` | No | Global injection detection applied to all tool calls |
| `defaultRateLimit` | `RateLimitConfig` | No | Default rate limit applied to all tools that do not specify their own |
| `defaultMaxConcurrency` | `number` | No | Default concurrency cap applied to all tools that do not specify their own |
| `otel` | `OtelConfig` | No | OpenTelemetry configuration |
| `dryRun` | `boolean` | No | When `true`, policy is evaluated and decisions are recorded, but tools are not executed |
| `onDecision` | `(record: DecisionRecord) => void \| Promise<void>` | No | Callback fired for every policy decision; use for logging, metrics, or audit trails |
| `resolveUserAttributes` | `() => Record<string, unknown> \| Promise<Record<string, unknown>>` | No | Async resolver called per invocation to populate `PolicyContext.userAttributes` |
| `resolveConversationContext` | `() => ConversationContext \| Promise<ConversationContext>` | No | Async resolver called per invocation to populate `PolicyContext.conversation` |
