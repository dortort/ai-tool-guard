# MCP Drift Detection

## Overview

Model Context Protocol (MCP) servers expose tools dynamically. When a server updates a tool's schema — changing parameter types, adding required fields, or removing arguments — an AI agent that cached the old schema may call the tool with malformed arguments, or worse, receive unexpected data it was not designed to handle.

MCP drift detection solves this by pinning a cryptographic fingerprint of each tool schema at a known-good point in time and checking live schemas against those pins at runtime or in CI. Any change to the schema produces a different fingerprint and surfaces a structured `McpDriftChange` record with a human-readable remediation message.

---

## Basic Usage

Pin your tool schemas once at setup time, then check for drift before each agent run:

```typescript
import {
  pinFingerprint,
  detectDrift,
  FingerprintStore,
} from 'ai-tool-guard/mcp';

// 1. Pin schemas when you first approve them.
const store = new FingerprintStore();

const fp = await pinFingerprint(
  'readFile',
  'filesystem-server',
  myFileReadToolSchema,
  'production',
);
store.set(fp);

// 2. At runtime, fetch live schemas from the MCP server and check for drift.
const liveSchemas = await fetchSchemasFromMcpServer();

const result = await detectDrift(store.getAll(), liveSchemas);

if (result.drifted) {
  for (const change of result.changes) {
    console.error(change.remediation);
  }
  process.exit(1);
}
```

---

## Configuration Options

MCP drift detection is a standalone module. It does not require a `ToolGuard` instance. All functions are pure async utilities.

The `mcpFingerprint` field on `ToolGuardConfig` lets you attach an expected schema hash to a guarded tool so the guard can verify it at execution time:

```typescript
const tools = guard.guardTools({
  readFile: {
    tool: readFileTool,
    riskLevel: 'medium',
    mcpFingerprint: 'abc123...', // Expected SHA-256 hash
  },
});
```

---

## Core Functions

### `computeFingerprint(toolName, schema): Promise<string>`

Computes a SHA-256 fingerprint for a tool schema. The schema is canonicalized (object keys sorted recursively) before hashing, so fingerprints are stable regardless of key insertion order.

```typescript
import { computeFingerprint } from 'ai-tool-guard/mcp';

const hash = await computeFingerprint('readFile', {
  type: 'object',
  properties: {
    path: { type: 'string' },
  },
  required: ['path'],
});
// => "4f3e2a1b..." (64-character hex string)
```

The input to the hash function is `JSON.stringify({ toolName, schema })` with canonicalized key order. Including `toolName` in the hash means the same schema used under two different tool names produces two different fingerprints.

### `pinFingerprint(toolName, serverId, schema, environment?): Promise<McpToolFingerprint>`

Creates a `McpToolFingerprint` record capturing the current schema hash, the time of pinning, and an optional environment tag.

```typescript
import { pinFingerprint } from 'ai-tool-guard/mcp';

const fp: McpToolFingerprint = await pinFingerprint(
  'queryDatabase',
  'db-server-v2',
  queryDatabaseSchema,
  'staging',
);
// {
//   toolName: 'queryDatabase',
//   serverId: 'db-server-v2',
//   schemaHash: 'c4f9...',
//   pinnedAt: '2024-01-15T10:30:00.000Z',
//   environment: 'staging',
// }
```

### `detectDrift(pinnedFingerprints, currentSchemas): Promise<McpDriftResult>`

Compares a set of pinned fingerprints against live schemas. Returns a `McpDriftResult` indicating whether any drift was found and providing details for each changed tool.

Tools present in `currentSchemas` but absent from `pinnedFingerprints` are also flagged — they are treated as unknown tools that have not been reviewed.

```typescript
const result = await detectDrift(
  store.getAll(),
  [
    { toolName: 'readFile', serverId: 'fs-server', schema: liveReadFileSchema },
    { toolName: 'writeFile', serverId: 'fs-server', schema: liveWriteFileSchema },
  ],
);

console.log(result.drifted);          // true | false
console.log(result.changes.length);   // number of drifted tools
```

---

## Data Types

### `McpToolFingerprint`

```typescript
interface McpToolFingerprint {
  /** Tool name. */
  toolName: string;
  /** MCP server identifier. */
  serverId: string;
  /** SHA-256 of the canonical schema JSON. */
  schemaHash: string;
  /** ISO-8601 timestamp when this fingerprint was pinned. */
  pinnedAt: string;
  /** Optional environment tag (e.g. "production", "staging"). */
  environment?: string;
}
```

### `McpDriftResult`

```typescript
interface McpDriftResult {
  /** True if any tool schemas changed or new unpinned tools appeared. */
  drifted: boolean;
  /** Details for each drifted tool. */
  changes: McpDriftChange[];
}
```

### `McpDriftChange`

```typescript
interface McpDriftChange {
  toolName: string;
  serverId: string;
  /** The hash stored in the pin. "(not pinned)" for new unknown tools. */
  expectedHash: string;
  /** The hash computed from the live schema. */
  actualHash: string;
  /** Human-readable description of what changed and how to fix it. */
  remediation: string;
}
```

The `remediation` string is ready to log or display to a developer. It identifies the server and tool by name, shows the first 12 characters of both hashes for visual comparison, and instructs the developer to call `pinFingerprint()` after reviewing the change.

