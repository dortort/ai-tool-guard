import { describe, it, expect } from "vitest";
import {
  secretsFilter,
  piiOutputFilter,
  customFilter,
  runOutputFilters,
} from "./output-filter.js";
import type { PolicyContext } from "../types.js";

function ctx(): PolicyContext {
  return { toolName: "test", args: {}, userAttributes: {} };
}

describe("secretsFilter", () => {
  it("redacts AWS keys", async () => {
    const filter = secretsFilter();
    const result = await filter.filter(
      "key: AKIAIOSFODNN7EXAMPLE",
      ctx(),
    );
    expect(result.verdict).toBe("redact");
    expect(result.output).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result.redactedFields).toContain("aws-key");
  });

  it("redacts GitHub tokens", async () => {
    const filter = secretsFilter();
    const result = await filter.filter(
      "token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl",
      ctx(),
    );
    expect(result.verdict).toBe("redact");
    expect(result.redactedFields).toContain("github-token");
  });

  it("passes clean output", async () => {
    const filter = secretsFilter();
    const result = await filter.filter("Hello, world!", ctx());
    expect(result.verdict).toBe("pass");
    expect(result.output).toBe("Hello, world!");
  });

  it("handles nested objects", async () => {
    const filter = secretsFilter();
    const result = await filter.filter(
      { data: { key: "AKIAIOSFODNN7EXAMPLE" } },
      ctx(),
    );
    expect(result.verdict).toBe("redact");
  });
});

describe("piiOutputFilter", () => {
  it("redacts emails", async () => {
    const filter = piiOutputFilter();
    const result = await filter.filter("user@example.com", ctx());
    expect(result.verdict).toBe("redact");
    expect(result.output).toBe("[EMAIL REDACTED]");
  });

  it("redacts SSNs", async () => {
    const filter = piiOutputFilter();
    const result = await filter.filter("SSN: 123-45-6789", ctx());
    expect(result.verdict).toBe("redact");
    expect(result.output).toContain("[SSN REDACTED]");
  });

  it("skips allowed PII types", async () => {
    const filter = piiOutputFilter({ allowedTypes: ["email"] });
    const result = await filter.filter("user@example.com", ctx());
    expect(result.verdict).toBe("pass");
  });

  it("redacts valid credit card numbers", async () => {
    const filter = piiOutputFilter();
    // Visa test number (passes Luhn)
    const result = await filter.filter("Card: 4111 1111 1111 1111", ctx());
    expect(result.verdict).toBe("redact");
    expect(result.output).toContain("[CARD REDACTED]");
    expect(result.redactedFields).toContain("credit-card");
  });

  it("does not redact digit sequences that fail Luhn check", async () => {
    const filter = piiOutputFilter();
    // Same prefix but fails Luhn
    const result = await filter.filter("ID: 4111111111111112", ctx());
    expect(result.verdict).toBe("pass");
    expect(result.output).toBe("ID: 4111111111111112");
  });
});

describe("runOutputFilters", () => {
  it("chains multiple filters", async () => {
    const filters = [secretsFilter(), piiOutputFilter()];
    const result = await runOutputFilters(
      filters,
      "key: AKIAIOSFODNN7EXAMPLE and email user@example.com",
      ctx(),
    );
    expect(result.blocked).toBe(false);
    expect(result.redactedFields.length).toBeGreaterThanOrEqual(2);
    expect(String(result.output)).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(String(result.output)).not.toContain("user@example.com");
  });

  it("stops on block verdict", async () => {
    const blocker = customFilter("blocker", async () => ({
      verdict: "block" as const,
      output: null,
    }));
    const result = await runOutputFilters([blocker], "data", ctx());
    expect(result.blocked).toBe(true);
    expect(result.blockedBy).toBe("blocker");
  });
});
