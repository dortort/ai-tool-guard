# Error Handling

## Overview

When ai-tool-guard blocks a tool call — whether due to a policy denial, a failed approval, rate limiting, argument validation, injection detection, or output filtering — it throws a `ToolGuardError`. All guard-originated errors derive from this single class, making it straightforward to distinguish guard failures from errors thrown by your own tool implementations.

`ToolGuardError` extends the built-in `Error` class and adds three fields: a machine-readable `code`, the `toolName` that was involved, and an optional `decision` containing the full `DecisionRecord` that produced the verdict.

---

## Basic Usage

Wrap tool calls in a `try/catch` block and check `instanceof ToolGuardError` to distinguish guard errors from other exceptions:

```typescript
import { ToolGuardError } from 'ai-tool-guard';

try {
  const result = await guardedTools.deleteRecord.execute(args, execOptions);
} catch (err) {
  if (err instanceof ToolGuardError) {
    console.error(`Guard blocked the call: [${err.code}] ${err.message}`);
    // Handle the specific guard failure.
  } else {
    // Re-throw unexpected errors.
    throw err;
  }
}
```

---

## `ToolGuardError` Class

```typescript
class ToolGuardError extends Error {
  readonly name: 'ToolGuardError';
  readonly code: ToolGuardErrorCode;
  readonly toolName: string;
  readonly decision?: DecisionRecord;
}
```

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Always `"ToolGuardError"`. Useful for logging and serialization. |
| `message` | `string` | Human-readable explanation of why the call was blocked, suitable for logging. |
| `code` | `ToolGuardErrorCode` | Machine-readable error category. Use this in `switch` statements. |
| `toolName` | `string` | The name of the tool that was being invoked when the error occurred. |
| `decision` | `DecisionRecord \| undefined` | The full decision record for policy-originated errors. Present on `policy-denied` and `approval-denied`. |

---

## Error Codes

```typescript
type ToolGuardErrorCode =
  | 'policy-denied'
  | 'approval-denied'
  | 'no-approval-handler'
  | 'arg-validation-failed'
  | 'injection-detected'
  | 'rate-limited'
  | 'output-blocked'
  | 'mcp-drift';
```

| Code | Description | Typical Cause |
|---|---|---|
| `policy-denied` | The policy engine returned a `deny` verdict. | A rule matched the tool call and its condition evaluated to `true`. |
| `approval-denied` | The approval handler returned `approved: false`. | A human operator rejected the tool call in the approval UI. |
| `no-approval-handler` | A `require-approval` verdict was issued but no `onApprovalRequired` handler is configured. | The guard was set up without an approval handler, but a rule requires one. |
| `arg-validation-failed` | One or more `argGuards` rejected the arguments. | An argument value failed a type check, range check, or custom validation. |
| `injection-detected` | The injection detector scored the arguments above the configured threshold with an `action` of `deny`. | Arguments contained patterns associated with prompt injection. |
| `rate-limited` | The tool exceeded its configured call rate or concurrency limit. | Too many calls in the time window, or the concurrency cap is reached. |
| `output-blocked` | An output filter returned a `block` verdict after the tool executed. | The tool result matched a pattern that must not be returned to the model. |
| `mcp-drift` | An MCP schema fingerprint mismatch was detected before execution. | A tool schema changed since it was pinned. |

---

## Accessing the `DecisionRecord`

For `policy-denied` and `approval-denied` errors, `err.decision` contains the complete `DecisionRecord`. This includes the matched rule IDs, risk level, risk categories, and evaluation duration:

```typescript
import { ToolGuardError } from 'ai-tool-guard';

try {
  await guardedTools.sendEmail.execute(args, execOptions);
} catch (err) {
  if (err instanceof ToolGuardError && err.code === 'policy-denied') {
    const record = err.decision!;
    console.log('Verdict:', record.verdict);
    console.log('Matched rules:', record.matchedRules.join(', '));
    console.log('Risk level:', record.riskLevel);
    console.log('Reason:', record.reason);
    console.log('Eval duration:', record.evalDurationMs, 'ms');
  }
}
```

For all other error codes, `err.decision` is `undefined`.

---

## Handling All Error Codes

Use a `switch` statement on `err.code` to handle each error type distinctly:

