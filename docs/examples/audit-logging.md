# Complete Audit Trail

This example builds a comprehensive audit system on top of `ai-tool-guard`. Every decision — allow, deny, or require-approval — is written to a structured JSON lines log. Output filter redactions are tracked alongside policy decisions. OpenTelemetry spans are correlated with decision records. A simple alerting function detects repeated denials in the same session.

---

## Decision record structure

The `DecisionRecord` type captures the full context of every policy evaluation. Understanding its fields is the foundation of any audit system.

```ts
interface DecisionRecord {
  id: string;               // Unique ID for correlation with OTel spans and logs
  timestamp: string;        // ISO-8601 (e.g. "2026-02-17T14:23:01.123Z")
  verdict: "allow" | "deny" | "require-approval";
  toolName: string;
  matchedRules: string[];   // IDs of the rules that produced this verdict
  riskLevel: "low" | "medium" | "high" | "critical";
  riskCategories: string[]; // e.g. ["data-write", "pii"]
  attributes: Record<string, unknown>; // userAttributes snapshot
  reason: string;           // Human-readable explanation
  redactions?: string[];    // Output filter redaction trail
  evalDurationMs: number;   // Policy evaluation time in ms
  dryRun: boolean;
}
```

---

## Structured audit logger

The logger writes every decision to a JSON lines file, routing events through separate handlers for each verdict type.

```ts title="lib/audit-logger.ts"
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DecisionRecord } from "ai-tool-guard";

export interface AuditEvent {
  /** ISO-8601 write timestamp (may differ slightly from record.timestamp). */
  writtenAt: string;
  record: DecisionRecord;
}

export class AuditLogger {
  private readonly logPath: string;

  constructor(logPath: string) {
    this.logPath = logPath;
    mkdirSync(dirname(logPath), { recursive: true });
  }

  /** Write a decision record to the log. */
  write(record: DecisionRecord): void {
    const event: AuditEvent = {
      writtenAt: new Date().toISOString(),
      record,
    };

    try {
      appendFileSync(this.logPath, JSON.stringify(event) + "\n", {
        encoding: "utf8",
        flag: "a",
      });
    } catch (err) {
      // Audit failures must never crash the application.
      console.error("[audit] Write failed:", (err as Error).message, record.id);
    }
  }

  /** Handler for allowed decisions. */
  onAllow(record: DecisionRecord): void {
    if (record.redactions && record.redactions.length > 0) {
      console.info(
        `[audit:allow+redact] id=${record.id} tool=${record.toolName} ` +
          `redactions=${record.redactions.join(",")}`
      );
    }
    this.write(record);
  }

  /** Handler for denied decisions. */
  onDeny(record: DecisionRecord): void {
    console.warn(
      `[audit:deny] id=${record.id} tool=${record.toolName} ` +
        `rules=${record.matchedRules.join(",")} reason="${record.reason}"`
    );
    this.write(record);
  }

  /** Handler for approval-required decisions. */
  onApprovalRequired(record: DecisionRecord): void {
    console.info(
      `[audit:approval] id=${record.id} tool=${record.toolName} ` +
        `risk=${record.riskLevel}`
    );
    this.write(record);
  }

  /** Dispatch a record to the appropriate handler. */
  dispatch(record: DecisionRecord): void {
    switch (record.verdict) {
      case "allow":
        this.onAllow(record);
        break;
      case "deny":
        this.onDeny(record);
        break;
      case "require-approval":
        this.onApprovalRequired(record);
        break;
    }
  }
}

export const auditLogger = new AuditLogger("/var/log/tool-guard/decisions.jsonl");
```

---

## Alert on repeated denials

A session that accumulates multiple denials in a short window may indicate an adversarial prompt or a misconfigured model. The alerter reads recent denials from an in-memory ring buffer and fires when a threshold is crossed.

