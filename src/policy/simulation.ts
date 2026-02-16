/**
 * Policy simulation / dry-run mode (#3).
 *
 * Evaluates policies across a recorded trace of tool calls without executing
 * tools, producing a diff of what would have been blocked / approved.
 */

import type {
  DecisionRecord,
  GuardOptions,
  PolicyContext,
  RiskCategory,
  RiskLevel,
  ToolGuardConfig,
} from "../types.js";
import { evaluatePolicy } from "./engine.js";

/** A recorded tool call for simulation. */
export interface RecordedToolCall {
  toolName: string;
  args: Record<string, unknown>;
  /** Optional override for user attributes during simulation. */
  userAttributes?: Record<string, unknown>;
}

/** Result of running a simulation across a trace. */
export interface SimulationResult {
  /** All decision records produced. */
  decisions: DecisionRecord[];
  /** Summary counts. */
  summary: {
    total: number;
    allowed: number;
    denied: number;
    requireApproval: number;
  };
  /** Tool calls that would have been blocked (denied or require-approval). */
  blocked: Array<{ toolCall: RecordedToolCall; decision: DecisionRecord }>;
}

/**
 * Run a simulation over a trace of recorded tool calls.
 *
 * No tools are executed. Policy evaluation runs in dry-run mode, producing
 * decision records for every call.
 */
export async function simulate(
  trace: RecordedToolCall[],
  options: GuardOptions,
  toolConfigs?: Record<string, ToolGuardConfig>,
): Promise<SimulationResult> {
  const decisions: DecisionRecord[] = [];
  const blocked: SimulationResult["blocked"] = [];

  for (const call of trace) {
    const config = toolConfigs?.[call.toolName];
    const ctx: PolicyContext = {
      toolName: call.toolName,
      args: call.args,
      userAttributes: call.userAttributes ?? {},
      dryRun: true,
    };

    const decision = await evaluatePolicy(ctx, options, {
      riskLevel: config?.riskLevel,
      riskCategories: config?.riskCategories,
    });

    decisions.push(decision);

    if (decision.verdict !== "allow") {
      blocked.push({ toolCall: call, decision });
    }
  }

  return {
    decisions,
    summary: {
      total: decisions.length,
      allowed: decisions.filter((d) => d.verdict === "allow").length,
      denied: decisions.filter((d) => d.verdict === "deny").length,
      requireApproval: decisions.filter(
        (d) => d.verdict === "require-approval",
      ).length,
    },
    blocked,
  };
}
