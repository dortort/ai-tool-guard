# Core — `ai-tool-guard`

The root import path is the primary integration point. It provides the guard
factory, the `ToolGuard` class, and the error type, together with re-exports of
every type defined in the library.

```ts
import { createToolGuard, ToolGuard, ToolGuardError } from "ai-tool-guard";
```

---

## Functions

### `createToolGuard`

```ts
function createToolGuard(options?: GuardOptions): ToolGuard
```

Create a `ToolGuard` instance. This is the recommended entry point.

**Parameters**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `options` | `GuardOptions` | No | Guard configuration. Defaults to an empty object (allow-all mode). |

**Returns** `ToolGuard`

**Example**

```ts
const guard = createToolGuard({
  rules: [deny({ tools: "dangerousTool" })],
  onApprovalRequired: async (token) => showModal(token),
  otel: { enabled: true },
});
```

---

## Classes

### `ToolGuard`

Wraps Vercel AI SDK tools with policy enforcement, argument validation, approval
flows, rate limiting, output filtering, and telemetry.

#### Constructor

```ts
new ToolGuard(options: GuardOptions)
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `options` | `GuardOptions` | Yes | Configuration for this guard instance |

#### Methods

##### `guardTool`

```ts
guardTool<TArgs extends Record<string, unknown>, TResult>(
  name: string,
  tool: AiSdkTool<TArgs, TResult>,
  config?: ToolGuardConfig,
): AiSdkTool<TArgs, TResult>
```

Wrap a single AI SDK tool with guard enforcement.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Tool name used in policy evaluation and error messages |
| `tool` | `AiSdkTool<TArgs, TResult>` | Yes | The original AI SDK tool object |
| `config` | `ToolGuardConfig` | No | Per-tool metadata: risk level, guards, rate limits, filters |

**Returns** `AiSdkTool<TArgs, TResult>` — the wrapped tool, compatible with `generateText({ tools })`.

If the tool has no `execute` function (e.g., a client-side tool), it is returned unchanged.

##### `guardTools`

```ts
guardTools<T extends Record<string, ToolWithConfig>>(
  toolMap: T,
): { [K in keyof T]: AiSdkTool }
```

Wrap multiple tools at once. Accepts a map of `{ toolName: { tool, ...config } }`
and returns a flat `{ toolName: guardedTool }` map.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `toolMap` | `T extends Record<string, ToolWithConfig>` | Yes | Map of tool names to tool + config entries |

**Returns** `{ [K in keyof T]: AiSdkTool }` — a map of guarded tools.

**Example**

```ts
const tools = guard.guardTools({
  readFile:  { tool: readFileTool,  riskLevel: "low" },
  writeFile: { tool: writeFileTool, riskLevel: "high" },
  deleteFile: { tool: deleteFileTool, riskLevel: "critical" },
});

const result = await generateText({ model, tools, prompt });
```

---

### `ToolGuardError`

Thrown by `ToolGuard` when a tool call is rejected at any stage of the pipeline.

#### Constructor

```ts
new ToolGuardError(
  message: string,
  code: ToolGuardErrorCode,
  toolName: string,
  decision?: DecisionRecord,
)
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `message` | `string` | Yes | Human-readable error description |
| `code` | `ToolGuardErrorCode` | Yes | Machine-readable error code |
| `toolName` | `string` | Yes | Name of the tool that was blocked |
| `decision` | `DecisionRecord` | No | The policy decision record, if available |

#### Properties

| Property | Type | Description |
|---|---|---|
| `name` | `string` | Always `"ToolGuardError"` |
| `code` | `ToolGuardErrorCode` | Machine-readable code indicating the rejection reason |
| `toolName` | `string` | Name of the tool that was blocked |
| `decision` | `DecisionRecord \| undefined` | Policy decision record for the rejection, if applicable |

**Example**

```ts
try {
  await generateText({ model, tools, prompt });
} catch (err) {
  if (err instanceof ToolGuardError) {
    console.error(err.code, err.toolName, err.decision?.reason);
  }
}
```

---

## Types

### `ToolGuardErrorCode`

```ts
type ToolGuardErrorCode =
  | "policy-denied"
  | "approval-denied"
  | "no-approval-handler"
  | "arg-validation-failed"
  | "injection-detected"
  | "rate-limited"
  | "output-blocked"
  | "mcp-drift";
```

