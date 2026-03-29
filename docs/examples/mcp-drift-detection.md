# MCP Drift Detection

This example demonstrates how to pin MCP tool schemas at deploy time and detect when a server changes its tool definitions unexpectedly. Schema drift can introduce security vulnerabilities or break assumptions your policy rules depend on.

---

## Scenario

You operate an AI assistant that connects to two MCP servers: a **database** server and a **filesystem** server. Before each deployment you pin the expected tool schemas. At runtime you compare the live schemas against the pins and block execution if anything has changed.

---

## Pinning tool schemas at deploy time

Use `pinFingerprint` to create a cryptographic record of each tool's schema. The fingerprint is a SHA-256 hash of the canonicalized schema, ensuring deterministic results regardless of key order.

```ts title="scripts/pin-schemas.ts"
import {
  pinFingerprint,
  FingerprintStore,
} from "ai-tool-guard/mcp";

// Schemas as reported by each MCP server at deploy time.
const dbToolSchemas = [
  {
    toolName: "queryRecords",
    serverId: "mcp-database",
    schema: {
      type: "object",
      properties: {
        table: { type: "string" },
        filter: { type: "object" },
        limit: { type: "number" },
      },
      required: ["table"],
    },
  },
  {
    toolName: "insertRecord",
    serverId: "mcp-database",
    schema: {
      type: "object",
      properties: {
        table: { type: "string" },
        data: { type: "object" },
      },
      required: ["table", "data"],
    },
  },
];

const fsToolSchemas = [
  {
    toolName: "readFile",
    serverId: "mcp-filesystem",
    schema: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
  },
];

async function pinAll() {
  const store = new FingerprintStore();

  for (const tool of [...dbToolSchemas, ...fsToolSchemas]) {
    const fp = await pinFingerprint(
      tool.toolName,
      tool.serverId,
      tool.schema,
      "production", // environment-scoped pin
    );
    store.set(fp);
    console.log(`Pinned ${tool.serverId}:${tool.toolName} → ${fp.schemaHash.slice(0, 12)}…`);
  }

  // Persist to disk for runtime use.
  const json = store.export();
  await Bun.write("fingerprints.json", json);
  // Or in Node.js:
  // fs.writeFileSync("fingerprints.json", json);
  console.log(`Exported ${store.getAll().length} fingerprints.`);
}

pinAll();
```

Running this script produces a `fingerprints.json` file containing an array of pinned records:

```json
[
  {
    "toolName": "queryRecords",
    "serverId": "mcp-database",
    "schemaHash": "a1b2c3d4e5f6…",
    "pinnedAt": "2025-06-15T10:30:00.000Z",
    "environment": "production"
  }
]
```

---

## FingerprintStore operations

The `FingerprintStore` is an in-memory reference implementation. Use it for CRUD operations and JSON serialization.

```ts title="lib/fingerprint-ops.ts"
import { FingerprintStore, pinFingerprint } from "ai-tool-guard/mcp";

const store = new FingerprintStore();

// --- Set: pin a tool and store the fingerprint ---
const fp = await pinFingerprint("queryRecords", "mcp-database", { type: "object" });
store.set(fp);

// --- Get: retrieve a single pinned fingerprint ---
const pinned = store.get("mcp-database", "queryRecords");
console.log(pinned?.schemaHash); // "a1b2c3…"

// --- Get all: list every pinned fingerprint ---
const all = store.getAll();
console.log(`${all.length} tools pinned.`);

// --- Delete: remove a pin when a tool is retired ---
store.delete("mcp-database", "queryRecords");

// --- Export / Import: persist to and restore from JSON ---
const json = store.export();
// ... save to file, database, or config store ...
const restored = new FingerprintStore();
restored.import(json);
```

---

## Detecting drift at runtime

At startup or on a schedule, fetch the current schemas from each MCP server and compare them against your pinned fingerprints.

