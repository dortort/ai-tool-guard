import { describe, it, expect } from "vitest";
import {
  simulate,
  allow,
  deny,
  requireApproval,
  defaultPolicy,
} from "../src/policy/index.js";
import type { RecordedToolCall } from "../src/policy/index.js";
import type { ToolGuardConfig } from "../src/types.js";

const trace: RecordedToolCall[] = [
  { toolName: "readData", args: { id: "1" } },
  { toolName: "writeData", args: { value: "test" } },
  { toolName: "deleteData", args: { id: "1" } },
];

describe("simulate e2e", () => {
  it("returns correct summary counts", async () => {
    const result = await simulate(trace, {
      rules: [
        allow({ tools: "readData", priority: 10 }),
        requireApproval({ tools: "writeData", priority: 10 }),
        deny({ tools: "deleteData", priority: 10 }),
      ],
    });

    expect(result.summary).toEqual({
      total: 3,
      allowed: 1,
      denied: 1,
      requireApproval: 1,
    });
  });

  it("populates blocked array with denied and require-approval calls", async () => {
    const result = await simulate(trace, {
      rules: [
        allow({ tools: "readData", priority: 10 }),
        requireApproval({ tools: "writeData", priority: 10 }),
        deny({ tools: "deleteData", priority: 10 }),
      ],
    });

    expect(result.blocked).toHaveLength(2);

    const writeBlocked = result.blocked.find(
      (b) => b.toolCall.toolName === "writeData",
    );
    expect(writeBlocked?.decision.verdict).toBe("require-approval");

    const deleteBlocked = result.blocked.find(
      (b) => b.toolCall.toolName === "deleteData",
    );
    expect(deleteBlocked?.decision.verdict).toBe("deny");
  });

  it("marks all decisions as dryRun", async () => {
    const result = await simulate(trace, {
      rules: [allow({ tools: "*", priority: 0 })],
    });

    for (const decision of result.decisions) {
      expect(decision.dryRun).toBe(true);
    }
  });

  it("uses per-tool configs for risk-level scoped rules", async () => {
    const toolConfigs: Record<string, ToolGuardConfig> = {
      readData: { riskLevel: "low" },
      writeData: { riskLevel: "medium" },
      deleteData: { riskLevel: "high" },
    };

    const result = await simulate(
      trace,
      { rules: defaultPolicy() },
      toolConfigs,
    );

    expect(result.summary.allowed).toBe(1); // low → allow
    expect(result.summary.requireApproval).toBe(1); // medium → require-approval
    expect(result.summary.denied).toBe(1); // high → deny
  });

  it("evaluates user attributes from recorded calls", async () => {
    const traceWithAttrs: RecordedToolCall[] = [
      {
        toolName: "adminAction",
        args: {},
        userAttributes: { role: "admin" },
      },
      {
        toolName: "adminAction",
        args: {},
        userAttributes: { role: "viewer" },
      },
    ];

    const result = await simulate(traceWithAttrs, {
      rules: [
        deny({
          tools: "adminAction",
          condition: (ctx) => ctx.userAttributes["role"] !== "admin",
          priority: 10,
        }),
        allow({
          tools: "adminAction",
          condition: (ctx) => ctx.userAttributes["role"] === "admin",
          priority: 5,
        }),
      ],
    });

    expect(result.summary.allowed).toBe(1);
    expect(result.summary.denied).toBe(1);
    expect(result.blocked[0].toolCall.userAttributes?.role).toBe("viewer");
  });

  it("returns empty blocked array when all calls are allowed", async () => {
    const result = await simulate(trace, {
      rules: [allow({ tools: "*", priority: 0 })],
    });

    expect(result.blocked).toHaveLength(0);
    expect(result.summary.allowed).toBe(3);
    expect(result.summary.denied).toBe(0);
    expect(result.summary.requireApproval).toBe(0);
  });
});
