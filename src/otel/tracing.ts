/**
 * OpenTelemetry integration (#12).
 *
 * Opinionated spans for policy evaluation, approval wait time,
 * tool execution, redaction, and budget checks. Semantic attributes
 * for tool name, risk level, and decision verdict.
 *
 * Falls back to a no-op tracer when @opentelemetry/api is not installed.
 */

import type { DecisionRecord, OtelConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Semantic attribute keys
// ---------------------------------------------------------------------------

export const ATTR = {
  TOOL_NAME: "ai_tool_guard.tool.name",
  TOOL_RISK_LEVEL: "ai_tool_guard.tool.risk_level",
  TOOL_RISK_CATEGORIES: "ai_tool_guard.tool.risk_categories",
  DECISION_VERDICT: "ai_tool_guard.decision.verdict",
  DECISION_REASON: "ai_tool_guard.decision.reason",
  DECISION_MATCHED_RULES: "ai_tool_guard.decision.matched_rules",
  DECISION_DRY_RUN: "ai_tool_guard.decision.dry_run",
  APPROVAL_TOKEN_ID: "ai_tool_guard.approval.token_id",
  APPROVAL_APPROVED: "ai_tool_guard.approval.approved",
  APPROVAL_PATCHED: "ai_tool_guard.approval.patched",
  INJECTION_SCORE: "ai_tool_guard.injection.score",
  INJECTION_SUSPECTED: "ai_tool_guard.injection.suspected",
  RATE_LIMIT_ALLOWED: "ai_tool_guard.rate_limit.allowed",
  OUTPUT_REDACTED: "ai_tool_guard.output.redacted",
  OUTPUT_BLOCKED: "ai_tool_guard.output.blocked",
  MCP_DRIFT_DETECTED: "ai_tool_guard.mcp.drift_detected",
} as const;

// ---------------------------------------------------------------------------
// Tracer abstraction (optional OTel dependency)
// ---------------------------------------------------------------------------

/** Minimal span interface we need. */
export interface Span {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: { code: number; message?: string }): void;
  end(): void;
}

/** Minimal tracer interface. */
export interface Tracer {
  startSpan(name: string, options?: { attributes?: Record<string, string | number | boolean> }): Span;
}

/** No-op span for when OTel is not available. */
class NoopSpan implements Span {
  setAttribute(): void {}
  setStatus(): void {}
  end(): void {}
}

/** No-op tracer. */
class NoopTracer implements Tracer {
  startSpan(): Span {
    return new NoopSpan();
  }
}

/**
 * Attempt to load the real OTel tracer, falling back to noop.
 */
export function createTracer(config?: OtelConfig): Tracer {
  if (config?.enabled === false) {
    return new NoopTracer();
  }

  try {
    // Dynamic import of optional peer dependency.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const otelApi = require("@opentelemetry/api") as typeof import("@opentelemetry/api");
    return otelApi.trace.getTracer(
      config?.tracerName ?? "ai-tool-guard",
    ) as unknown as Tracer;
  } catch {
    return new NoopTracer();
  }
}

// ---------------------------------------------------------------------------
// Span helpers
// ---------------------------------------------------------------------------

/**
 * Create a span for policy evaluation and populate it from a DecisionRecord.
 */
export function spanFromDecision(
  tracer: Tracer,
  record: DecisionRecord,
  config?: OtelConfig,
): Span {
  const span = tracer.startSpan("ai_tool_guard.policy_eval", {
    attributes: {
      ...config?.defaultAttributes,
      [ATTR.TOOL_NAME]: record.toolName,
      [ATTR.TOOL_RISK_LEVEL]: record.riskLevel,
      [ATTR.TOOL_RISK_CATEGORIES]: record.riskCategories.join(","),
      [ATTR.DECISION_VERDICT]: record.verdict,
      [ATTR.DECISION_REASON]: record.reason,
      [ATTR.DECISION_MATCHED_RULES]: record.matchedRules.join(","),
      [ATTR.DECISION_DRY_RUN]: record.dryRun,
    },
  });

  if (record.verdict === "deny") {
    span.setStatus({ code: 2, message: record.reason }); // SpanStatusCode.ERROR
  }

  return span;
}

/**
 * Create a span for tool execution.
 */
export function startToolExecutionSpan(
  tracer: Tracer,
  toolName: string,
  config?: OtelConfig,
): Span {
  return tracer.startSpan("ai_tool_guard.tool_execute", {
    attributes: {
      ...config?.defaultAttributes,
      [ATTR.TOOL_NAME]: toolName,
    },
  });
}

/**
 * Create a span for approval wait time.
 */
export function startApprovalSpan(
  tracer: Tracer,
  toolName: string,
  tokenId: string,
  config?: OtelConfig,
): Span {
  return tracer.startSpan("ai_tool_guard.approval_wait", {
    attributes: {
      ...config?.defaultAttributes,
      [ATTR.TOOL_NAME]: toolName,
      [ATTR.APPROVAL_TOKEN_ID]: tokenId,
    },
  });
}
