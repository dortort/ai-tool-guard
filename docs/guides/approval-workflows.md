# Approval Workflows

When the policy engine returns `"require-approval"` for a tool call, `ai-tool-guard` pauses execution and invokes your `ApprovalHandler`. The handler receives a signed token describing the pending call and must return a resolution — approved, denied, or approved with modified arguments.

## Overview

The approval flow involves three types:

| Type | Role |
|---|---|
| `ApprovalToken` | Describes the pending tool call. Created by `ApprovalManager` and passed to your handler. |
| `ApprovalResolution` | Your handler's response: approve, deny, or approve with patched arguments. |
| `ApprovalHandler` | Your callback function: `(token: ApprovalToken) => Promise<ApprovalResolution>`. |

The `ApprovalManager` class manages the full lifecycle: creating tokens, tracking pending requests, enforcing TTL expiry, and merging patched arguments into the final call.

## Basic Usage

Register an `ApprovalHandler` via `onApprovalRequired` in your guard configuration:

```ts
import { createToolGuard, defaultPolicy } from "ai-tool-guard";

const guard = createToolGuard({
  rules: defaultPolicy(),
  onApprovalRequired: async (token) => {
    console.log(`Approval requested for "${token.toolName}"`);
    console.log("Arguments:", token.originalArgs);
    console.log("Token ID:", token.id);
    console.log("Payload hash:", token.payloadHash);

    // Simple synchronous approval for illustration.
    return {
      approved: true,
      approvedBy: "admin@example.com",
    };
  },
});
```

To deny a call from the handler, return `{ approved: false }` with an optional `reason`:

```ts
onApprovalRequired: async (token) => {
  return {
    approved: false,
    reason: "Request rejected by the on-call operator.",
  };
},
```

## Configuration Options

### `ApprovalToken`

The token is created by `ApprovalManager` and passed read-only to your handler.

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Random unique identifier for this approval request. |
| `payloadHash` | `string` | SHA-256 hash of `{ toolName, args }` (canonicalised). Used for correlation and tamper detection. |
| `toolName` | `string` | Name of the tool awaiting approval. |
| `originalArgs` | `Record<string, unknown>` | Deep clone of the arguments the model supplied. |
| `createdAt` | `string` | ISO-8601 timestamp of token creation. |
| `ttlMs` | `number \| undefined` | Token expiry window in milliseconds. Default is 5 minutes (300 000 ms). |

### `ApprovalResolution`

Return this object from your handler.

| Field | Type | Required | Description |
|---|---|---|---|
| `approved` | `boolean` | Yes | Whether the call is approved. |
| `patchedArgs` | `Record<string, unknown>` | No | Partial argument overrides. Merged with `originalArgs`; keys in `patchedArgs` take precedence. |
| `approvedBy` | `string` | No | Identity of the approver, written to the decision record for audit. |
| `reason` | `string` | No | Human-readable reason, used when `approved` is `false`. |

### `ApprovalManager`

`ApprovalManager` is the class that orchestrates the flow internally. You do not instantiate it directly — the guard creates one from your `onApprovalRequired` callback. Its public surface is useful when building approval UIs:

```ts
class ApprovalManager {
  constructor(handler: ApprovalHandler, defaultTtlMs?: number);

  /** Create a token and invoke the handler. Returns the final flow result. */
  requestApproval(ctx: PolicyContext): Promise<ApprovalFlowResult>;

  /** Read-only snapshot of pending tokens (useful for dashboards). */
  getPendingTokens(): ReadonlyArray<ApprovalToken>;
}
```

## Advanced Examples

### Slack-Based Approval

Route approval requests through a Slack message. The handler sends a message, then polls for a response via a shared in-memory map updated by a Slack webhook endpoint:

