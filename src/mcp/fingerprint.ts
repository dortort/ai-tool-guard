/**
 * MCP drift detection and tool fingerprint pinning (#15).
 *
 * Pins schema fingerprints per environment, blocks execution on drift,
 * and emits actionable remediation (which server/tool changed).
 */

import type { McpDriftChange, McpDriftResult, McpToolFingerprint } from "../types.js";
import { sha256, canonicalize } from "../utils/index.js";

// ---------------------------------------------------------------------------
// Fingerprint generation
// ---------------------------------------------------------------------------

/**
 * Compute a fingerprint for a tool's schema.
 * The schema is canonicalized (sorted keys) before hashing to ensure
 * deterministic fingerprints regardless of key order.
 */
export async function computeFingerprint(
  toolName: string,
  schema: unknown,
): Promise<string> {
  const canonical = canonicalize({ toolName, schema });
  return sha256(canonical);
}

/**
 * Create a pinned fingerprint record for a tool.
 */
export async function pinFingerprint(
  toolName: string,
  serverId: string,
  schema: unknown,
  environment?: string,
): Promise<McpToolFingerprint> {
  const schemaHash = await computeFingerprint(toolName, schema);
  return {
    toolName,
    serverId,
    schemaHash,
    pinnedAt: new Date().toISOString(),
    environment,
  };
}

// ---------------------------------------------------------------------------
// Drift detection
// ---------------------------------------------------------------------------

/**
 * Check a set of tool schemas against their pinned fingerprints.
 * Returns a drift result indicating which tools (if any) changed.
 */
export async function detectDrift(
  pinnedFingerprints: McpToolFingerprint[],
  currentSchemas: Array<{
    toolName: string;
    serverId: string;
    schema: unknown;
  }>,
): Promise<McpDriftResult> {
  const pinMap = new Map<string, McpToolFingerprint>();
  for (const fp of pinnedFingerprints) {
    pinMap.set(`${fp.serverId}:${fp.toolName}`, fp);
  }

  const changes: McpDriftChange[] = [];

  for (const current of currentSchemas) {
    const key = `${current.serverId}:${current.toolName}`;
    const pinned = pinMap.get(key);

    if (!pinned) {
      // New tool not in pinned set — could be suspicious.
      changes.push({
        toolName: current.toolName,
        serverId: current.serverId,
        expectedHash: "(not pinned)",
        actualHash: await computeFingerprint(
          current.toolName,
          current.schema,
        ),
        remediation:
          `Tool "${current.toolName}" from server "${current.serverId}" ` +
          `is not in the pinned fingerprint set. Pin it with pinFingerprint() ` +
          `or remove it from the MCP server.`,
      });
      continue;
    }

    const actualHash = await computeFingerprint(
      current.toolName,
      current.schema,
    );

    if (actualHash !== pinned.schemaHash) {
      changes.push({
        toolName: current.toolName,
        serverId: current.serverId,
        expectedHash: pinned.schemaHash,
        actualHash,
        remediation:
          `Tool "${current.toolName}" from server "${current.serverId}" ` +
          `has changed since it was pinned at ${pinned.pinnedAt}. ` +
          `Expected hash: ${pinned.schemaHash.slice(0, 12)}…, ` +
          `got: ${actualHash.slice(0, 12)}…. ` +
          `Re-pin with pinFingerprint() after reviewing the schema change.`,
      });
    }
  }

  return {
    drifted: changes.length > 0,
    changes,
  };
}

// ---------------------------------------------------------------------------
// Fingerprint store (in-memory reference implementation)
// ---------------------------------------------------------------------------

/**
 * Simple in-memory fingerprint store.
 * Production deployments should persist to a database or config file.
 */
export class FingerprintStore {
  private readonly fingerprints = new Map<string, McpToolFingerprint>();

  private key(serverId: string, toolName: string): string {
    return `${serverId}:${toolName}`;
  }

  /** Pin a fingerprint. */
  set(fp: McpToolFingerprint): void {
    this.fingerprints.set(this.key(fp.serverId, fp.toolName), fp);
  }

  /** Get a pinned fingerprint. */
  get(
    serverId: string,
    toolName: string,
  ): McpToolFingerprint | undefined {
    return this.fingerprints.get(this.key(serverId, toolName));
  }

  /** Get all pinned fingerprints. */
  getAll(): McpToolFingerprint[] {
    return Array.from(this.fingerprints.values());
  }

  /** Remove a pinned fingerprint. */
  delete(serverId: string, toolName: string): boolean {
    return this.fingerprints.delete(this.key(serverId, toolName));
  }

  /** Export all fingerprints as JSON (for persistence). */
  export(): string {
    return JSON.stringify(this.getAll(), null, 2);
  }

  /** Import fingerprints from JSON. Validates required fields on each entry. */
  import(json: string): void {
    const parsed: unknown = JSON.parse(json);

    if (!Array.isArray(parsed)) {
      throw new Error(
        "FingerprintStore.import(): expected a JSON array of fingerprints.",
      );
    }

    for (let i = 0; i < parsed.length; i++) {
      const entry = parsed[i] as Record<string, unknown>;
      if (
        !entry ||
        typeof entry !== "object" ||
        typeof entry.toolName !== "string" ||
        typeof entry.serverId !== "string" ||
        typeof entry.schemaHash !== "string" ||
        typeof entry.pinnedAt !== "string"
      ) {
        throw new Error(
          `FingerprintStore.import(): invalid fingerprint at index ${i}. ` +
            "Each entry must have toolName, serverId, schemaHash, and pinnedAt as strings.",
        );
      }
      this.set(entry as unknown as McpToolFingerprint);
    }
  }
}
