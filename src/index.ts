/**
 * ai-tool-guard — Policy enforcement middleware for Vercel AI SDK tool calls.
 *
 * @module ai-tool-guard
 */

// Main API
export { createToolGuard, ToolGuard, ToolGuardError } from "./guard.js";
export type {
  AiSdkTool,
  ToolExecuteOptions,
  ToolWithConfig,
  ToolGuardErrorCode,
} from "./guard.js";

// Types
export type {
  RiskLevel,
  RiskCategory,
  DecisionVerdict,
  DecisionRecord,
  PolicyContext,
  ConversationContext,
  PolicyRule,
  PolicyBackend,
  PolicyBackendResult,
  ToolGuardConfig,
  ArgGuard,
  ZodArgGuard,
  OutputFilter,
  OutputFilterResult,
  OutputFilterVerdict,
  ApprovalToken,
  ApprovalResolution,
  ApprovalHandler,
  RateLimitConfig,
  RateLimitState,
  InjectionDetectorConfig,
  McpToolFingerprint,
  McpDriftResult,
  McpDriftChange,
  OtelConfig,
  GuardOptions,
} from "./types.js";

// Policy engine
export {
  evaluatePolicy,
  allow,
  deny,
  requireApproval,
  defaultPolicy,
  readOnlyPolicy,
  simulate,
} from "./policy/index.js";
export type { RecordedToolCall, SimulationResult } from "./policy/index.js";

// Approval
export { ApprovalManager } from "./approval/index.js";
export type { ApprovalFlowResult } from "./approval/index.js";

// Guards
export {
  zodGuard,
  allowlist,
  denylist,
  regexGuard,
  piiGuard,
  evaluateArgGuards,
  checkInjection,
  secretsFilter,
  piiOutputFilter,
  customFilter,
  runOutputFilters,
  RateLimiter,
} from "./guards/index.js";
export type {
  ArgGuardResult,
  InjectionCheckResult,
  RedactionRule,
  OutputFilterChainResult,
  RateLimitAcquireResult,
} from "./guards/index.js";

// OTel
export {
  createTracer,
  spanFromDecision,
  startToolExecutionSpan,
  startApprovalSpan,
  ATTR,
} from "./otel/index.js";
export type { Span, Tracer } from "./otel/index.js";

// MCP
export {
  computeFingerprint,
  pinFingerprint,
  detectDrift,
  FingerprintStore,
} from "./mcp/index.js";
