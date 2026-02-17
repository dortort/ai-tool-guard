# Multi-Tenant Policies

This example models a SaaS platform where different tenants receive different tool access depending on their subscription plan and the user's role within that tenant. The guard is instantiated per-request, and `resolveUserAttributes` returns a full tenant context that policy rules can inspect.

---

## Tenant model

| Plan | Roles | What they can do |
|---|---|---|
| free | viewer | Read-only tool access |
| pro | viewer, editor | Read + write; no bulk operations |
| enterprise | viewer, editor, admin | Full access including bulk operations and admin tools |

---

## Tenant context resolver

The `resolveUserAttributes` callback is called once per tool invocation. It should read from your authentication layer — a JWT, a session cookie, or a middleware-injected header.

```ts title="lib/tenant.ts"
export interface TenantContext {
  tenantId: string;
  userId: string;
  plan: "free" | "pro" | "enterprise";
  role: "viewer" | "editor" | "admin";
}

/**
 * In production, decode a JWT or call your auth service.
 * Here we simulate a lookup from request headers.
 */
export function resolveTenantContext(request: Request): TenantContext {
  // These would typically come from a validated JWT payload.
  const tenantId = request.headers.get("x-tenant-id") ?? "unknown";
  const userId = request.headers.get("x-user-id") ?? "unknown";
  const plan = (request.headers.get("x-tenant-plan") ?? "free") as TenantContext["plan"];
  const role = (request.headers.get("x-user-role") ?? "viewer") as TenantContext["role"];

  return { tenantId, userId, plan, role };
}
```

---

## Guard factory

The guard is created per-request so that `resolveUserAttributes` captures the current request context via closure.

```ts title="lib/tenant-guard.ts"
import {
  createToolGuard,
  allow,
  deny,
  requireApproval,
  type DecisionRecord,
  type PolicyContext,
} from "ai-tool-guard";
import { type TenantContext } from "./tenant";

// ---------------------------------------------------------------------------
// Per-tenant audit log
//
// Write to a per-tenant partition so that logs can be queried and
// exported independently for each customer.
// ---------------------------------------------------------------------------
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

function tenantAuditLog(tenantId: string, record: DecisionRecord): void {
  const dir = `/var/log/tenants/${tenantId}`;
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "audit.jsonl"), JSON.stringify(record) + "\n");
  } catch {
    console.error(`[audit] Failed to write for tenant ${tenantId}`, record.id);
  }
}

// ---------------------------------------------------------------------------
// Guard factory
// ---------------------------------------------------------------------------

export function createTenantGuard(tenant: TenantContext) {
  return createToolGuard({
    // ------------------------------------------------------------------
    // Policy rules
    // ------------------------------------------------------------------
    rules: [
      // ----------------------------------------------------------------
      // Free plan: read-only access only.
      // ----------------------------------------------------------------
      deny({
        tools: ["createRecord", "updateRecord", "deleteRecord", "bulkOperation", "adminPanel"],
        description: "Free plan users cannot perform write operations.",
        condition: (ctx) => ctx.userAttributes["plan"] === "free",
        priority: 100,
      }),

      // ----------------------------------------------------------------
      // Pro plan: read + write, but no bulk operations or admin panel.
      // ----------------------------------------------------------------
      deny({
        tools: ["bulkOperation", "adminPanel"],
        description: "Bulk operations and admin panel require an enterprise plan.",
        condition: (ctx) => ctx.userAttributes["plan"] === "pro",
        priority: 90,
      }),

      // ----------------------------------------------------------------
      // Role-based access: viewers cannot write regardless of plan.
      // ----------------------------------------------------------------
      deny({
        tools: ["createRecord", "updateRecord", "deleteRecord", "bulkOperation"],
        description: "Viewer role does not have write access.",
        condition: (ctx) => ctx.userAttributes["role"] === "viewer",
        priority: 85,
      }),

      // ----------------------------------------------------------------
      // Admin-only tools: require both enterprise plan and admin role.
      // ----------------------------------------------------------------
      deny({
        tools: "adminPanel",
        description: "Admin panel requires enterprise plan and admin role.",
        condition: (ctx) =>
          ctx.userAttributes["plan"] !== "enterprise" ||
          ctx.userAttributes["role"] !== "admin",
        priority: 80,
      }),

      // ----------------------------------------------------------------
      // Destructive operations: always require approval, even for admins.
      // ----------------------------------------------------------------
      requireApproval({
        tools: "deleteRecord",
        riskLevels: ["high"],
        description: "Record deletion requires human confirmation.",
        condition: (ctx) =>
          ctx.userAttributes["plan"] === "enterprise" &&
          ctx.userAttributes["role"] === "admin",
        priority: 70,
      }),

      // ----------------------------------------------------------------
      // Bulk operations: require approval from enterprise admins.
      // ----------------------------------------------------------------
      requireApproval({
        tools: "bulkOperation",
        description: "Bulk operations require operator approval.",
        condition: (ctx) =>
          ctx.userAttributes["plan"] === "enterprise" &&
          ctx.userAttributes["role"] === "admin",
        priority: 70,
      }),

      // ----------------------------------------------------------------
      // Write access for editors (pro and enterprise).
      // ----------------------------------------------------------------
      allow({
        tools: ["createRecord", "updateRecord"],
        description: "Editors on pro and enterprise plans can write.",
        condition: (ctx) =>
          ["pro", "enterprise"].includes(ctx.userAttributes["plan"] as string) &&
          ["editor", "admin"].includes(ctx.userAttributes["role"] as string),
        priority: 50,
      }),

      // ----------------------------------------------------------------
      // Universal read access.
      // ----------------------------------------------------------------
      allow({
        tools: ["listRecords", "getRecord", "searchRecords"],
        riskLevels: ["low"],
        description: "All authenticated users may read records.",
        priority: 10,
      }),
    ],

    defaultRiskLevel: "medium",

    // ------------------------------------------------------------------
    // Inject the full tenant context as user attributes.
    // Policy rule conditions read from ctx.userAttributes.
    // ------------------------------------------------------------------
    resolveUserAttributes: () => ({
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      plan: tenant.plan,
      role: tenant.role,
    }),

    // ------------------------------------------------------------------
    // Rate limiting — keyed per tool; limits apply within this process.
    // For distributed rate limiting, implement a custom RateLimiter
    // backed by Redis and pass it as a PolicyBackend.
    // ------------------------------------------------------------------
    defaultRateLimit: {
      maxCalls: 100,
      windowMs: 60_000,
      strategy: "reject",
    },

    // ------------------------------------------------------------------
    // Approval handler — route to the tenant's configured approver.
    // ------------------------------------------------------------------
    onApprovalRequired: async (token) => {
      console.info(
        `[approval] tenant=${tenant.tenantId} tool=${token.toolName} token=${token.id}`
      );
      // Replace with tenant-specific approval workflow (Slack, email, etc.).
      return {
        approved: false,
        reason: "Approval workflow not configured for this tenant.",
      };
    },

    // ------------------------------------------------------------------
    // Decision callback — write to the per-tenant audit partition.
    // ------------------------------------------------------------------
    onDecision: (record) => {
      tenantAuditLog(tenant.tenantId, record);
    },
  });
}
```