```ts
import type { ApprovalHandler, ApprovalResolution } from "ai-tool-guard";

// Map populated by your /slack/actions webhook handler.
const pendingSlackResponses = new Map<string, ApprovalResolution>();

const slackApprovalHandler: ApprovalHandler = async (token) => {
  // Post a message to the approvals channel.
  await postSlackMessage({
    channel: "#tool-approvals",
    text: `Tool call requires approval`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Tool:* \`${token.toolName}\`\n*Args:* \`\`\`${JSON.stringify(token.originalArgs, null, 2)}\`\`\``,
        },
      },
      {
        type: "actions",
        elements: [
          { type: "button", text: { type: "plain_text", text: "Approve" }, value: token.id, action_id: "approve_tool" },
          { type: "button", text: { type: "plain_text", text: "Deny" }, value: token.id, action_id: "deny_tool", style: "danger" },
        ],
      },
    ],
  });

  // Poll for a response until TTL elapses.
  const deadline = Date.now() + (token.ttlMs ?? 300_000);
  while (Date.now() < deadline) {
    const resolution = pendingSlackResponses.get(token.id);
    if (resolution) {
      pendingSlackResponses.delete(token.id);
      return resolution;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  return { approved: false, reason: "Approval request timed out." };
};

// In your Slack webhook route:
// app.post("/slack/actions", (req, res) => {
//   const payload = JSON.parse(req.body.payload);
//   const action = payload.actions[0];
//   pendingSlackResponses.set(action.value, {
//     approved: action.action_id === "approve_tool",
//     approvedBy: payload.user.name,
//   });
//   res.send();
// });
```

### Approve with Edits (patchedArgs)

An approver can modify the arguments before the tool executes. Patched fields are merged shallowly with the original arguments and recorded in `ApprovalFlowResult.patchedFields`:

```ts
import type { ApprovalHandler } from "ai-tool-guard";

const editingApprovalHandler: ApprovalHandler = async (token) => {
  // Suppose the model tried to delete all records; an operator limits the scope.
  if (token.toolName === "db.deleteRecords") {
    const originalQuery = token.originalArgs["query"] as string;

    if (originalQuery === "*") {
      // Approve, but rewrite the wildcard to a safe test scope.
      return {
        approved: true,
        approvedBy: "dba@example.com",
        patchedArgs: {
          query: "status = 'test'",
          limit: 100,
        },
      };
    }
  }

  return { approved: true, approvedBy: "auto-approver" };
};
```

After the handler returns, `ApprovalManager` merges `patchedArgs` over `originalArgs`:

```ts
const finalArgs = { ...token.originalArgs, ...resolution.patchedArgs };
```

The merged `finalArgs` are used for the actual tool execution. The original arguments are never mutated.

### CLI Prompt Approval

For command-line tools and scripts, prompt the operator interactively using Node's `readline` module:

```ts
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { ApprovalHandler } from "ai-tool-guard";

const cliApprovalHandler: ApprovalHandler = async (token) => {
  const rl = readline.createInterface({ input, output });

  console.log(`\n--- Approval Required ---`);
  console.log(`Tool:      ${token.toolName}`);
  console.log(`Arguments: ${JSON.stringify(token.originalArgs, null, 2)}`);
  console.log(`Token ID:  ${token.id}`);
  console.log(`Hash:      ${token.payloadHash}`);

  const answer = await rl.question("\nApprove? [y/N] ");
  rl.close();

  if (answer.trim().toLowerCase() === "y") {
    const approver = await rl.question("Your name: ");
    rl.close();
    return { approved: true, approvedBy: approver.trim() };
  }

  return { approved: false, reason: "Denied at CLI prompt." };
};
```

## How It Works

The internal flow, implemented in `src/approval/manager.ts`, runs as follows:

1. **Token creation** — `requestApproval(ctx)` computes a SHA-256 hash of the canonicalised `{ toolName, args }` payload. This `payloadHash` ties the token to the exact tool call; any tampering with the arguments after token creation is detectable via hash mismatch.

2. **Token registration** — The token is stored in an in-memory `Map<string, ApprovalToken>` keyed by `token.id`. `getPendingTokens()` exposes a read-only snapshot of this map for UI display.

3. **Handler invocation** — Your `ApprovalHandler` is called with the token. The manager awaits the returned `Promise<ApprovalResolution>`.

4. **TTL check** — When the resolution arrives, the manager checks whether `Date.now() - createdAt > ttlMs`. Expired tokens return an error result with `approved: false` regardless of what the handler returned.

5. **Argument patching** — If `resolution.patchedArgs` is non-empty, it is shallow-merged over `token.originalArgs`. The merged result becomes the `args` field of `ApprovalFlowResult`.

6. **Token cleanup** — The token is removed from the pending map in the `finally` block of `requestApproval`, ensuring cleanup even if the handler throws.

!!! info "Payload hash correlation"
    The `payloadHash` (SHA-256 of the canonical `{ toolName, args }` JSON) lets downstream systems — approval UIs, audit logs, Slack bots — verify that the call they are approving matches exactly what the policy engine originally evaluated. Store and display it alongside approval records.

!!! warning "TTL is enforced server-side"
    The 5-minute default TTL is enforced by the manager when the resolution arrives, not when the token is created. A handler that blocks for longer than the TTL will have its resolution rejected. Set a custom TTL via the `defaultTtlMs` constructor parameter when instantiating `ApprovalManager` directly, or accept the 300 000 ms default.

## Related

- [API Reference](../api/approval.md) — full type documentation for `ApprovalToken`, `ApprovalResolution`, `ApprovalHandler`, and `ApprovalFlowResult`.
- [Error Handling](error-handling.md) — how denied and errored approvals are surfaced to the caller.