```ts title="lib/denial-alerter.ts"
import type { DecisionRecord } from "ai-tool-guard";

interface DenialEvent {
  toolName: string;
  timestamp: number;
  reason: string;
  decisionId: string;
}

export class DenialAlerter {
  /** Per-session denial ring buffers. */
  private readonly buffers = new Map<string, DenialEvent[]>();

  /** Threshold: fire an alert if this many denials occur within windowMs. */
  constructor(
    private readonly threshold: number = 3,
    private readonly windowMs: number = 60_000
  ) {}

  /**
   * Record a denial and fire the alert callback if the threshold is reached.
   */
  record(
    sessionId: string,
    record: DecisionRecord,
    onAlert: (sessionId: string, events: DenialEvent[]) => void
  ): void {
    if (record.verdict !== "deny") return;

    const now = Date.now();

    // Prune events outside the window.
    const buffer = (this.buffers.get(sessionId) ?? []).filter(
      (e) => now - e.timestamp < this.windowMs
    );

    buffer.push({
      toolName: record.toolName,
      timestamp: now,
      reason: record.reason,
      decisionId: record.id,
    });

    this.buffers.set(sessionId, buffer);

    if (buffer.length >= this.threshold) {
      onAlert(sessionId, [...buffer]);
    }
  }

  /** Clear the buffer for a session (e.g. after an alert is acknowledged). */
  clear(sessionId: string): void {
    this.buffers.delete(sessionId);
  }
}

export const denialAlerter = new DenialAlerter(3, 60_000);
```

---

## OpenTelemetry correlation

`ai-tool-guard` emits an `ai_tool_guard.policy_eval` span for every decision. The span carries `ai_tool_guard.tool.name` as an attribute, which you can use to correlate spans with decision records.

The example below creates the guard with OTel enabled and uses `spanFromDecision` directly in a custom wrapper to attach the decision ID to the span as an additional attribute.

```ts title="lib/otel-guard.ts"
import {
  createToolGuard,
  spanFromDecision,
  createTracer,
  allow,
  requireApproval,
  deny,
  type DecisionRecord,
} from "ai-tool-guard";
import { auditLogger } from "./audit-logger";
import { denialAlerter } from "./denial-alerter";

// Tracer shared with the rest of the application.
// The guard creates its own internal tracer via the otel config, but you
// can use createTracer to obtain the same tracer for manual instrumentation.
const tracer = createTracer({ tracerName: "ai-tool-guard" });

export function createAuditedGuard(sessionId: string) {
  return createToolGuard({
    rules: [
      allow({
        tools: ["readDocument", "searchDocuments"],
        riskLevels: ["low"],
        description: "Read operations are safe to execute autonomously.",
        priority: 10,
      }),
      requireApproval({
        tools: ["writeDocument", "deleteDocument"],
        riskLevels: ["medium", "high"],
        description: "Write and delete operations require approval.",
        priority: 20,
      }),
      deny({
        tools: "purgeAll",
        riskLevels: ["critical"],
        description: "Bulk purge is never permitted through the AI assistant.",
        priority: 100,
      }),
    ],

    defaultRiskLevel: "medium",

    otel: {
      enabled: true,
      tracerName: "ai-tool-guard",
      defaultAttributes: {
        "service.name": "document-assistant",
        "deployment.environment": "production",
        "session.id": sessionId,
      },
    },

    onApprovalRequired: async (token) => {
      console.info(`[approval] token=${token.id} tool=${token.toolName}`);
      return { approved: false, reason: "Approval workflow not configured." };
    },

    onDecision: (record: DecisionRecord) => {
      // 1. Dispatch to the structured audit logger.
      auditLogger.dispatch(record);

      // 2. Attach the decision ID to a new span for cross-signal correlation.
      //    When you search by decision ID in your log, you can find the
      //    corresponding trace by looking up this span in your OTel backend.
      const correlationSpan = tracer.startSpan("ai_tool_guard.decision_logged", {
        attributes: {
          "ai_tool_guard.decision.id": record.id,
          "ai_tool_guard.tool.name": record.toolName,
          "ai_tool_guard.decision.verdict": record.verdict,
          "session.id": sessionId,
        },
      });
      correlationSpan.end();

      // 3. Alert on repeated denials.
      denialAlerter.record(sessionId, record, (sid, events) => {
        console.error(
          `[ALERT] Session ${sid} has ${events.length} denials in 60 s: ` +
            events.map((e) => e.toolName).join(", ")
        );

        // Emit an alert span that will appear in your trace backend.
        const alertSpan = tracer.startSpan("ai_tool_guard.denial_alert", {
          attributes: {
            "session.id": sid,
            "alert.denial_count": events.length,
            "alert.tools": events.map((e) => e.toolName).join(","),
          },
        });
        alertSpan.end();
      });
    },
  });
}
```