---

## Tool definitions

```ts title="lib/tenant-tools.ts"
import { tool } from "ai";
import { z } from "zod";
import { zodGuard, secretsFilter, piiOutputFilter } from "ai-tool-guard";
import { createTenantGuard } from "./tenant-guard";
import { type TenantContext } from "./tenant";

// ---------------------------------------------------------------------------
// Raw tool definitions
// ---------------------------------------------------------------------------

const listRecordsTool = tool({
  description: "List records in a collection with optional filters.",
  parameters: z.object({
    collection: z.string(),
    filter: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  execute: async ({ collection, filter, limit }) => ({
    collection,
    records: [], // replace with real query
    total: 0,
    filter,
    limit,
  }),
});

const getRecordTool = tool({
  description: "Retrieve a single record by ID.",
  parameters: z.object({
    collection: z.string(),
    id: z.string(),
  }),
  execute: async ({ collection, id }) => ({
    collection,
    id,
    data: {}, // replace with real fetch
  }),
});

const createRecordTool = tool({
  description: "Create a new record in a collection.",
  parameters: z.object({
    collection: z.string(),
    data: z.record(z.unknown()),
  }),
  execute: async ({ collection, data }) => ({
    id: crypto.randomUUID(),
    collection,
    data,
    createdAt: new Date().toISOString(),
  }),
});

const updateRecordTool = tool({
  description: "Update fields on an existing record.",
  parameters: z.object({
    collection: z.string(),
    id: z.string(),
    patch: z.record(z.unknown()),
  }),
  execute: async ({ collection, id, patch }) => ({
    collection,
    id,
    patch,
    updatedAt: new Date().toISOString(),
  }),
});

const deleteRecordTool = tool({
  description: "Permanently delete a record.",
  parameters: z.object({
    collection: z.string(),
    id: z.string(),
  }),
  execute: async ({ collection, id }) => ({
    deleted: true,
    collection,
    id,
  }),
});

const bulkOperationTool = tool({
  description: "Apply an operation to all records matching a filter.",
  parameters: z.object({
    collection: z.string(),
    operation: z.enum(["delete", "archive", "export"]),
    filter: z.string(),
  }),
  execute: async ({ collection, operation, filter }) => ({
    collection,
    operation,
    filter,
    affectedCount: 0, // replace with real query
  }),
});

const adminPanelTool = tool({
  description: "Access tenant administration functions.",
  parameters: z.object({
    action: z.enum(["list_users", "reset_quota", "view_billing"]),
  }),
  execute: async ({ action }) => ({
    action,
    result: {}, // replace with real admin call
  }),
});

// ---------------------------------------------------------------------------
// Guarded tools — assembled per-request with tenant context
// ---------------------------------------------------------------------------

export function buildTenantTools(tenant: TenantContext) {
  const guard = createTenantGuard(tenant);

  return guard.guardTools({
    listRecords: {
      tool: listRecordsTool,
      riskLevel: "low",
      riskCategories: ["data-read"],
      outputFilters: [piiOutputFilter()],
    },
    getRecord: {
      tool: getRecordTool,
      riskLevel: "low",
      riskCategories: ["data-read"],
      outputFilters: [secretsFilter(), piiOutputFilter()],
    },
    createRecord: {
      tool: createRecordTool,
      riskLevel: "medium",
      riskCategories: ["data-write"],
      argGuards: [
        zodGuard({
          field: "collection",
          schema: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/, "Invalid collection name."),
        }),
      ],
    },
    updateRecord: {
      tool: updateRecordTool,
      riskLevel: "medium",
      riskCategories: ["data-write"],
    },
    deleteRecord: {
      tool: deleteRecordTool,
      riskLevel: "high",
      riskCategories: ["data-delete"],
    },
    bulkOperation: {
      tool: bulkOperationTool,
      riskLevel: "high",
      riskCategories: ["data-delete", "data-write"],
    },
    adminPanel: {
      tool: adminPanelTool,
      riskLevel: "high",
      riskCategories: ["authentication"],
    },
  });
}
```

