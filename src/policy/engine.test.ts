import { describe, it, expect } from "vitest";
import { evaluatePolicy } from "./engine.js";
import { allow, deny, requireApproval, defaultPolicy } from "./builders.js";
import type { PolicyContext, GuardOptions, PolicyBackend } from "../types.js";

function ctx(overrides?: Partial<PolicyContext>): PolicyContext {
  return {
    toolName: "testTool",
    args: {},
    userAttributes: {},
    ...overrides,
  };
}

describe("evaluatePolicy", () => {
  it("returns allow when no rules are configured", async () => {
    const decision = await evaluatePolicy(ctx(), {});
    expect(decision.verdict).toBe("allow");
    expect(decision.toolName).toBe("testTool");
  });

  it("matches a deny rule by tool pattern", async () => {
    const options: GuardOptions = {
      rules: [deny({ tools: "testTool", description: "block test" })],
    };
    const decision = await evaluatePolicy(ctx(), options);
    expect(decision.verdict).toBe("deny");
    expect(decision.matchedRules).toHaveLength(1);
    expect(decision.reason).toBe("block test");
  });

  it("supports glob patterns", async () => {
    const options: GuardOptions = {
      rules: [deny({ tools: "test*" })],
    };
    const decision = await evaluatePolicy(ctx(), options);
    expect(decision.verdict).toBe("deny");
  });

  it("does not match non-matching patterns", async () => {
    const options: GuardOptions = {
      rules: [deny({ tools: "otherTool" })],
    };
    const decision = await evaluatePolicy(ctx(), options);
    expect(decision.verdict).toBe("allow");
  });

  it("filters by risk level", async () => {
    const options: GuardOptions = {
      rules: [
        deny({ tools: "*", riskLevels: ["high"] }),
      ],
    };
    // Tool is low risk by default
    const decision = await evaluatePolicy(ctx(), options);
    expect(decision.verdict).toBe("allow");

    // Tool is high risk
    const decision2 = await evaluatePolicy(ctx(), options, {
      riskLevel: "high",
    });
    expect(decision2.verdict).toBe("deny");
  });

  it("evaluates async conditions", async () => {
    const options: GuardOptions = {
      rules: [
        deny({
          tools: "*",
          condition: async (c) => c.userAttributes.role === "guest",
          description: "Guests blocked",
        }),
      ],
    };

    const guestCtx = ctx({ userAttributes: { role: "guest" } });
    const adminCtx = ctx({ userAttributes: { role: "admin" } });

    expect((await evaluatePolicy(guestCtx, options)).verdict).toBe("deny");
    expect((await evaluatePolicy(adminCtx, options)).verdict).toBe("allow");
  });

  it("respects priority ordering (higher priority first)", async () => {
    const options: GuardOptions = {
      rules: [
        deny({ tools: "*", priority: 0, description: "deny all" }),
        allow({ tools: "testTool", priority: 10, description: "allow test" }),
      ],
    };
    const decision = await evaluatePolicy(ctx(), options);
    // allow has higher priority but allow does not escalate over deny
    // Actually allow is evaluated first (priority 10), but "allow" cannot escalate.
    // Then deny is evaluated (priority 0), "deny" escalates over "allow".
    expect(decision.verdict).toBe("deny");
  });

  it("escalates from allow to require-approval", async () => {
    const options: GuardOptions = {
      rules: [
        allow({ tools: "*", priority: 10 }),
        requireApproval({ tools: "testTool", priority: 5 }),
      ],
    };
    const decision = await evaluatePolicy(ctx(), options);
    // allow matched first (priority 10), then require-approval (priority 5)
    // require-approval escalates over allow
    expect(decision.verdict).toBe("require-approval");
  });

  it("delegates to external backend", async () => {
    const backend: PolicyBackend = {
      name: "test-backend",
      async evaluate() {
        return {
          verdict: "deny",
          reason: "Backend says no",
          matchedRules: ["backend-rule-1"],
        };
      },
    };
    const options: GuardOptions = { backend };
    const decision = await evaluatePolicy(ctx(), options);
    expect(decision.verdict).toBe("deny");
    expect(decision.reason).toBe("Backend says no");
  });

  it("includes dryRun flag in decision record", async () => {
    const decision = await evaluatePolicy(
      ctx({ dryRun: true }),
      {},
    );
    expect(decision.dryRun).toBe(true);
  });

  it("records evaluation duration", async () => {
    const decision = await evaluatePolicy(ctx(), {});
    expect(decision.evalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("escalates from backend allow to rules deny when both are configured", async () => {
    const backend: PolicyBackend = {
      name: "test-backend",
      async evaluate() {
        return {
          verdict: "allow",
          reason: "Backend allows",
          matchedRules: ["b1"],
        };
      },
    };
    const options: GuardOptions = {
      backend,
      rules: [deny({ tools: "testTool", description: "Rules deny" })],
    };
    const decision = await evaluatePolicy(ctx(), options);
    expect(decision.verdict).toBe("deny");
  });

  it("does not de-escalate from backend deny to rules allow", async () => {
    const backend: PolicyBackend = {
      name: "test-backend",
      async evaluate() {
        return {
          verdict: "deny",
          reason: "Backend denies",
          matchedRules: ["b1"],
        };
      },
    };
    const options: GuardOptions = {
      backend,
      rules: [allow({ tools: "testTool" })],
    };
    const decision = await evaluatePolicy(ctx(), options);
    expect(decision.verdict).toBe("deny");
  });

  it("evaluates conversation-aware condition", async () => {
    const options: GuardOptions = {
      rules: [
        deny({
          tools: "testTool",
          condition: (c) => (c.conversation?.riskScore ?? 0) > 0.8,
          description: "High risk conversation",
        }),
      ],
    };

    const highRiskCtx = ctx({ conversation: { riskScore: 0.9 } });
    const lowRiskCtx = ctx({ conversation: { riskScore: 0.5 } });

    const highRiskDecision = await evaluatePolicy(highRiskCtx, options);
    expect(highRiskDecision.verdict).toBe("deny");

    const lowRiskDecision = await evaluatePolicy(lowRiskCtx, options);
    expect(lowRiskDecision.verdict).toBe("allow");
  });
});

describe("defaultPolicy", () => {
  it("allows low risk, requires approval for medium, denies high", async () => {
    const rules = defaultPolicy();
    const options: GuardOptions = { rules };

    const low = await evaluatePolicy(ctx(), options, { riskLevel: "low" });
    expect(low.verdict).toBe("allow");

    const med = await evaluatePolicy(ctx(), options, { riskLevel: "medium" });
    expect(med.verdict).toBe("require-approval");

    const high = await evaluatePolicy(ctx(), options, { riskLevel: "high" });
    expect(high.verdict).toBe("deny");
  });
});
