# Rate Limiting

Rate limiting and concurrency control protect your tools from runaway invocation loops, expensive API hammering, and resource exhaustion. ai-tool-guard provides a sliding-window rate limiter and a concurrency cap that can be configured globally with per-tool overrides.

## Overview

Rate limiting is handled by the `RateLimiter` class, which is instantiated internally by the guard engine. You configure limits declaratively through `GuardOptions` and `ToolGuardConfig`. The limiter tracks call timestamps and active concurrency counts per tool and enforces them on every `acquire` call.

When a limit is exceeded, the behaviour depends on the configured strategy: either reject immediately or queue the call until a slot becomes available.

## Basic Usage

Set global defaults on `GuardOptions` and override per tool as needed:

```typescript
import { createToolGuard } from "ai-tool-guard";

const guard = createToolGuard({
  rules: [{ id: "allow-all", toolPatterns: ["*"], verdict: "allow" }],

  // Global defaults applied to every tool.
  defaultRateLimit: {
    maxCalls: 60,
    windowMs: 60_000,   // 60 calls per minute.
    strategy: "reject",
  },
  defaultMaxConcurrency: 5,
});

// This tool gets its own tighter limits.
const wrappedExpensiveTool = guard.guardTool("llmSummarize", llmSummarizeTool, {
  riskLevel: "medium",
  rateLimit: {
    maxCalls: 5,
    windowMs: 60_000,   // 5 calls per minute.
    strategy: "queue",  // Queue excess calls instead of rejecting.
  },
  maxConcurrency: 2,
});
```

## Configuration Options

### `RateLimitConfig`

| Field | Type | Default | Description |
|---|---|---|---|
| `maxCalls` | `number` | required | Maximum number of calls allowed within the window. |
| `windowMs` | `number` | required | Window size in milliseconds. |
| `strategy` | `"reject" \| "queue"` | `"reject"` | What to do when the limit is exceeded. |

### Global Defaults via `GuardOptions`

| Field | Type | Description |
|---|---|---|
| `defaultRateLimit` | `RateLimitConfig` | Applied to every tool that does not specify its own `rateLimit`. |
| `defaultMaxConcurrency` | `number` | Maximum concurrent executions for any tool without an explicit `maxConcurrency`. |

### Per-Tool Overrides via `ToolGuardConfig`

| Field | Type | Description |
|---|---|---|
| `rateLimit` | `RateLimitConfig` | Overrides `defaultRateLimit` for this specific tool. |
| `maxConcurrency` | `number` | Overrides `defaultMaxConcurrency` for this specific tool. |

Per-tool configuration always takes precedence over global defaults. A tool with no rate limit configuration and no global defaults has no rate limiting applied.

### Strategies

**`"reject"`** — When the rate limit or concurrency cap is exceeded, `acquire` returns immediately with `allowed: false`. The guard engine throws a `ToolGuardError` with `code: "rate-limited"` and includes `retryAfterMs` when available (rate limit case only — not for concurrency rejections). The tool is never executed.

**`"queue"`** — When the rate limit or concurrency cap is exceeded, `acquire` suspends the current call until a slot opens. Calls are released in FIFO order via a per-tool queue. This provides backpressure rather than hard rejection. Use it when occasional latency is preferable to dropped calls.

!!! warning "Queue strategy and timeouts"
    Queued calls wait indefinitely for a slot. If you use the `"queue"` strategy, ensure your caller has an appropriate timeout so that a stalled queue does not block your application indefinitely.

## `RateLimiter` Class

The `RateLimiter` class is used internally by the guard engine. It is also exported for testing and custom integration scenarios.

### `acquire(toolName, config, maxConcurrency?)`

Attempt to claim a slot for the given tool:

```typescript
import { RateLimiter } from "ai-tool-guard/guards";

const limiter = new RateLimiter();

const result = await limiter.acquire("my-tool", {
  maxCalls: 10,
  windowMs: 1000,
  strategy: "reject",
}, /* maxConcurrency */ 3);

if (!result.allowed) {
  console.error(result.reason);
  // result.retryAfterMs is set for rate limit violations (not concurrency).
}
```

`acquire` returns `RateLimitAcquireResult`:

```typescript
interface RateLimitAcquireResult {
  allowed: boolean;
  reason?: string;        // Human-readable explanation when not allowed.
  retryAfterMs?: number;  // Milliseconds until the oldest call leaves the window.
}
```

For the `"queue"` strategy, `acquire` does not return until a slot is available. The resolved `result.allowed` is always `true` in that case.

### `release(toolName)`

Release a concurrency slot after tool execution completes. The guard engine calls this in a `finally` block, guaranteeing cleanup even when the tool throws:

```typescript
// Internal pattern — the guard engine does this automatically.
await limiter.acquire(toolName, config, maxConcurrency);
try {
  result = await tool.execute(args);
} finally {
  limiter.release(toolName);
}
```