| Code | When thrown |
|---|---|
| `"policy-denied"` | A policy rule or backend returned `"deny"` |
| `"approval-denied"` | The approval handler rejected the request |
| `"no-approval-handler"` | Approval required but no `onApprovalRequired` handler configured |
| `"arg-validation-failed"` | One or more argument guards failed |
| `"injection-detected"` | Injection score exceeded threshold and action is `"deny"` |
| `"rate-limited"` | The tool exceeded its rate or concurrency limit |
| `"output-blocked"` | An output filter returned verdict `"block"` |
| `"mcp-drift"` | Tool schema differs from its pinned fingerprint |

---

## Interfaces

### `GuardOptions`

Top-level configuration object passed to `createToolGuard()`.

| Field | Type | Required | Description |
|---|---|---|---|
| `rules` | `PolicyRule[]` | No | Built-in policy rules evaluated against every tool call |
| `backend` | `PolicyBackend` | No | External policy backend (OPA, Cedar, custom); evaluated before built-in rules |
| `defaultRiskLevel` | `RiskLevel` | No | Fallback risk level for tools without explicit config. Default: `"low"` |
| `onApprovalRequired` | `ApprovalHandler` | No | Callback invoked when a tool requires human approval |
| `injectionDetection` | `InjectionDetectorConfig` | No | Global injection detection settings |
| `defaultRateLimit` | `RateLimitConfig` | No | Default rate limit applied to all tools |
| `defaultMaxConcurrency` | `number` | No | Default concurrency cap applied to all tools |
| `otel` | `OtelConfig` | No | OpenTelemetry tracing configuration |
| `dryRun` | `boolean` | No | When `true`, policy is evaluated but tools are not executed |
| `onDecision` | `(record: DecisionRecord) => void \| Promise<void>` | No | Callback fired for every policy decision (allow, deny, or approval) |
| `resolveUserAttributes` | `() => Record<string, unknown> \| Promise<Record<string, unknown>>` | No | Resolver called per invocation to supply user attributes for policy context |
| `resolveConversationContext` | `() => ConversationContext \| Promise<ConversationContext>` | No | Resolver called per invocation to supply conversation metadata |

---

### `ToolGuardConfig`

Per-tool metadata attached via `guardTool()` or the `guardTools()` input map.

| Field | Type | Required | Description |
|---|---|---|---|
| `riskLevel` | `RiskLevel` | No | Risk level of this tool (`"low"` \| `"medium"` \| `"high"` \| `"critical"`) |
| `riskCategories` | `RiskCategory[]` | No | Classification tags for audit and explainability |
| `rateLimit` | `RateLimitConfig` | No | Per-tool rate limit (overrides `defaultRateLimit`) |
| `maxConcurrency` | `number` | No | Per-tool concurrency cap (overrides `defaultMaxConcurrency`) |
| `argGuards` | `ArgGuard[]` | No | Argument-level validators run before policy evaluation |
| `outputFilters` | `OutputFilter[]` | No | Output filters applied after tool execution |
| `requireApproval` | `boolean` | No | Force approval regardless of policy verdict |
| `mcpFingerprint` | `string` | No | Expected schema hash; execution is blocked on mismatch |

---

### `AiSdkTool`

Minimal structural interface matching the Vercel AI SDK `tool()` return shape.
The library depends on this structural type rather than importing from `ai`
directly, so it works across AI SDK versions.

```ts
interface AiSdkTool<TArgs = Record<string, unknown>, TResult = unknown> {
  description?: string;
  parameters: unknown;        // Zod schema
  execute?: (args: TArgs, options: ToolExecuteOptions) => Promise<TResult>;
  [key: string]: unknown;
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `description` | `string` | No | Human-readable tool description |
| `parameters` | `unknown` | Yes | Zod schema describing the tool's arguments |
| `execute` | `(args: TArgs, options: ToolExecuteOptions) => Promise<TResult>` | No | Tool implementation; absent for client-side tools |

---

### `ToolExecuteOptions`

Options forwarded to a tool's `execute` function by the AI SDK runtime.

| Field | Type | Required | Description |
|---|---|---|---|
| `toolCallId` | `string` | Yes | Unique identifier for this tool call invocation |
| `messages` | `unknown[]` | No | Conversation message history |
| `abortSignal` | `AbortSignal` | No | Signal to abort the tool call |

Additional keys are permitted (index signature `[key: string]: unknown`).

---

### `ToolWithConfig`

Input entry shape for `guardTools()`. Extends `ToolGuardConfig` with a required
`tool` field.

```ts
interface ToolWithConfig extends ToolGuardConfig {
  tool: AiSdkTool;
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `tool` | `AiSdkTool` | Yes | The original AI SDK tool to wrap |
| *(all `ToolGuardConfig` fields)* | — | No | Guard configuration for this tool |
