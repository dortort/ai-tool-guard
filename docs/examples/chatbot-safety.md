# Building a Safe Chatbot

This example builds a customer support chatbot with layered defenses: injection detection on incoming input, argument validation on every tool call, output filtering to prevent data leakage, conversation-aware escalation, and rate limiting to resist abuse. All five tools operate at different risk levels so you can see how the guard behaves across the spectrum.

---

## Tool inventory

| Tool | Risk | Category | Guard behaviour |
|---|---|---|---|
| `lookupOrder` | low | data-read | Allow; scrub PII from output |
| `updateAddress` | medium | data-write, pii | Require approval; validate address format |
| `issueRefund` | high | payment | Require approval; validate reason allowlist |
| `deleteAccount` | critical | data-delete | Deny always |
| `exportData` | high | data-read | Deny unless admin role; scrub secrets from output |

---

## Complete guard setup

```ts title="lib/chatbot-guard.ts"
import {
  createToolGuard,
  allow,
  deny,
  requireApproval,
  type DecisionRecord,
  type ConversationContext,
} from "ai-tool-guard";
import { appendFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Conversation context store
//
// In production, back this with a session store (Redis, DynamoDB, etc.).
// ---------------------------------------------------------------------------
const sessions = new Map<string, ConversationContext>();

export function getSession(sessionId: string): ConversationContext {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      sessionId,
      riskScore: 0,
      priorFailures: 0,
      recentApprovals: [],
    });
  }
  return sessions.get(sessionId)!;
}

export function updateSession(
  sessionId: string,
  patch: Partial<ConversationContext>
): void {
  const current = getSession(sessionId);
  sessions.set(sessionId, { ...current, ...patch });
}

// ---------------------------------------------------------------------------
// Audit log — append-only JSON lines file
// ---------------------------------------------------------------------------
const AUDIT_LOG = "/var/log/chatbot-audit.jsonl";

function writeAudit(record: DecisionRecord): void {
  try {
    appendFileSync(AUDIT_LOG, JSON.stringify(record) + "\n");
  } catch {
    // Audit write failures must never crash the request.
    console.error("Audit log write failed", record.id);
  }
}

// ---------------------------------------------------------------------------
// Guard factory
// ---------------------------------------------------------------------------

export function createChatbotGuard(sessionId: string) {
  return createToolGuard({
    // ------------------------------------------------------------------
    // Policy rules — evaluated in descending priority order.
    // ------------------------------------------------------------------
    rules: [
      // Hard block on account deletion — no conditions, no exceptions.
      deny({
        tools: "deleteAccount",
        riskLevels: ["critical"],
        description: "Account deletion is never permitted through the AI assistant.",
        priority: 100,
      }),

      // Escalate entire session if risk score is too high.
      deny({
        tools: "*",
        description: "Session risk score exceeds safe threshold.",
        condition: (ctx) => (ctx.conversation?.riskScore ?? 0) > 0.8,
        priority: 90,
      }),

      // After three prior failures in a session, require approval for everything.
      requireApproval({
        tools: "*",
        description: "Session has accumulated too many failures.",
        condition: (ctx) => (ctx.conversation?.priorFailures ?? 0) >= 3,
        priority: 80,
      }),

      // Data export is admin-only.
      deny({
        tools: "exportData",
        description: "Data export restricted to admin users.",
        condition: (ctx) => ctx.userAttributes["role"] !== "admin",
        priority: 70,
      }),

      // High-risk tools require approval.
      requireApproval({
        tools: ["issueRefund", "exportData"],
        riskLevels: ["high"],
        description: "High-risk tools require human sign-off.",
        priority: 50,
      }),

      // Medium-risk tools require approval.
      requireApproval({
        tools: "updateAddress",
        riskLevels: ["medium"],
        description: "Address changes require human confirmation.",
        priority: 40,
      }),

      // Low-risk reads are allowed outright.
      allow({
        tools: "lookupOrder",
        riskLevels: ["low"],
        description: "Read-only order lookups are safe to execute autonomously.",
        priority: 10,
      }),
    ],

    defaultRiskLevel: "medium",

    // ------------------------------------------------------------------
    // Injection detection
    //
    // threshold: 0.5 — flag calls where the suspicion score meets or
    // exceeds 50 %.  action: "deny" — block suspected injections outright
    // rather than downgrading or logging only. Public-facing chatbots
    // should be strict here.
    // ------------------------------------------------------------------
    injectionDetection: {
      threshold: 0.5,
      action: "deny",
    },

    // ------------------------------------------------------------------
    // Global rate limits
    //
    // Caps apply per tool name across all sessions sharing this guard
    // instance. Per-tool overrides are set on individual tool configs.
    // ------------------------------------------------------------------
    defaultRateLimit: {
      maxCalls: 60,
      windowMs: 60_000, // 60 calls per minute globally
      strategy: "reject",
    },

    // ------------------------------------------------------------------
    // Approval handler — in this example, approvals are logged and
    // auto-denied (implement a real UI in production).
    // ------------------------------------------------------------------
    onApprovalRequired: async (token) => {
      console.warn(
        `[approval-required] tool=${token.toolName} token=${token.id}`
      );
      return {
        approved: false,
        reason: "Automated approval not available. Contact support.",
      };
    },

    // ------------------------------------------------------------------
    // Conversation context — resolved fresh on every tool invocation.
    // ------------------------------------------------------------------
    resolveConversationContext: () => getSession(sessionId),

    // ------------------------------------------------------------------
    // Decision callback — runs after every verdict.
    // ------------------------------------------------------------------
    onDecision: (record) => {
      // 1. Write to audit log.
      writeAudit(record);

      // 2. Update session risk score on denial.
      if (record.verdict === "deny") {
        const session = getSession(sessionId);
        updateSession(sessionId, {
          riskScore: Math.min(1, (session.riskScore ?? 0) + 0.15),
          priorFailures: (session.priorFailures ?? 0) + 1,
        });
      }

      // 3. Track approvals in session context.
      if (record.verdict === "require-approval") {
        const session = getSession(sessionId);
        updateSession(sessionId, {
          recentApprovals: [
            ...(session.recentApprovals ?? []),
            record.toolName,
          ].slice(-10), // keep last 10
        });
      }
    },
  });
}
```

