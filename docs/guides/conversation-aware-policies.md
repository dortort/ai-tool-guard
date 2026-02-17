# Conversation-Aware Policies

## Overview

Standard policy rules evaluate each tool call in isolation using the tool name, arguments, and static user attributes. Conversation-aware policies extend this by making session-level state available to rule conditions — things like how many tool failures have occurred in the current conversation, what risk score has accumulated, or which tools have already been approved by a human operator in this session.

This enables dynamic policy behavior: restrictions that escalate after repeated failures, tools that become available only after an initial approval, or risk scoring that tightens access as a session accumulates suspicious patterns.

---

## Basic Usage

Provide a `resolveConversationContext` callback in `createToolGuard`. It is called before every policy evaluation and may return a plain object or a `Promise`:

```typescript
import { createToolGuard } from 'ai-tool-guard';
import type { ConversationContext } from 'ai-tool-guard';

const guard = createToolGuard({
  rules: [...],
  resolveConversationContext: async (): Promise<ConversationContext> => {
    // Fetch session state from your session store or in-memory map.
    const session = await sessionStore.get(currentSessionId);
    return {
      sessionId: session.id,
      riskScore: session.riskScore,
      priorFailures: session.failureCount,
      recentApprovals: session.approvedTools,
    };
  },
});
```

The returned `ConversationContext` is attached to `PolicyContext.conversation` and is accessible inside any rule `condition` function.

---

## `ConversationContext` Fields

```typescript
interface ConversationContext {
  /** Unique conversation or session identifier. */
  sessionId?: string;
  /** Accumulated risk score for the session. Range is application-defined. */
  riskScore?: number;
  /** Number of tool failures (errors, denials) in the current conversation. */
  priorFailures?: number;
  /** Tool names that a human has explicitly approved earlier in this session. */
  recentApprovals?: string[];
  /** Arbitrary application-specific key-value state. */
  metadata?: Record<string, unknown>;
}
```

| Field | Type | Description |
|---|---|---|
| `sessionId` | `string` | Identifies the conversation for logging and correlation. |
| `riskScore` | `number` | A numeric score you maintain and update as the session progresses. Interpretation is entirely application-defined. |
| `priorFailures` | `number` | Count of failed or denied tool calls in the session. Useful for progressive lockdown. |
| `recentApprovals` | `string[]` | Tool names approved by a human operator. Lets you relax subsequent checks for already-reviewed tools. |
| `metadata` | `Record<string, unknown>` | Escape hatch for any session state that does not fit the other fields. |

---

## Accessing Conversation Context in Rules

Inside a rule's `condition` function, conversation state is available via `ctx.conversation`:

```typescript
import type { PolicyRule } from 'ai-tool-guard';

const rule: PolicyRule = {
  id: 'escalate-on-failures',
  description: 'Deny all high-risk tools if 3+ failures have occurred.',
  toolPatterns: ['*'],
  riskLevels: ['high', 'critical'],
  verdict: 'deny',
  condition: (ctx) => {
    const failures = ctx.conversation?.priorFailures ?? 0;
    return failures >= 3;
  },
};
```

`ctx.conversation` is `undefined` when no `resolveConversationContext` callback is configured, so defensive access with `?.` and a fallback default is recommended.

The full `PolicyContext` shape:

```typescript
interface PolicyContext {
  toolName: string;
  args: Record<string, unknown>;
  userAttributes: Record<string, unknown>;
  conversation?: ConversationContext;  // Available when callback is set.
  dryRun?: boolean;
}
```

---

## Use Cases

### Escalating Restrictions After Failures

Lock down high-risk tools automatically when a session accumulates too many failures, reducing the blast radius of a compromised or confused agent:

```typescript
const guard = createToolGuard({
  rules: [
    {
      id: 'progressive-lockdown',
      toolPatterns: ['*'],
      riskLevels: ['high', 'critical'],
      verdict: 'deny',
      priority: 10,
      condition: (ctx) => (ctx.conversation?.priorFailures ?? 0) >= 3,
    },
  ],
  resolveConversationContext: () => sessionState.get(currentSessionId),
});
```

### Session-Based Risk Scoring

Compute a risk score from the agent's recent behavior and use it to gate access to sensitive tools:

