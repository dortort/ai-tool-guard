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
});
