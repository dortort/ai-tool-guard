# Next.js Integration

This example walks through a complete Next.js App Router setup using `ai-tool-guard` with the Vercel AI SDK. The guard is created once as a module-level singleton, tools are defined with `tool()` from the `ai` package, and a human-in-the-loop approval flow is handled through a dedicated API endpoint.

---

## Prerequisites

```bash
npm install ai-tool-guard ai zod
npm install @opentelemetry/api   # optional, for tracing
```

---

## Guard singleton

Create the guard in a shared module so it is initialised once across all requests. The guard holds the rate limiter state and the approval manager, so it must not be recreated per-request.

```ts title="lib/guard.ts"
import {
  createToolGuard,
  requireApproval,
  deny,
  allow,
  ToolGuardError,
  type ApprovalToken,
  type ApprovalResolution,
} from "ai-tool-guard";

// ---------------------------------------------------------------------------
// Pending approvals store
//
// In production, replace this with Redis or a database so that
// the approval-resolution endpoint and the chat endpoint can
// run on separate serverless instances.
// ---------------------------------------------------------------------------
export const pendingApprovals = new Map<
  string,
  { resolve: (r: ApprovalResolution) => void; token: ApprovalToken }
>();

export const guard = createToolGuard({
  rules: [
    // Read operations — allow outright.
    allow({
      tools: "lookupOrder",
      description: "Order lookups are safe for autonomous execution.",
      priority: 10,
    }),
    // Write operations — require human approval.
    requireApproval({
      tools: ["updateAddress", "issueRefund"],
      description: "State-mutating tools require operator sign-off.",
      priority: 20,
    }),
    // Destructive operations — deny entirely.
    deny({
      tools: "cancelOrder",
      riskLevels: ["high", "critical"],
      description: "Cancellations are not permitted through the AI assistant.",
      priority: 30,
    }),
  ],

  defaultRiskLevel: "medium",

  // Called when a tool reaches require-approval verdict.
  onApprovalRequired: async (token) => {
    return new Promise<ApprovalResolution>((resolve) => {
      // Store the resolver; the /api/approve route calls it.
      pendingApprovals.set(token.id, { resolve, token });

      // Expire unresolved tokens after the built-in TTL.
      setTimeout(() => {
        if (pendingApprovals.has(token.id)) {
          pendingApprovals.delete(token.id);
          resolve({ approved: false, reason: "Approval timed out." });
        }
      }, token.ttlMs ?? 300_000);
    });
  },

  onDecision: (record) => {
    console.log(
      JSON.stringify({
        level: "info",
        event: "tool_decision",
        id: record.id,
        tool: record.toolName,
        verdict: record.verdict,
        rules: record.matchedRules,
        durationMs: record.evalDurationMs,
      })
    );
  },

  otel: {
    enabled: true,
    tracerName: "nextjs-ai-app",
    defaultAttributes: { "deployment.environment": "production" },
  },
});
```

!!! note "Singleton lifetime in serverless"
    Next.js module state is reused across warm invocations within a single worker process. On a serverless platform where workers are recycled frequently, replace `pendingApprovals` with a distributed store (e.g. Redis with `BLPOP`) so that the chat route and the approval route can run on different instances.

---

## Tool definitions

Define tools with the Vercel AI SDK `tool()` helper, then wrap them with `guard.guardTools()` to assign risk configuration and output filters.

