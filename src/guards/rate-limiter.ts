/**
 * Per-tool rate limiting and concurrency control (#11).
 *
 * Provides sliding-window rate limiting, concurrency caps,
 * and configurable backpressure (reject or queue).
 */

import type { RateLimitConfig, RateLimitState } from "../types.js";

export class RateLimiter {
  private readonly state = new Map<string, RateLimitState>();
  private readonly queues = new Map<
    string,
    Array<{ resolve: () => void; reject: (err: Error) => void }>
  >();

  /**
   * Attempt to acquire a rate limit slot for the given tool.
   * Returns true if the call is allowed, false if rejected.
   * When strategy is "queue", resolves when a slot becomes available.
   */
  async acquire(
    toolName: string,
    config: RateLimitConfig,
    maxConcurrency?: number,
  ): Promise<RateLimitAcquireResult> {
    const now = Date.now();
    let state = this.state.get(toolName);

    if (!state) {
      state = { timestamps: [], activeCalls: 0 };
      this.state.set(toolName, state);
    }

    // Slide the window: remove timestamps outside the window.
    state.timestamps = state.timestamps.filter(
      (t) => now - t < config.windowMs,
    );

    // Check rate limit.
    if (state.timestamps.length >= config.maxCalls) {
      if (config.strategy === "queue") {
        await this.enqueue(toolName);
        // Re-check after dequeue.
        return this.acquire(toolName, config, maxConcurrency);
      }
      const retryAfterMs =
        config.windowMs - (now - state.timestamps[0]!);
      return {
        allowed: false,
        reason: `Rate limit exceeded for "${toolName}": ${config.maxCalls} calls per ${config.windowMs}ms.`,
        retryAfterMs,
      };
    }

    // Check concurrency.
    if (maxConcurrency != null && state.activeCalls >= maxConcurrency) {
      if (config.strategy === "queue") {
        await this.enqueue(toolName);
        return this.acquire(toolName, config, maxConcurrency);
      }
      return {
        allowed: false,
        reason: `Concurrency limit exceeded for "${toolName}": max ${maxConcurrency}.`,
      };
    }

    // Acquire.
    state.timestamps.push(now);
    state.activeCalls++;

    return { allowed: true };
  }

  /**
   * Release a concurrency slot after tool execution completes.
   */
  release(toolName: string): void {
    const state = this.state.get(toolName);
    if (state && state.activeCalls > 0) {
      state.activeCalls--;
    }

    // Wake up queued callers.
    const queue = this.queues.get(toolName);
    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      next.resolve();
    }
  }

  /** Get current state for a tool (for observability). */
  getState(toolName: string): RateLimitState | undefined {
    return this.state.get(toolName);
  }

  /** Reset all state (useful for testing). */
  reset(): void {
    this.state.clear();
    for (const queue of this.queues.values()) {
      for (const waiter of queue) {
        waiter.reject(new Error("Rate limiter reset."));
      }
    }
    this.queues.clear();
  }

  private enqueue(toolName: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let queue = this.queues.get(toolName);
      if (!queue) {
        queue = [];
        this.queues.set(toolName, queue);
      }
      queue.push({ resolve, reject });
    });
  }
}

export interface RateLimitAcquireResult {
  allowed: boolean;
  reason?: string;
  retryAfterMs?: number;
}
