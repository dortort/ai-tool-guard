import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createTracer,
  spanFromDecision,
  startToolExecutionSpan,
  startApprovalSpan,
  ATTR,
  type Tracer,
  type Span,
} from "./tracing.js";
import type { DecisionRecord } from "../types.js";

// ---------------------------------------------------------------------------
// Mock Tracer and Span for testing
// ---------------------------------------------------------------------------

class MockSpan implements Span {
  public attributes: Record<string, string | number | boolean> = {};
  public status?: { code: number; message?: string };
  public ended = false;

  setAttribute(key: string, value: string | number | boolean): void {
    this.attributes[key] = value;
  }

  setStatus(status: { code: number; message?: string }): void {
    this.status = status;
  }

  end(): void {
    this.ended = true;
  }
}

class MockTracer implements Tracer {
  public spans: MockSpan[] = [];
  public lastSpanName?: string;
  public lastSpanOptions?: { attributes?: Record<string, string | number | boolean> };

  startSpan(
    name: string,
    options?: { attributes?: Record<string, string | number | boolean> },
  ): Span {
    this.lastSpanName = name;
    this.lastSpanOptions = options;
    const span = new MockSpan();
    if (options?.attributes) {
      Object.entries(options.attributes).forEach(([key, value]) => {
        span.setAttribute(key, value);
      });
    }
    this.spans.push(span);
    return span;
  }
}

// ---------------------------------------------------------------------------
// Helper to create a sample DecisionRecord
// ---------------------------------------------------------------------------

function createSampleDecision(overrides?: Partial<DecisionRecord>): DecisionRecord {
  return {
    id: "test-id-123",
    timestamp: "2024-01-15T10:30:00Z",
    verdict: "allow",
    toolName: "test_tool",
    matchedRules: ["rule1", "rule2"],
    riskLevel: "medium",
    riskCategories: ["data-access"],
    attributes: {},
    reason: "Test reason",
    evalDurationMs: 42,
    dryRun: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createTracer", () => {
  it("returns a NoopTracer when disabled", () => {
    const tracer = createTracer({ enabled: false });
    expect(tracer).toBeDefined();

    // Verify it produces noop spans
    const span = tracer.startSpan("test-span");
    expect(span).toBeDefined();
    expect(() => span.setAttribute("key", "value")).not.toThrow();
    expect(() => span.setStatus({ code: 2 })).not.toThrow();
    expect(() => span.end()).not.toThrow();
  });

  it("returns a tracer with default tracerName when enabled", () => {
    const tracer = createTracer({ enabled: true });
    expect(tracer).toBeDefined();
    // The tracer should be functional (either real OTel or noop)
    const span = tracer.startSpan("test-span");
    expect(span).toBeDefined();
  });

  it("returns a tracer with custom tracerName", () => {
    const tracer = createTracer({ tracerName: "custom-tracer" });
    expect(tracer).toBeDefined();
  });

  it("caches the tracer for same tracerName", () => {
    const tracer1 = createTracer({ tracerName: "cached-tracer" });
    const tracer2 = createTracer({ tracerName: "cached-tracer" });
    // Both should be the same instance due to caching
    expect(tracer1).toBe(tracer2);
  });
});

describe("spanFromDecision", () => {
  let mockTracer: MockTracer;

  beforeEach(() => {
    mockTracer = new MockTracer();
  });

  it("creates a span with correct name and attributes", () => {
    const decision = createSampleDecision({
      toolName: "read_file",
      verdict: "allow",
      riskLevel: "high",
      riskCategories: ["file-system", "sensitive-data"],
      reason: "Allowed by policy",
      matchedRules: ["allow-rule-1"],
      dryRun: true,
    });

    const span = spanFromDecision(mockTracer, decision);

    expect(mockTracer.lastSpanName).toBe("ai_tool_guard.policy_eval");
    expect(mockTracer.spans).toHaveLength(1);
    expect(span).toBe(mockTracer.spans[0]);

    const attributes = mockTracer.spans[0].attributes;
    expect(attributes[ATTR.TOOL_NAME]).toBe("read_file");
    expect(attributes[ATTR.TOOL_RISK_LEVEL]).toBe("high");
    expect(attributes[ATTR.TOOL_RISK_CATEGORIES]).toBe("file-system,sensitive-data");
    expect(attributes[ATTR.DECISION_VERDICT]).toBe("allow");
    expect(attributes[ATTR.DECISION_REASON]).toBe("Allowed by policy");
    expect(attributes[ATTR.DECISION_MATCHED_RULES]).toBe("allow-rule-1");
    expect(attributes[ATTR.DECISION_DRY_RUN]).toBe(true);
  });

  it("sets error status for deny verdicts", () => {
    const decision = createSampleDecision({
      verdict: "deny",
      reason: "Blocked by security policy",
    });

    const span = spanFromDecision(mockTracer, decision) as MockSpan;

    expect(span.status).toEqual({
      code: 2,
      message: "Blocked by security policy",
    });
  });

  it("does not set error status for allow verdicts", () => {
    const decision = createSampleDecision({
      verdict: "allow",
      reason: "Policy allows this action",
    });

    const span = spanFromDecision(mockTracer, decision) as MockSpan;

    expect(span.status).toBeUndefined();
  });

  it("does not set error status for require-approval verdicts", () => {
    const decision = createSampleDecision({
      verdict: "require-approval",
      reason: "Requires human approval",
    });

    const span = spanFromDecision(mockTracer, decision) as MockSpan;

    expect(span.status).toBeUndefined();
  });

  it("includes defaultAttributes from config", () => {
    const decision = createSampleDecision();
    const config = {
      defaultAttributes: {
        "service.name": "my-service",
        "environment": "test",
      },
    };

    spanFromDecision(mockTracer, decision, config);

    const attributes = mockTracer.spans[0].attributes;
    expect(attributes["service.name"]).toBe("my-service");
    expect(attributes["environment"]).toBe("test");
    expect(attributes[ATTR.TOOL_NAME]).toBe("test_tool");
  });

  it("handles empty risk categories", () => {
    const decision = createSampleDecision({
      riskCategories: [],
    });

    spanFromDecision(mockTracer, decision);

    const attributes = mockTracer.spans[0].attributes;
    expect(attributes[ATTR.TOOL_RISK_CATEGORIES]).toBe("");
  });

  it("handles empty matched rules", () => {
    const decision = createSampleDecision({
      matchedRules: [],
    });

    spanFromDecision(mockTracer, decision);

    const attributes = mockTracer.spans[0].attributes;
    expect(attributes[ATTR.DECISION_MATCHED_RULES]).toBe("");
  });
});

