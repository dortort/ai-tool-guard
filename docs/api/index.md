# API Reference

This reference documents every public export from `ai-tool-guard`. The library is
distributed as a single npm package with six import paths, each focused on a
distinct concern.

## Module map

| Import path | Purpose |
|---|---|
| `ai-tool-guard` | Core guard factory, `ToolGuard` class, error types, and all re-exports |
| `ai-tool-guard/policy` | Policy rule builders, preset bundles, engine, and simulation |
| `ai-tool-guard/approval` | Approval lifecycle manager |
| `ai-tool-guard/guards` | Argument guards, injection detection, output filters, rate limiter |
| `ai-tool-guard/otel` | OpenTelemetry span helpers and semantic attribute constants |
| `ai-tool-guard/mcp` | MCP tool fingerprinting and drift detection |

All six paths are also re-exported from the root `ai-tool-guard` path, so you can
import everything from one place if you prefer:

```ts
import { createToolGuard, allow, deny, secretsFilter, ATTR } from "ai-tool-guard";
```

---

## Quick reference

### Core (`ai-tool-guard`)

| Export | Kind | Description |
|---|---|---|
| `createToolGuard` | function | Create a `ToolGuard` instance from options |
| `ToolGuard` | class | Wraps AI SDK tools with policy enforcement |
| `ToolGuardError` | class | Error thrown when a guard rejects a tool call |
| `ToolGuardErrorCode` | type | Union of 8 error code strings |
| `GuardOptions` | interface | Top-level configuration object |
| `ToolGuardConfig` | interface | Per-tool configuration metadata |
| `AiSdkTool` | interface | Minimal Vercel AI SDK tool shape |
| `ToolExecuteOptions` | interface | Options forwarded to the tool's execute function |
| `ToolWithConfig` | interface | `guardTools()` input entry: tool plus guard config |

### Policy (`ai-tool-guard/policy`)

| Export | Kind | Description |
|---|---|---|
| `evaluatePolicy` | function | Evaluate a tool call against rules and/or backend |
| `allow` | function | Build a rule that allows matching tools |
| `deny` | function | Build a rule that denies matching tools |
| `requireApproval` | function | Build a rule that requires approval |
| `defaultPolicy` | function | Preset: low=allow, medium=approval, high/critical=deny |
| `readOnlyPolicy` | function | Preset: allow listed patterns, deny everything else |
| `simulate` | function | Dry-run evaluation across a recorded trace |
| `PolicyRule` | interface | Atomic policy rule definition |
| `PolicyBackend` | interface | Adapter for external engines (OPA, Cedar) |
| `PolicyBackendResult` | interface | Result returned by a `PolicyBackend` |
| `PolicyContext` | interface | Context passed to every policy evaluation |
| `RecordedToolCall` | interface | A captured tool call for simulation |
| `SimulationResult` | interface | Aggregate result of a simulation run |

### Approval (`ai-tool-guard/approval`)

| Export | Kind | Description |
|---|---|---|
| `ApprovalManager` | class | Manages token lifecycle and handler invocation |
| `ApprovalFlowResult` | interface | Result of a full approval cycle |
| `ApprovalToken` | interface | Correlation token sent to the approval handler |
| `ApprovalResolution` | interface | Handler response (approved/denied/patched) |
| `ApprovalHandler` | type | Callback type for approval handlers |

### Guards (`ai-tool-guard/guards`)

| Export | Kind | Description |
|---|---|---|
| `zodGuard` | function | Create an `ArgGuard` from a Zod schema |
| `allowlist` | function | Field must equal one of the allowed values |
| `denylist` | function | Field must not equal any denied value |
| `regexGuard` | function | Field must (or must not) match a regex |
| `piiGuard` | function | Detect PII patterns in a string field |
| `evaluateArgGuards` | function | Run all argument guards for a tool call |
| `checkInjection` | function | Heuristic prompt injection scan |
| `secretsFilter` | function | Output filter that redacts common secrets |
| `piiOutputFilter` | function | Output filter that redacts PII |
| `customFilter` | function | Wrap a function as an `OutputFilter` |
| `runOutputFilters` | function | Execute a chain of output filters |
| `RateLimiter` | class | Sliding-window rate limiter with concurrency control |
| `ArgGuardResult` | interface | Result of running argument guards |
| `InjectionCheckResult` | interface | Injection scan outcome |
| `RedactionRule` | interface | Pattern-based redaction rule definition |
| `OutputFilterChainResult` | interface | Aggregate result of running a filter chain |
| `RateLimitAcquireResult` | interface | Outcome of a rate limit acquire attempt |

### OpenTelemetry (`ai-tool-guard/otel`)

| Export | Kind | Description |
|---|---|---|
| `createTracer` | function | Obtain a tracer (real OTel or no-op fallback) |
| `spanFromDecision` | function | Create a policy-evaluation span from a `DecisionRecord` |
| `startToolExecutionSpan` | function | Create a span for tool execution |
| `startApprovalSpan` | function | Create a span for approval wait time |
| `ATTR` | constant | Object of 16 semantic attribute key strings |
| `Span` | interface | Minimal span interface |
| `Tracer` | interface | Minimal tracer interface |
| `OtelConfig` | interface | OTel configuration options |

### MCP (`ai-tool-guard/mcp`)

| Export | Kind | Description |
|---|---|---|
| `computeFingerprint` | function | SHA-256 fingerprint of a tool schema |
| `pinFingerprint` | function | Create a `McpToolFingerprint` record |
| `detectDrift` | function | Compare current schemas against pinned fingerprints |
| `FingerprintStore` | class | In-memory fingerprint store with JSON import/export |
| `McpToolFingerprint` | interface | Pinned schema fingerprint record |
| `McpDriftResult` | interface | Aggregate drift detection result |
| `McpDriftChange` | interface | Individual changed-tool detail |

---

## Subpages

- [Core](./core.md)
- [Policy](./policy.md)
- [Approval](./approval.md)
- [Guards](./guards.md)
- [OpenTelemetry](./otel.md)
- [MCP](./mcp.md)
- [All Types](./types.md)
