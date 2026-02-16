import { describe, it, expect } from "vitest";
import { simulate } from "./simulation.js";
import { deny, allow } from "./builders.js";
import type { GuardOptions } from "../types.js";

describe("simulate", () => {
  it("evaluates a trace of tool calls in dry-run mode", async () => {
    const options: GuardOptions = {
      rules: [
        deny({ tools: "dangerousTool", description: "block dangerous" }),
        allow({ tools: "*" }),
      ],
    };

    const result = await simulate(
      [
        { toolName: "safeTool", args: {} },
        { toolName: "dangerousTool", args: { x: 1 } },
        { toolName: "anotherSafe", args: {} },
      ],
      options,
    );

    expect(result.summary.total).toBe(3);
    expect(result.summary.denied).toBe(1);
    expect(result.summary.allowed).toBe(2);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]!.toolCall.toolName).toBe("dangerousTool");

    // All decisions should be dry-run
    for (const d of result.decisions) {
      expect(d.dryRun).toBe(true);
    }
  });

  it("returns empty blocked list when all calls are allowed", async () => {
    const result = await simulate(
      [{ toolName: "safe", args: {} }],
      { rules: [allow({ tools: "*" })] },
    );
    expect(result.blocked).toHaveLength(0);
    expect(result.summary.allowed).toBe(1);
  });
});
