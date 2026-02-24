# Core Concepts

Understand the key abstractions and mental model behind ai-tool-guard.

---

## Risk Levels

Every tool you register with ai-tool-guard is assigned a **risk level**. This single value drives default policy decisions and determines how cautiously the guard treats a tool call before you write any custom rules.

| Level | Description | Default policy behavior |
|---|---|---|
| `low` | Read-only operations, safe queries | Allow automatically |
| `medium` | Write operations with bounded, reversible impact | Require approval |
| `high` | Destructive or sensitive operations | Deny by default |
| `critical` | Irreversible actions affecting infrastructure or security | Deny by default |

**Examples by level:**

- `low` — `getWeather`, `searchProducts`, `listFiles`
- `medium` — `updateProfile`, `sendEmail`, `createRecord`
- `high` — `deleteUser`, `processPayment`, `exportDatabase`
- `critical` — `dropDatabase`, `revokeAllTokens`, `purgeBackups`

!!! tip
    The `defaultPolicy()` helper generates a baseline rule set from these levels. You can layer custom rules on top to tighten or relax behavior for specific tools.

!!! note
    Risk level is not a security boundary on its own. It is an input to policy evaluation. Explicit `deny` rules always take precedence regardless of level.

---

## Risk Categories

Risk categories are **classification tags** applied to tools alongside the risk level. They do not affect policy matching directly, but they appear in every `DecisionRecord` and can be used to build audit queries, dashboards, and category-scoped external policies.

| Category | Description |
|---|---|
| `data-read` | Reading records, querying databases, fetching content |
| `data-write` | Creating or updating persisted data |
| `data-delete` | Removing records, truncating datasets |
| `network` | Making outbound HTTP requests, webhooks, integrations |
| `filesystem` | Reading or writing files on disk |
| `authentication` | Token issuance, session management, credential changes |
| `payment` | Billing, charge, refund, and subscription operations |
| `pii` | Accessing or processing personally identifiable information |
| `custom` | Application-specific categories defined by the caller |

A tool can carry multiple categories. For example, a `sendInvoiceEmail` tool might be tagged `["network", "payment", "pii"]`.

!!! info
    Categories are surfaced in decision records and passed to external approval backends, giving those systems the context needed to make informed decisions without needing to inspect tool arguments directly.

---

## Decision Verdicts

After evaluating all applicable rules, ai-tool-guard produces one of three **verdicts**:

| Verdict | Meaning |
|---|---|
| `allow` | The tool call proceeds to execution immediately |
| `require-approval` | Execution pauses and the configured approval handler is invoked |
| `deny` | The tool call is blocked and a `ToolGuardError` is thrown |

### Escalation semantics

When multiple rules match a single tool call, the **most restrictive verdict wins**:

```
deny  >  require-approval  >  allow
```

A rule producing `deny` cannot be overridden by another rule producing `allow`. This prevents a permissive catch-all rule from inadvertently lowering the effective verdict on a sensitive operation.

!!! tip
    Design rules so that the most permissive case is the baseline and stricter rules layer on top. Relying on escalation to enforce security is safer than relying on rule ordering.

---

## The Execution Pipeline

Every tool call intercepted by ai-tool-guard passes through seven ordered stages. Each stage can halt execution before the tool runs.

```
Tool call invoked
        |
        v
┌───────────────────────┐
│ 1. Injection detection │  Heuristic scan of arguments for prompt injection patterns
└───────────┬───────────┘
            |
            v
┌───────────────────────┐
│ 2. Argument validation │  Zod schemas, allowlists, denylists, regex, PII scanning
└───────────┬───────────┘
            |
            v
┌───────────────────────┐
│ 3. Policy evaluation   │  Rules + external backend determine verdict
└───────────┬───────────┘
            |
            v
┌───────────────────────┐
│ 4. Approval flow       │  If verdict is require-approval, invoke handler and wait
└───────────┬───────────┘
            |
            v
┌───────────────────────┐
│ 5. Rate limiting       │  Sliding window count + concurrency check
└───────────┬───────────┘
            |
            v
┌───────────────────────┐
│ 6. Tool execution      │  The actual tool function runs (or dry-run returns mock)
└───────────┬───────────┘
            |
            v
┌───────────────────────┐
│ 7. Output filtering    │  Secrets stripping and PII redaction on the result
└───────────┬───────────┘
            |
            v
     Result returned
```

**Stage descriptions:**

1. **Injection detection** — Before any other check, raw argument values are scanned for heuristic patterns associated with prompt injection (e.g., instruction overrides, role-switching phrases). A positive signal raises an immediate `deny` verdict.

2. **Argument validation** — Structured argument guards run per-argument: Zod schema checks, allowlist/denylist membership, regex pattern matching, and PII field detection. Failures produce a `deny` verdict with a descriptive reason.

