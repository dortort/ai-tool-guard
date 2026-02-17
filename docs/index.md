# ai-tool-guard

**Policy enforcement middleware for Vercel AI SDK tool calls.**

Intercept, validate, approve, and audit every tool invocation your AI agents make — before they execute.

```sh
npm install ai-tool-guard
```

---

## Why ai-tool-guard?

- **Prevent dangerous AI tool calls.** Define declarative policies that block, require approval, or silently allow tool invocations based on arguments, caller context, or external signals — before any side effect occurs.
- **Human-in-the-loop approval.** Route sensitive operations to a human reviewer (or a secondary AI) and resume execution only when explicitly approved, with support for approve-with-edits so reviewers can correct arguments mid-flight.
- **Comprehensive audit trail.** Every decision — allow, block, approve, edit — is recorded as a structured `DecisionRecord` with full argument snapshots, policy match details, timestamps, and optional OpenTelemetry spans.
- **Zero-config sensible defaults.** Drop `guardTool` around any existing Vercel AI SDK tool and get injection detection, basic argument validation, and decision logging with no additional configuration required.

---

## Features

| Feature | Description |
|---|---|
| **Policy engine** | Declarative allow/block/require-approval rules evaluated per tool call |
| **External backends** | Plug in HTTP, database, or custom `PolicyBackend` implementations |
| **Decision records** | Structured audit log of every policy decision with full context |
| **Dry-run / simulation** | Evaluate policies without executing tools, for testing and previewing |
| **Conversation-aware policies** | Policies can inspect conversation history and accumulated context |
| **Approve with edits** | Human reviewers can modify tool arguments before approving execution |
| **Approval correlation** | Track approval requests and responses across async boundaries |
| **Argument guards** | Schema-level and semantic validation of tool input arguments |
| **Injection detection** | Detect prompt injection attempts embedded in tool arguments |
| **Output filtering** | Scrub or redact sensitive data from tool return values |
| **Rate limiting** | Per-tool and per-session call-rate limits with configurable windows |
| **OpenTelemetry** | First-class OTel span and attribute instrumentation throughout the pipeline |
| **MCP drift detection** | Detect when MCP server tool schemas diverge from expected definitions |

---

## Architecture

The execution pipeline wraps each tool call in a series of composable stages:

```
 ┌─────────────────────────────────────────────────────────────────┐
 │                        createToolGuard                          │
 │                    (configuration & backends)                    │
 └──────────────────────────────┬──────────────────────────────────┘
                                │
               ┌────────────────▼────────────────┐
               │        guardTool / guardTools    │
               │    (wraps Vercel AI SDK tools)   │
               └────────────────┬────────────────┘
                                │
               ┌────────────────▼────────────────┐
               │            Pipeline              │
               │                                  │
               │  1. Injection detection          │◄── OTel span
               │  2. Argument validation          │◄── OTel span
               │  3. Policy evaluation            │◄── PolicyBackend
               │     ├─ allow                     │
               │     ├─ block ──────────────────► │ DecisionRecord
               │     └─ require-approval ───────► │ ApprovalRequest
               │  4. Approval flow                │◄── OTel span
               │     └─ approve / edit / deny     │
               │  5. Rate limit check             │◄── OTel span
               │  6. Tool execution               │◄── OTel span
               │  7. Output filtering             │◄── OTel span
               └────────────────┬────────────────┘
                                │
                    ┌───────────▼───────────┐
                    │      Tool result      │
                    │   + DecisionRecord    │
                    └───────────────────────┘
```

Every stage emits an OpenTelemetry span. Policy decisions at stage 3 are dispatched to the configured `PolicyBackend`, which can be an in-process rule set, an external HTTP service, or a custom implementation.

---

## Quick Navigation

<div class="grid cards" markdown>

- **Getting Started**

  Install the library, wrap your first tool, and run a guarded agent in under five minutes.

  [Getting Started](getting-started/installation.md)

- **Guides**

  Deep dives into policies, approval flows, audit trails, rate limiting, and OTel integration.

  [Guides](guides/policy-engine.md)

- **API Reference**

  Full TypeScript API documentation for `createToolGuard`, `guardTool`, `PolicyBackend`, and all types.

  [API Reference](api/index.md)

- **Examples**

  Runnable example projects covering common use cases and integration patterns.

  [Examples](examples/nextjs-integration.md)

</div>

---

## Installation

```sh
npm install ai-tool-guard
```

!!! note "Peer dependencies"
    `ai-tool-guard` requires the [Vercel AI SDK](https://sdk.vercel.ai/) (`ai`) as a peer dependency. Install it alongside if you have not already:

    ```sh
    npm install ai-tool-guard ai
    ```

    TypeScript 5.0 or later is recommended. The package ships with full type declarations and targets ESM (`"type": "module"`).

---

## License

MIT. Copyright (c) Francis Eytan Dortort. See [LICENSE](https://github.com/dortort/ai-tool-guard/blob/main/LICENSE) for details.
