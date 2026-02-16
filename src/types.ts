/**
 * Core type definitions for ai-tool-guard.
 *
 * These types model the policy engine, decision records, approval flows,
 * guard configuration, and observability hooks that power the library.
 */

import type { z } from "zod";

// ---------------------------------------------------------------------------
// Risk & classification
// ---------------------------------------------------------------------------

/** Risk levels assigned to tools or actions. */
export type RiskLevel = "low" | "medium" | "high" | "critical";

/** Human-readable category tags for audit / explainability. */
export type RiskCategory =
  | "data-read"
  | "data-write"
  | "data-delete"
  | "network"
  | "filesystem"
  | "authentication"
  | "payment"
  | "pii"
  | "custom";

// ---------------------------------------------------------------------------
// Decision records  (requirement #2 – first-class explanations)
// ---------------------------------------------------------------------------

export type DecisionVerdict = "allow" | "deny" | "require-approval";

export interface DecisionRecord {
  /** Unique id for correlation. */
  id: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Final verdict. */
  verdict: DecisionVerdict;
  /** Name of the tool under evaluation. */
  toolName: string;
  /** Which policy rule(s) matched. */
  matchedRules: string[];
  /** Risk level of the tool as evaluated. */
  riskLevel: RiskLevel;
  /** Risk categories that applied. */
  riskCategories: RiskCategory[];
  /** Free-form attributes consumed during eval (user roles, etc.). */
  attributes: Record<string, unknown>;
  /** Human-readable explanation string. */
  reason: string;
  /** If output was redacted, which fields. */
  redactions?: string[];
  /** Duration of policy evaluation in ms. */
  evalDurationMs: number;
  /** Whether this was a dry-run evaluation. */
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Policy primitives  (requirements #1, #3, #4)
// ---------------------------------------------------------------------------

/** Context passed into every policy evaluation. */
export interface PolicyContext {
  /** Name of the tool being invoked. */
  toolName: string;
  /** The arguments the model wants to pass. */
  args: Record<string, unknown>;
  /** Caller-supplied attributes (user id, roles, tenant, etc.). */
  userAttributes: Record<string, unknown>;
  /** Conversation-level metadata for contextual policies (#4). */
  conversation?: ConversationContext;
  /** When true, the engine is in dry-run / simulation mode (#3). */
  dryRun?: boolean;
}

/** Conversation metadata available to context-aware policies (#4). */
export interface ConversationContext {
  /** Unique conversation / session id. */
  sessionId?: string;
  /** Running risk score for the conversation. */
  riskScore?: number;
  /** Count of prior tool failures in this conversation. */
  priorFailures?: number;
  /** Tool names approved earlier in this conversation. */
  recentApprovals?: string[];
  /** Arbitrary key-value bag for app-specific state. */
  metadata?: Record<string, unknown>;
}

/**
 * A policy rule is the atomic unit of the built-in policy engine.
 * For external DSL backends (OPA/Cedar), use `PolicyBackend` instead.
 */
export interface PolicyRule {
  /** Stable identifier for the rule (used in decision records). */
  id: string;
  /** Human-readable description. */
  description?: string;
  /** Tool name glob patterns this rule applies to (e.g. "db.*", "*"). */
  toolPatterns: string[];
  /** Risk levels this rule matches. */
  riskLevels?: RiskLevel[];
  /** Verdict to apply when this rule matches. */
  verdict: DecisionVerdict;
  /** Optional predicate for attribute-based / contextual matching. */
  condition?: (ctx: PolicyContext) => boolean | Promise<boolean>;
  /** Priority (higher = evaluated first). Default 0. */
  priority?: number;
}

/**
 * Adapter for external policy backends (OPA, Cedar, custom) (#1).
 * Implement this interface to delegate decisions to an external engine.
 */
export interface PolicyBackend {
  /** Unique name for logging / tracing. */
  name: string;
  /** Evaluate a tool invocation and return a verdict + explanation. */
  evaluate(ctx: PolicyContext): Promise<PolicyBackendResult>;
}

export interface PolicyBackendResult {
  verdict: DecisionVerdict;
  reason: string;
  matchedRules: string[];
  attributes?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tool guard configuration
// ---------------------------------------------------------------------------

/** Per-tool metadata attached via `guardTool` or `guardTools`. */
export interface ToolGuardConfig {
  /** Risk level of this tool. */
  riskLevel?: RiskLevel;
  /** Risk categories for classification. */
  riskCategories?: RiskCategory[];
  /** Maximum calls per window (rate limiting, #11). */
  rateLimit?: RateLimitConfig;
  /** Concurrency cap for this tool (#11). */
  maxConcurrency?: number;
  /** Argument-level validators (#8). */
  argGuards?: ArgGuard[];
  /** Output filters applied after execution (#10). */
  outputFilters?: OutputFilter[];
  /** Whether to require approval regardless of policy. */
  requireApproval?: boolean;
  /** MCP fingerprint for drift detection (#15). */
  mcpFingerprint?: string;
}

// ---------------------------------------------------------------------------
// Argument guards  (#8 – schema + semantic checks)
// ---------------------------------------------------------------------------

export interface ArgGuard {
  /** Which argument field(s) this guard targets (dot-path or "*"). */
  field: string;
  /** Validation function. Return string to deny with reason, null to pass. */
  validate: (
    value: unknown,
    ctx: PolicyContext,
  ) => string | null | Promise<string | null>;
}

/**
 * Convenience: create an ArgGuard from a Zod schema for a specific field.
 */
export interface ZodArgGuard {
  field: string;
  schema: z.ZodType;
}

// ---------------------------------------------------------------------------
// Output filtering  (#10 – egress controls)
// ---------------------------------------------------------------------------

export type OutputFilterVerdict = "pass" | "redact" | "block";

export interface OutputFilter {
  /** Identifier for logging. */
  name: string;
  /**
   * Inspect / transform the tool result.
   * Return the (possibly redacted) result, or throw to block entirely.
   */
  filter(
    result: unknown,
    ctx: PolicyContext,
  ): Promise<OutputFilterResult>;
}

export interface OutputFilterResult {
  verdict: OutputFilterVerdict;
  /** The (possibly transformed) output. */
  output: unknown;
  /** Fields that were redacted (for the decision record). */
  redactedFields?: string[];
}

// ---------------------------------------------------------------------------
// Approval flow  (#5, #6)
// ---------------------------------------------------------------------------

/** Unique token tying an approval request to a specific tool call. */
export interface ApprovalToken {
  /** Random id. */
  id: string;
  /** Hash of the original tool call payload for correlation (#6). */
  payloadHash: string;
  /** Tool name. */
  toolName: string;
  /** Original arguments snapshot. */
  originalArgs: Record<string, unknown>;
  /** ISO-8601 creation time. */
  createdAt: string;
  /** Optional TTL in ms after which the token expires. */
  ttlMs?: number;
}

/** Resolution returned by the approval handler. */
export interface ApprovalResolution {
  /** Whether the call is approved. */
  approved: boolean;
  /** Optionally patched arguments (#5 – "approve with edits"). */
  patchedArgs?: Record<string, unknown>;
  /** Who approved (for audit). */
  approvedBy?: string;
  /** Reason for denial. */
  reason?: string;
}

/** Callback the consumer implements to handle approval requests. */
export type ApprovalHandler = (
  token: ApprovalToken,
) => Promise<ApprovalResolution>;

// ---------------------------------------------------------------------------
// Rate limiting & concurrency  (#11)
// ---------------------------------------------------------------------------

export interface RateLimitConfig {
  /** Maximum calls allowed in the window. */
  maxCalls: number;
  /** Window size in ms. */
  windowMs: number;
  /** Strategy when limit is hit. */
  strategy?: "reject" | "queue";
}

export interface RateLimitState {
  /** Timestamps of recent calls. */
  timestamps: number[];
  /** Current concurrency count. */
  activeCalls: number;
}

// ---------------------------------------------------------------------------
// Injection detection  (#9)
// ---------------------------------------------------------------------------

export interface InjectionDetectorConfig {
  /** Sensitivity threshold (0-1). Default 0.5. */
  threshold?: number;
  /** Action to take on suspected injection. */
  action?: "downgrade" | "deny" | "log";
  /** Custom detector function. Return suspicion score 0-1. */
  detect?: (args: Record<string, unknown>) => number | Promise<number>;
}

// ---------------------------------------------------------------------------
// MCP drift detection  (#15)
// ---------------------------------------------------------------------------

export interface McpToolFingerprint {
  /** Tool name. */
  toolName: string;
  /** Server identifier. */
  serverId: string;
  /** SHA-256 of the canonical schema. */
  schemaHash: string;
  /** ISO-8601 timestamp when pinned. */
  pinnedAt: string;
  /** Environment tag (e.g. "production", "staging"). */
  environment?: string;
}

export interface McpDriftResult {
  /** Whether drift was detected. */
  drifted: boolean;
  /** Which tools changed. */
  changes: McpDriftChange[];
}

export interface McpDriftChange {
  toolName: string;
  serverId: string;
  expectedHash: string;
  actualHash: string;
  /** Human-readable remediation. */
  remediation: string;
}

// ---------------------------------------------------------------------------
// OpenTelemetry integration  (#12)
// ---------------------------------------------------------------------------

export interface OtelConfig {
  /** Whether tracing is enabled. Default true when OTel API is available. */
  enabled?: boolean;
  /** Custom tracer name. Default "ai-tool-guard". */
  tracerName?: string;
  /** Additional span attributes added to every span. */
  defaultAttributes?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Top-level guard options (the main config object)
// ---------------------------------------------------------------------------

export interface GuardOptions {
  /** Built-in policy rules. */
  rules?: PolicyRule[];
  /** External policy backend (OPA, Cedar, custom). */
  backend?: PolicyBackend;
  /** Default risk level for tools without explicit config. */
  defaultRiskLevel?: RiskLevel;
  /** Approval handler callback. */
  onApprovalRequired?: ApprovalHandler;
  /** Global injection detection config (#9). */
  injectionDetection?: InjectionDetectorConfig;
  /** Global rate limit defaults (#11). */
  defaultRateLimit?: RateLimitConfig;
  /** Global concurrency cap (#11). */
  defaultMaxConcurrency?: number;
  /** OpenTelemetry config (#12). */
  otel?: OtelConfig;
  /** Run in dry-run / simulation mode (#3). */
  dryRun?: boolean;
  /** Called for every decision (allow, deny, approval). */
  onDecision?: (record: DecisionRecord) => void | Promise<void>;
  /** User attributes resolver (called per invocation). */
  resolveUserAttributes?: () =>
    | Record<string, unknown>
    | Promise<Record<string, unknown>>;
  /** Conversation context resolver. */
  resolveConversationContext?: () =>
    | ConversationContext
    | Promise<ConversationContext>;
}