Calling `release` also wakes the next queued caller (if any) for the `"queue"` strategy.

### `getState(toolName)`

Returns the current `RateLimitState` for a tool, useful for observability and debugging:

```typescript
const state = limiter.getState("my-tool");
// state.timestamps  — array of call timestamps within the current window
// state.activeCalls — number of currently executing calls
```

### `reset()`

Clears all state and rejects all queued callers with an error. Intended for use in tests between test cases:

```typescript
limiter.reset();
```

## Advanced Examples

### Protecting an Expensive External API

Cap calls to a third-party API that bills per request, and queue excess calls rather than dropping them:

```typescript
import { createToolGuard } from "ai-tool-guard";

const guard = createToolGuard();

const wrappedOcrTool = guard.guardTool("ocrApi", ocrApiTool, {
  riskLevel: "medium",
  rateLimit: {
    maxCalls: 100,
    windowMs: 60_000,   // 100 calls per minute matches API plan limit.
    strategy: "queue",  // Back-pressure excess calls.
  },
  maxConcurrency: 10,   // No more than 10 in-flight requests at once.
});
```

With this configuration, calls beyond the 100/min window wait in the queue. As calls complete and their timestamps age out of the window, queued callers are admitted in order.

### Preventing Runaway Tool Loops

AI agents can enter feedback loops where a tool result causes the model to call the same tool repeatedly. A tight rate limit on high-risk tools breaks these loops before they cause damage:

```typescript
import { createToolGuard } from "ai-tool-guard";

const guard = createToolGuard({
  rules: [
    {
      id: "require-approval-high",
      toolPatterns: ["db.*"],
      riskLevels: ["high", "critical"],
      verdict: "require-approval",
    },
  ],
  defaultRateLimit: {
    maxCalls: 20,
    windowMs: 60_000,
    strategy: "reject",
  },
});

const wrappedDelete = guard.guardTool("deleteRecord", deleteRecordTool, {
  riskLevel: "critical",
  riskCategories: ["data-delete"],
  rateLimit: {
    maxCalls: 3,
    windowMs: 60_000,   // Maximum 3 delete operations per minute.
    strategy: "reject",
  },
  maxConcurrency: 1,    // Never run more than one delete at a time.
});
```

When `strategy: "reject"` fires, the caller receives a `ToolGuardError`:

```typescript
try {
  await wrappedDelete.execute(args);
} catch (err) {
  if (err instanceof ToolGuardError && err.code === "rate-limited") {
    console.warn(`Rate limited: ${err.message}`);
  }
}
```

### Observing Limiter State

Use `getState` to expose rate limit metrics to your monitoring system:

```typescript
import { RateLimiter } from "ai-tool-guard/guards";

// Access the internal limiter (if you hold a reference to it).
setInterval(() => {
  const tools = ["db.query", "email.send", "payment.charge"];
  for (const tool of tools) {
    const state = limiter.getState(tool);
    if (state) {
      metrics.gauge(`tools.${tool}.active_calls`, state.activeCalls);
      metrics.gauge(`tools.${tool}.window_calls`, state.timestamps.length);
    }
  }
}, 5_000);
```

## How It Works

### Sliding Window Algorithm

The limiter uses a **sliding window** rather than a fixed window. On each `acquire` call:

1. `Date.now()` is sampled as `now`.
2. The `timestamps` array for the tool is pruned: any timestamp where `now - timestamp >= windowMs` is removed.
3. If `timestamps.length >= maxCalls`, the rate limit has been hit.
4. Otherwise, `now` is appended to `timestamps` and the call is admitted.

The sliding window avoids the burst-at-boundary problem of fixed windows. A call made at `t=59s` does not reset the counter at `t=60s`; its timestamp ages out of the window at `t=119s`.

### Concurrency Checks

Concurrency is tracked separately via `state.activeCalls`:

1. After the rate limit check passes, `state.activeCalls` is compared to `maxConcurrency`.
2. If `activeCalls >= maxConcurrency`, the concurrency cap has been hit.
3. Otherwise, `activeCalls` is incremented and the call is admitted.
4. `release(toolName)` decrements `activeCalls` in the `finally` block of tool execution, guaranteeing the slot is always returned.

Both checks happen within the same `acquire` loop, so a queued call re-evaluates both conditions when it wakes up.

### Queue Mechanics

When the strategy is `"queue"` and a limit is hit, `acquire` calls `enqueue(toolName)` which pushes a `{ resolve, reject }` pair onto a per-tool queue and returns a Promise. `acquire` then `await`s that Promise, suspending the caller. When `release(toolName)` is called, it shifts the first waiter off the queue and calls `resolve()`, waking the oldest queued caller. That caller re-enters the `acquire` loop and re-checks limits before being admitted. If `reset()` is called while callers are queued, all pending Promises are rejected.

## Related

- [API Reference — Guards](../api/guards.md)
- [Error Handling](error-handling.md)
- [Decision Records](decision-records.md)
