/**
 * Prompt-injection resistance at the tool boundary (#9).
 *
 * Configurable detection that can automatically downgrade capabilities
 * (e.g., convert writes → require approval) when arguments look adversarial.
 */

import type {
  DecisionVerdict,
  InjectionDetectorConfig,
  PolicyContext,
} from "../types.js";

// ---------------------------------------------------------------------------
// Built-in heuristic detector
// ---------------------------------------------------------------------------

/** Common prompt injection indicators. */
const INJECTION_PATTERNS: Array<{ pattern: RegExp; weight: number }> = [
  // Instruction override attempts
  { pattern: /ignore\s+(previous|all|above|prior)\s+instructions/i, weight: 0.9 },
  { pattern: /disregard\s+(previous|all|above|prior)/i, weight: 0.85 },
  { pattern: /you\s+are\s+now\s+a/i, weight: 0.7 },
  { pattern: /new\s+instructions?:/i, weight: 0.75 },
  { pattern: /system\s*prompt/i, weight: 0.6 },
  // Role hijacking
  { pattern: /\bact\s+as\b/i, weight: 0.5 },
  { pattern: /\bpretend\s+(you('re|re)?|to\s+be)\b/i, weight: 0.6 },
  // Delimiter injection
  { pattern: /```system/i, weight: 0.8 },
  { pattern: /<\/?system>/i, weight: 0.7 },
  // Data exfiltration attempts
  { pattern: /(?:fetch|curl|wget|http[s]?:\/\/)/i, weight: 0.4 },
  // Encoded payloads
  { pattern: /base64[_\s]*(?:decode|encode)/i, weight: 0.5 },
  { pattern: /\\x[0-9a-f]{2}/i, weight: 0.4 },
];

/**
 * Built-in heuristic detector. Returns a suspicion score from 0 to 1.
 */
function heuristicDetect(args: Record<string, unknown>): number {
  const text = flattenToString(args);
  if (!text) return 0;

  let maxScore = 0;
  for (const { pattern, weight } of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      maxScore = Math.max(maxScore, weight);
    }
  }

  // Length heuristic: very long string arguments are more suspicious.
  if (text.length > 5000) {
    maxScore = Math.max(maxScore, 0.3);
  }

  return Math.min(maxScore, 1);
}

/** Flatten all string values in args into one blob for scanning. */
function flattenToString(obj: unknown, depth = 0): string {
  if (depth > 10) return "";
  if (typeof obj === "string") return obj;
  if (Array.isArray(obj)) {
    return obj.map((v) => flattenToString(v, depth + 1)).join(" ");
  }
  if (obj && typeof obj === "object") {
    return Object.values(obj)
      .map((v) => flattenToString(v, depth + 1))
      .join(" ");
  }
  return "";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface InjectionCheckResult {
  /** Suspicion score 0-1. */
  score: number;
  /** Whether the threshold was exceeded. */
  suspected: boolean;
  /** The action to take based on config. */
  action: InjectionDetectorConfig["action"];
  /** How the verdict should be modified (if at all). */
  verdictOverride?: DecisionVerdict;
}

/**
 * Check tool arguments for potential prompt injection.
 */
export async function checkInjection(
  ctx: PolicyContext,
  config: InjectionDetectorConfig,
): Promise<InjectionCheckResult> {
  const threshold = config.threshold ?? 0.5;
  const action = config.action ?? "log";

  const score = config.detect
    ? await config.detect(ctx.args)
    : heuristicDetect(ctx.args);

  const suspected = score >= threshold;

  let verdictOverride: DecisionVerdict | undefined;
  if (suspected) {
    switch (action) {
      case "deny":
        verdictOverride = "deny";
        break;
      case "downgrade":
        verdictOverride = "require-approval";
        break;
      case "log":
        // No verdict change, just log it.
        break;
    }
  }

  return { score, suspected, action, verdictOverride };
}