---

## Route handler

```ts title="app/api/chat/route.ts"
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import { ToolGuardError } from "ai-tool-guard";
import { resolveTenantContext } from "@/lib/tenant";
import { buildTenantTools } from "@/lib/tenant-tools";

export async function POST(request: Request) {
  // Resolve tenant from the authenticated request.
  const tenant = resolveTenantContext(request);

  const { messages } = await request.json();

  // Build a tool set scoped to this tenant's plan and role.
  const tools = buildTenantTools(tenant);

  try {
    const result = streamText({
      model: openai("gpt-4o"),
      system: `You are an AI assistant for tenant "${tenant.tenantId}". ` +
        `The current user has the "${tenant.role}" role on the "${tenant.plan}" plan. ` +
        "Only attempt operations appropriate for their access level.",
      messages,
      tools,
      maxSteps: 5,
    });

    return result.toDataStreamResponse();
  } catch (err) {
    if (err instanceof ToolGuardError) {
      return Response.json(
        {
          error: "tool_guard_error",
          code: err.code,
          tool: err.toolName,
          message: err.message,
          tenant: tenant.tenantId,
        },
        { status: err.code === "rate-limited" ? 429 : 403 }
      );
    }

    console.error(`[${tenant.tenantId}] Unexpected error:`, err);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
}
```

---

## Policy matrix summary

The table below shows the effective verdict for each tool, plan, and role combination after all rules are applied. Higher-priority rules take precedence.

| Tool | free/viewer | pro/viewer | pro/editor | enterprise/viewer | enterprise/editor | enterprise/admin |
|---|---|---|---|---|---|---|
| `listRecords` | allow | allow | allow | allow | allow | allow |
| `getRecord` | allow | allow | allow | allow | allow | allow |
| `createRecord` | deny | deny | allow | deny | allow | allow |
| `updateRecord` | deny | deny | allow | deny | allow | allow |
| `deleteRecord` | deny | deny | deny | deny | deny | require-approval |
| `bulkOperation` | deny | deny | deny | deny | deny | require-approval |
| `adminPanel` | deny | deny | deny | deny | deny | allow |

!!! info "Rule ordering matters"
    Rules are evaluated from highest to lowest `priority`. The first matching rule wins. In this setup, the role check (priority 85) fires before the plan-level write check (priority 100 for free, 90 for pro), which means a free-plan admin still cannot write — the plan-level deny fires first. Adjust priorities if you need different precedence.

!!! tip "Distributed rate limiting"
    The built-in `RateLimiter` is in-process and does not share state between serverless worker instances. For per-tenant distributed rate limiting, implement a `PolicyBackend` that calls a Redis counter, and configure it via the `backend` option on `createToolGuard`.

---

## Related

- [Policy Engine](../guides/policy-engine.md) — condition predicates, `PolicyContext`, and escalation.
- [External Backends](../guides/external-backends.md) — delegating decisions to OPA or Cedar.
- [Rate Limiting](../guides/rate-limiting.md) — per-tool and global rate limits.
- [Decision Records](../guides/decision-records.md) — `DecisionRecord` structure for audit logging.
