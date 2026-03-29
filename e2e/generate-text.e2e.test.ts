import { describe, it, expect, vi } from "vitest";
import { generateText, tool } from "ai";
import { z } from "zod";
import { createToolGuard, ToolGuardError } from "../src/guard.js";
import { deny, allow, requireApproval } from "../src/policy/builders.js";
import { allowlist } from "../src/guards/arg-guards.js";
import { secretsFilter } from "../src/guards/output-filter.js";
import {
  createToolCallModel,
  createMultiStepToolCallModel,
} from "./helpers/mock-model.js";

describe("generateText e2e", () => {
  it("calls a guarded tool and returns its result", async () => {
    const guard = createToolGuard();
    const weatherTool = guard.guardTool(
      "getWeather",
      tool({
        description: "Get weather",
        parameters: z.object({ city: z.string() }),
        execute: async ({ city }) => `Sunny in ${city}`,
      }),
    );

    const result = await generateText({
      model: createToolCallModel([
        { toolName: "getWeather", toolCallId: "tc-1", args: { city: "Paris" } },
      ]),
      tools: { getWeather: weatherTool },
      maxSteps: 2,
      prompt: "What is the weather in Paris?",
    });

    expect(result.steps.length).toBeGreaterThanOrEqual(1);
    const toolResult = result.steps[0]?.toolResults?.[0];
    expect(toolResult?.result).toBe("Sunny in Paris");
  });

  it("surfaces ToolGuardError through generateText when policy denies", async () => {
    const guard = createToolGuard({
      rules: [deny({ tools: "dangerousTool" })],
    });
    const dangerousTool = guard.guardTool(
      "dangerousTool",
      tool({
        description: "Dangerous",
        parameters: z.object({}),
        execute: async () => "should not run",
      }),
    );

    try {
      await generateText({
        model: createToolCallModel([
          { toolName: "dangerousTool", toolCallId: "tc-1", args: {} },
        ]),
        tools: { dangerousTool },
        maxSteps: 2,
        prompt: "Run the dangerous tool",
      });
      expect.fail("Expected generateText to throw");
    } catch (err: unknown) {
      // AI SDK wraps tool errors in ToolExecutionError with cause
      expect(err).toBeDefined();
      const cause = (err as { cause?: unknown }).cause;
      expect(cause).toBeInstanceOf(ToolGuardError);
      expect((cause as ToolGuardError).code).toBe("policy-denied");
    }
  });

  it("correctly deserializes complex/nested args from the SDK", async () => {
    const receivedArgs = vi.fn();
    const guard = createToolGuard();
    const complexTool = guard.guardTool(
      "process",
      tool({
        description: "Process data",
        parameters: z.object({
          nested: z.object({ deep: z.string() }),
          arr: z.array(z.number()),
        }),
        execute: async (args) => {
          receivedArgs(args);
          return "processed";
        },
      }),
    );

    await generateText({
      model: createToolCallModel([
        {
          toolName: "process",
          toolCallId: "tc-1",
          args: { nested: { deep: "value" }, arr: [1, 2] },
        },
      ]),
      tools: { process: complexTool },
      maxSteps: 2,
      prompt: "Process the data",
    });

    expect(receivedArgs).toHaveBeenCalledWith({
      nested: { deep: "value" },
      arr: [1, 2],
    });
  });

  it("handles multi-tool-call response with independent guard decisions", async () => {
    const guard = createToolGuard({
      rules: [deny({ tools: "blocked" })],
    });

    const executedTools: string[] = [];
    const allowedTool = guard.guardTool(
      "allowed",
      tool({
        description: "Allowed tool",
        parameters: z.object({}),
        execute: async () => {
          executedTools.push("allowed");
          return "ok";
        },
      }),
    );
    const blockedTool = guard.guardTool(
      "blocked",
      tool({
        description: "Blocked tool",
        parameters: z.object({}),
        execute: async () => {
          executedTools.push("blocked");
          return "should not run";
        },
      }),
    );

    // Multi-tool-call: one allowed, one blocked.
    // generateText will throw on the blocked tool.
    try {
      await generateText({
        model: createToolCallModel([
          { toolName: "allowed", toolCallId: "tc-1", args: {} },
          { toolName: "blocked", toolCallId: "tc-2", args: {} },
        ]),
        tools: { allowed: allowedTool, blocked: blockedTool },
        maxSteps: 2,
        prompt: "Use both tools",
      });
      expect.fail("Expected generateText to throw for the blocked tool");
    } catch (err: unknown) {
      const cause = (err as { cause?: unknown }).cause;
      expect(cause).toBeInstanceOf(ToolGuardError);
      expect((cause as ToolGuardError).code).toBe("policy-denied");
    }
  });

  it("approval flow approves tool call mid-generation", async () => {
    const guard = createToolGuard({
      rules: [requireApproval({ tools: "sensitive" })],
      onApprovalRequired: async () => ({
        approved: true,
        approvedBy: "admin",
      }),
    });

    const sensitiveTool = guard.guardTool(
      "sensitive",
      tool({
        description: "Sensitive operation",
        parameters: z.object({ action: z.string() }),
        execute: async ({ action }) => `Executed: ${action}`,
      }),
    );

    const result = await generateText({
      model: createToolCallModel([
        {
          toolName: "sensitive",
          toolCallId: "tc-1",
          args: { action: "deploy" },
        },
      ]),
      tools: { sensitive: sensitiveTool },
      maxSteps: 2,
      prompt: "Deploy the app",
    });

    const toolResult = result.steps[0]?.toolResults?.[0];
    expect(toolResult?.result).toBe("Executed: deploy");
  });

  it("rate limiter blocks after max calls across multi-step generation", async () => {
    const guard = createToolGuard({
      defaultRateLimit: { maxCalls: 1, windowMs: 60_000, strategy: "reject" },
    });

    const myTool = guard.guardTool(
      "myTool",
      tool({
        description: "A tool",
        parameters: z.object({}),
        execute: async () => "ok",
      }),
    );

    // Two steps, each calling the same tool. Second should be rate-limited.
    try {
      await generateText({
        model: createMultiStepToolCallModel([
          [{ toolName: "myTool", toolCallId: "tc-1", args: {} }],
          [{ toolName: "myTool", toolCallId: "tc-2", args: {} }],
        ]),
        tools: { myTool },
        maxSteps: 3,
        prompt: "Use the tool twice",
      });
      expect.fail("Expected rate limit error");
    } catch (err: unknown) {
      const cause = (err as { cause?: unknown }).cause;
      expect(cause).toBeInstanceOf(ToolGuardError);
      expect((cause as ToolGuardError).code).toBe("rate-limited");
    }
  });

  it("dry-run mode returns decision without executing the tool", async () => {
    const executeFn = vi.fn(async () => "should not run");
    const guard = createToolGuard({
      dryRun: true,
      rules: [deny({ tools: "*" })],
    });

    const myTool = guard.guardTool(
      "myTool",
      tool({
        description: "A tool",
        parameters: z.object({}),
        execute: executeFn,
      }),
    );

    const result = await generateText({
      model: createToolCallModel([
        { toolName: "myTool", toolCallId: "tc-1", args: {} },
      ]),
      tools: { myTool },
      maxSteps: 2,
      prompt: "Use the tool",
    });

    expect(executeFn).not.toHaveBeenCalled();
    const toolResult = result.steps[0]?.toolResults?.[0];
    expect((toolResult?.result as Record<string, unknown>)?.dryRun).toBe(true);
  });

  it("guardTools works with multiple tools in one generateText call", async () => {
    const guard = createToolGuard();
    const tools = guard.guardTools({
      add: {
        tool: tool({
          description: "Add numbers",
          parameters: z.object({ a: z.number(), b: z.number() }),
          execute: async ({ a, b }) => a + b,
        }),
      },
      greet: {
        tool: tool({
          description: "Greet",
          parameters: z.object({ name: z.string() }),
          execute: async ({ name }) => `Hello, ${name}!`,
        }),
      },
    });

    const result = await generateText({
      model: createToolCallModel([
        { toolName: "add", toolCallId: "tc-1", args: { a: 2, b: 3 } },
      ]),
      tools,
      maxSteps: 2,
      prompt: "Add 2 and 3",
    });

    const toolResult = result.steps[0]?.toolResults?.[0];
    expect(toolResult?.result).toBe(5);
  });
});
