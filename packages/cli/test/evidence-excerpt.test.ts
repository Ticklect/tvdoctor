import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { availableObservation } from "@tvdoctor/protocol";
import type { WebDomNodeSnapshot } from "@tvdoctor/driver-web";
import {
  createArtifactStore,
  sanitiseEvidenceJson,
  stableJson,
  writeIssueEvidence,
} from "@tvdoctor/reporters";
import { describe, expect, it } from "vitest";

import {
  EVIDENCE_EXCERPT_MAX_NODES,
  boundedSnapshot,
} from "../src/node-audit.js";

function uiNode(index: number): WebDomNodeSnapshot {
  return {
    stableId: `node-${String(index).padStart(4, "0")}`,
    role: "button",
    name: `Realistic control ${index}`,
    text: null,
    bounds: { x: index % 8 * 160, y: Math.floor(index / 8) * 90, width: 148, height: 76 },
    visible: true,
    enabled: true,
    focusable: true,
    focused: index === 1,
    modal: false,
    selectionState: null,
    valueNow: null,
    attributes: {
      type: "button",
      "data-screen": "large-dom",
      "data-tv-id": `node-${String(index).padStart(4, "0")}`,
    },
    tagName: "button",
    children: [],
  };
}

function focusTarget(index: number) {
  const node = uiNode(index);
  if (node.stableId === null) throw new Error("Test stable ID is required.");
  return {
    stableId: node.stableId,
    ...(node.role === null ? {} : { role: node.role }),
    ...(node.name === null ? {} : { name: node.name }),
    ...(node.bounds === null ? {} : { bounds: node.bounds }),
  };
}

describe("production evidence excerpt", () => {
  it("retains a useful bounded prefix and survives reporter sanitation", () => {
    const networkEntries = Array.from({ length: 200 }, (_, index) => ({
      method: "GET",
      url: `https://example.test/resource/${index}`,
      resourceType: "fetch",
      outcome: "succeeded",
      status: 200,
      startedAt: "2026-08-23T00:00:00.000Z",
      finishedAt: "2026-08-23T00:00:00.100Z",
      durationMs: 100,
      failure: null,
    }));
    const snapshot = {
      capturedAt: "2026-08-23T00:00:00.000Z",
      location: availableObservation("https://example.test/large"),
      focusedElement: availableObservation(focusTarget(1)),
      uiTree: availableObservation(Array.from({ length: 250 }, (_, index) => uiNode(index))),
      network: availableObservation({
        requestsStarted: 200,
        requestsSucceeded: 200,
        requestsFailed: 0,
        requestsInFlight: 0,
        recentEntries: networkEntries,
      }),
    };
    const bounded = boundedSnapshot(snapshot);
    const tree = bounded.uiTree.status === "available" ? bounded.uiTree.value : [];
    const flattened = tree.flatMap((node) => [node]);

    expect(EVIDENCE_EXCERPT_MAX_NODES).toBe(150);
    expect(flattened).toHaveLength(EVIDENCE_EXCERPT_MAX_NODES);
    expect(flattened.some((node) => node.stableId === "node-0001")).toBe(true);
    expect(() => sanitiseEvidenceJson(
      JSON.parse(JSON.stringify(bounded)),
    )).not.toThrow();
  });

  it("writes valid evidence quickly for the bounded production-sized payload", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-evidence-"));
    try {
      const store = await createArtifactStore(root);
      const snapshot = {
        capturedAt: "2026-08-23T00:00:00.000Z",
        location: availableObservation("https://example.test/large"),
      focusedElement: availableObservation(focusTarget(1)),
        uiTree: availableObservation(Array.from({ length: 250 }, (_, index) => uiNode(index))),
      };
      const startedAtMs = performance.now();
      const written = await writeIssueEvidence(store, {
        issueId: "TVDOCTOR-EVIDENCE-LARGE-DOM",
        artifacts: [{
          slot: "ui-excerpt",
          capture: {
            status: "available",
            format: "json",
            value: JSON.parse(JSON.stringify(boundedSnapshot(snapshot))),
          },
        }],
      });
      const elapsedMs = performance.now() - startedAtMs;
      const descriptor = written.descriptors[0];
      expect(descriptor?.status).toBe("available");
      expect(elapsedMs).toBeLessThan(1_000);
      await expect(readFile(join(root, "evidence", "TVDOCTOR-EVIDENCE-LARGE-DOM", "ui-excerpt.json"), "utf8"))
        .resolves.toContain("node-0001");
      console.info(`large-DOM evidence artifact write: ${elapsedMs.toFixed(3)} ms`);
      expect(stableJson({ elapsedMs }).length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