```ts title="lib/tools.ts"
import { tool } from "ai";
import { z } from "zod";
import {
  zodGuard,
  regexGuard,
  secretsFilter,
  piiOutputFilter,
} from "ai-tool-guard";
import { guard } from "./guard";

// ---------------------------------------------------------------------------
// Raw AI SDK tool definitions
// ---------------------------------------------------------------------------

const lookupOrderTool = tool({
  description: "Look up an order by ID and return its current status.",
  parameters: z.object({
    orderId: z.string().min(1),
  }),
  execute: async ({ orderId }) => {
    // Replace with real database call.
    return {
      orderId,
      status: "shipped",
      estimatedDelivery: "2026-02-20",
      trackingNumber: "1Z999AA10123456784",
    };
  },
});

const updateAddressTool = tool({
  description: "Update the shipping address for an unshipped order.",
  parameters: z.object({
    orderId: z.string().min(1),
    newAddress: z.string().min(10),
  }),
  execute: async ({ orderId, newAddress }) => {
    // Replace with real mutation.
    return { success: true, orderId, updatedAddress: newAddress };
  },
});

const issueRefundTool = tool({
  description: "Issue a full or partial refund for a completed order.",
  parameters: z.object({
    orderId: z.string().min(1),
    amount: z.number().positive(),
    reason: z.enum(["damaged", "not_received", "wrong_item", "changed_mind"]),
  }),
  execute: async ({ orderId, amount, reason }) => {
    return { success: true, orderId, refundedAmount: amount, reason };
  },
});

// ---------------------------------------------------------------------------
// Guarded tools — pass to streamText({ tools })
// ---------------------------------------------------------------------------

export const guardedTools = guard.guardTools({
  lookupOrder: {
    tool: lookupOrderTool,
    riskLevel: "low",
    riskCategories: ["data-read"],
    // Scrub secrets and PII from order records before the model sees them.
    outputFilters: [secretsFilter(), piiOutputFilter()],
  },
  updateAddress: {
    tool: updateAddressTool,
    riskLevel: "medium",
    riskCategories: ["data-write", "pii"],
    argGuards: [
      zodGuard({
        field: "orderId",
        schema: z.string().regex(/^ORD-\d{6,}$/, "Invalid order ID format."),
      }),
      // Reject addresses that look like they contain SQL or script injection.
      regexGuard("newAddress", /<script|select\s+\*|drop\s+table/i, {
        mustMatch: false,
        message: "Address contains disallowed characters.",
      }),
    ],
    outputFilters: [secretsFilter()],
  },
  issueRefund: {
    tool: issueRefundTool,
    riskLevel: "high",
    riskCategories: ["payment"],
    argGuards: [
      zodGuard({
        field: "orderId",
        schema: z.string().regex(/^ORD-\d{6,}$/, "Invalid order ID format."),
      }),
      zodGuard({
        field: "amount",
        schema: z.number().positive().max(10_000),
      }),
    ],
    outputFilters: [secretsFilter()],
  },
});
```

---

## Route handler

The chat route uses `streamText` from the Vercel AI SDK with the guarded tools. `ToolGuardError` is caught and surfaced as a structured error response.

```ts title="app/api/chat/route.ts"
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import { ToolGuardError } from "ai-tool-guard";
import { guardedTools } from "@/lib/tools";

export const runtime = "nodejs"; // required for long-lived approval polling

export async function POST(request: Request) {
  const { messages } = await request.json();

  try {
    const result = streamText({
      model: openai("gpt-4o"),
      system:
        "You are a customer support assistant. " +
        "Help users with order lookups, address updates, and refunds. " +
        "Always confirm order details before making changes.",
      messages,
      tools: guardedTools,
      maxSteps: 5,
    });

    return result.toDataStreamResponse();
  } catch (err) {
    if (err instanceof ToolGuardError) {
      const status =
        err.code === "rate-limited"
          ? 429
          : err.code === "injection-detected"
          ? 400
          : 403;

      return Response.json(
        {
          error: "tool_guard_error",
          code: err.code,
          tool: err.toolName,
          message: err.message,
        },
        { status }
      );
    }

    console.error("Unhandled chat error:", err);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
}
```

---

## Approval endpoint

When a tool's verdict is `require-approval`, the guard's `onApprovalRequired` callback suspends execution and waits for this endpoint to be called. The operator (or an internal admin UI) resolves the approval by posting to `/api/approve`.