```typescript
const guard = createToolGuard({
  rules: [
    {
      id: 'high-risk-score-block',
      toolPatterns: ['*'],
      riskLevels: ['medium', 'high', 'critical'],
      verdict: 'require-approval',
      condition: (ctx) => (ctx.conversation?.riskScore ?? 0) > 0.7,
    },
  ],
  resolveConversationContext: async () => {
    const score = await riskScorer.getScore(currentSessionId);
    return { riskScore: score };
  },
});
```

### Unlocking Tools After Human Approval

Once a human approves a sensitive tool call in a session, allow subsequent calls to that tool without re-prompting:

```typescript
const guard = createToolGuard({
  rules: [
    {
      id: 'require-first-approval',
      toolPatterns: ['sendEmail', 'postToSlack'],
      verdict: 'require-approval',
      condition: (ctx) => {
        const approved = ctx.conversation?.recentApprovals ?? [];
        // Skip approval if this tool was already approved this session.
        return !approved.includes(ctx.toolName);
      },
    },
  ],
  resolveConversationContext: () => ({
    recentApprovals: approvedToolsCache.get(currentSessionId) ?? [],
  }),
  onApprovalRequired: async (token) => {
    const resolution = await showApprovalModal(token);
    if (resolution.approved) {
      // Record the approval so future calls skip the modal.
      approvedToolsCache.add(currentSessionId, token.toolName);
    }
    return resolution;
  },
});
```

---

## Advanced Examples

### Progressive Lockdown with Auto-Recovery

Escalate restrictions as failures accumulate, but reset after a cool-down period using `metadata`:

```typescript
import { createToolGuard } from 'ai-tool-guard';

const guard = createToolGuard({
  rules: [
    {
      id: 'lockdown-after-failures',
      toolPatterns: ['*'],
      riskLevels: ['high', 'critical'],
      verdict: 'deny',
      priority: 20,
      condition: (ctx) => {
        const failures = ctx.conversation?.priorFailures ?? 0;
        const lockedUntil = ctx.conversation?.metadata?.lockedUntil as number | undefined;
        if (lockedUntil && Date.now() < lockedUntil) {
          return true; // Still in lockdown period.
        }
        return failures >= 5;
      },
    },
  ],
  resolveConversationContext: async () => {
    const session = await sessionStore.get(currentSessionId);
    return {
      priorFailures: session.failures,
      metadata: {
        lockedUntil: session.lockedUntil,
      },
    };
  },
  onDecision: async (record) => {
    if (record.verdict === 'deny') {
      await sessionStore.incrementFailures(currentSessionId);
      if ((await sessionStore.getFailures(currentSessionId)) >= 5) {
        // Lock the session for 15 minutes.
        await sessionStore.setLockedUntil(
          currentSessionId,
          Date.now() + 15 * 60 * 1000,
        );
      }
    }
  },
});
```

### Trusted Session Relaxation

Allow additional capabilities once a session has demonstrated trustworthy behavior through a series of approved low-risk calls:

```typescript
const guard = createToolGuard({
  rules: [
    {
      id: 'trusted-session-expanded-access',
      toolPatterns: ['exportReport', 'bulkUpdate'],
      verdict: 'allow',
      priority: 15, // Higher priority than the default deny rules below.
      condition: (ctx) => {
        const approvals = ctx.conversation?.recentApprovals ?? [];
        // Require that at least 3 different tools have been reviewed this session.
        return approvals.length >= 3;
      },
    },
    {
      id: 'default-deny-bulk-ops',
      toolPatterns: ['exportReport', 'bulkUpdate'],
      verdict: 'require-approval',
    },
  ],
  resolveConversationContext: () => ({
    recentApprovals: sessionApprovals.get(currentSessionId) ?? [],
  }),
});
```

---

## How It Works

1. Before each tool invocation, `ToolGuard` calls `resolveConversationContext()` if configured and awaits the result.
2. The returned `ConversationContext` is merged into the `PolicyContext` as the `conversation` field.
3. The full `PolicyContext` — including `conversation` — is passed to every policy rule's `condition` function.
4. Rules can read any field from `ctx.conversation` to make contextual decisions. The context is read-only from within a rule; mutations to the returned object do not affect the session store.
5. After the evaluation, `resolveConversationContext` is called again on the next invocation — the callback is responsible for reading fresh state each time.

!!! tip
    Keep `resolveConversationContext` fast. It runs synchronously in the guard's execution pipeline before the policy engine. Use in-memory caches or lightweight lookups rather than database queries where possible.

---

## Related

- [Policy Engine](policy-engine.md)
- [API Reference — Types](../api/types.md)
