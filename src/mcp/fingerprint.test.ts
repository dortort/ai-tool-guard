import { describe, it, expect } from "vitest";
import {
  computeFingerprint,
  pinFingerprint,
  detectDrift,
  FingerprintStore,
} from "./fingerprint.js";

describe("computeFingerprint", () => {
  it("produces deterministic hashes", async () => {
    const schema = { type: "object", properties: { x: { type: "number" } } };
    const h1 = await computeFingerprint("tool", schema);
    const h2 = await computeFingerprint("tool", schema);
    expect(h1).toBe(h2);
  });

  it("produces different hashes for different schemas", async () => {
    const h1 = await computeFingerprint("tool", { a: 1 });
    const h2 = await computeFingerprint("tool", { a: 2 });
    expect(h1).not.toBe(h2);
  });

  it("is key-order independent", async () => {
    const h1 = await computeFingerprint("tool", { a: 1, b: 2 });
    const h2 = await computeFingerprint("tool", { b: 2, a: 1 });
    expect(h1).toBe(h2);
  });
});

describe("detectDrift", () => {
  it("reports no drift when schemas match", async () => {
    const schema = { type: "string" };
    const pinned = await pinFingerprint("tool", "server1", schema);
    const result = await detectDrift(
      [pinned],
      [{ toolName: "tool", serverId: "server1", schema }],
    );
    expect(result.drifted).toBe(false);
    expect(result.changes).toHaveLength(0);
  });

  it("detects drift when schema changes", async () => {
    const originalSchema = { type: "string" };
    const changedSchema = { type: "number" };
    const pinned = await pinFingerprint("tool", "server1", originalSchema);

    const result = await detectDrift(
      [pinned],
      [{ toolName: "tool", serverId: "server1", schema: changedSchema }],
    );
    expect(result.drifted).toBe(true);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]!.toolName).toBe("tool");
    expect(result.changes[0]!.remediation).toContain("has changed");
  });

  it("detects new unpinned tools", async () => {
    const result = await detectDrift(
      [],
      [{ toolName: "newTool", serverId: "server1", schema: {} }],
    );
    expect(result.drifted).toBe(true);
    expect(result.changes[0]!.expectedHash).toBe("(not pinned)");
    expect(result.changes[0]!.remediation).toContain("not in the pinned fingerprint set");
  });
});

describe("FingerprintStore", () => {
  it("stores and retrieves fingerprints", async () => {
    const store = new FingerprintStore();
    const fp = await pinFingerprint("tool", "server1", { x: 1 });
    store.set(fp);

    const retrieved = store.get("server1", "tool");
    expect(retrieved).toEqual(fp);
  });

  it("exports and imports JSON", async () => {
    const store = new FingerprintStore();
    store.set(await pinFingerprint("a", "s1", {}));
    store.set(await pinFingerprint("b", "s1", {}));

    const json = store.export();
    const store2 = new FingerprintStore();
    store2.import(json);

    expect(store2.getAll()).toHaveLength(2);
    expect(store2.get("s1", "a")).toBeDefined();
  });

  it("deletes fingerprints", async () => {
    const store = new FingerprintStore();
    store.set(await pinFingerprint("tool", "s1", {}));
    expect(store.delete("s1", "tool")).toBe(true);
    expect(store.get("s1", "tool")).toBeUndefined();
  });
});
