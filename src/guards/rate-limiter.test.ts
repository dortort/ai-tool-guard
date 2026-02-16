import { describe, it, expect, beforeEach } from "vitest";
import { RateLimiter } from "./rate-limiter.js";
import type { RateLimitConfig } from "../types.js";

describe("RateLimiter", () => {
  let limiter: RateLimiter;
  const config: RateLimitConfig = {
    maxCalls: 3,
    windowMs: 1000,
    strategy: "reject",
  };

  beforeEach(() => {
    limiter = new RateLimiter();
  });

  it("allows calls within the rate limit", async () => {
    const r1 = await limiter.acquire("tool", config);
    const r2 = await limiter.acquire("tool", config);
    const r3 = await limiter.acquire("tool", config);

    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r3.allowed).toBe(true);
  });

  it("rejects calls exceeding the rate limit", async () => {
    await limiter.acquire("tool", config);
    await limiter.acquire("tool", config);
    await limiter.acquire("tool", config);

    const r4 = await limiter.acquire("tool", config);
    expect(r4.allowed).toBe(false);
    expect(r4.reason).toContain("Rate limit exceeded");
  });

  it("tracks tools independently", async () => {
    await limiter.acquire("tool-a", config);
    await limiter.acquire("tool-a", config);
    await limiter.acquire("tool-a", config);

    const rb = await limiter.acquire("tool-b", config);
    expect(rb.allowed).toBe(true);
  });

  it("enforces concurrency limits", async () => {
    const r1 = await limiter.acquire("tool", { maxCalls: 100, windowMs: 10000, strategy: "reject" }, 1);
    expect(r1.allowed).toBe(true);

    // Don't release — second call should be rejected
    const r2 = await limiter.acquire("tool", { maxCalls: 100, windowMs: 10000, strategy: "reject" }, 1);
    expect(r2.allowed).toBe(false);
    expect(r2.reason).toContain("Concurrency limit exceeded");
  });

  it("releases concurrency slots", async () => {
    await limiter.acquire("tool", { maxCalls: 100, windowMs: 10000, strategy: "reject" }, 1);
    limiter.release("tool");

    const r2 = await limiter.acquire("tool", { maxCalls: 100, windowMs: 10000, strategy: "reject" }, 1);
    expect(r2.allowed).toBe(true);
  });

  it("resets all state", async () => {
    await limiter.acquire("tool", config);
    await limiter.acquire("tool", config);
    await limiter.acquire("tool", config);

    limiter.reset();

    const r = await limiter.acquire("tool", config);
    expect(r.allowed).toBe(true);
  });

  it("queues calls when rate limit is exceeded with queue strategy", async () => {
    const queueConfig: RateLimitConfig = {
      maxCalls: 100,
      windowMs: 10000,
      strategy: "queue",
    };

    // First call should be allowed immediately
    const r1 = await limiter.acquire("tool", queueConfig, 2);
    expect(r1.allowed).toBe(true);

    // Second call should be allowed (within concurrency limit)
    const r2 = await limiter.acquire("tool", queueConfig, 2);
    expect(r2.allowed).toBe(true);

    // Third call should block because concurrency limit is reached
    let r3Resolved = false;
    const r3Promise = limiter.acquire("tool", queueConfig, 2).then((result) => {
      r3Resolved = true;
      return result;
    });

    // Give it a moment to ensure it's queued
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(r3Resolved).toBe(false);

    // Release one slot
    limiter.release("tool");

    // Now the third call should resolve
    const r3 = await r3Promise;
    expect(r3.allowed).toBe(true);
    expect(r3Resolved).toBe(true);
  });

  it("queues calls when concurrency limit is exceeded with queue strategy", async () => {
    const queueConfig: RateLimitConfig = {
      maxCalls: 100,
      windowMs: 10000,
      strategy: "queue",
    };

    // First call should be allowed immediately
    const r1 = await limiter.acquire("tool", queueConfig, 1);
    expect(r1.allowed).toBe(true);

    // Second call should block until first is released
    let r2Resolved = false;
    const r2Promise = limiter.acquire("tool", queueConfig, 1).then((result) => {
      r2Resolved = true;
      return result;
    });

    // Give it a moment to ensure it's queued
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(r2Resolved).toBe(false);

    // Release the first slot
    limiter.release("tool");

    // Now the second call should resolve
    const r2 = await r2Promise;
    expect(r2.allowed).toBe(true);
    expect(r2Resolved).toBe(true);
  });
});
