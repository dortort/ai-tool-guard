# OpenTelemetry Integration

## Overview

ai-tool-guard emits structured OpenTelemetry spans for every significant stage of tool execution: policy evaluation, approval waiting, tool execution, injection detection, rate limiting, and output filtering. Spans are annotated with semantic attributes that map directly to the domain model, making traces immediately useful in tools like Jaeger, Grafana Tempo, or any OTLP-compatible backend.

OpenTelemetry support is entirely optional. `@opentelemetry/api` is a peer dependency. When it is not installed, the library uses an internal no-op tracer with zero overhead — no exceptions, no warnings, no branching in your application code.

---

## Basic Usage

Install the peer dependency alongside your OTel SDK setup:

```bash
npm install @opentelemetry/api
```

Enable tracing in `createToolGuard`:

```typescript
import { createToolGuard } from 'ai-tool-guard';

const guard = createToolGuard({
  rules: [...],
  otel: {
    enabled: true,
    tracerName: 'my-agent',
    defaultAttributes: {
      'service.name': 'my-ai-service',
      'deployment.environment': 'production',
    },
  },
});
```

ai-tool-guard picks up whatever OTel SDK and exporter you have configured globally. The library does not configure exporters itself.

---

## Configuration Options

The `otel` key in `GuardOptions` accepts an `OtelConfig` object:

```typescript
export interface OtelConfig {
  /** Whether tracing is enabled. Default: true when OTel API is available. */
  enabled?: boolean;
  /** Custom tracer name registered with the OTel TracerProvider. Default: "ai-tool-guard". */
  tracerName?: string;
  /** Additional span attributes merged into every span emitted by the library. */
  defaultAttributes?: Record<string, string>;
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `true` | Set to `false` to force the no-op tracer even when `@opentelemetry/api` is installed. |
| `tracerName` | `string` | `"ai-tool-guard"` | The name passed to `trace.getTracer()`. Appears in span instrumentation scope metadata. |
| `defaultAttributes` | `Record<string, string>` | `{}` | Static attributes merged into every span. Useful for service name, environment, tenant ID, etc. |

---

## Span Catalog

The library emits the following spans. All span names are prefixed with `ai_tool_guard.`.

| Span Name | When Emitted | Key Attributes |
|---|---|---|
| `ai_tool_guard.policy_eval` | After every policy evaluation, before the verdict is acted on | `tool.name`, `tool.risk_level`, `tool.risk_categories`, `decision.verdict`, `decision.reason`, `decision.matched_rules`, `decision.dry_run` |
| `ai_tool_guard.tool_execute` | Wraps the actual tool `execute()` call | `tool.name` |
| `ai_tool_guard.approval_wait` | Wraps the approval handler call for `require-approval` verdicts | `tool.name`, `approval.token_id`, `approval.approved`, `approval.patched` |
| `ai_tool_guard.injection_check` | When injection detection fires and a suspected injection is detected | `injection.score`, `injection.suspected` |
| `ai_tool_guard.rate_limit` | When a rate limit check rejects a call | `rate_limit.allowed` |
| `ai_tool_guard.output_filter` | When an output filter runs and either redacts or blocks the result | `output.redacted`, `output.blocked` |

!!! note
    The `policy_eval` span is set to error status (`SpanStatusCode.ERROR`) when the verdict is `deny`, making denied calls immediately visible in trace UIs without custom queries.

---

## Semantic Attribute Keys

All attribute keys are available via the exported `ATTR` constant object. Import it to avoid relying on raw strings:

```typescript
import { ATTR } from 'ai-tool-guard/otel';
```

The full set of 16 attributes:

| Constant | Attribute Key | Value Type | Description |
|---|---|---|---|
| `ATTR.TOOL_NAME` | `ai_tool_guard.tool.name` | `string` | Name of the guarded tool |
| `ATTR.TOOL_RISK_LEVEL` | `ai_tool_guard.tool.risk_level` | `string` | Evaluated risk level (`low`, `medium`, `high`, `critical`) |
| `ATTR.TOOL_RISK_CATEGORIES` | `ai_tool_guard.tool.risk_categories` | `string` | Comma-separated list of risk categories |
| `ATTR.DECISION_VERDICT` | `ai_tool_guard.decision.verdict` | `string` | `allow`, `deny`, or `require-approval` |
| `ATTR.DECISION_REASON` | `ai_tool_guard.decision.reason` | `string` | Human-readable explanation from the policy engine |
| `ATTR.DECISION_MATCHED_RULES` | `ai_tool_guard.decision.matched_rules` | `string` | Comma-separated matched rule IDs |
| `ATTR.DECISION_DRY_RUN` | `ai_tool_guard.decision.dry_run` | `boolean` | Whether this was a dry-run evaluation |
| `ATTR.APPROVAL_TOKEN_ID` | `ai_tool_guard.approval.token_id` | `string` | Approval token ID for correlation |
| `ATTR.APPROVAL_APPROVED` | `ai_tool_guard.approval.approved` | `boolean` | Whether the approval was granted |
| `ATTR.APPROVAL_PATCHED` | `ai_tool_guard.approval.patched` | `boolean` | Whether arguments were patched during approval |
| `ATTR.INJECTION_SCORE` | `ai_tool_guard.injection.score` | `number` | Suspicion score from 0 to 1 |
| `ATTR.INJECTION_SUSPECTED` | `ai_tool_guard.injection.suspected` | `boolean` | Whether a prompt injection was detected |
| `ATTR.RATE_LIMIT_ALLOWED` | `ai_tool_guard.rate_limit.allowed` | `boolean` | Whether the call was within rate limits |
| `ATTR.OUTPUT_REDACTED` | `ai_tool_guard.output.redacted` | `boolean` | Whether output fields were redacted |
| `ATTR.OUTPUT_BLOCKED` | `ai_tool_guard.output.blocked` | `boolean` | Whether the output was blocked entirely |
| `ATTR.MCP_DRIFT_DETECTED` | `ai_tool_guard.mcp.drift_detected` | `boolean` | Whether MCP schema drift was detected |

---

## Span Helper Functions

The following functions are exported from the tracing module for cases where you need to integrate with custom instrumentation.

### `createTracer(config?: OtelConfig): Tracer`

Attempts a dynamic `require('@opentelemetry/api')` using Node's `createRequire` for ESM compatibility. Returns the real OTel tracer if the package is available, or a no-op tracer otherwise. The result is cached after the first call for the same `tracerName`.

```typescript
import { createTracer } from 'ai-tool-guard/otel';

