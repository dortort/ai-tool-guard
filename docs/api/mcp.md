# MCP — `ai-tool-guard/mcp`

The MCP module provides tool schema fingerprinting and drift detection for Model
Context Protocol servers. It detects when a remote tool's schema changes between
deployments, which can indicate an inadvertent update or a supply-chain attack.

```ts
import {
  computeFingerprint,
  pinFingerprint,
  detectDrift,
  FingerprintStore,
} from "ai-tool-guard/mcp";
```

---

## Functions

### `computeFingerprint`

```ts
async function computeFingerprint(
  toolName: string,
  schema: unknown,
): Promise<string>
```

Compute a deterministic SHA-256 fingerprint for a tool's schema. The tool name
and schema are combined and canonicalized (keys sorted recursively) before
hashing, so fingerprints are stable regardless of JSON key order.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `toolName` | `string` | Yes | Name of the tool |
| `schema` | `unknown` | Yes | The tool's schema object (typically the Zod or JSON Schema definition) |

**Returns** `Promise<string>` — hex-encoded SHA-256 hash

---

### `pinFingerprint`

```ts
async function pinFingerprint(
  toolName: string,
  serverId: string,
  schema: unknown,
  environment?: string,
): Promise<McpToolFingerprint>
```

Create a `McpToolFingerprint` record by computing the schema hash and capturing
metadata. Store the result in a `FingerprintStore` or a persistent database for
later drift comparison.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `toolName` | `string` | Yes | Name of the tool to pin |
| `serverId` | `string` | Yes | Identifier of the MCP server serving this tool |
| `schema` | `unknown` | Yes | Current schema to pin |
| `environment` | `string` | No | Environment tag such as `"production"` or `"staging"` |

**Returns** `Promise<McpToolFingerprint>`

**Example**

```ts
const fp = await pinFingerprint("web_search", "mcp-server-prod", webSearchSchema, "production");
store.set(fp);
```

---

### `detectDrift`

```ts
async function detectDrift(
  pinnedFingerprints: McpToolFingerprint[],
  currentSchemas: Array<{
    toolName: string;
    serverId: string;
    schema: unknown;
  }>,
): Promise<McpDriftResult>
```

Compare a set of current tool schemas against their pinned fingerprints. For each
current schema, the function recomputes the fingerprint and compares it against
the pinned hash.

Two conditions generate a `McpDriftChange` entry:

1. The tool is present in `currentSchemas` but absent from `pinnedFingerprints`
   (new, unpinned tool).
2. The tool is pinned but its computed hash differs from the stored hash.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `pinnedFingerprints` | `McpToolFingerprint[]` | Yes | Previously pinned fingerprint records |
| `currentSchemas` | `Array<{ toolName: string; serverId: string; schema: unknown }>` | Yes | Current schemas from the live MCP server |

**Returns** `Promise<McpDriftResult>`

**Example**

```ts
const driftResult = await detectDrift(store.getAll(), liveSchemas);

if (driftResult.drifted) {
  for (const change of driftResult.changes) {
    console.error(change.remediation);
  }
}
```

---

## Classes

### `FingerprintStore`

Simple in-memory reference implementation for storing pinned fingerprints. For
production use, persist the data by calling `export()` and storing the JSON, then
reloading with `import()` on startup.

#### Constructor

```ts
new FingerprintStore()
```

No parameters. Initializes an empty in-memory map.

#### Methods

##### `set`

```ts
set(fp: McpToolFingerprint): void
```

Pin a fingerprint. Overwrites any existing entry for the same `serverId` +
`toolName` combination.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `fp` | `McpToolFingerprint` | Yes | Fingerprint record to store |

##### `get`

```ts
get(serverId: string, toolName: string): McpToolFingerprint | undefined
```

Retrieve a pinned fingerprint by server and tool name. Returns `undefined` if not
found.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `serverId` | `string` | Yes | MCP server identifier |
| `toolName` | `string` | Yes | Tool name |

**Returns** `McpToolFingerprint | undefined`

##### `getAll`

```ts
getAll(): McpToolFingerprint[]
```

Return all pinned fingerprints as an array. Suitable for passing directly to
`detectDrift()`.

**Returns** `McpToolFingerprint[]`

##### `delete`

```ts
delete(serverId: string, toolName: string): boolean
```

Remove a pinned fingerprint. Returns `true` if an entry was deleted, `false` if
no matching entry existed.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `serverId` | `string` | Yes | MCP server identifier |
| `toolName` | `string` | Yes | Tool name |

**Returns** `boolean`

##### `export`

```ts
export(): string
```

Serialize all fingerprints to a JSON string for persistence. The output is an
array of `McpToolFingerprint` objects formatted with two-space indentation.

**Returns** `string`

##### `import`

```ts
import(json: string): void
```

Deserialize fingerprints from a JSON string and add them to the store. Validates
that each entry has `toolName`, `serverId`, `schemaHash`, and `pinnedAt` as
strings. Throws an `Error` if the JSON is invalid or any entry fails validation.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `json` | `string` | Yes | JSON string produced by `export()` |

---

## Interfaces

### `McpToolFingerprint`

A pinned schema fingerprint record for a single MCP tool.

| Field | Type | Required | Description |
|---|---|---|---|
| `toolName` | `string` | Yes | Name of the tool |
| `serverId` | `string` | Yes | Identifier of the MCP server |
| `schemaHash` | `string` | Yes | SHA-256 hex hash of the canonicalized schema |
| `pinnedAt` | `string` | Yes | ISO-8601 timestamp of when the fingerprint was created |
| `environment` | `string` | No | Environment tag (e.g. `"production"`, `"staging"`) |

---

### `McpDriftResult`

Aggregate result of `detectDrift()`.

| Field | Type | Description |
|---|---|---|
| `drifted` | `boolean` | `true` when at least one tool has changed or is unpinned |
| `changes` | `McpDriftChange[]` | Detailed change records for every drifted or unpinned tool |

---

### `McpDriftChange`

Detail for a single tool that has drifted or is not pinned.

| Field | Type | Description |
|---|---|---|
| `toolName` | `string` | Name of the changed tool |
| `serverId` | `string` | MCP server identifier |
| `expectedHash` | `string` | Pinned hash, or `"(not pinned)"` for new tools |
| `actualHash` | `string` | Currently computed hash |
| `remediation` | `string` | Human-readable description of what changed and how to resolve it |
