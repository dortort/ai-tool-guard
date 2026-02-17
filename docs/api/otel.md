# OpenTelemetry — `ai-tool-guard/otel`

The OTel module provides tracer creation and pre-built span helpers for the main
guard pipeline stages. It depends on `@opentelemetry/api` as an optional peer
dependency; when the package is not installed, all functions return no-op
implementations that produce zero overhead.

```ts
import {
  createTracer,
  spanFromDecision,
  startToolExecutionSpan,
  startApprovalSpan,
  ATTR,
} from "ai-tool-guard/otel";
import type { Span, Tracer } from "ai-tool-guard/otel";
```

---

## Functions

### `createTracer`

```ts
function createTracer(config?: OtelConfig): Tracer
```

Obtain a tracer instance. If `@opentelemetry/api` is available in the runtime,
returns the real OTel tracer registered under the configured name. Otherwise
returns a no-op tracer.

The result is cached per tracer name to avoid repeated import attempts.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `config` | `OtelConfig` | No | OTel configuration options |

**Returns** `Tracer`

**Example**

```ts
const tracer = createTracer({ tracerName: "my-app", enabled: true });
const span = tracer.startSpan("custom.operation");
span.end();
```

---

### `spanFromDecision`

```ts
function spanFromDecision(
  tracer: Tracer,
  record: DecisionRecord,
  config?: OtelConfig,
): Span
```

Create and populate a span for a policy evaluation step. The span name is
`"ai_tool_guard.policy_eval"`. All standard decision attributes are set from the
`DecisionRecord`. If the verdict is `"deny"`, the span status is set to ERROR.

The caller is responsible for calling `span.end()` when the work is done.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `tracer` | `Tracer` | Yes | Tracer obtained from `createTracer()` |
| `record` | `DecisionRecord` | Yes | Decision record to read attributes from |
| `config` | `OtelConfig` | No | OTel config; `defaultAttributes` are merged into span attributes |

**Returns** `Span`

---

### `startToolExecutionSpan`

```ts
function startToolExecutionSpan(
  tracer: Tracer,
  toolName: string,
  config?: OtelConfig,
): Span
```

Create a span for the tool execution phase. The span name is
`"ai_tool_guard.tool_execute"`. Sets `ATTR.TOOL_NAME` on the span.

The caller is responsible for calling `span.end()` (and `span.setStatus()` on
error) when execution completes.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `tracer` | `Tracer` | Yes | Tracer instance |
| `toolName` | `string` | Yes | Name of the tool being executed |
| `config` | `OtelConfig` | No | OTel config; `defaultAttributes` are merged |

**Returns** `Span`

---

### `startApprovalSpan`

```ts
function startApprovalSpan(
  tracer: Tracer,
  toolName: string,
  tokenId: string,
  config?: OtelConfig,
): Span
```

Create a span that measures approval wait time. The span name is
`"ai_tool_guard.approval_wait"`. Sets `ATTR.TOOL_NAME` and
`ATTR.APPROVAL_TOKEN_ID` as initial attributes.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `tracer` | `Tracer` | Yes | Tracer instance |
| `toolName` | `string` | Yes | Name of the tool awaiting approval |
| `tokenId` | `string` | Yes | Approval token ID for correlation |
| `config` | `OtelConfig` | No | OTel config; `defaultAttributes` are merged |

**Returns** `Span`

---

## Constants

### `ATTR`

Object of 16 semantic attribute key strings. Import and use these constants when
setting span attributes to ensure consistent naming across services.

```ts
import { ATTR } from "ai-tool-guard/otel";
span.setAttribute(ATTR.DECISION_VERDICT, "deny");
```

| Key | String value |
|---|---|
| `ATTR.TOOL_NAME` | `"ai_tool_guard.tool.name"` |
| `ATTR.TOOL_RISK_LEVEL` | `"ai_tool_guard.tool.risk_level"` |
| `ATTR.TOOL_RISK_CATEGORIES` | `"ai_tool_guard.tool.risk_categories"` |
| `ATTR.DECISION_VERDICT` | `"ai_tool_guard.decision.verdict"` |
| `ATTR.DECISION_REASON` | `"ai_tool_guard.decision.reason"` |
| `ATTR.DECISION_MATCHED_RULES` | `"ai_tool_guard.decision.matched_rules"` |
| `ATTR.DECISION_DRY_RUN` | `"ai_tool_guard.decision.dry_run"` |
| `ATTR.APPROVAL_TOKEN_ID` | `"ai_tool_guard.approval.token_id"` |
| `ATTR.APPROVAL_APPROVED` | `"ai_tool_guard.approval.approved"` |
| `ATTR.APPROVAL_PATCHED` | `"ai_tool_guard.approval.patched"` |
| `ATTR.INJECTION_SCORE` | `"ai_tool_guard.injection.score"` |
| `ATTR.INJECTION_SUSPECTED` | `"ai_tool_guard.injection.suspected"` |
| `ATTR.RATE_LIMIT_ALLOWED` | `"ai_tool_guard.rate_limit.allowed"` |
| `ATTR.OUTPUT_REDACTED` | `"ai_tool_guard.output.redacted"` |
| `ATTR.OUTPUT_BLOCKED` | `"ai_tool_guard.output.blocked"` |
| `ATTR.MCP_DRIFT_DETECTED` | `"ai_tool_guard.mcp.drift_detected"` |

---

## Interfaces

### `Span`

Minimal span interface. The real OTel `Span` type satisfies this interface, as
does the no-op implementation used when `@opentelemetry/api` is absent.

```ts
interface Span {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: { code: number; message?: string }): void;
  end(): void;
}
```

| Method | Description |
|---|---|
| `setAttribute(key, value)` | Set a span attribute. Value must be a primitive. |
| `setStatus({ code, message? })` | Set the span status. Code `2` = ERROR, `1` = OK, `0` = UNSET. |
| `end()` | Finish the span and flush it to the exporter. |

---

### `Tracer`

Minimal tracer interface used to create spans.

```ts
interface Tracer {
  startSpan(
    name: string,
    options?: { attributes?: Record<string, string | number | boolean> },
  ): Span;
}
```

| Method | Description |
|---|---|
| `startSpan(name, options?)` | Start a new span with the given name and optional initial attributes. |

---

## Interface

### `OtelConfig`

Configuration for the OTel integration, passed to `createTracer()` and span
helpers.

| Field | Type | Required | Description |
|---|---|---|---|
| `enabled` | `boolean` | No | When `false`, all functions return no-op implementations regardless of whether `@opentelemetry/api` is installed. Default: `true` when OTel API is available |
| `tracerName` | `string` | No | Custom tracer name registered with OTel. Default: `"ai-tool-guard"` |
| `defaultAttributes` | `Record<string, string>` | No | Additional attributes merged into every span created by span helpers |
