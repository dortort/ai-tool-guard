import { describe, it, expect } from "vitest";
import { streamText, tool } from "ai";
import { z } from "zod";
import { createToolGuard, ToolGuardError } from "../src/guard.js";
import { deny, requireApproval } from "../src/policy/builders.js";
import { secretsFilter } from "../src/guards/output-filter.js";
import { createStreamingToolCallModel } from "./helpers/mock-model.js";

/**
 * Consume a streamText result fully and return collected stream parts.
 * streamText's promises only resolve after the stream is consumed.
 */
async function consumeStream(result: ReturnType<typeof streamText>) {
  const parts: unknown[] = [];
  for await (const part of result.fullStream) {
    parts.push(part);
  }
  return parts;
}

/**
 * Find a ToolGuardError in a stream error part's cause chain.
 * streamText emits errors as { type: "error", error: ToolExecutionError }
 * where ToolExecutionError.cause is the original ToolGuardError.
 */
function findStreamError(parts: unknown[]): ToolGuardError | null {
  const errorPart = parts.find((p: any) => p.type === "error") as any;
  if (!errorPart) return null;
  let current: unknown = errorPart.error;
  while (current) {
    if (current instanceof ToolGuardError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

describe("streamText e2e", () => {
  it("calls a guarded tool and streams the result", async () => {
    const guard = createToolGuard();
    const weatherTool = guard.guardTool(
      "getWeather",
      tool({
        description: "Get weather",
        parameters: z.object({ city: z.string() }),
        execute: async ({ city }) => `Sunny in ${city}`,
      }),
    );

    const result = streamText({
      model: createStreamingToolCallModel([
        { toolName: "getWeather", toolCallId: "tc-1", args: { city: "Tokyo" } },
      ]),
      tools: { getWeather: weatherTool },
      maxSteps: 2,
      prompt: "What is the weather in Tokyo?",
    });

    const parts = await consumeStream(result);
    const toolResultPart = parts.find(
      (p: any) => p.type === "tool-result",
    ) as any;
    expect(toolResultPart).toBeDefined();
    expect(toolResultPart.result).toBe("Sunny in Tokyo");
  });

  it("policy deny surfaces error in stream", async () => {
    const guard = createToolGuard({
      rules: [deny({ tools: "blocked" })],
    });
    const blockedTool = guard.guardTool(
      "blocked",
      tool({
        description: "Blocked",
        parameters: z.object({}),
        execute: async () => "should not run",
      }),
    );

    const result = streamText({
      model: createStreamingToolCallModel([
        { toolName: "blocked", toolCallId: "tc-1", args: {} },
      ]),
      tools: { blocked: blockedTool },
      maxSteps: 2,
      prompt: "Use the blocked tool",
    });

    const parts = await consumeStream(result);
    const guardError = findStreamError(parts);
    expect(guardError).toBeInstanceOf(ToolGuardError);
    expect(guardError!.code).toBe("policy-denied");
  });

  it("output filter redacts secrets during streaming", async () => {
    const guard = createToolGuard();
    const leakyTool = guard.guardTool(
      "leaky",
      tool({
        description: "Leaky tool",
        parameters: z.object({}),
        execute: async () => "secret: AKIAIOSFODNN7EXAMPLE",
      }),
      { outputFilters: [secretsFilter()] },
    );

    const result = streamText({
      model: createStreamingToolCallModel([
        { toolName: "leaky", toolCallId: "tc-1", args: {} },
      ]),
      tools: { leaky: leakyTool },
      maxSteps: 2,
      prompt: "Get the secret",
    });

    const parts = await consumeStream(result);
    const toolResultPart = parts.find(
      (p: any) => p.type === "tool-result",
    ) as any;
    expect(toolResultPart).toBeDefined();
    expect(String(toolResultPart.result)).not.toContain(
      "AKIAIOSFODNN7EXAMPLE",
    );
  });

  it("approval flow works during streaming", async () => {
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
        description: "Sensitive",
        parameters: z.object({ action: z.string() }),
        execute: async ({ action }) => `Done: ${action}`,
      }),
    );

    const result = streamText({
      model: createStreamingToolCallModel([
        {
          toolName: "sensitive",
          toolCallId: "tc-1",
          args: { action: "deploy" },
        },
      ]),
      tools: { sensitive: sensitiveTool },
      maxSteps: 2,
      prompt: "Deploy",
    });

    const parts = await consumeStream(result);
    const toolResultPart = parts.find(
      (p: any) => p.type === "tool-result",
    ) as any;
    expect(toolResultPart).toBeDefined();
    expect(toolResultPart.result).toBe("Done: deploy");
  });

  it("rate limiter surfaces error in stream", async () => {
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

    // First call succeeds
    const result1 = streamText({
      model: createStreamingToolCallModel([
        { toolName: "myTool", toolCallId: "tc-1", args: {} },
      ]),
      tools: { myTool },
      maxSteps: 2,
      prompt: "Use the tool",
    });
    await consumeStream(result1);

    // Second call should be rate-limited
    const result2 = streamText({
      model: createStreamingToolCallModel([
        { toolName: "myTool", toolCallId: "tc-2", args: {} },
      ]),
      tools: { myTool },
      maxSteps: 2,
      prompt: "Use the tool again",
    });

    const parts = await consumeStream(result2);
    const guardError = findStreamError(parts);
    expect(guardError).toBeInstanceOf(ToolGuardError);
    expect(guardError!.code).toBe("rate-limited");
  });
});
