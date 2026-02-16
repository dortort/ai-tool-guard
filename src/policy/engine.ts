/**
 * Policy engine — evaluates tool calls against rules and backends.
 *
 * Supports:
 * - Built-in PolicyRule matching with glob patterns and conditions
 * - External PolicyBackend delegation (OPA, Cedar, custom)
 * - Dry-run / simulation mode
 * - Structured DecisionRecord output for every evaluation
 */

import type {
  DecisionRecord,
  DecisionVerdict,
  GuardOptions,
  PolicyBackend,
  PolicyContext,
  PolicyRule,
  RiskCategory,
  RiskLevel,
} from "../types.js";
import { generateId, matchGlob } from "../utils/index.js";

/**
 * Evaluate a tool call against the configured policy rules and/or backend.
 *
 * Evaluation order:
 * 1. If a PolicyBackend is configured, delegate to it first.
 * 2. Evaluate built-in PolicyRules in priority order (descending).
 * 3. If no rule matches, fall back to "allow".
 *
 * The result is always a full DecisionRecord.
 */
export async function evaluatePolicy(
  ctx: PolicyContext,
  options: GuardOptions,
  toolConfig?: { riskLevel?: RiskLevel; riskCategories?: RiskCategory[] },
): Promise<DecisionRecord> {
  const start = performance.now();
  const riskLevel = toolConfig?.riskLevel ?? options.defaultRiskLevel ?? "low";
  const riskCategories = toolConfig?.riskCategories ?? [];
  const dryRun = ctx.dryRun ?? options.dryRun ?? false;

  let verdict: DecisionVerdict = "allow";
  let matchedRules: string[] = [];
  let reason = "No matching policy rule; default allow.";
  let attributes: Record<string, unknown> = {};

  // 1. External backend takes priority if configured.
  if (options.backend) {
    const backendResult = await options.backend.evaluate(ctx);
    verdict = backendResult.verdict;
    matchedRules = backendResult.matchedRules;
    reason = backendResult.reason;
    attributes = backendResult.attributes ?? {};
  }

  // 2. Built-in rules (only if no backend, or backend said "allow" and rules
  //    might escalate).
  if (options.rules && options.rules.length > 0) {
    const rulesResult = await evaluateRules(
      ctx,
      options.rules,
      riskLevel,
    );
    if (rulesResult) {
      // Escalate: deny > require-approval > allow.
      if (
        shouldEscalate(rulesResult.verdict, verdict)
      ) {
        verdict = rulesResult.verdict;
        matchedRules = rulesResult.matchedRules;
        reason = rulesResult.reason;
      } else {
        // Merge matched rules even if we don't escalate.
        matchedRules = [...matchedRules, ...rulesResult.matchedRules];
      }
    }
  }

  const evalDurationMs = performance.now() - start;

  const record: DecisionRecord = {
    id: generateId(),
    timestamp: new Date().toISOString(),
    verdict,
    toolName: ctx.toolName,
    matchedRules,
    riskLevel,
    riskCategories,
    attributes: { ...ctx.userAttributes, ...attributes },
    reason,
    evalDurationMs,
    dryRun,
  };

  return record;
}

// ---------------------------------------------------------------------------
// Built-in rule evaluation
// ---------------------------------------------------------------------------

interface RulesResult {
  verdict: DecisionVerdict;
  matchedRules: string[];
  reason: string;
}

async function evaluateRules(
  ctx: PolicyContext,
  rules: PolicyRule[],
  toolRiskLevel: RiskLevel,
): Promise<RulesResult | null> {
  // Sort by priority descending.
  const sorted = [...rules].sort(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
  );

  for (const rule of sorted) {
    // Check tool pattern match.
    const patternMatch = rule.toolPatterns.some((p) =>
      matchGlob(p, ctx.toolName),
    );
    if (!patternMatch) continue;

    // Check risk level match (if specified).
    if (rule.riskLevels && rule.riskLevels.length > 0) {
      if (!rule.riskLevels.includes(toolRiskLevel)) continue;
    }

    // Check condition predicate.
    if (rule.condition) {
      const condResult = await rule.condition(ctx);
      if (!condResult) continue;
    }

    // Rule matched.
    return {
      verdict: rule.verdict,
      matchedRules: [rule.id],
      reason: rule.description ?? `Matched rule "${rule.id}".`,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VERDICT_SEVERITY: Record<DecisionVerdict, number> = {
  allow: 0,
  "require-approval": 1,
  deny: 2,
};

function shouldEscalate(
  candidate: DecisionVerdict,
  current: DecisionVerdict,
): boolean {
  return VERDICT_SEVERITY[candidate] > VERDICT_SEVERITY[current];
}