---

## Querying the audit log

The JSON lines format makes the log easy to parse with standard tools or a simple query function.

```ts title="lib/audit-query.ts"
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { AuditEvent } from "./audit-logger";

/**
 * Read all decisions from the log file and apply an optional predicate.
 */
export async function queryAuditLog(
  logPath: string,
  predicate?: (event: AuditEvent) => boolean
): Promise<AuditEvent[]> {
  const results: AuditEvent[] = [];

  const rl = createInterface({
    input: createReadStream(logPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as AuditEvent;
      if (!predicate || predicate(event)) {
        results.push(event);
      }
    } catch {
      // Skip malformed lines.
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Example queries
// ---------------------------------------------------------------------------

/** All denials for a specific session. */
export async function getDenialsForSession(
  logPath: string,
  sessionId: string
): Promise<AuditEvent[]> {
  return queryAuditLog(
    logPath,
    (e) =>
      e.record.verdict === "deny" &&
      e.record.attributes["sessionId"] === sessionId
  );
}

/** All records for a specific tool, newest first. */
export async function getToolHistory(
  logPath: string,
  toolName: string
): Promise<AuditEvent[]> {
  const events = await queryAuditLog(
    logPath,
    (e) => e.record.toolName === toolName
  );
  return events.sort(
    (a, b) =>
      new Date(b.record.timestamp).getTime() -
      new Date(a.record.timestamp).getTime()
  );
}

/** All decisions where output was redacted. */
export async function getRedactionEvents(
  logPath: string
): Promise<AuditEvent[]> {
  return queryAuditLog(
    logPath,
    (e) =>
      e.record.verdict === "allow" &&
      Array.isArray(e.record.redactions) &&
      e.record.redactions.length > 0
  );
}

/** Summary statistics grouped by verdict. */
export async function verdictSummary(logPath: string): Promise<{
  allow: number;
  deny: number;
  "require-approval": number;
}> {
  const counts = { allow: 0, deny: 0, "require-approval": 0 };
  const events = await queryAuditLog(logPath);
  for (const e of events) {
    counts[e.record.verdict]++;
  }
  return counts;
}
```

---

## Putting it together in a route

```ts title="app/api/chat/route.ts"
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import { tool } from "ai";
import { z } from "zod";
import { ToolGuardError, secretsFilter } from "ai-tool-guard";
import { createAuditedGuard } from "@/lib/otel-guard";

export async function POST(request: Request) {
  const { messages, sessionId } = await request.json();

  const guard = createAuditedGuard(sessionId as string);

  const readDocumentTool = tool({
    description: "Read a document by ID.",
    parameters: z.object({ docId: z.string() }),
    execute: async ({ docId }) => ({
      docId,
      content: "Document content here...",
      author: "alice@example.com", // will be redacted
    }),
  });

  const writeDocumentTool = tool({
    description: "Write or update a document.",
    parameters: z.object({ docId: z.string(), content: z.string() }),
    execute: async ({ docId, content }) => ({ saved: true, docId, content }),
  });

  const tools = guard.guardTools({
    readDocument: {
      tool: readDocumentTool,
      riskLevel: "low",
      riskCategories: ["data-read"],
      outputFilters: [secretsFilter()],
    },
    writeDocument: {
      tool: writeDocumentTool,
      riskLevel: "medium",
      riskCategories: ["data-write"],
    },
  });

  try {
    const result = streamText({
      model: openai("gpt-4o-mini"),
      messages,
      tools,
      maxSteps: 3,
    });

    return result.toDataStreamResponse();
  } catch (err) {
    if (err instanceof ToolGuardError) {
      return Response.json(
        {
          error: "tool_guard_error",
          code: err.code,
          tool: err.toolName,
          decisionId: err.decision?.id,
        },
        { status: err.code === "rate-limited" ? 429 : 403 }
      );
    }

    console.error("Unexpected error:", err);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
}
```