```typescript
import { ToolGuardError } from 'ai-tool-guard';

async function runToolSafely(name: string, args: unknown) {
  try {
    return await guardedTools[name].execute(args, execOptions);
  } catch (err) {
    if (!(err instanceof ToolGuardError)) throw err;

    switch (err.code) {
      case 'policy-denied':
        return {
          error: 'This action is not permitted by your current access policy.',
          ruleIds: err.decision?.matchedRules,
        };

      case 'approval-denied':
        return {
          error: 'The action was reviewed and rejected by an operator.',
        };

      case 'no-approval-handler':
        // Configuration error — log loudly, do not expose to end users.
        console.error('Guard misconfigured: approval required but no handler set.');
        return { error: 'This action requires approval, which is not configured.' };

      case 'arg-validation-failed':
        return {
          error: `The arguments provided to "${err.toolName}" are invalid.`,
          detail: err.message,
        };

      case 'injection-detected':
        return {
          error: 'The request was blocked due to suspected prompt injection.',
        };

      case 'rate-limited':
        return {
          error: `"${err.toolName}" is being called too frequently. Please wait and try again.`,
        };

      case 'output-blocked':
        return {
          error: 'The result of this action cannot be returned due to output policy.',
        };

      case 'mcp-drift':
        return {
          error: 'The tool schema has changed and must be re-validated before use.',
        };

      default:
        throw err;
    }
  }
}
```

---

## Advanced Examples

### Error Reporting and Monitoring

Send blocked calls to your monitoring platform for alerting and trend analysis:

```typescript
import { createToolGuard, ToolGuardError } from 'ai-tool-guard';
import { metrics } from './monitoring.js';

const guard = createToolGuard({
  rules: [...],
  onDecision: async (record) => {
    if (record.verdict !== 'allow') {
      await metrics.increment('tool_guard.blocked', {
        tool: record.toolName,
        verdict: record.verdict,
        riskLevel: record.riskLevel,
        rules: record.matchedRules.join(','),
      });
    }
  },
});

// In the call site, report errors with stack context.
try {
  await guardedTool.execute(args, execOptions);
} catch (err) {
  if (err instanceof ToolGuardError) {
    await monitoring.reportEvent('tool_guard_error', {
      code: err.code,
      toolName: err.toolName,
      decisionId: err.decision?.id,
      message: err.message,
    });
  }
  throw err;
}
```

### Graceful Degradation

Fall back to a safe alternative when the primary tool is blocked:

```typescript
import { ToolGuardError } from 'ai-tool-guard';

async function readUserData(userId: string) {
  try {
    // Try full record read.
    return await guardedTools.readFullRecord.execute({ userId }, execOptions);
  } catch (err) {
    if (err instanceof ToolGuardError && err.code === 'policy-denied') {
      // Fall back to redacted summary if full read is not permitted.
      return await guardedTools.readSummary.execute({ userId }, execOptions);
    }
    throw err;
  }
}
```

### User-Friendly Error Messages

Translate guard errors into user-facing messages keyed on error code, keeping internal details out of the AI response:

```typescript
import { ToolGuardError } from 'ai-tool-guard';

const userMessages: Record<string, string> = {
  'policy-denied': 'I am not permitted to perform that action.',
  'approval-denied': 'That action was not approved.',
  'rate-limited': 'I have reached the limit for that action. Please try again shortly.',
  'injection-detected': 'That request cannot be processed.',
  'output-blocked': 'I cannot share that information.',
  'arg-validation-failed': 'The parameters for that action are not valid.',
  'mcp-drift': 'That tool is temporarily unavailable.',
  'no-approval-handler': 'That action requires approval, which is not available right now.',
};

function toUserMessage(err: unknown): string {
  if (err instanceof ToolGuardError) {
    return userMessages[err.code] ?? 'That action could not be completed.';
  }
  return 'An unexpected error occurred.';
}
```

---

## How It Works

`ToolGuardError` is thrown directly by the `ToolGuard` execution pipeline at the point where a guard check fails:

- **Injection check** — thrown before argument guards if `injectionDetection.action === 'deny'` and the score exceeds the threshold.
- **Argument guards** — thrown if any `argGuard` validation function returns a non-null reason string.
- **Policy evaluation** — thrown after `evaluatePolicy()` returns a `deny` verdict (not in dry-run mode). The `DecisionRecord` from evaluation is attached as `err.decision`.
- **Approval flow** — thrown if the approval handler returns `approved: false`, or if no handler is configured for a `require-approval` verdict.
- **Rate limiting** — thrown if the rate limiter's `acquire()` call returns `allowed: false`.
- **Output filtering** — thrown after tool execution if a filter returns `block` verdict.

Errors from the tool's own `execute()` function are not wrapped — they propagate as-is. Only errors originating from the guard pipeline produce `ToolGuardError` instances.

---

## Related

- [API Reference — Core](../api/core.md)
- [Decision Records](decision-records.md)