```ts title="lib/drift-check.ts"
import {
  FingerprintStore,
  detectDrift,
} from "ai-tool-guard/mcp";
import { readFileSync } from "node:fs";

// Load pinned fingerprints from deploy-time export.
const store = new FingerprintStore();
store.import(readFileSync("fingerprints.json", "utf-8"));

// Current schemas as reported by the live MCP servers.
const currentSchemas = [
  {
    toolName: "queryRecords",
    serverId: "mcp-database",
    schema: {
      type: "object",
      properties: {
        table: { type: "string" },
        filter: { type: "object" },
        limit: { type: "number" },
        // New field added by the server — this triggers drift.
        orderBy: { type: "string" },
      },
      required: ["table"],
    },
  },
  {
    toolName: "readFile",
    serverId: "mcp-filesystem",
    schema: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
  },
  // A new tool not in the pinned set — also triggers drift.
  {
    toolName: "deleteFile",
    serverId: "mcp-filesystem",
    schema: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
  },
];

async function checkDrift() {
  const result = await detectDrift(store.getAll(), currentSchemas);

  if (!result.drifted) {
    console.log("No drift detected. All schemas match pinned fingerprints.");
    return;
  }

  console.warn(`Drift detected: ${result.changes.length} change(s).`);
  for (const change of result.changes) {
    console.warn(`  Tool: ${change.serverId}:${change.toolName}`);
    console.warn(`  Expected: ${change.expectedHash.slice(0, 12)}…`);
    console.warn(`  Actual:   ${change.actualHash.slice(0, 12)}…`);
    console.warn(`  Remediation: ${change.remediation}`);
  }

  // In production, you might:
  // - Block the affected tools from executing
  // - Alert the security team
  // - Fail the health check so the pod is not routed traffic
  process.exit(1);
}

checkDrift();
```

When the `queryRecords` schema gains a new `orderBy` field, the output looks like:

```
Drift detected: 2 change(s).
  Tool: mcp-database:queryRecords
  Expected: a1b2c3d4e5f6…
  Actual:   f6e5d4c3b2a1…
  Remediation: Tool "queryRecords" from server "mcp-database" has changed since it was pinned at 2025-06-15T10:30:00.000Z. Expected hash: a1b2c3d4e5f6…, got: f6e5d4c3b2a1…. Re-pin with pinFingerprint() after reviewing the schema change.

  Tool: mcp-filesystem:deleteFile
  Expected: (not pinned)
  Actual:   c3d4e5f6a1b2…
  Remediation: Tool "deleteFile" from server "mcp-filesystem" is not in the pinned fingerprint set. Pin it with pinFingerprint() or remove it from the MCP server.
```

---

## Environment-scoped pinning

Pin different schema versions per environment. This is useful when staging and production run different MCP server versions.

```ts title="lib/env-pinning.ts"
import { pinFingerprint, FingerprintStore } from "ai-tool-guard/mcp";

const store = new FingerprintStore();

const schema = {
  type: "object",
  properties: { query: { type: "string" } },
};

// Pin the same tool for two environments.
const stagingFp = await pinFingerprint("search", "mcp-search", schema, "staging");
const prodFp = await pinFingerprint("search", "mcp-search", schema, "production");

store.set(stagingFp);
store.set(prodFp);

// Both share the same schemaHash (same schema), but the environment
// field lets you filter or audit by deployment target.
console.log(stagingFp.environment); // "staging"
console.log(prodFp.environment);    // "production"
console.log(stagingFp.schemaHash === prodFp.schemaHash); // true
```

!!! info "FingerprintStore keys by `serverId:toolName`"
    The in-memory `FingerprintStore` keys entries by `serverId:toolName`, so setting both staging and production pins for the same tool overwrites the earlier entry. For multi-environment stores, use separate `FingerprintStore` instances per environment or implement a custom store backed by a database.

---

## Related

- [MCP Drift Detection Guide](../guides/mcp-drift-detection.md) -- configuration reference and advanced patterns.
- [Error Handling](../guides/error-handling.md) -- `ToolGuardError` with `code: "mcp-drift"`.
- [Decision Records](../guides/decision-records.md) -- audit trail for drift events.
