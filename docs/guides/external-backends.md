# External Backends

`ai-tool-guard` can delegate policy decisions to an external engine — Open Policy Agent (OPA), AWS Cedar, a custom database-backed ABAC system, or any other service — through the `PolicyBackend` interface. The external backend is evaluated first; built-in rules then apply with escalation semantics on top of the backend result.

## Overview

External backends are useful when:

- Your organisation already maintains policy definitions in OPA/Rego or Cedar.
- Policy must be managed centrally and consumed by multiple services.
- Access decisions depend on data that lives in an external store (e.g. a permissions database).
- Audit requirements mandate a single authoritative policy engine.

## Basic Usage

Implement the `PolicyBackend` interface and pass the instance as `backend` in `GuardOptions`:

```ts
import { createToolGuard } from "ai-tool-guard";
import type { PolicyBackend, PolicyContext, PolicyBackendResult } from "ai-tool-guard";

const myBackend: PolicyBackend = {
  name: "my-policy-service",
  async evaluate(ctx: PolicyContext): Promise<PolicyBackendResult> {
    // Call your external service and return a result.
    return {
      verdict: "allow",
      reason: "Policy service approved the call.",
      matchedRules: ["policy-service:rule-42"],
    };
  },
};

const guard = createToolGuard({ backend: myBackend });
```

## Configuration Options

### `PolicyBackend`

| Property | Type | Description |
|---|---|---|
| `name` | `string` | Unique name used in logs and traces. |
| `evaluate` | `(ctx: PolicyContext) => Promise<PolicyBackendResult>` | Called for every tool invocation before built-in rules run. |

### `PolicyBackendResult`

| Property | Type | Required | Description |
|---|---|---|---|
| `verdict` | `DecisionVerdict` | Yes | `"allow"`, `"deny"`, or `"require-approval"`. |
| `reason` | `string` | Yes | Human-readable explanation recorded in `DecisionRecord.reason`. |
| `matchedRules` | `string[]` | Yes | Identifiers of the rules that fired (for audit). |
| `attributes` | `Record<string, unknown>` | No | Additional metadata merged into `DecisionRecord.attributes`. |

### `PolicyContext` (input to the backend)

The context object passed to `evaluate` contains:

| Field | Type | Description |
|---|---|---|
| `toolName` | `string` | Name of the tool being invoked. |
| `args` | `Record<string, unknown>` | Arguments the model wants to pass to the tool. |
| `userAttributes` | `Record<string, unknown>` | Caller-supplied attributes (user ID, roles, tenant, etc.). |
| `conversation` | `ConversationContext \| undefined` | Session-level metadata such as `riskScore` and `priorFailures`. |
| `dryRun` | `boolean \| undefined` | Whether this is a simulation evaluation. |

## Advanced Examples

### OPA / Rego Backend

The following example calls a locally running OPA server using the REST API. The Rego policy receives the tool name and user attributes and returns a decision object.

```ts
import type { PolicyBackend, PolicyContext, PolicyBackendResult } from "ai-tool-guard";

// Example Rego policy (data.toolguard.authz):
//
// package toolguard.authz
//
// default allow = false
//
// allow {
//   input.user.roles[_] == "admin"
// }
//
// allow {
//   input.tool.riskLevel == "low"
// }

const opaBackend: PolicyBackend = {
  name: "opa",
  async evaluate(ctx: PolicyContext): Promise<PolicyBackendResult> {
    const response = await fetch("http://localhost:8181/v1/data/toolguard/authz", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: {
          tool: { name: ctx.toolName },
          user: ctx.userAttributes,
          args: ctx.args,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`OPA returned HTTP ${response.status}`);
    }

    const body = await response.json() as { result?: { allow?: boolean; reason?: string } };
    const result = body.result ?? {};
    const allowed = result.allow ?? false;

    return {
      verdict: allowed ? "allow" : "deny",
      reason: result.reason ?? (allowed ? "OPA policy approved." : "OPA policy denied."),
      matchedRules: ["opa:toolguard/authz"],
    };
  },
};

const guard = createToolGuard({ backend: opaBackend });
```

!!! tip "Dry-run forwarding"
    Forward `ctx.dryRun` to your OPA input so the policy server can log simulation evaluations separately from real ones.

### Database-Backed ABAC

For teams that store permissions in a relational database, a custom backend can query the database and translate rows into verdicts:

