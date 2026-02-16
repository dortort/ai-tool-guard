/**
 * Main guard API — wraps Vercel AI SDK tools with policy enforcement.
 *
 * This module is the primary integration point. It takes standard AI SDK
 * tool definitions and returns guarded versions that enforce policies,
 * validate arguments, handle approvals, apply rate limits, filter output,
 * and emit telemetry spans.
 */

import type { PolicyContext, ToolGuardConfig, GuardOptions, DecisionRecord, RiskLevel, RiskCategory } from "./types.js";
import { evaluatePolicy } from "./policy/engine.js";
import { ApprovalManager } from "./approval/manager.js";
import { evaluateArgGuards } from "./guards/arg-guards.js";
import { checkInjection } from "./guards/injection.js";
import { runOutputFilters } from "./guards/output-filter.js";
import { RateLimiter } from "./guards/rate-limiter.js";
import {
  createTracer,
  spanFromDecision,
  startToolExecutionSpan,
  startApprovalSpan,
  ATTR,
} from "./otel/tracing.js";
import type { Tracer } from "./otel/tracing.js";

// ---------------------------------------------------------------------------
// Vercel AI SDK tool type (minimal interface to avoid hard coupling)
// ---------------------------------------------------------------------------

/**
 * Minimal interface matching the Vercel AI SDK `tool()` return shape.
 * We depend on the structural type rather than importing from `ai` directly
 * so the library works across AI SDK versions.
 */
export interface AiSdkTool<TArgs = Record<string, unknown>, TResult = unknown> {
  description?: string;
  parameters: unknown; // Zod schema
  execute?: (args: TArgs, options: ToolExecuteOptions) => Promise<TResult>;
  [key: string]: unknown;
}

export interface ToolExecuteOptions {
  toolCallId: string;
  messages?: unknown[];
  abortSignal?: AbortSignal;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Guard factory
// ---------------------------------------------------------------------------

/**
 * Create a `ToolGuard` instance from options. This is the main entry point.
 *
 * ```ts
 * const guard = createToolGuard({
 *   rules: [deny({ tools: "dangerousTool" })],
 *   onApprovalRequired: async (token) => showApprovalModal(token),
 *   otel: { enabled: true },
 * });
 *
 * const tools = guard.guardTools({
 *   myTool: { tool: myAiSdkTool, riskLevel: "medium" },
 * });
 * ```
 */
export function createToolGuard(options: GuardOptions = {}): ToolGuard {
  return new ToolGuard(options);
}

// ---------------------------------------------------------------------------
// ToolGuard class
// ---------------------------------------------------------------------------

export class ToolGuard {
  private readonly options: GuardOptions;
  private readonly tracer: Tracer;
  private readonly rateLimiter: RateLimiter;
  private readonly approvalManager: ApprovalManager | null;

  constructor(options: GuardOptions) {
    this.options = options;
    this.tracer = createTracer(options.otel);
    this.rateLimiter = new RateLimiter();
    this.approvalManager = options.onApprovalRequired
      ? new ApprovalManager(options.onApprovalRequired)
      : null;
  }

  /**
   * Wrap a single AI SDK tool with guard enforcement.
   */
  guardTool<TArgs extends Record<string, unknown>, TResult>(
    name: string,
    tool: AiSdkTool<TArgs, TResult>,
    config?: ToolGuardConfig,
  ): AiSdkTool<TArgs, TResult> {
    const guard = this;
    const originalExecute = tool.execute;

    if (!originalExecute) {
      // Tool without execute (e.g., client-side tool). Pass through.
      return tool;
    }

    return {
      ...tool,
      execute: async (args: TArgs, execOptions: ToolExecuteOptions) => {
        return guard.executeGuarded(
          name,
          args,
          execOptions,
          originalExecute,
          config,
        );
      },
    };
  }