const tracer = createTracer({ tracerName: 'my-component' });
const span = tracer.startSpan('my.operation');
// ... do work ...
span.end();
```

### `spanFromDecision(tracer, record, config?): Span`

Creates an `ai_tool_guard.policy_eval` span populated from a `DecisionRecord`. The span status is set to ERROR when `record.verdict === 'deny'`. The caller is responsible for calling `.end()` on the returned span.

### `startToolExecutionSpan(tracer, toolName, config?): Span`

Creates an `ai_tool_guard.tool_execute` span for the given tool name. `defaultAttributes` from the config are merged in. Call `.end()` after the tool completes.

### `startApprovalSpan(tracer, toolName, tokenId, config?): Span`

Creates an `ai_tool_guard.approval_wait` span scoped to a specific token ID. Useful for measuring how long a human approval interaction takes.

---

## No-Op Behavior

When `@opentelemetry/api` is not installed, all tracing calls resolve to internal `NoopSpan` and `NoopTracer` instances whose methods are empty functions. There is no `try/catch` in the hot path — the import attempt happens once at guard construction time and the result is cached.

Setting `otel: { enabled: false }` explicitly forces the no-op tracer regardless of whether the package is installed. Use this in unit tests to eliminate any OTel initialization side effects.

!!! tip
    You do not need to guard OTel calls with `if (otelEnabled)` checks in your application code. The no-op tracer makes the same public interface available at zero cost.

---

## Advanced Examples

### Connecting to Jaeger

Configure the OTel Node SDK with an OTLP HTTP exporter before creating the guard. ai-tool-guard picks up the registered `TracerProvider` automatically.

```typescript
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { createToolGuard } from 'ai-tool-guard';

const sdk = new NodeSDK({
  serviceName: 'my-ai-service',
  traceExporter: new OTLPTraceExporter({
    url: 'http://localhost:4318/v1/traces',
  }),
});

sdk.start();

const guard = createToolGuard({
  rules: [...],
  otel: {
    enabled: true,
    tracerName: 'my-ai-service',
    defaultAttributes: {
      'deployment.environment': 'production',
    },
  },
});
```

### Custom Span Enrichment via `onDecision`

Use `onDecision` alongside `createTracer` to add application-specific attributes to child spans that the library does not produce by default:

```typescript
import { createToolGuard } from 'ai-tool-guard';
import { createTracer, ATTR } from 'ai-tool-guard/otel';

const tracer = createTracer({ tracerName: 'my-app-enrichment' });

const guard = createToolGuard({
  rules: [...],
  otel: { enabled: true },
  onDecision: (record) => {
    const span = tracer.startSpan('my_app.tool_decision', {
      attributes: {
        [ATTR.TOOL_NAME]: record.toolName,
        [ATTR.DECISION_VERDICT]: record.verdict,
        // Application-specific attributes beyond the default set.
        'my_app.tenant_id': String(record.attributes['tenantId'] ?? 'unknown'),
        'my_app.eval_ms': record.evalDurationMs,
      },
    });
    span.end();
  },
});
```

### Multi-Tenant Attribute Injection

Use `defaultAttributes` with a per-request guard factory to attach tenant context to every span:

```typescript
import { createToolGuard } from 'ai-tool-guard';

function createTenantGuard(tenantId: string) {
  return createToolGuard({
    rules: [...],
    otel: {
      enabled: true,
      defaultAttributes: {
        'tenant.id': tenantId,
        'service.name': 'ai-service',
      },
    },
  });
}
```

---

## How It Works

1. `createToolGuard` calls `createTracer(options.otel)`, which attempts `require('@opentelemetry/api')` once using `createRequire(import.meta.url)` for ESM/CJS compatibility, then caches the result.
2. During each tool invocation, the guard's internal pipeline calls the span helper functions at the appropriate stage.
3. Each helper opens a span with pre-populated attributes drawn from the `DecisionRecord` or the current tool call context, merging in `defaultAttributes` if configured.
4. Spans are ended immediately after their stage completes. The `tool_execute` span wraps the actual `execute()` call inside a `try/finally` block so it closes even on error.
5. The OTel SDK propagates spans to the configured exporter via its background batch processor, with no synchronous I/O in the hot path.

---

## Related

- [API Reference — OTel](../api/otel.md)
- [Decision Records](decision-records.md)
