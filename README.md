<p align="center">
  <img src="hero.png" alt="AI Tool Guard" width="600" />
</p>

[![CI](https://github.com/dortort/ai-tool-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/dortort/ai-tool-guard/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@dortort/ai-tool-guard)](https://www.npmjs.com/package/@dortort/ai-tool-guard)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-green?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Vercel AI SDK](https://img.shields.io/badge/Vercel_AI_SDK-%E2%89%A54.0-black?logo=vercel&logoColor=white)](https://sdk.vercel.ai)
[![Docs](https://readthedocs.org/projects/ai-tool-guard/badge/?version=latest)](https://ai-tool-guard.readthedocs.io/)

Policy enforcement middleware for [Vercel AI SDK](https://sdk.vercel.ai) tool calls.

Guards, approvals, argument validation, rate limiting, output filtering, prompt-injection detection, MCP drift detection, and OpenTelemetry observability — as a composable middleware layer around your AI SDK tools.

**[Read the full documentation](https://ai-tool-guard.readthedocs.io/)**

```
npm install @dortort/ai-tool-guard
```

## Quick start

```ts
import { createToolGuard, deny, requireApproval, defaultPolicy } from "@dortort/ai-tool-guard";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { tool } from "ai";
import { z } from "zod";

// 1. Define your tools as usual.
const getWeather = tool({
  description: "Get the weather for a city",
  parameters: z.object({ city: z.string() }),
  execute: async ({ city }) => `Weather in ${city}: sunny, 72°F`,
});

const deleteUser = tool({
  description: "Delete a user account",
  parameters: z.object({ userId: z.string() }),
  execute: async ({ userId }) => `User ${userId} deleted`,
});

// 2. Create a guard with policy rules.
const guard = createToolGuard({
  rules: defaultPolicy(),
  onApprovalRequired: async (token) => {
    console.log(`Approval needed for ${token.toolName}:`, token.originalArgs);
    return { approved: true, approvedBy: "admin" };
  },
  onDecision: (record) => {
    console.log(`[${record.verdict}] ${record.toolName}: ${record.reason}`);
  },
});

// 3. Wrap tools with per-tool risk levels.
const tools = guard.guardTools({
  getWeather: { tool: getWeather, riskLevel: "low" },
  deleteUser: { tool: deleteUser, riskLevel: "high" },
});

// 4. Use with AI SDK as normal.
const result = await generateText({
  model: openai("gpt-4o"),
  tools,
  prompt: "What's the weather in Tokyo?",
});
```

## Features

| Feature | Description |
|---------|-------------|
| **Policy engine** | Rule-based allow/deny/require-approval with glob patterns, risk levels, priorities, and async conditions |
| **External policy backends** | Adapter interface for OPA/Rego, Cedar, or custom ABAC engines |
| **Decision records** | Structured audit output for every evaluation (matched rules, risk category, attributes, redactions) |
| **Dry-run / simulation** | Evaluate policies across recorded traces without executing tools |
| **Conversation-aware policies** | Policies can incorporate session risk score, prior failures, recent approvals |
| **Approve with edits** | Approval handler can patch arguments before execution |
| **Approval correlation** | Payload-hash tokens with TTL prevent mismatch between request and resolution |
| **Argument guards** | Zod schemas, allowlists, denylists, regex, PII scanning per field |
| **Injection detection** | Heuristic prompt-injection detector that can deny or downgrade to approval |
| **Output filtering** | Secrets stripping, PII redaction, custom filters on tool results |
| **Rate limiting** | Sliding-window rate limits + concurrency caps with reject or queue backpressure |
| **OpenTelemetry** | Opinionated spans for policy eval, approval wait, tool execution, redaction |
| **MCP drift detection** | SHA-256 schema fingerprinting, drift detection, actionable remediation |

## Architecture

Every guarded tool call passes through a 7-stage execution pipeline: injection detection, argument validation, policy evaluation, approval flow, rate limiting, tool execution, and output filtering. Each stage emits an OpenTelemetry span.

See the **[architecture overview](https://ai-tool-guard.readthedocs.io/#architecture)** for the full pipeline diagram.

## API reference

### `createToolGuard(options)`

Creates a `ToolGuard` instance. All options are optional.

```ts
interface GuardOptions {
  rules?: PolicyRule[];           // Built-in policy rules
  backend?: PolicyBackend;        // External policy backend
  defaultRiskLevel?: RiskLevel;   // Default risk for unconfigured tools ("low")
  onApprovalRequired?: ApprovalHandler;  // Approval callback
  injectionDetection?: InjectionDetectorConfig;
  defaultRateLimit?: RateLimitConfig;
  defaultMaxConcurrency?: number;
  otel?: OtelConfig;
  dryRun?: boolean;               // Simulation mode
  onDecision?: (record: DecisionRecord) => void | Promise<void>;
  resolveUserAttributes?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  resolveConversationContext?: () => ConversationContext | Promise<ConversationContext>;
}
```

### `guard.guardTool(name, tool, config?)`

Wrap a single AI SDK tool.

```ts
const guarded = guard.guardTool("sendEmail", sendEmailTool, {
  riskLevel: "medium",
  riskCategories: ["network", "pii"],
  argGuards: [piiGuard("body")],
  outputFilters: [secretsFilter()],
  rateLimit: { maxCalls: 10, windowMs: 60_000 },
  maxConcurrency: 2,
});
```

### `guard.guardTools(map)`

Wrap multiple tools at once. Returns a flat tools map compatible with `generateText({ tools })`.

```ts
const tools = guard.guardTools({
  readFile:  { tool: readFileTool,  riskLevel: "low" },
  writeFile: { tool: writeFileTool, riskLevel: "high", requireApproval: true },
  search:    { tool: searchTool },
});
```

---

## Policy rules

### Built-in rule builders

```ts
import { allow, deny, requireApproval } from "@dortort/ai-tool-guard";

const rules = [
  allow({ tools: "read*", description: "Allow all read tools" }),
  requireApproval({ tools: "write*", riskLevels: ["medium", "high"] }),
  deny({
    tools: "delete*",
    condition: (ctx) => ctx.userAttributes.role !== "admin",
    description: "Only admins can delete",
    priority: 10,
  }),
];
```

### Preset policies

```ts
import { defaultPolicy, readOnlyPolicy } from "@dortort/ai-tool-guard";

// low → allow, medium → require-approval, high/critical → deny
const rules = defaultPolicy();

// Allow specific tools, deny everything else
const rules = readOnlyPolicy(["getUser", "listItems", "search*"]);
```

### External policy backend (OPA, Cedar, custom)

```ts
import type { PolicyBackend } from "@dortort/ai-tool-guard";

const opaBackend: PolicyBackend = {
  name: "opa",
  async evaluate(ctx) {
    const res = await fetch("http://opa:8181/v1/data/tool_policy", {
      method: "POST",
      body: JSON.stringify({ input: ctx }),
    });
    const data = await res.json();
    return {
      verdict: data.result.allow ? "allow" : "deny",
      reason: data.result.reason,
      matchedRules: data.result.matched_rules ?? [],
    };
  },
};

const guard = createToolGuard({ backend: opaBackend });
```

---

## Approval flow

The approval handler receives an `ApprovalToken` and returns an `ApprovalResolution`.

### Basic approval

```ts
const guard = createToolGuard({
  rules: [requireApproval({ tools: "payment*" })],
  onApprovalRequired: async (token) => {
    const answer = await askUser(
      `Allow ${token.toolName} with args ${JSON.stringify(token.originalArgs)}?`
    );
    return { approved: answer === "yes" };
  },
});
```

### Approve with edits (parameter patching)

```ts
onApprovalRequired: async (token) => {
  // User can modify the amount before approving
  const editedAmount = await showEditableForm(token.originalArgs);
  return {
    approved: true,
    patchedArgs: { amount: editedAmount },
    approvedBy: "finance-team",
  };
},
```

The `ApprovalToken` includes a `payloadHash` for correlation — the SHA-256 of the canonical `{ toolName, args }` object. This prevents mismatch bugs when message history is reshaped.

---

## Argument guards

Validate tool arguments before policy evaluation.

```ts
import {
  zodGuard, allowlist, denylist, regexGuard, piiGuard
} from "@dortort/ai-tool-guard";
import { z } from "zod";

const guarded = guard.guardTool("queryDb", queryTool, {
  argGuards: [
    // Zod schema validation
    zodGuard({ field: "limit", schema: z.number().int().min(1).max(100) }),

    // Allowlist
    allowlist("table", ["users", "orders", "products"]),

    // Denylist
    denylist("operation", ["DROP", "TRUNCATE"]),

    // Regex: must match allowed domain
    regexGuard("url", /^https:\/\/.*\.example\.com/, {
      message: "Only example.com URLs are allowed",
    }),

    // Regex: must NOT match forbidden pattern
    regexGuard("query", /DROP\s+TABLE/i, {
      mustMatch: false,
      message: "SQL injection detected",
    }),

    // PII scanning
    piiGuard("userInput", { allowedTypes: ["email"] }),
  ],
});
```

Guards support dot-path field access for nested arguments:

```ts
allowlist("config.region", ["us-east-1", "eu-west-1"])
```

---

## Output filtering

Control what comes back from tool execution.

```ts
import { secretsFilter, piiOutputFilter, customFilter } from "@dortort/ai-tool-guard";

const guarded = guard.guardTool("fetchData", fetchTool, {
  outputFilters: [
    // Strip AWS keys, GitHub tokens, JWTs, API keys, bearer tokens, private keys
    secretsFilter(),

    // Redact emails, SSNs, phone numbers, credit card numbers
    piiOutputFilter({ allowedTypes: ["email"] }),

    // Custom filter
    customFilter("size-limit", async (result) => {
      const str = JSON.stringify(result);
      if (str.length > 100_000) {
        return { verdict: "block", output: null };
      }
      return { verdict: "pass", output: result };
    }),
  ],
});
```

Filters run in order after tool execution. If any filter returns `"block"`, the filter chain stops, the tool result is discarded, and a `ToolGuardError` is thrown.

---

## Injection detection

Heuristic prompt-injection detection at the tool boundary.

```ts
const guard = createToolGuard({
  injectionDetection: {
    threshold: 0.5,    // Suspicion score 0-1
    action: "deny",    // "deny" | "downgrade" | "log"
  },
});
```

- **`deny`** — Block the tool call entirely.
- **`downgrade`** — Convert the call to require approval.
- **`log`** — Allow but flag in the decision record.

Custom detectors (e.g., LLM-as-judge):

```ts
injectionDetection: {
  threshold: 0.7,
  action: "downgrade",
  detect: async (args) => {
    const score = await myLlmJudge(JSON.stringify(args));
    return score; // 0-1
  },
},
```

---

## Rate limiting and concurrency

```ts
const guard = createToolGuard({
  // Global defaults
  defaultRateLimit: { maxCalls: 100, windowMs: 60_000, strategy: "reject" },
  defaultMaxConcurrency: 5,
});

// Per-tool overrides
guard.guardTool("expensiveApi", tool, {
  rateLimit: { maxCalls: 5, windowMs: 60_000, strategy: "queue" },
  maxConcurrency: 1,
});
```

- **`reject`** — Immediately throw `ToolGuardError` with code `"rate-limited"`.
- **`queue`** — Wait for a slot to become available (backpressure).

---

## Dry-run / simulation mode

Evaluate policies without executing tools.

### Global dry-run

```ts
const guard = createToolGuard({ dryRun: true, rules: [...] });
// All tool calls return { dryRun: true, toolName, args } instead of executing.
```

### Trace simulation

```ts
import { simulate } from "@dortort/ai-tool-guard";

const result = await simulate(
  [
    { toolName: "readFile", args: { path: "/etc/passwd" } },
    { toolName: "deleteUser", args: { id: "123" } },
    { toolName: "getWeather", args: { city: "NYC" } },
  ],
  { rules: defaultPolicy() },
  {
    readFile: { riskLevel: "medium" },
    deleteUser: { riskLevel: "critical" },
    getWeather: { riskLevel: "low" },
  },
);

console.log(result.summary);
// { total: 3, allowed: 1, denied: 1, requireApproval: 1 }

console.log(result.blocked);
// [{ toolCall: { toolName: "deleteUser", ... }, decision: { verdict: "deny", ... } }, ...]
```

---

## Decision records

Every policy evaluation produces a structured `DecisionRecord`:

```ts
interface DecisionRecord {
  id: string;                    // Unique correlation id
  timestamp: string;             // ISO-8601
  verdict: "allow" | "deny" | "require-approval";
  toolName: string;
  matchedRules: string[];        // Rule ids that matched
  riskLevel: RiskLevel;
  riskCategories: RiskCategory[];
  attributes: Record<string, unknown>;  // User attributes consumed
  reason: string;                // Human-readable explanation
  redactions?: string[];         // Fields redacted in output
  evalDurationMs: number;        // Policy eval time
  dryRun: boolean;
}
```

Subscribe via `onDecision`:

```ts
const guard = createToolGuard({
  onDecision: (record) => {
    auditLog.write(record);
    if (record.verdict === "deny") {
      alerting.fire("tool-denied", record);
    }
  },
});
```

---

## Conversation-aware policies

Policies can incorporate conversation metadata for contextual decisions.

```ts
const guard = createToolGuard({
  resolveConversationContext: () => ({
    sessionId: currentSession.id,
    riskScore: currentSession.riskScore,
    priorFailures: currentSession.failureCount,
    recentApprovals: currentSession.approvedTools,
  }),
  rules: [
    deny({
      tools: "*",
      condition: (ctx) => (ctx.conversation?.riskScore ?? 0) > 0.8,
      description: "Block all tools when conversation risk is high",
    }),
    requireApproval({
      tools: "*",
      condition: (ctx) => (ctx.conversation?.priorFailures ?? 0) > 3,
      description: "Require approval after repeated failures",
    }),
  ],
});
```

---

## MCP drift detection

Pin tool schemas and detect when MCP servers change.

```ts
import {
  pinFingerprint, detectDrift, FingerprintStore
} from "@dortort/ai-tool-guard/mcp";

// Pin fingerprints for your MCP tools
const store = new FingerprintStore();
store.set(await pinFingerprint("readFile", "fs-server", readFileSchema, "production"));
store.set(await pinFingerprint("queryDb", "db-server", queryDbSchema, "production"));

// Before using tools, check for drift
const result = await detectDrift(store.getAll(), [
  { toolName: "readFile", serverId: "fs-server", schema: currentReadFileSchema },
  { toolName: "queryDb",  serverId: "db-server",  schema: currentQueryDbSchema },
]);

if (result.drifted) {
  for (const change of result.changes) {
    console.error(change.remediation);
    // "Tool "queryDb" from server "db-server" has changed since it was pinned
    //  at 2025-01-15T... Expected hash: a1b2c3..., got: d4e5f6...
    //  Re-pin with pinFingerprint() after reviewing the schema change."
  }
  throw new Error("MCP schema drift detected. Aborting.");
}
```

Persist fingerprints:

```ts
// Export to file
fs.writeFileSync("fingerprints.json", store.export());

// Import from file
store.import(fs.readFileSync("fingerprints.json", "utf-8"));
```

---

## OpenTelemetry

Automatic spans when `@opentelemetry/api` is installed.

```ts
const guard = createToolGuard({
  otel: {
    enabled: true,
    tracerName: "my-app",
    defaultAttributes: { "service.name": "ai-agent" },
  },
});
```

Spans emitted:

| Span name | When | Key attributes |
|-----------|------|---------------|
| `ai_tool_guard.policy_eval` | Every policy evaluation | `tool.name`, `tool.risk_level`, `decision.verdict`, `decision.reason` |
| `ai_tool_guard.tool_execute` | Tool execution | `tool.name` |
| `ai_tool_guard.approval_wait` | Waiting for approval | `tool.name`, `approval.token_id` |
| `ai_tool_guard.injection_check` | Injection suspected | `injection.score`, `injection.suspected` |
| `ai_tool_guard.rate_limit` | Rate limit hit | `rate_limit.allowed` |
| `ai_tool_guard.output_filter` | Output redacted/blocked | `output.redacted`, `output.blocked` |

All attribute keys are exported as `ATTR` for custom span creation.

---

## Error handling

All guard failures throw `ToolGuardError` with a machine-readable `code`:

```ts
import { ToolGuardError } from "@dortort/ai-tool-guard";

try {
  await generateText({ model, tools, prompt: "..." });
} catch (err) {
  // AI SDK wraps tool errors in ToolExecutionError — unwrap with .cause
  const cause = err instanceof Error ? (err as { cause?: unknown }).cause : err;
  if (cause instanceof ToolGuardError) {
    switch (cause.code) {
      case "policy-denied":         // Policy rule blocked the call
      case "approval-denied":       // Human denied approval
      case "no-approval-handler":   // Approval required but no handler set
      case "arg-validation-failed": // Argument guard failed
      case "injection-detected":    // Prompt injection suspected
      case "rate-limited":          // Rate limit exceeded
      case "output-blocked":        // Output filter blocked the result
      case "mcp-drift":             // MCP schema drift detected
    }
    console.log(cause.toolName);   // Which tool
    console.log(cause.decision);   // Full DecisionRecord (if available)
  }
}
```

---

## TypeScript

The library is written in TypeScript and exports all types:

```ts
import type {
  // Core
  RiskLevel, RiskCategory, DecisionVerdict, DecisionRecord,
  PolicyContext, ConversationContext, GuardOptions,
  // Policy
  PolicyRule, PolicyBackend, PolicyBackendResult,
  // Tools
  ToolGuardConfig, AiSdkTool,
  // Guards
  ArgGuard, ZodArgGuard, OutputFilter, OutputFilterResult,
  // Approval
  ApprovalToken, ApprovalResolution, ApprovalHandler,
  // Rate limiting
  RateLimitConfig, RateLimitState,
  // Injection
  InjectionDetectorConfig,
  // MCP
  McpToolFingerprint, McpDriftResult, McpDriftChange,
  // OTel
  OtelConfig,
} from "@dortort/ai-tool-guard";
```

## Subpath exports

```ts
import { evaluatePolicy, allow, deny } from "@dortort/ai-tool-guard/policy";
import { ApprovalManager } from "@dortort/ai-tool-guard/approval";
import { zodGuard, secretsFilter, RateLimiter } from "@dortort/ai-tool-guard/guards";
import { createTracer, ATTR } from "@dortort/ai-tool-guard/otel";
import { detectDrift, FingerprintStore } from "@dortort/ai-tool-guard/mcp";
```

## Examples

Full worked examples are available in the [documentation](https://ai-tool-guard.readthedocs.io/):

- **[Next.js Integration](https://ai-tool-guard.readthedocs.io/examples/nextjs-integration/)** — App Router setup with per-tool config, approval flow, and error mapping
- **[Chatbot Safety](https://ai-tool-guard.readthedocs.io/examples/chatbot-safety/)** — Multi-layered defense for a customer support chatbot (5 risk levels, injection detection, PII redaction)
- **[Multi-Tenant Policies](https://ai-tool-guard.readthedocs.io/examples/multi-tenant/)** — SaaS platform with plan/role-based access and per-tenant audit logs
- **[Audit Logging](https://ai-tool-guard.readthedocs.io/examples/audit-logging/)** — Structured audit system with denial alerting and OpenTelemetry correlation
- **[MCP Drift Detection](https://ai-tool-guard.readthedocs.io/examples/mcp-drift-detection/)** — Schema fingerprinting, drift detection, and environment-scoped pinning
- **[Simulation & Testing](https://ai-tool-guard.readthedocs.io/examples/simulation-testing/)** — Policy validation with recorded traces and CI/CD integration

## License

MIT