---

## Tool definitions with per-tool guards

```ts title="lib/chatbot-tools.ts"
import { tool } from "ai";
import { z } from "zod";
import {
  zodGuard,
  allowlist,
  piiGuard,
  secretsFilter,
  piiOutputFilter,
} from "ai-tool-guard";
import { createChatbotGuard } from "./chatbot-guard";

// ---------------------------------------------------------------------------
// Raw tools
// ---------------------------------------------------------------------------

const lookupOrderTool = tool({
  description: "Retrieve order status and shipment details.",
  parameters: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => ({
    orderId,
    status: "in_transit",
    carrier: "FedEx",
    trackingNumber: "123456789012",
    estimatedDelivery: "2026-02-20",
    customerEmail: "customer@example.com", // redacted by piiOutputFilter
  }),
});

const updateAddressTool = tool({
  description: "Change the delivery address on an unshipped order.",
  parameters: z.object({
    orderId: z.string(),
    newAddress: z.string(),
  }),
  execute: async ({ orderId, newAddress }) => ({
    success: true,
    orderId,
    updatedAddress: newAddress,
  }),
});

const issueRefundTool = tool({
  description: "Issue a refund for a completed order.",
  parameters: z.object({
    orderId: z.string(),
    amount: z.number().positive(),
    reason: z.string(),
  }),
  execute: async ({ orderId, amount, reason }) => ({
    success: true,
    orderId,
    refundedAmount: amount,
    reason,
    transactionId: "txn_abc123",
  }),
});

const deleteAccountTool = tool({
  description: "Permanently delete a customer account.",
  parameters: z.object({ userId: z.string() }),
  execute: async ({ userId }) => ({ deleted: true, userId }),
});

const exportDataTool = tool({
  description: "Export all data for a customer account.",
  parameters: z.object({
    userId: z.string(),
    format: z.enum(["csv", "json"]),
  }),
  execute: async ({ userId, format }) => ({
    exportUrl: `https://internal.example.com/exports/${userId}.${format}`,
    // Internal URL may contain credentials — secretsFilter will redact them.
    downloadUrl: `https://internal.example.com/exports/${userId}.${format}?api_key=sk-prod-1234567890abcdef`,
  }),
});

// ---------------------------------------------------------------------------
// Wrap with guard — call once per session
// ---------------------------------------------------------------------------

