# Installation

This guide walks through installing `ai-tool-guard` and configuring your project for use with the library.

## Prerequisites

Before installing, ensure your environment meets the following requirements:

- **Node.js 20 or later** — required for native ESM support and modern runtime features
- **TypeScript 5.7 or later** — required for accurate module resolution and type inference

## Install the Package

Install `ai-tool-guard` from npm:

```bash
npm install ai-tool-guard
```

## Peer Dependencies

`ai-tool-guard` has two required peer dependencies and one optional peer dependency.

### Required

| Package | Version | Purpose |
|---------|---------|---------|
| `ai` | `>=4.0.0` | Vercel AI SDK — provides the tool calling primitives that ai-tool-guard wraps |
| `zod` | `>=3.0.0` | Schema validation used by the built-in `zodGuard` and argument guards |

Install both at once:

```bash
npm install ai zod
```

### Optional

| Package | Version | Purpose |
|---------|---------|---------|
| `@opentelemetry/api` | `>=1.0.0` | Enables structured tracing via the `ai-tool-guard/otel` subpath export |

Install if you intend to use the OpenTelemetry integration:

```bash
npm install @opentelemetry/api
```

!!! info "OpenTelemetry is opt-in"
    The core library and all other subpath exports function without `@opentelemetry/api`. You only need it if you import from `ai-tool-guard/otel`.

## TypeScript Configuration

`ai-tool-guard` is published as an ES module (ESM). Your `tsconfig.json` must be configured for ESM resolution. The following settings are recommended:

```json title="tsconfig.json"
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "verbatimModuleSyntax": true
  }
}
```

!!! warning "CommonJS projects"
    If your project uses CommonJS (`"module": "CommonJS"`), you will need to either migrate to ESM or use a bundler that can handle ESM packages. The library does not ship a CommonJS build.

!!! tip "Using a bundler"
    When targeting a bundler (Vite, webpack, esbuild, Rollup), `"moduleResolution": "bundler"` is the correct setting. For projects running directly under Node.js without a bundler, use `"moduleResolution": "NodeNext"` and ensure your `package.json` includes `"type": "module"`.

## Verify the Installation

After installing, confirm everything is wired up correctly by running a quick import check. Create a temporary file:

```ts title="verify.ts"
import { createToolGuard } from "ai-tool-guard";

const guard = createToolGuard();
console.log("ai-tool-guard is ready!");
```

Run it with `tsx` or your preferred TypeScript runner:

```bash
npx tsx verify.ts
```

You should see:

```
ai-tool-guard is ready!
```

If you encounter a module resolution error, double-check that your `tsconfig.json` matches the settings above and that peer dependencies are installed.

## Subpath Exports

`ai-tool-guard` exposes a set of granular subpath exports so you can import only what you need, keeping bundle sizes lean. Each subpath is independently tree-shakeable.

| Import path | Contents |
|-------------|----------|
| `ai-tool-guard` | Core API — `createToolGuard`, `ToolGuard`, `ToolGuardError` |
| `ai-tool-guard/policy` | Policy engine — `evaluatePolicy`, `allow`, `deny`, `requireApproval`, `simulate` |
| `ai-tool-guard/approval` | Approval flow — `ApprovalManager` |
| `ai-tool-guard/guards` | Built-in guards — `zodGuard`, `allowlist`, `denylist`, `secretsFilter`, `RateLimiter`, and more |
| `ai-tool-guard/otel` | OpenTelemetry integration — `createTracer`, `ATTR`, span helpers |
| `ai-tool-guard/mcp` | MCP drift detection — `detectDrift`, `FingerprintStore` |

### Usage example

Rather than importing everything from the root, prefer the specific subpath for the functionality you need:

```ts
import { createToolGuard } from "ai-tool-guard";
import { allow, deny, requireApproval } from "ai-tool-guard/policy";
import { zodGuard, secretsFilter } from "ai-tool-guard/guards";
```

!!! tip "Import from the root when in doubt"
    The root `ai-tool-guard` export re-exports the most commonly used symbols. Start there and switch to subpath imports once you know which modules you rely on.

## Next Steps

With the library installed, move on to [Quick Start](quick-start.md) to create your first guarded tool.
