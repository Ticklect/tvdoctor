import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactStore } from "@tvdoctor/reporters";
import { describe, expect, it } from "vitest";
import { writeAuditAuxiliaryArtifacts } from "../src/node-audit-output.js";

describe("Deep aggregate audit artifacts", () => {
  it("writes every transition when aggregate navigation evidence exceeds the per-issue node limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-deep-report-"));
    try {
      const store = await createArtifactStore(root);
      const transitions = Array.from({ length: 3_000 }, (_, index) => ({
        key: "edge-" + String(index),
        source: "screen-" + String(index % 23),
        target: "screen-" + String((index + 1) % 23),
        path: ["DOWN", "RIGHT", "SELECT"],
        confidence: "high",
        meta: { index, outcome: "applied" },
      }));
      const descriptors = await writeAuditAuxiliaryArtifacts(
        store,
        { navigation: { termination: { reason: "queue-exhausted", complete: true } } },
        { transitions, password: "private" },
      );
      expect(descriptors.map((descriptor) => descriptor.status)).toEqual(["available", "available"]);
      const inventory = JSON.parse(await readFile(join(root, "inventory.json"), "utf8")) as {
        transitions: readonly { key: string }[];
        password: string;
      };
      expect(inventory.transitions).toHaveLength(3_000);
      expect(inventory.transitions[2_999]?.key).toBe("edge-2999");
      expect(inventory.password).toBe("[REDACTED]");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes 30,000 detailed edges beyond the old aggregate sanitizer ceiling with verifiable descriptors", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-huge-report-"));
    try {
      const store = await createArtifactStore(root);
      const transitions = Array.from({ length: 30_000 }, (_, index) => ({
        key: `edge-${index}`,
        source: `screen-${index % 240}`,
        target: `screen-${(index + 1) % 240}`,
        path: ["DOWN", "RIGHT", "SELECT"],
        metadata: { index, action: "SELECT", observation: "https://example.org/?session=private" },
      }));
      const descriptors = await writeAuditAuxiliaryArtifacts(store, { status: "partial" }, {
        transitions,
        apiKey: "private",
      });
      const inventoryBytes = await readFile(join(root, "inventory.json"));
      const inventory = JSON.parse(inventoryBytes.toString("utf8")) as {
        transitions: { key: string; metadata: { observation: string } }[];
        apiKey: string;
      };
      expect(inventory.transitions).toHaveLength(30_000);
      expect(inventory.transitions.at(-1)?.key).toBe("edge-29999");
      expect(inventory.apiKey).toBe("[REDACTED]");
      expect(inventory.transitions[0]?.metadata.observation).toBe("https://example.org/");
      expect(descriptors[1]).toMatchObject({
        byteLength: inventoryBytes.byteLength,
        sha256: createHash("sha256").update(inventoryBytes).digest("hex"),
      });
      await store.verifyAvailableArtifact(descriptors[1] as Extract<typeof descriptors[number], { status: "available" }>);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
