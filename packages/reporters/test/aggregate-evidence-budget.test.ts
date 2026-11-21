import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aggregateReportJsonChunks } from "../src/aggregate-json-stream.js";
import { createArtifactStore } from "../src/artifact-store.js";
import { sanitiseAggregateReportJson, sanitiseEvidenceJson } from "../src/evidence.js";
import { stableJson } from "../src/stable-json.js";

function largeNavigationEvidence() {
  return {
    transitions: Array.from({ length: 3_000 }, (_, index) => ({
      key: "edge-" + String(index),
      from: "state-" + String(index % 71),
      to: "state-" + String((index + 1) % 71),
      action: "RIGHT",
      nested: { x: index, y: index + 1 },
    })),
    password: "should never leak",
  };
}

describe("Deep navigation artifact sanitisation budgets", () => {
  it("keeps full bounded aggregate graph data while retaining redaction", () => {
    const graph = largeNavigationEvidence();
    expect(() => sanitiseEvidenceJson({ transitions: graph.transitions.slice(0, 2_000) }))
      .toThrow("Evidence JSON exceeds the node limit.");
    const sanitised = sanitiseAggregateReportJson(graph) as {
      transitions: readonly { key: string }[];
      password: string;
    };
    expect(sanitised.transitions).toHaveLength(3_000);
    expect(sanitised.transitions[2_999]?.key).toBe("edge-2999");
    expect(sanitised.password).toBe("[REDACTED]");
  });

  it("still rejects unbounded aggregate lists and prototype-sensitive keys", () => {
    expect(() => sanitiseAggregateReportJson({
      transitions: Array.from({ length: 20_001 }, () => null),
    })).toThrow("Evidence JSON array exceeds the item limit.");
    const hostile = JSON.parse('{"constructor":"unsafe"}') as Record<string, string>;
    expect(() => sanitiseAggregateReportJson(hostile))
      .toThrow("Evidence JSON cannot contain prototype-sensitive keys.");
  });

  it("streams exactly the same stable JSON/redaction as the existing bounded sanitizer", () => {
    const value = {
      nested: [{ url: "https://user:secret@example.com/a?token=secret#frag", apiKey: "private" }],
      authorization: "Bearer private",
      z: "text",
      empty: [],
      omitted: undefined,
    };
    const expected = stableJson(sanitiseAggregateReportJson(JSON.parse(JSON.stringify(value))));
    expect(Array.from(aggregateReportJsonChunks(value)).join("")).toBe(expected);
    expect(expected).not.toContain("private");
    expect(expected).not.toContain("user:secret");
  });

  it("enforces finite stream budgets, rejects unsafe properties, and preserves prior bytes on failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-stream-budget-"));
    try {
      const store = await createArtifactStore(root, { overwrite: true });
      const original = "{\"previous\":true}\n";
      await store.writeBundleFile("inventory.json", original);
      const large = { transitions: Array.from({ length: 2_000 }, (_, i) => ({ index: i, value: "x".repeat(80) })) };
      await expect(store.writeBundleFileStream(
        "inventory.json", aggregateReportJsonChunks(large, { maxBytes: 64 * 1024 }),
      )).rejects.toThrow("Aggregate JSON exceeds the byte limit.");
      expect(await readFile(join(root, "inventory.json"), "utf8")).toBe(original);
      expect(await readdir(root)).toEqual(["inventory.json"]);

      const bad = JSON.parse('{"nested":{"__proto__":"injected"}}') as unknown;
      expect(() => Array.from(aggregateReportJsonChunks(bad))).toThrow("unsafe property name");
      expect(() => Array.from(aggregateReportJsonChunks({ password: "secret", value: 1 }, { maxNodes: 2 })))
        .toThrow("node limit");
      expect(() => Array.from(aggregateReportJsonChunks([0, 1, 2], { maxArrayEntries: 2 })))
        .toThrow("item limit");
      expect(() => Array.from(aggregateReportJsonChunks([1], { maxBytes: 500_000_000 })))
        .toThrow("hard limit");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports an exact digest for multi-chunk output and atomically publishes all bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-stream-hash-"));
    try {
      const store = await createArtifactStore(root);
      const graph = { transitions: Array.from({ length: 28_000 }, (_, i) => ({ index: i, action: "RIGHT", token: "never shared" })) };
      const expected = Array.from(aggregateReportJsonChunks(graph)).join("");
      const result = await store.writeBundleFileStream("graph.json", aggregateReportJsonChunks(graph));
      const contents = await readFile(join(root, "graph.json"));
      expect(contents.toString("utf8")).toBe(expected);
      expect(result.byteLength).toBe(contents.byteLength);
      expect(result.sha256).toBe(createHash("sha256").update(contents).digest("hex"));
      expect((JSON.parse(contents.toString("utf8")) as { transitions: unknown[] }).transitions).toHaveLength(28_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