export function buildTools(sessionId: string) {
  const guard = createChatbotGuard(sessionId);

  return guard.guardTools({
    lookupOrder: {
      tool: lookupOrderTool,
      riskLevel: "low",
      riskCategories: ["data-read"],
      // Redact PII (email, phone) from order records returned to the model.
      outputFilters: [piiOutputFilter()],
      rateLimit: { maxCalls: 20, windowMs: 60_000 },
    },

    updateAddress: {
      tool: updateAddressTool,
      riskLevel: "medium",
      riskCategories: ["data-write", "pii"],
      argGuards: [
        // Order IDs must follow the ORD-XXXXXX pattern.
        zodGuard({
          field: "orderId",
          schema: z.string().regex(/^ORD-\d{6,}$/, "Invalid order ID."),
        }),
        // Scan the user-supplied address field for PII before it reaches the tool.
        piiGuard("newAddress"),
      ],
      outputFilters: [secretsFilter()],
      rateLimit: { maxCalls: 5, windowMs: 60_000 },
    },

    issueRefund: {
      tool: issueRefundTool,
      riskLevel: "high",
      riskCategories: ["payment"],
      argGuards: [
        zodGuard({
          field: "orderId",
          schema: z.string().regex(/^ORD-\d{6,}$/, "Invalid order ID."),
        }),
        // Cap refund amounts per call.
        zodGuard({
          field: "amount",
          schema: z.number().positive().max(500),
        }),
        // Only these refund reasons are permitted.
        allowlist("reason", [
          "damaged_item",
          "not_received",
          "wrong_item",
          "duplicate_charge",
        ]),
      ],
      outputFilters: [secretsFilter()],
      rateLimit: { maxCalls: 3, windowMs: 60_000 },
    },

    deleteAccount: {
      tool: deleteAccountTool,
      riskLevel: "critical",
      riskCategories: ["data-delete"],
      // No filters needed — the deny rule fires before execution.
    },

    exportData: {
      tool: exportDataTool,
      riskLevel: "high",
      riskCategories: ["data-read"],
      outputFilters: [secretsFilter()],
      rateLimit: { maxCalls: 2, windowMs: 3_600_000 }, // 2 per hour
    },
  });
}
```

---

## Using the tools in a route

```ts title="app/api/chat/route.ts"
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import { ToolGuardError } from "ai-tool-guard";
import { buildTools } from "@/lib/chatbot-tools";

export async function POST(request: Request) {
  const { messages, sessionId } = await request.json();

  // Build a fresh tool set bound to this session's context and risk state.
  const tools = buildTools(sessionId as string);

  try {
    const result = streamText({
      model: openai("gpt-4o-mini"),
      system:
        "You are a helpful customer support agent. " +
        "Never attempt to delete accounts or export bulk data. " +
        "Always confirm order IDs before taking action.",
      messages,
      tools,
      maxSteps: 4,
    });

    return result.toDataStreamResponse();
  } catch (err) {
    if (err instanceof ToolGuardError) {
      const statusMap: Record<string, number> = {
        "policy-denied": 403,
        "injection-detected": 400,
        "rate-limited": 429,
        "arg-validation-failed": 422,
        "output-blocked": 500,
      };

      return Response.json(
        {
          error: "tool_guard_error",
          code: err.code,
          tool: err.toolName,
          message: err.message,
          decision: err.decision
            ? {
                id: err.decision.id,
                matchedRules: err.decision.matchedRules,
                reason: err.decision.reason,
              }
            : undefined,
        },
        { status: statusMap[err.code] ?? 403 }
      );
    }

    console.error("Unexpected error:", err);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
}
```

---

## How the layers interact

The guard processes each tool invocation through a fixed pipeline. Understanding the order helps predict which layer fires when multiple conditions are true simultaneously.

```
Incoming tool call
      │
      ▼
1. Injection detection  (threshold 0.5, action "deny")
      │ suspected → ToolGuardError("injection-detected")
      ▼
2. Argument guards  (zodGuard, allowlist, piiGuard)
      │ violation → ToolGuardError("arg-validation-failed")
      ▼
3. Policy evaluation  (rules in priority order, conversation context)
      │ deny   → ToolGuardError("policy-denied")
      │ approval → onApprovalRequired callback
      ▼
4. Rate limiting  (per-tool maxCalls / windowMs)
      │ exceeded → ToolGuardError("rate-limited")
      ▼
5. Tool execution
      │
      ▼
6. Output filters  (secretsFilter, piiOutputFilter)
      │ blocked → ToolGuardError("output-blocked")
      ▼
Final result returned to the model
```

!!! info "Conversation risk score"
    The `riskScore` stored in the session context is updated in `onDecision` after every denial. Once it exceeds 0.8, a high-priority `deny` rule fires for all subsequent tool calls in that session, regardless of the tool's own risk level. This provides a circuit-breaker against adversarial conversation loops.

!!! warning "piiGuard on input vs piiOutputFilter on output"
    `piiGuard` (applied via `argGuards`) blocks calls where the model passes PII in the arguments. `piiOutputFilter` (applied via `outputFilters`) redacts PII from the tool's return value before the model sees it. Use both together for end-to-end PII coverage.

---

## Related

- [Policy Engine](../guides/policy-engine.md) — rule priority and escalation semantics.
- [Injection Detection](../guides/injection-detection.md) — threshold tuning and custom detectors.
- [Argument Validation](../guides/argument-validation.md) — `zodGuard`, `allowlist`, `piiGuard`.
- [Output Filtering](../guides/output-filtering.md) — `secretsFilter` and `piiOutputFilter`.
- [Rate Limiting](../guides/rate-limiting.md) — per-tool and global limits.
- [Conversation-Aware Policies](../guides/conversation-aware-policies.md) — `ConversationContext` in depth.