---

## Sample log output

A typical `decisions.jsonl` file looks like this. Each line is a complete, self-contained JSON object suitable for ingestion into Elasticsearch, Loki, or any structured log platform.

```json
{"writtenAt":"2026-02-17T14:23:01.456Z","record":{"id":"rec_abc123","timestamp":"2026-02-17T14:23:01.123Z","verdict":"allow","toolName":"readDocument","matchedRules":["allow-1"],"riskLevel":"low","riskCategories":["data-read"],"attributes":{"sessionId":"sess_xyz","userId":"user_001"},"reason":"Tool matched allow rule: Read operations are safe to execute autonomously.","redactions":["pii-output-filter:email"],"evalDurationMs":2,"dryRun":false}}
{"writtenAt":"2026-02-17T14:23:45.789Z","record":{"id":"rec_def456","timestamp":"2026-02-17T14:23:45.500Z","verdict":"deny","toolName":"purgeAll","matchedRules":["deny-1"],"riskLevel":"critical","riskCategories":["data-delete"],"attributes":{"sessionId":"sess_xyz","userId":"user_001"},"reason":"Tool matched deny rule: Bulk purge is never permitted through the AI assistant.","evalDurationMs":1,"dryRun":false}}
{"writtenAt":"2026-02-17T14:24:10.321Z","record":{"id":"rec_ghi789","timestamp":"2026-02-17T14:24:10.100Z","verdict":"require-approval","toolName":"writeDocument","matchedRules":["require-approval-1"],"riskLevel":"medium","riskCategories":["data-write"],"attributes":{"sessionId":"sess_xyz","userId":"user_001"},"reason":"Tool matched require-approval rule: Write and delete operations require approval.","evalDurationMs":3,"dryRun":false}}
```

---

## Compliance checklist

When building for regulated environments, verify that your audit setup covers the following.

| Requirement | How it is met |
|---|---|
| Every tool call is logged | `onDecision` fires for every verdict, including `allow` |
| Denials include the reason | `record.reason` and `record.matchedRules` |
| Output mutations are tracked | `record.redactions` lists every filter and field name |
| Approvals are recorded | `require-approval` verdict written to log; `approvedBy` available via the approval handler |
| Timestamps are tamper-evident | Append-only log file; use a WORM store in production |
| Decisions are traceable in OTel | Decision ID attached to `ai_tool_guard.decision_logged` span |
| Alerts on anomalies | `DenialAlerter` fires on session-level denial bursts |

!!! tip "Long-term storage"
    For compliance archives, ship the JSONL file to an immutable object store (AWS S3 with Object Lock, GCS with retention policies) at the end of each day. Keep the live file on fast local storage for real-time queries.

!!! warning "PII in decision records"
    The `attributes` field contains the full `userAttributes` snapshot, which may include user IDs, email addresses, or role data. Ensure your log storage is access-controlled and review your data retention policy before enabling long-term archival.

---

## Related

- [Decision Records](../guides/decision-records.md) — full `DecisionRecord` field reference.
- [OpenTelemetry](../guides/opentelemetry.md) — span names, attributes, and SDK setup.
- [Output Filtering](../guides/output-filtering.md) — how redactions are tracked and reported.
- [Error Handling](../guides/error-handling.md) — `ToolGuardError` and the `decision` property.