describe("startToolExecutionSpan", () => {
  let mockTracer: MockTracer;

  beforeEach(() => {
    mockTracer = new MockTracer();
  });

  it("creates a span with correct name and tool name attribute", () => {
    const span = startToolExecutionSpan(mockTracer, "execute_command");

    expect(mockTracer.lastSpanName).toBe("ai_tool_guard.tool_execute");
    expect(mockTracer.spans).toHaveLength(1);
    expect(span).toBe(mockTracer.spans[0]);

    const attributes = mockTracer.spans[0].attributes;
    expect(attributes[ATTR.TOOL_NAME]).toBe("execute_command");
  });

  it("includes defaultAttributes from config", () => {
    const config = {
      defaultAttributes: {
        "service.name": "my-service",
        "trace.id": "abc123",
      },
    };

    startToolExecutionSpan(mockTracer, "fetch_data", config);

    const attributes = mockTracer.spans[0].attributes;
    expect(attributes["service.name"]).toBe("my-service");
    expect(attributes["trace.id"]).toBe("abc123");
    expect(attributes[ATTR.TOOL_NAME]).toBe("fetch_data");
  });
});

describe("startApprovalSpan", () => {
  let mockTracer: MockTracer;

  beforeEach(() => {
    mockTracer = new MockTracer();
  });

  it("creates a span with correct name, tool name, and token ID attributes", () => {
    const span = startApprovalSpan(mockTracer, "sensitive_operation", "token-xyz-789");

    expect(mockTracer.lastSpanName).toBe("ai_tool_guard.approval_wait");
    expect(mockTracer.spans).toHaveLength(1);
    expect(span).toBe(mockTracer.spans[0]);

    const attributes = mockTracer.spans[0].attributes;
    expect(attributes[ATTR.TOOL_NAME]).toBe("sensitive_operation");
    expect(attributes[ATTR.APPROVAL_TOKEN_ID]).toBe("token-xyz-789");
  });

  it("includes defaultAttributes from config", () => {
    const config = {
      defaultAttributes: {
        "user.id": "user-123",
        "session.id": "session-456",
      },
    };

    startApprovalSpan(mockTracer, "delete_resource", "token-abc", config);

    const attributes = mockTracer.spans[0].attributes;
    expect(attributes["user.id"]).toBe("user-123");
    expect(attributes["session.id"]).toBe("session-456");
    expect(attributes[ATTR.TOOL_NAME]).toBe("delete_resource");
    expect(attributes[ATTR.APPROVAL_TOKEN_ID]).toBe("token-abc");
  });
});

describe("ATTR", () => {
  it("contains expected semantic attribute keys", () => {
    expect(ATTR.TOOL_NAME).toBe("ai_tool_guard.tool.name");
    expect(ATTR.TOOL_RISK_LEVEL).toBe("ai_tool_guard.tool.risk_level");
    expect(ATTR.TOOL_RISK_CATEGORIES).toBe("ai_tool_guard.tool.risk_categories");
    expect(ATTR.DECISION_VERDICT).toBe("ai_tool_guard.decision.verdict");
    expect(ATTR.DECISION_REASON).toBe("ai_tool_guard.decision.reason");
    expect(ATTR.DECISION_MATCHED_RULES).toBe("ai_tool_guard.decision.matched_rules");
    expect(ATTR.DECISION_DRY_RUN).toBe("ai_tool_guard.decision.dry_run");
    expect(ATTR.APPROVAL_TOKEN_ID).toBe("ai_tool_guard.approval.token_id");
    expect(ATTR.APPROVAL_APPROVED).toBe("ai_tool_guard.approval.approved");
    expect(ATTR.APPROVAL_PATCHED).toBe("ai_tool_guard.approval.patched");
    expect(ATTR.INJECTION_SCORE).toBe("ai_tool_guard.injection.score");
    expect(ATTR.INJECTION_SUSPECTED).toBe("ai_tool_guard.injection.suspected");
    expect(ATTR.RATE_LIMIT_ALLOWED).toBe("ai_tool_guard.rate_limit.allowed");
    expect(ATTR.OUTPUT_REDACTED).toBe("ai_tool_guard.output.redacted");
    expect(ATTR.OUTPUT_BLOCKED).toBe("ai_tool_guard.output.blocked");
    expect(ATTR.MCP_DRIFT_DETECTED).toBe("ai_tool_guard.mcp.drift_detected");
  });

  it("has string values for all attributes", () => {
    Object.values(ATTR).forEach((value) => {
      expect(typeof value).toBe("string");
      expect(value).toMatch(/^ai_tool_guard\./);
    });
  });
});
