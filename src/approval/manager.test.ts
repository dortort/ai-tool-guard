import { describe, it, expect } from "vitest";
import { ApprovalManager } from "./manager.js";
import type { PolicyContext } from "../types.js";

const testCtx: PolicyContext = {
  toolName: "test",
  args: { x: 1 },
  userAttributes: {},
};

describe("ApprovalManager", () => {
  it("returns tokenId in the result", async () => {
    const manager = new ApprovalManager(async () => ({ approved: true }));
    const result = await manager.requestApproval(testCtx);

    expect(result.tokenId).toBeDefined();
    expect(typeof result.tokenId).toBe("string");
    expect(result.tokenId.length).toBeGreaterThan(0);
  });

  it("expires approval when TTL is exceeded", async () => {
    const manager = new ApprovalManager(
      async () => {
        // Delay longer than TTL
        await new Promise((r) => setTimeout(r, 50));
        return { approved: true };
      },
      1, // 1ms TTL
    );

    const result = await manager.requestApproval(testCtx);

    expect(result.approved).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("expired");
  });
});
