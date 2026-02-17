# Decision Records

## Overview

Every tool call evaluation — whether it results in `allow`, `deny`, or `require-approval` — produces a `DecisionRecord`. This record is the primary observability artifact of ai-tool-guard. It captures the full context of the decision: which rules matched, what risk classifications applied, how long evaluation took, whether output was redacted, and a human-readable reason for the verdict.

Decision records are delivered via the `onDecision` callback in `GuardOptions`. They are also attached to `ToolGuardError` instances for policy-originated errors, and they map directly to OTel span attributes for trace-level visibility.

---

## The `DecisionRecord` Interface

```typescript
interface DecisionRecord {
  /** UUIDv4 identifier for this decision. Use for correlation across logs, spans, and alerts. */
  id: string;
  /** ISO-8601 timestamp of when the decision was made. */
  timestamp: string;
  /** The policy verdict: "allow", "deny", or "require-approval". */
  verdict: DecisionVerdict;
  /** Name of the tool that was evaluated. */
  toolName: string;
  /** IDs of all policy rules that matched and influenced the verdict. */
  matchedRules: string[];
  /** Risk level assigned to the tool at evaluation time. */
  riskLevel: RiskLevel;
  /** Risk categories that applied to this tool call. */
  riskCategories: RiskCategory[];
  /** Caller-supplied attributes available to the policy engine (user roles, tenant, etc.). */
  attributes: Record<string, unknown>;
  /** Human-readable explanation of the verdict. */
  reason: string;
  /** Field names redacted by output filters, if any. Present only when redaction occurred. */
  redactions?: string[];
  /** Wall-clock time spent in policy evaluation, in milliseconds. */
  evalDurationMs: number;
  /** Whether this was a dry-run evaluation (no tool was actually executed). */
  dryRun: boolean;
}
```

All 12 fields:

| Field | Type | Always Present | Description |
|---|---|---|---|
| `id` | `string` | Yes | UUIDv4 for correlation across systems. |
| `timestamp` | `string` | Yes | ISO-8601 datetime of the evaluation. |
| `verdict` | `"allow" \| "deny" \| "require-approval"` | Yes | The outcome of policy evaluation. |
| `toolName` | `string` | Yes | The tool that was evaluated. |
| `matchedRules` | `string[]` | Yes | IDs of rules that matched. Empty array means no rules matched (default verdict applied). |
| `riskLevel` | `"low" \| "medium" \| "high" \| "critical"` | Yes | Effective risk level used in evaluation. |
| `riskCategories` | `RiskCategory[]` | Yes | Classification tags for the tool call. |
| `attributes` | `Record<string, unknown>` | Yes | User-supplied context attributes available during evaluation. |
| `reason` | `string` | Yes | Human-readable verdict explanation. |
| `redactions` | `string[]` | No | Field names removed by output filters. Only present when redaction occurred. |
| `evalDurationMs` | `number` | Yes | Time spent in policy evaluation. Excludes tool execution time. |
| `dryRun` | `boolean` | Yes | `true` when the guard is in simulation or dry-run mode. |

---

## The `onDecision` Callback

Register a callback to receive every `DecisionRecord` as it is produced:

```typescript
import { createToolGuard } from 'ai-tool-guard';

const guard = createToolGuard({
  rules: [...],
  onDecision: async (record) => {
    // Called for every evaluation: allow, deny, and require-approval.
    console.log(`[${record.verdict}] ${record.toolName} — ${record.reason}`);
  },
});
```

The callback signature is:

```typescript
onDecision?: (record: DecisionRecord) => void | Promise<void>;
```

The callback is `await`ed before the guard pipeline continues, so errors thrown inside it propagate to the caller. If you want non-blocking side effects (e.g., fire-and-forget logging), resolve the promise yourself:

```typescript
onDecision: (record) => {
  // Do not await — fire and forget.
  writeToAuditLog(record).catch(console.error);
},
```

!!! warning
    `onDecision` is called on every verdict including `allow`. If your callback performs I/O, ensure it is fast or non-blocking. Slow callbacks will add latency to every tool call, including allowed ones.

---

## Use Cases

### Audit Logging

Write every decision to a structured log file for compliance and post-hoc analysis:

```typescript
import { createToolGuard } from 'ai-tool-guard';
import fs from 'node:fs';

const auditStream = fs.createWriteStream('audit.jsonl', { flags: 'a' });

const guard = createToolGuard({
  rules: [...],
  onDecision: (record) => {
    auditStream.write(JSON.stringify(record) + '\n');
  },
});
```

Each line in the output is a complete, self-contained JSON object. The `id` field enables joining these records with OTel spans, application logs, and approval system events.

### Alerting on Denials

Send denied decisions to an alerting system in real time:

```typescript
import { createToolGuard } from 'ai-tool-guard';
import { alerting } from './alerting.js';

const guard = createToolGuard({
  rules: [...],
  onDecision: async (record) => {
    if (record.verdict === 'deny') {
      await alerting.send({
        severity: record.riskLevel === 'critical' ? 'critical' : 'warning',
        title: `Tool blocked: ${record.toolName}`,
        body: record.reason,
        metadata: {
          decisionId: record.id,
          matchedRules: record.matchedRules,
          riskLevel: record.riskLevel,
          attributes: record.attributes,
        },
      });
    }
  },
});
```

