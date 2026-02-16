/**
 * Ergonomic builder functions for creating policy rules.
 *
 * These provide a simpler on-ramp than writing raw PolicyRule objects,
 * while still producing the same type consumed by the engine.
 */

import type {
  DecisionVerdict,
  PolicyContext,
  PolicyRule,
  RiskLevel,
} from "../types.js";

let ruleCounter = 0;

function nextRuleId(prefix: string): string {
  return `${prefix}-${++ruleCounter}`;
}

// ---------------------------------------------------------------------------
// Simple allow / deny / require-approval rules
// ---------------------------------------------------------------------------

export interface SimpleRuleOptions {
  /** Tool name patterns (glob). */
  tools: string | string[];
  /** Optional risk level filter. */
  riskLevels?: RiskLevel[];
  /** Optional condition. */
  condition?: (ctx: PolicyContext) => boolean | Promise<boolean>;
  /** Description for audit trail. */
  description?: string;
  /** Priority (higher = first). */
  priority?: number;
}

function toRule(
  verdict: DecisionVerdict,
  opts: SimpleRuleOptions,
): PolicyRule {
  const tools = Array.isArray(opts.tools) ? opts.tools : [opts.tools];
  return {
    id: nextRuleId(verdict),
    description: opts.description,
    toolPatterns: tools,
    riskLevels: opts.riskLevels,
    verdict,
    condition: opts.condition,
    priority: opts.priority,
  };
}

/** Create a rule that allows matching tool calls. */
export function allow(opts: SimpleRuleOptions): PolicyRule {
  return toRule("allow", opts);
}

/** Create a rule that denies matching tool calls. */
export function deny(opts: SimpleRuleOptions): PolicyRule {
  return toRule("deny", opts);
}

/** Create a rule that requires approval for matching tool calls. */
export function requireApproval(opts: SimpleRuleOptions): PolicyRule {
  return toRule("require-approval", opts);
}

// ---------------------------------------------------------------------------
// Preset policy bundles
// ---------------------------------------------------------------------------

/**
 * A sensible default policy: low-risk tools are allowed, medium require
 * approval, high/critical are denied.
 */
export function defaultPolicy(): PolicyRule[] {
  return [
    allow({
      tools: "*",
      riskLevels: ["low"],
      description: "Allow all low-risk tools by default.",
      priority: 0,
    }),
    requireApproval({
      tools: "*",
      riskLevels: ["medium"],
      description: "Medium-risk tools require human approval.",
      priority: 0,
    }),
    deny({
      tools: "*",
      riskLevels: ["high", "critical"],
      description: "Deny high and critical-risk tools by default.",
      priority: 0,
    }),
  ];
}

/**
 * Read-only policy: allow data-read tools, deny everything else.
 */
export function readOnlyPolicy(readToolPatterns: string[]): PolicyRule[] {
  return [
    allow({
      tools: readToolPatterns,
      description: "Allow read-only tools.",
      priority: 10,
    }),
    deny({
      tools: "*",
      description: "Deny all non-read tools.",
      priority: 0,
    }),
  ];
}
