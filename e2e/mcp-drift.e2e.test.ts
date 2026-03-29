import { describe, it, expect } from "vitest";
import {
  computeFingerprint,
  pinFingerprint,
  detectDrift,
  FingerprintStore,
} from "../src/mcp/index.js";

const sampleSchema = {
  type: "object",
  properties: {
    query: { type: "string" },
    limit: { type: "number" },
  },
  required: ["query"],
};

describe("MCP drift detection e2e", () => {
  describe("computeFingerprint", () => {
    it("returns a consistent hash for the same schema", async () => {
      const hash1 = await computeFingerprint("search", sampleSchema);
      const hash2 = await computeFingerprint("search", sampleSchema);
      expect(hash1).toBe(hash2);
      expect(typeof hash1).toBe("string");
      expect(hash1.length).toBeGreaterThan(0);
    });

    it("returns different hashes for different schemas", async () => {
      const hash1 = await computeFingerprint("search", sampleSchema);
      const hash2 = await computeFingerprint("search", { type: "string" });
      expect(hash1).not.toBe(hash2);
    });

    it("returns different hashes for different tool names with same schema", async () => {
      const hash1 = await computeFingerprint("search", sampleSchema);
      const hash2 = await computeFingerprint("query", sampleSchema);
      expect(hash1).not.toBe(hash2);
    });

    it("produces deterministic hash regardless of key order", async () => {
      const schema1 = { b: 2, a: 1 };
      const schema2 = { a: 1, b: 2 };
      const hash1 = await computeFingerprint("tool", schema1);
      const hash2 = await computeFingerprint("tool", schema2);
      expect(hash1).toBe(hash2);
    });
  });

  describe("pinFingerprint", () => {
    it("creates a valid fingerprint record", async () => {
      const fp = await pinFingerprint("search", "mcp-server", sampleSchema);
      expect(fp.toolName).toBe("search");
      expect(fp.serverId).toBe("mcp-server");
      expect(fp.schemaHash).toBe(
        await computeFingerprint("search", sampleSchema),
      );
      expect(fp.pinnedAt).toBeTruthy();
      expect(fp.environment).toBeUndefined();
    });

    it("includes environment when provided", async () => {
      const fp = await pinFingerprint(
        "search",
        "mcp-server",
        sampleSchema,
        "production",
      );
      expect(fp.environment).toBe("production");
    });
  });

  describe("detectDrift", () => {
    it("reports no drift when schemas match", async () => {
      const fp = await pinFingerprint("search", "srv", sampleSchema);
      const result = await detectDrift([fp], [
        { toolName: "search", serverId: "srv", schema: sampleSchema },
      ]);
      expect(result.drifted).toBe(false);
      expect(result.changes).toHaveLength(0);
    });

    it("detects changed schema", async () => {
      const fp = await pinFingerprint("search", "srv", sampleSchema);
      const modifiedSchema = { ...sampleSchema, properties: { query: { type: "number" } } };

      const result = await detectDrift([fp], [
        { toolName: "search", serverId: "srv", schema: modifiedSchema },
      ]);

      expect(result.drifted).toBe(true);
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].toolName).toBe("search");
      expect(result.changes[0].serverId).toBe("srv");
      expect(result.changes[0].expectedHash).toBe(fp.schemaHash);
      expect(result.changes[0].actualHash).not.toBe(fp.schemaHash);
      expect(result.changes[0].remediation).toContain("has changed since it was pinned");
    });

    it("detects new unpinned tool", async () => {
      const fp = await pinFingerprint("search", "srv", sampleSchema);
      const result = await detectDrift([fp], [
        { toolName: "search", serverId: "srv", schema: sampleSchema },
        { toolName: "newTool", serverId: "srv", schema: { type: "string" } },
      ]);

      expect(result.drifted).toBe(true);
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].toolName).toBe("newTool");
      expect(result.changes[0].expectedHash).toBe("(not pinned)");
      expect(result.changes[0].remediation).toContain("not in the pinned fingerprint set");
    });

    it("handles multiple changes across servers", async () => {
      const fp1 = await pinFingerprint("search", "srv-a", sampleSchema);
      const fp2 = await pinFingerprint("read", "srv-b", { type: "string" });

      const result = await detectDrift([fp1, fp2], [
        { toolName: "search", serverId: "srv-a", schema: { type: "number" } },
        { toolName: "read", serverId: "srv-b", schema: { type: "number" } },
      ]);

      expect(result.drifted).toBe(true);
      expect(result.changes).toHaveLength(2);
    });
  });

  describe("FingerprintStore", () => {
    it("supports set, get, getAll, and delete", async () => {
      const store = new FingerprintStore();
      const fp = await pinFingerprint("search", "srv", sampleSchema);

      store.set(fp);
      expect(store.get("srv", "search")).toEqual(fp);
      expect(store.getAll()).toHaveLength(1);

      store.delete("srv", "search");
      expect(store.get("srv", "search")).toBeUndefined();
      expect(store.getAll()).toHaveLength(0);
    });

    it("export and import round-trip preserves data", async () => {
      const store = new FingerprintStore();
      const fp1 = await pinFingerprint("search", "srv-a", sampleSchema);
      const fp2 = await pinFingerprint("read", "srv-b", { type: "string" }, "staging");
      store.set(fp1);
      store.set(fp2);

      const json = store.export();
      const restored = new FingerprintStore();
      restored.import(json);

      expect(restored.getAll()).toHaveLength(2);
      expect(restored.get("srv-a", "search")).toEqual(fp1);
      expect(restored.get("srv-b", "read")).toEqual(fp2);
    });

    it("import rejects non-array JSON", () => {
      const store = new FingerprintStore();
      expect(() => store.import('{"not": "array"}')).toThrow(
        "expected a JSON array",
      );
    });

    it("import rejects entries with missing fields", () => {
      const store = new FingerprintStore();
      expect(() =>
        store.import('[{"toolName": "x"}]'),
      ).toThrow("invalid fingerprint at index 0");
    });
  });
});