### Compliance Reporting

Collect decision records for a compliance dashboard that tracks tool usage, risk distribution, and denial rates:

```typescript
import { createToolGuard } from 'ai-tool-guard';
import type { DecisionRecord } from 'ai-tool-guard';

const dailyStats = {
  total: 0,
  byVerdict: { allow: 0, deny: 0, 'require-approval': 0 },
  byRiskLevel: {} as Record<string, number>,
  evalDurationTotal: 0,
};

const guard = createToolGuard({
  rules: [...],
  onDecision: (record) => {
    dailyStats.total++;
    dailyStats.byVerdict[record.verdict]++;
    dailyStats.byRiskLevel[record.riskLevel] =
      (dailyStats.byRiskLevel[record.riskLevel] ?? 0) + 1;
    dailyStats.evalDurationTotal += record.evalDurationMs;
  },
});
```

### Combining with OTel Spans

The `id` field on each `DecisionRecord` is a UUIDv4 that can be attached to OTel spans as a custom attribute, enabling correlation between the structured audit log and distributed traces:

```typescript
import { createToolGuard } from 'ai-tool-guard';
import { createTracer, ATTR } from 'ai-tool-guard/otel';

const tracer = createTracer({ tracerName: 'my-service' });

const guard = createToolGuard({
  rules: [...],
  otel: { enabled: true },
  onDecision: (record) => {
    // Create a child span keyed to the decision ID.
    const span = tracer.startSpan('my_service.tool_decision', {
      attributes: {
        [ATTR.DECISION_VERDICT]: record.verdict,
        [ATTR.TOOL_NAME]: record.toolName,
        'decision.id': record.id,  // Correlates with audit log entries.
      },
    });
    span.end();
  },
});
```

---

## Field Details

### Correlation via `id`

The `id` is a UUIDv4 generated per evaluation. Use it as a foreign key when joining:

- Audit log entries (written via `onDecision`)
- OTel spans (attach as a custom attribute, as shown above)
- Approval system records (the `ApprovalToken` contains `toolName` and `originalArgs` for cross-referencing)
- `ToolGuardError.decision.id` for errors caught at the call site

### Duration Tracking via `evalDurationMs`

`evalDurationMs` measures wall-clock time from the start of `evaluatePolicy()` to the point the record is produced. It does not include:

- Time spent in `resolveUserAttributes()` or `resolveConversationContext()`
- Time spent waiting for approval (measured separately via the `approval_wait` OTel span)
- Tool execution time (measured via the `tool_execute` OTel span)

Use this field to detect slow policy rules, especially those with async `condition` callbacks calling external services.

### Redaction Tracking via `redactions`

When output filters redact fields from a tool result, the names of those fields are recorded in the `redactions` array on the decision record. This makes it possible to audit what data was removed even though the redacted values themselves are not stored.

```typescript
// Example: a decision record after output filtering.
const record = {
  id: 'a1b2c3d4-...',
  verdict: 'allow',
  toolName: 'queryUser',
  redactions: ['ssn', 'creditCardNumber'],
  // ...
};
```

`redactions` is `undefined` (not an empty array) when no redaction occurred, so `record.redactions?.length > 0` is the correct check.

---

## Advanced Examples

### Per-Tool Decision Aggregation

Track per-tool metrics for a usage analytics system:

```typescript
const toolStats = new Map<string, { calls: number; denials: number }>();

const guard = createToolGuard({
  rules: [...],
  onDecision: (record) => {
    const existing = toolStats.get(record.toolName) ?? { calls: 0, denials: 0 };
    existing.calls++;
    if (record.verdict === 'deny') existing.denials++;
    toolStats.set(record.toolName, existing);
  },
});

// Expose as a health check endpoint.
function getToolStats() {
  return Object.fromEntries(toolStats.entries());
}
```

### Decision Record Forwarding to External Audit System

Buffer and batch-send decision records to an external audit service:

```typescript
import { createToolGuard } from 'ai-tool-guard';
import type { DecisionRecord } from 'ai-tool-guard';

const buffer: DecisionRecord[] = [];

setInterval(async () => {
  if (buffer.length === 0) return;
  const batch = buffer.splice(0, buffer.length);
  await auditService.ingestBatch(batch);
}, 5000);

const guard = createToolGuard({
  rules: [...],
  onDecision: (record) => {
    buffer.push(record);
  },
});
```

---

## How It Works

1. The policy engine (`evaluatePolicy()`) runs all matching rules, applies the external backend if configured, and assembles a `DecisionRecord` with the final verdict, matched rule IDs, risk classification, and a reason string. The `evalDurationMs` is calculated using `performance.now()` around this evaluation.
2. The record's `id` is a randomly generated UUIDv4 produced per evaluation.
3. The guard calls `onDecision(record)` and awaits the result before proceeding to the verdict handling phase.
4. If the verdict is `deny` and the guard is not in dry-run mode, a `ToolGuardError` is thrown with `err.decision` set to the same record.
5. After tool execution completes and output filters run, any redacted field names are appended to `record.redactions`. The record passed to `onDecision` reflects the state at evaluation time, before output filtering — redactions are available on the error's decision record when output filtering occurs post-execution.

---

## Related

- [OpenTelemetry](opentelemetry.md)
- [Output Filtering](output-filtering.md)
- [API Reference — Types](../api/types.md)