---

## `FingerprintStore`

`FingerprintStore` is an in-memory reference implementation for managing pinned fingerprints. For production deployments, use `export()` and `import()` to persist to a file, database, or secret store.

```typescript
import { FingerprintStore } from 'ai-tool-guard/mcp';

const store = new FingerprintStore();
```

### Methods

| Method | Signature | Description |
|---|---|---|
| `set` | `(fp: McpToolFingerprint) => void` | Adds or replaces a pinned fingerprint. |
| `get` | `(serverId: string, toolName: string) => McpToolFingerprint \| undefined` | Retrieves a single pin by server and tool name. |
| `getAll` | `() => McpToolFingerprint[]` | Returns all pinned fingerprints as an array. |
| `delete` | `(serverId: string, toolName: string) => boolean` | Removes a pin. Returns `true` if it existed. |
| `export` | `() => string` | Serializes all fingerprints to a pretty-printed JSON string. |
| `import` | `(json: string) => void` | Loads fingerprints from a JSON string, validating each entry. |

### Persistence with `export()` and `import()`

```typescript
import fs from 'node:fs';

// Save to disk.
fs.writeFileSync('fingerprints.json', store.export());

// Load on next startup.
const stored = new FingerprintStore();
stored.import(fs.readFileSync('fingerprints.json', 'utf-8'));
```

`import()` validates that every entry in the JSON array has non-empty `toolName`, `serverId`, `schemaHash`, and `pinnedAt` string fields. Malformed entries throw an `Error` identifying the index of the invalid entry.

!!! warning
    `FingerprintStore` is an in-memory store. Data is lost when the process exits unless you call `export()` and persist the result. Plan your persistence strategy before deploying.

---

## Advanced Examples

### CI/CD Schema Validation

Run drift detection as a pre-deployment check. Fail the pipeline if any tool schema changed since the last pin.

```typescript
// scripts/check-mcp-drift.ts
import fs from 'node:fs';
import { FingerprintStore, detectDrift } from 'ai-tool-guard/mcp';
import { fetchToolSchemas } from './mcp-client.js';

const store = new FingerprintStore();
store.import(fs.readFileSync('fingerprints.json', 'utf-8'));

const liveSchemas = await fetchToolSchemas();
const result = await detectDrift(store.getAll(), liveSchemas);

if (result.drifted) {
  console.error('MCP schema drift detected:');
  for (const change of result.changes) {
    console.error(`  [${change.serverId}] ${change.toolName}`);
    console.error(`    Expected: ${change.expectedHash.slice(0, 12)}...`);
    console.error(`    Actual:   ${change.actualHash.slice(0, 12)}...`);
    console.error(`    ${change.remediation}`);
  }
  process.exit(1);
}

console.log('All MCP tool schemas match pinned fingerprints.');
```

### Runtime Drift Checking

Check for drift at agent startup, before any tool calls are made, and block execution if drift is found:

```typescript
import { createToolGuard } from 'ai-tool-guard';
import { FingerprintStore, detectDrift } from 'ai-tool-guard/mcp';
import { fetchToolSchemas } from './mcp-client.js';

async function createGuardedAgent() {
  const store = new FingerprintStore();
  store.import(loadPersistedFingerprints());

  const liveSchemas = await fetchToolSchemas();
  const driftResult = await detectDrift(store.getAll(), liveSchemas);

  if (driftResult.drifted) {
    throw new Error(
      `MCP schema drift detected on ${driftResult.changes.length} tool(s). ` +
      `Re-pin schemas after review.`
    );
  }

  return createToolGuard({ rules: [...] });
}
```

### Multi-Environment Pinning

Pin the same tool separately for `production` and `staging` environments, which may expose different schema versions:

```typescript
import { pinFingerprint, FingerprintStore } from 'ai-tool-guard/mcp';

const store = new FingerprintStore();

// Pin production schema.
store.set(await pinFingerprint('sendEmail', 'email-server', prodSchema, 'production'));

// Pin staging schema (may differ during a rollout).
store.set(await pinFingerprint('sendEmail', 'email-server', stagingSchema, 'staging'));

// The store keys on serverId + toolName, so both coexist.
// Filter by environment when running drift checks:
const prodPins = store.getAll().filter(fp => fp.environment === 'production');
```

---

## How It Works

1. `computeFingerprint` takes the tool name and schema, wraps them in a deterministic object `{ toolName, schema }`, then passes it through `canonicalize()` — a recursive key-sorting serializer — before computing SHA-256 via the Node `crypto` module.
2. `pinFingerprint` calls `computeFingerprint` and wraps the result in a `McpToolFingerprint` record stamped with the current ISO-8601 time.
3. `detectDrift` builds an internal lookup map keyed on `"${serverId}:${toolName}"`. For each live schema, it looks up the corresponding pin. If the pin is missing, the tool is flagged as unknown. If the pin exists but the hashes differ, the tool is flagged as changed.
4. For each mismatch, a `McpDriftChange` is constructed with the expected and actual hashes and a remediation string that includes the pin timestamp for easy auditing.
5. The final `McpDriftResult` sets `drifted: true` if the `changes` array is non-empty.

---

## Related

- [API Reference — MCP](../api/mcp.md)
