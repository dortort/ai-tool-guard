import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  zodGuard,
  allowlist,
  denylist,
  regexGuard,
  piiGuard,
  evaluateArgGuards,
} from "./arg-guards.js";
import type { PolicyContext } from "../types.js";

function ctx(args: Record<string, unknown>): PolicyContext {
  return { toolName: "test", args, userAttributes: {} };
}

describe("zodGuard", () => {
  it("passes when value matches schema", async () => {
    const guard = zodGuard({
      field: "email",
      schema: z.string().email(),
    });
    const result = await evaluateArgGuards([guard], ctx({ email: "a@b.com" }));
    expect(result.passed).toBe(true);
  });

  it("fails when value does not match schema", async () => {
    const guard = zodGuard({
      field: "email",
      schema: z.string().email(),
    });
    const result = await evaluateArgGuards([guard], ctx({ email: "not-email" }));
    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.field).toBe("email");
  });
});

describe("allowlist", () => {
  it("passes for allowed values", async () => {
    const guard = allowlist("color", ["red", "blue"]);
    const result = await evaluateArgGuards([guard], ctx({ color: "red" }));
    expect(result.passed).toBe(true);
  });

  it("fails for disallowed values", async () => {
    const guard = allowlist("color", ["red", "blue"]);
    const result = await evaluateArgGuards([guard], ctx({ color: "green" }));
    expect(result.passed).toBe(false);
  });
});

describe("denylist", () => {
  it("passes for non-denied values", async () => {
    const guard = denylist("cmd", ["rm", "drop"]);
    const result = await evaluateArgGuards([guard], ctx({ cmd: "ls" }));
    expect(result.passed).toBe(true);
  });

  it("fails for denied values", async () => {
    const guard = denylist("cmd", ["rm", "drop"]);
    const result = await evaluateArgGuards([guard], ctx({ cmd: "rm" }));
    expect(result.passed).toBe(false);
  });
});

describe("regexGuard", () => {
  it("passes when value matches required pattern", async () => {
    const guard = regexGuard("domain", /^.*\.example\.com$/);
    const result = await evaluateArgGuards(
      [guard],
      ctx({ domain: "api.example.com" }),
    );
    expect(result.passed).toBe(true);
  });

  it("fails when value does not match required pattern", async () => {
    const guard = regexGuard("domain", /^.*\.example\.com$/);
    const result = await evaluateArgGuards(
      [guard],
      ctx({ domain: "evil.com" }),
    );
    expect(result.passed).toBe(false);
  });

  it("blocks matching forbidden patterns with mustMatch=false", async () => {
    const guard = regexGuard("query", /DROP\s+TABLE/i, {
      mustMatch: false,
      message: "SQL injection detected",
    });
    const result = await evaluateArgGuards(
      [guard],
      ctx({ query: "DROP TABLE users" }),
    );
    expect(result.passed).toBe(false);
    expect(result.violations[0]!.message).toBe("SQL injection detected");
  });
});

describe("piiGuard", () => {
  it("detects emails", async () => {
    const guard = piiGuard("text");
    const result = await evaluateArgGuards(
      [guard],
      ctx({ text: "Contact user@example.com" }),
    );
    expect(result.passed).toBe(false);
    expect(result.violations[0]!.message).toContain("email");
  });

  it("detects SSNs", async () => {
    const guard = piiGuard("text");
    const result = await evaluateArgGuards(
      [guard],
      ctx({ text: "SSN: 123-45-6789" }),
    );
    expect(result.passed).toBe(false);
    expect(result.violations[0]!.message).toContain("ssn");
  });

  it("skips allowed PII types", async () => {
    const guard = piiGuard("text", { allowedTypes: ["email"] });
    const result = await evaluateArgGuards(
      [guard],
      ctx({ text: "Contact user@example.com" }),
    );
    expect(result.passed).toBe(true);
  });
});

describe("nested field access", () => {
  it("validates nested fields via dot-path", async () => {
    const guard = allowlist("user.role", ["admin", "editor"]);
    const result = await evaluateArgGuards(
      [guard],
      ctx({ user: { role: "hacker" } }),
    );
    expect(result.passed).toBe(false);
  });
});