  /**
   * Wrap multiple AI SDK tools at once.
   *
   * Input map shape: `{ toolName: { tool, ...guardConfig } }`.
   * Returns a flat `{ toolName: guardedTool }` map compatible with
   * `generateText({ tools })`.
   */
  guardTools<T extends Record<string, ToolWithConfig>>(
    toolMap: T,
  ): { [K in keyof T]: AiSdkTool } {
    const result: Record<string, AiSdkTool> = {};

    for (const [name, entry] of Object.entries(toolMap)) {
      const { tool, ...config } = entry;
      result[name] = this.guardTool(name, tool, config);
    }

    return result as { [K in keyof T]: AiSdkTool };
  }

  // -------------------------------------------------------------------------
  // Core execution pipeline
  // -------------------------------------------------------------------------

  private async executeGuarded<TArgs extends Record<string, unknown>, TResult>(
    toolName: string,
    args: TArgs,
    execOptions: ToolExecuteOptions,
    execute: (args: TArgs, options: ToolExecuteOptions) => Promise<TResult>,
    config?: ToolGuardConfig,
  ): Promise<TResult> {
    // 1. Build policy context.
    const ctx: PolicyContext = {
      toolName,
      args: args as Record<string, unknown>,
      userAttributes: this.options.resolveUserAttributes
        ? await this.options.resolveUserAttributes()
        : {},
      conversation: this.options.resolveConversationContext
        ? await this.options.resolveConversationContext()
        : undefined,
      dryRun: this.options.dryRun,
    };

    // 2. Injection detection.
    if (this.options.injectionDetection) {
      const injectionResult = await checkInjection(
        ctx,
        this.options.injectionDetection,
      );
      if (injectionResult.suspected) {
        const span = this.tracer.startSpan("ai_tool_guard.injection_check");
        span.setAttribute(ATTR.INJECTION_SCORE, injectionResult.score);
        span.setAttribute(ATTR.INJECTION_SUSPECTED, true);
        span.end();

        if (injectionResult.verdictOverride === "deny") {
          throw new ToolGuardError(
            `Tool call "${toolName}" blocked: prompt injection suspected ` +
              `(score: ${injectionResult.score.toFixed(2)}).`,
            "injection-detected",
            toolName,
          );
        }
        // "downgrade" case is handled below as require-approval.
        if (injectionResult.verdictOverride === "require-approval") {
          config = { ...config, requireApproval: true };
        }
      }
    }

    // 3. Argument-level guards.
    if (config?.argGuards && config.argGuards.length > 0) {
      const argResult = await evaluateArgGuards(config.argGuards, ctx);
      if (!argResult.passed) {
        const messages = argResult.violations
          .map((v) => `${v.field}: ${v.message}`)
          .join("; ");
        throw new ToolGuardError(
          `Argument validation failed for "${toolName}": ${messages}`,
          "arg-validation-failed",
          toolName,
        );
      }
    }

    // 4. Policy evaluation.
    const decision = await evaluatePolicy(ctx, this.options, {
      riskLevel: config?.riskLevel,
      riskCategories: config?.riskCategories,
    });

    // Emit OTel span for policy eval.
    const policySpan = spanFromDecision(
      this.tracer,
      decision,
      this.options.otel,
    );
    policySpan.end();

    // Notify decision listener.
    if (this.options.onDecision) {
      await this.options.onDecision(decision);
    }

    // 5. Handle verdict.
    let effectiveVerdict = decision.verdict;

    // Override to require-approval if config says so.
    if (config?.requireApproval && effectiveVerdict === "allow") {
      effectiveVerdict = "require-approval";
    }

    if (effectiveVerdict === "deny" && !decision.dryRun) {
      throw new ToolGuardError(
        `Tool call "${toolName}" denied: ${decision.reason}`,
        "policy-denied",
        toolName,
        decision,
      );
    }

    // 6. Approval flow.
    let finalArgs = args;
    if (effectiveVerdict === "require-approval" && !decision.dryRun) {
      if (!this.approvalManager) {
        throw new ToolGuardError(
          `Tool "${toolName}" requires approval but no onApprovalRequired handler is configured.`,
          "no-approval-handler",
          toolName,
          decision,
        );
      }

      const approvalSpan = startApprovalSpan(
        this.tracer,
        toolName,
        decision.id,
        this.options.otel,
      );

      const approvalResult = await this.approvalManager.requestApproval(ctx);

      approvalSpan.setAttribute(
        ATTR.APPROVAL_APPROVED,
        approvalResult.approved,
      );
      if (approvalResult.patchedFields) {
        approvalSpan.setAttribute(ATTR.APPROVAL_PATCHED, true);
      }
      approvalSpan.end();

      if (!approvalResult.approved) {
        throw new ToolGuardError(
          `Tool call "${toolName}" not approved: ${approvalResult.reason ?? approvalResult.error ?? "denied"}`,
          "approval-denied",
          toolName,
          decision,
        );
      }

      // Use patched args if provided.
      finalArgs = approvalResult.args as TArgs;
    }

    // 7. Rate limiting.
    const rateConfig =
      config?.rateLimit ?? this.options.defaultRateLimit;
    if (rateConfig) {
      const maxConcurrency =
        config?.maxConcurrency ?? this.options.defaultMaxConcurrency;
      const rlResult = await this.rateLimiter.acquire(
        toolName,
        rateConfig,
        maxConcurrency,
      );
      if (!rlResult.allowed) {
        const span = this.tracer.startSpan("ai_tool_guard.rate_limit");
        span.setAttribute(ATTR.RATE_LIMIT_ALLOWED, false);
        span.end();

        throw new ToolGuardError(
          rlResult.reason ?? `Rate limit exceeded for "${toolName}".`,
          "rate-limited",
          toolName,
        );
      }
    }

    // 8. Execute the tool.
    const execSpan = startToolExecutionSpan(
      this.tracer,
      toolName,
      this.options.otel,
    );

    let result: TResult;
    try {
      if (decision.dryRun) {
        // In dry-run mode, do not execute the tool.
        result = { dryRun: true, toolName, args: finalArgs } as unknown as TResult;
      } else {
        result = await execute(finalArgs, execOptions);
      }
    } catch (err) {
      execSpan.setStatus({
        code: 2,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      execSpan.end();
      // Release concurrency slot.
      if (rateConfig) {
        this.rateLimiter.release(toolName);
      }
    }

    // 9. Output filtering.
    if (config?.outputFilters && config.outputFilters.length > 0) {
      const filterResult = await runOutputFilters(
        config.outputFilters,
        result,
        ctx,
      );

      if (filterResult.blocked) {
        const span = this.tracer.startSpan("ai_tool_guard.output_filter");
        span.setAttribute(ATTR.OUTPUT_BLOCKED, true);
        span.end();

        throw new ToolGuardError(
          `Output from "${toolName}" blocked by filter "${filterResult.blockedBy}".`,
          "output-blocked",
          toolName,
        );
      }

      if (filterResult.redactedFields.length > 0) {
        const span = this.tracer.startSpan("ai_tool_guard.output_filter");
        span.setAttribute(ATTR.OUTPUT_REDACTED, true);
        span.end();
      }

      result = filterResult.output as TResult;
    }

    return result;
  }
}

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

/** Config shape for guardTools() input entries. */
export interface ToolWithConfig extends ToolGuardConfig {
  tool: AiSdkTool;
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export type ToolGuardErrorCode =
  | "policy-denied"
  | "approval-denied"
  | "no-approval-handler"
  | "arg-validation-failed"
  | "injection-detected"
  | "rate-limited"
  | "output-blocked"
  | "mcp-drift";

export class ToolGuardError extends Error {
  readonly code: ToolGuardErrorCode;
  readonly toolName: string;
  readonly decision?: DecisionRecord;

  constructor(
    message: string,
    code: ToolGuardErrorCode,
    toolName: string,
    decision?: DecisionRecord,
  ) {
    super(message);
    this.name = "ToolGuardError";
    this.code = code;
    this.toolName = toolName;
    this.decision = decision;
  }
}
