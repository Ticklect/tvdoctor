import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

import { createNodeAuditOperation } from "../src/node-audit.js";

test("navigation explores sibling routes after restoring the launch URL in the same tab", async ({ baseURL }) => {
  if (baseURL === undefined) throw new Error("Missing Northstar fixture URL");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "tvdoctor-route-restore-"));
  try {
    const result = await createNodeAuditOperation()({
      target: new URL("/route-navigation.html", baseURL).toString(),
      packs: ["navigation"],
      mode: "standard",
      outputPath: join(temporaryRoot, "bundle"),
      searchQuery: "N",
      maxDurationMs: 75_000,
      navigationBudgets: { maxActions: 300, maxStates: 40, maxDepth: 12 },
      disableRepetitionCompression: true,
      screenshots: false,
      targetRedaction: "origin",
    });
    const ledger = JSON.parse(await readFile(join(temporaryRoot, "bundle", "stage-ledger.json"), "utf8")) as {
      navigation: {
        termination: { reason: string };
        statistics: { screenStates: number };
      } | null;
    };
    const graph = JSON.parse(await readFile(join(temporaryRoot, "bundle", "navigation-graph.json"), "utf8")) as {
      screens: { shortestKnownPath: readonly string[] }[];
    };
    const report = JSON.parse(await readFile(join(temporaryRoot, "bundle", "report.json"), "utf8")) as {
      coverage: { budget: { maxRepetitiveItems: number | null } };
    };

    expect(result.status, result.details.join("\n")).not.toBe("failed");
    expect(report.coverage.budget.maxRepetitiveItems).toBeNull();
    expect(ledger.navigation?.termination.reason).not.toBe("prepared-state-diverged");
    expect(ledger.navigation?.statistics.screenStates).toBeGreaterThanOrEqual(3);
    expect(graph.screens).toEqual(expect.arrayContaining([
      expect.objectContaining({ shortestKnownPath: [] }),
    ]));
    // Search and Settings require independent SELECT actions from the Home rail.
    expect(graph.screens.some((screen) => screen.shortestKnownPath.includes("SELECT"))).toBe(true);
    expect(graph.screens.filter((screen) => screen.shortestKnownPath.includes("SELECT")).length)
      .toBeGreaterThanOrEqual(2);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