```ts
import type { PolicyBackend, PolicyContext, PolicyBackendResult } from "ai-tool-guard";

interface Permission {
  toolPattern: string;
  verdict: "allow" | "deny" | "require-approval";
  reason: string;
}

function createDatabaseBackend(db: DatabaseClient): PolicyBackend {
  return {
    name: "database-abac",
    async evaluate(ctx: PolicyContext): Promise<PolicyBackendResult> {
      const userId = ctx.userAttributes["userId"] as string | undefined;
      if (!userId) {
        return {
          verdict: "deny",
          reason: "No user identity present in request.",
          matchedRules: ["db-abac:no-identity"],
        };
      }

      // Query the permissions table for this user and tool.
      const permissions: Permission[] = await db.query(
        `SELECT tool_pattern, verdict, reason
           FROM tool_permissions
          WHERE user_id = $1
            AND $2 LIKE tool_pattern
          ORDER BY priority DESC
          LIMIT 1`,
        [userId, ctx.toolName],
      );

      if (permissions.length === 0) {
        return {
          verdict: "deny",
          reason: `No permission record found for user "${userId}" and tool "${ctx.toolName}".`,
          matchedRules: [],
        };
      }

      const { verdict, reason } = permissions[0];
      return {
        verdict,
        reason,
        matchedRules: [`db-abac:user:${userId}:tool:${ctx.toolName}`],
        attributes: { userId, source: "database-abac" },
      };
    },
  };
}

const guard = createToolGuard({
  backend: createDatabaseBackend(myDatabaseClient),
});
```

### Combining a Backend with Built-In Rules

You can layer built-in rules on top of a backend. The engine applies escalation: if the built-in rules produce a stricter verdict than the backend, the stricter verdict wins.

```ts
import { createToolGuard, deny } from "ai-tool-guard";

const guard = createToolGuard({
  backend: opaBackend,
  rules: [
    // Hard deny for critical tools regardless of what OPA says.
    deny({
      tools: "*",
      riskLevels: ["critical"],
      description: "Critical tools are always denied, even if OPA permits them.",
      priority: 1000,
    }),
  ],
});
```

!!! warning "Built-in rules can only escalate, not relax"
    If the backend returns `"deny"`, a built-in `allow` rule will not override it. Escalation is unidirectional: `deny > require-approval > allow`. To relax a backend decision, you must update the backend policy itself.

## How It Works

The backend integration is handled in `evaluatePolicy` (`src/policy/engine.ts`):

1. **Backend called first** — `options.backend.evaluate(ctx)` is awaited. Its returned `verdict`, `reason`, `matchedRules`, and `attributes` become the initial values for the decision record.

2. **Built-in rules run unconditionally** — Even when a backend is configured, the built-in rules array is evaluated. The engine checks whether the rules verdict is stricter than the backend verdict using a severity map: `deny (2) > require-approval (1) > allow (0)`.

3. **Escalation applied** — If the built-in rules produce a stricter verdict, the record is updated with the new verdict, reason, and matched rule IDs. The backend's matched rule IDs are preserved and merged.

4. **Error handling** — If `backend.evaluate` throws, the exception propagates to the caller. The guard does not silently fall back to `allow` on backend errors. Wrap your backend implementation in a try/catch if you need a fallback posture:

```ts
const resilientBackend: PolicyBackend = {
  name: "resilient-opa",
  async evaluate(ctx: PolicyContext): Promise<PolicyBackendResult> {
    try {
      return await opaBackend.evaluate(ctx);
    } catch (err) {
      // Fail closed: deny on backend error.
      console.error("OPA backend error:", err);
      return {
        verdict: "deny",
        reason: "Policy backend unavailable; failing closed.",
        matchedRules: ["resilient-opa:fallback-deny"],
      };
    }
  },
};
```

!!! note "Only one backend at a time"
    `GuardOptions.backend` accepts a single `PolicyBackend` instance. To fan out to multiple backends, implement a composite backend that calls each service and merges results internally before returning a single `PolicyBackendResult`.

## Related

- [Policy Engine](policy-engine.md) — evaluation order, escalation mechanics, and `DecisionRecord` structure.
- [API Reference](../api/policy.md) — full type documentation for `PolicyBackend`, `PolicyBackendResult`, and `PolicyContext`.
