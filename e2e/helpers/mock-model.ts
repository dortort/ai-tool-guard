/**
 * Factory functions wrapping MockLanguageModelV1 from ai/test
 * for e2e tests that exercise guarded tools through generateText/streamText.
 */

import {
  MockLanguageModelV1,
  convertArrayToReadableStream,
} from "ai/test";
import type { LanguageModelV1StreamPart } from "@ai-sdk/provider";

interface ToolCallSpec {
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
}

/**
 * Creates a mock model that emits the specified tool calls via doGenerate,
 * then returns final text on subsequent calls (after tool results come back).
 */
export function createToolCallModel(toolCalls: ToolCallSpec[]) {
  let callCount = 0;

  return new MockLanguageModelV1({
    doGenerate: async () => {
      callCount++;
      if (callCount === 1) {
        return {
          toolCalls: toolCalls.map((tc) => ({
            toolCallType: "function" as const,
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            args: JSON.stringify(tc.args),
          })),
          finishReason: "tool-calls" as const,
          usage: { promptTokens: 10, completionTokens: 5 },
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      }
      return {
        text: "Done.",
        finishReason: "stop" as const,
        usage: { promptTokens: 10, completionTokens: 5 },
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  });
}

/**
 * Creates a mock model that emits different tool calls per step.
 * Each entry in `steps` is the tool calls for that generation step.
 */
export function createMultiStepToolCallModel(
  steps: ToolCallSpec[][],
) {
  let callCount = 0;

  return new MockLanguageModelV1({
    doGenerate: async () => {
      const stepIndex = callCount;
      callCount++;

      if (stepIndex < steps.length) {
        return {
          toolCalls: steps[stepIndex].map((tc) => ({
            toolCallType: "function" as const,
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            args: JSON.stringify(tc.args),
          })),
          finishReason: "tool-calls" as const,
          usage: { promptTokens: 10, completionTokens: 5 },
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      }
      return {
        text: "Done.",
        finishReason: "stop" as const,
        usage: { promptTokens: 10, completionTokens: 5 },
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  });
}

/**
 * Creates a mock model that emits tool calls via doStream.
 */
export function createStreamingToolCallModel(toolCalls: ToolCallSpec[]) {
  let callCount = 0;

  return new MockLanguageModelV1({
    doStream: async () => {
      callCount++;
      if (callCount === 1) {
        const chunks: LanguageModelV1StreamPart[] = [
          ...toolCalls.map(
            (tc) =>
              ({
                type: "tool-call" as const,
                toolCallType: "function" as const,
                toolCallId: tc.toolCallId,
                toolName: tc.toolName,
                args: JSON.stringify(tc.args),
              }),
          ),
          {
            type: "finish" as const,
            finishReason: "tool-calls" as const,
            usage: { promptTokens: 10, completionTokens: 5 },
          },
        ];
        return {
          stream: convertArrayToReadableStream(chunks),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      }
      const chunks: LanguageModelV1StreamPart[] = [
        { type: "text-delta" as const, textDelta: "Done." },
        {
          type: "finish" as const,
          finishReason: "stop" as const,
          usage: { promptTokens: 10, completionTokens: 5 },
        },
      ];
      return {
        stream: convertArrayToReadableStream(chunks),
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  });
}