```ts title="app/api/approve/route.ts"
import { pendingApprovals } from "@/lib/guard";

export async function POST(request: Request) {
  const body = await request.json();
  const { tokenId, approved, approvedBy, patchedArgs, reason } = body as {
    tokenId: string;
    approved: boolean;
    approvedBy?: string;
    patchedArgs?: Record<string, unknown>;
    reason?: string;
  };

  const pending = pendingApprovals.get(tokenId);
  if (!pending) {
    return Response.json(
      { error: "Unknown or expired approval token." },
      { status: 404 }
    );
  }

  // Resolve the promise that the guard is awaiting.
  pending.resolve({
    approved,
    approvedBy,
    patchedArgs,
    reason,
  });

  pendingApprovals.delete(tokenId);

  return Response.json({ ok: true, tokenId });
}

// List pending approvals for the admin UI.
export async function GET() {
  const tokens = Array.from(pendingApprovals.values()).map((p) => p.token);
  return Response.json({ pending: tokens });
}
```

---

## Client — chat UI

Use `useChat` from `ai/react`. When the API returns a `tool_guard_error`, display it inline rather than throwing.

```tsx title="app/chat/page.tsx"
"use client";

import { useChat } from "ai/react";

export default function ChatPage() {
  const { messages, input, handleInputChange, handleSubmit, error } = useChat({
    api: "/api/chat",
  });

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: 24 }}>
      <h1>Customer Support</h1>

      <ul style={{ listStyle: "none", padding: 0 }}>
        {messages.map((m) => (
          <li key={m.id} style={{ marginBottom: 12 }}>
            <strong>{m.role === "user" ? "You" : "Assistant"}:</strong>{" "}
            {m.content}
          </li>
        ))}
      </ul>

      {error && (
        <p style={{ color: "crimson" }}>
          {/* The error body is a JSON string from our route handler. */}
          {(() => {
            try {
              const parsed = JSON.parse(error.message);
              return `Blocked: ${parsed.message} (code: ${parsed.code})`;
            } catch {
              return error.message;
            }
          })()}
        </p>
      )}

      <form onSubmit={handleSubmit}>
        <input
          value={input}
          onChange={handleInputChange}
          placeholder="Ask about your order..."
          style={{ width: "100%", padding: 8 }}
        />
        <button type="submit" style={{ marginTop: 8 }}>
          Send
        </button>
      </form>
    </main>
  );
}
```

---

## How the approval flow works end-to-end

1. The model calls `issueRefund` or `updateAddress`.
2. The guard evaluates the `require-approval` rule and invokes `onApprovalRequired`.
3. `onApprovalRequired` stores a `Promise` resolver in `pendingApprovals` and returns the promise.
4. The AI SDK route is blocked, awaiting the resolution. The HTTP connection remains open (set `runtime = "nodejs"` to avoid the default 10-second Edge timeout).
5. An admin sees the pending approval via `GET /api/approve` and posts a resolution to `POST /api/approve`.
6. The resolver fires, the guard receives the `ApprovalResolution`, and execution continues with the original (or patched) arguments.
7. The stream completes and the client receives the final response.

!!! warning "Serverless timeout"
    By default, Vercel serverless functions time out after 10 seconds on the Hobby plan and 60 seconds on Pro. For approval flows that may take minutes, use the `runtime = "nodejs"` export and configure a longer `maxDuration` in `next.config.ts`, or move the approval wait into a separate background job pattern.

!!! tip "Patching arguments"
    The approver can modify arguments before execution. For example, an operator reviewing an `issueRefund` call can lower the `amount` by returning `patchedArgs: { amount: 50 }` in the POST body. The guard merges the patched fields over the original arguments.

---

## Related

- [Approval Workflows](../guides/approval-workflows.md) — full lifecycle documentation.
- [Argument Validation](../guides/argument-validation.md) — all available arg guard factories.
- [Output Filtering](../guides/output-filtering.md) — `secretsFilter` and `piiOutputFilter` in depth.
- [Error Handling](../guides/error-handling.md) — `ToolGuardError` codes.