3. **Policy evaluation** — The guard evaluates all matching rules (built-in defaults, custom rules, and responses from any configured external backend) and resolves a final verdict using escalation semantics.

4. **Approval flow** — If the resolved verdict is `require-approval`, execution pauses and the `onApprovalRequired` callback is invoked. The callback receives an `ApprovalToken` with the full decision context and must return an `ApprovalResolution` object (`{ approved: boolean, patchedArgs?, approvedBy? }`) to continue or abort.

5. **Rate limiting** — A sliding window counter checks whether the tool has exceeded its configured call rate. A concurrency check verifies that the tool is not already executing more instances than the configured maximum. Either failure produces a `deny` verdict.

6. **Tool execution** — The wrapped tool function is called with the original arguments. If the guard is running in dry-run mode, execution is skipped and a configured mock response is returned instead.

7. **Output filtering** — The tool result is scanned for sensitive values. Configured secret patterns and PII field names are redacted before the result is returned to the model. Redaction actions are recorded in the `DecisionRecord`.

!!! note
    Stages 1 through 5 run before the tool executes. A failure at any pre-execution stage means the tool never runs and no side effects occur.

---

## Decision Records

Every evaluation — successful or blocked — produces a **`DecisionRecord`**: a structured, immutable audit object that captures the full context of the decision.

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique identifier for this evaluation |
| `timestamp` | `Date` | When the evaluation occurred |
| `verdict` | `"allow" \| "deny" \| "require-approval"` | The resolved verdict |
| `toolName` | `string` | The name of the evaluated tool |
| `matchedRules` | `string[]` | IDs or names of all rules that matched |
| `riskLevel` | `RiskLevel` | The tool's configured risk level |
| `riskCategories` | `RiskCategory[]` | The tool's configured categories |
| `attributes` | `Record<string, unknown>` | Arbitrary context attributes attached at call time |
| `reason` | `string` | Human-readable explanation of the verdict |
| `redactions` | `RedactionRecord[]` | Fields redacted in the output and why |
| `evalDurationMs` | `number` | Time taken to complete the evaluation in milliseconds |
| `dryRun` | `boolean` | Whether this evaluation ran in dry-run mode |

Decision records are delivered to your code through the `onDecision` callback configured in `GuardOptions`. From there, you can persist them to a database, forward them to a logging pipeline, or emit them as structured log events.

!!! tip
    Because every evaluation produces a record — including allowed calls — you get a complete audit trail, not just a log of blocked events. This makes it possible to retrospectively analyze what the model was doing when an incident occurred.

---

## Guard Options vs Tool Config

ai-tool-guard uses two distinct configuration objects that operate at different scopes.

### `GuardOptions` — global settings

Passed once to `createToolGuard()`. Applies to every tool registered with the guard.

| Field | Purpose |
|---|---|
| `rules` | Array of policy rules evaluated for all tools |
| `backend` | External approval or policy backend (HTTP, custom) |
| `injectionDetection` | Enable/disable and configure injection heuristics |
| `rateLimits` | Global default rate limit settings |
| `otel` | OpenTelemetry tracer and meter configuration |
| `onDecision` | Callback invoked after every evaluation with the `DecisionRecord` |
| `onApprovalRequired` | Callback invoked when a verdict is `require-approval` |
| `dryRun` | When `true`, no tool executes; mock responses are returned |

### `ToolGuardConfig` — per-tool settings

Passed per-tool via `guardTool()` or as values in the `guardTools()` map. Overrides or extends global settings for a specific tool.

| Field | Purpose |
|---|---|
| `riskLevel` | The tool's risk level (`low`, `medium`, `high`, `critical`) |
| `riskCategories` | Classification tags for this tool |
| `argGuards` | Per-argument validation rules (Zod, allowlist, denylist, regex, PII) |
| `outputFilters` | Secret and PII redaction patterns applied to this tool's output |
| `rateLimit` | Per-tool call rate limit (overrides global default) |
| `maxConcurrency` | Maximum simultaneous executions of this tool |
| `requireApproval` | Force `require-approval` verdict for this tool regardless of rules |

!!! info
    Global settings in `GuardOptions` establish the baseline for all tools. Per-tool settings in `ToolGuardConfig` narrow or extend that baseline for specific tools. Where both define the same setting, the per-tool value takes precedence.

```typescript
const guard = createToolGuard({
  // GuardOptions — applies to every tool
  rules: defaultPolicy(),
  onDecision: (record) => auditLog.write(record),
});

const safeTool = guard.guardTool("myTool", myTool, {
  // ToolGuardConfig — applies only to myTool
  riskLevel: "medium",
  riskCategories: ["data-write", "network"],
  argGuards: [
    piiGuard("email"),
  ],
});
```
