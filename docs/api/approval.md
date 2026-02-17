# Approval — `ai-tool-guard/approval`

The approval module manages the lifecycle of human-in-the-loop approval requests.
It creates correlation tokens, enforces TTL expiry, supports argument patching
("approve with edits"), and delegates the actual approval decision to a
caller-supplied handler.

```ts
import { ApprovalManager } from "ai-tool-guard/approval";
import type { ApprovalFlowResult } from "ai-tool-guard/approval";
```

The related types `ApprovalToken`, `ApprovalResolution`, and `ApprovalHandler` are
defined in `ai-tool-guard/types` and re-exported from the root path.

```ts
import type {
  ApprovalToken,
  ApprovalResolution,
  ApprovalHandler,
} from "ai-tool-guard";
```

---

## Classes

### `ApprovalManager`

Manages the full lifecycle of approval tokens: creation, handler invocation, TTL
enforcement, and resolution.

#### Constructor

```ts
new ApprovalManager(handler: ApprovalHandler, defaultTtlMs?: number)
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `handler` | `ApprovalHandler` | Yes | Async callback invoked with the approval token; must return an `ApprovalResolution` |
| `defaultTtlMs` | `number` | No | Token time-to-live in milliseconds. Default: `300000` (5 minutes) |

#### Methods

##### `requestApproval`

```ts
async requestApproval(ctx: PolicyContext): Promise<ApprovalFlowResult>
```

Create an approval token for a tool call and invoke the handler. The token
includes a SHA-256 hash of the call payload for correlation. Tokens are
automatically removed from the pending set after the handler resolves.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `ctx` | `PolicyContext` | Yes | Policy context of the tool call requiring approval |

**Returns** `Promise<ApprovalFlowResult>`

The result indicates whether the call was approved, the final arguments to use
(original or patched), and optional metadata from the approver.

##### `getPendingTokens`

```ts
getPendingTokens(): ReadonlyArray<ApprovalToken>
```

Return a read-only snapshot of currently pending approval tokens. Useful for
rendering an approval UI.

**Returns** `ReadonlyArray<ApprovalToken>`

---

## Interfaces

### `ApprovalFlowResult`

The complete result of a single approval flow cycle returned by
`requestApproval()`.

| Field | Type | Required | Description |
|---|---|---|---|
| `approved` | `boolean` | Yes | Whether the tool call was approved |
| `tokenId` | `string` | Yes | The approval token ID for correlation and auditing |
| `args` | `Record<string, unknown>` | Yes | The final arguments to pass to the tool (original or patched by the approver) |
| `patchedFields` | `string[]` | No | Names of argument fields that were modified by the approver |
| `approvedBy` | `string` | No | Identity of the approver, if provided by the handler |
| `reason` | `string` | No | Human-readable reason for denial, if the call was not approved |
| `error` | `string` | No | Error message if the approval flow itself failed (e.g., token not found or expired) |

---

## Types (from `ai-tool-guard`)

### `ApprovalToken`

Correlation token sent to the `ApprovalHandler`. Contains a snapshot of the
original arguments and a payload hash for tamper detection.

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | Yes | Randomly generated unique token ID |
| `payloadHash` | `string` | Yes | SHA-256 hash of the canonical `{ toolName, args }` payload |
| `toolName` | `string` | Yes | Name of the tool awaiting approval |
| `originalArgs` | `Record<string, unknown>` | Yes | Snapshot of the tool arguments at request time |
| `createdAt` | `string` | Yes | ISO-8601 timestamp of token creation |
| `ttlMs` | `number` | No | Token time-to-live in milliseconds |

---

### `ApprovalResolution`

The response returned by the `ApprovalHandler` callback.

| Field | Type | Required | Description |
|---|---|---|---|
| `approved` | `boolean` | Yes | Whether the tool call is approved |
| `patchedArgs` | `Record<string, unknown>` | No | Partial argument overrides; merged with `originalArgs` when provided |
| `approvedBy` | `string` | No | Identity of the approver for audit purposes |
| `reason` | `string` | No | Reason for denial when `approved` is `false` |

---

### `ApprovalHandler`

```ts
type ApprovalHandler = (token: ApprovalToken) => Promise<ApprovalResolution>;
```

Callback type the consumer implements to handle approval requests. The handler
receives the token, presents it to a human approver (or automated system), and
resolves with the decision.

**Example**

```ts
const handler: ApprovalHandler = async (token) => {
  const decision = await showApprovalModal({
    toolName: token.toolName,
    args: token.originalArgs,
  });

  return {
    approved: decision.confirmed,
    approvedBy: decision.userId,
    patchedArgs: decision.edits,
    reason: decision.reason,
  };
};

const guard = createToolGuard({ onApprovalRequired: handler });
```
