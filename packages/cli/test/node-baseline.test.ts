import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildTVDoctorReportV1, renderReportJson } from "@tvdoctor/reporters";
import type { TVDoctorIssue } from "@tvdoctor/protocol";
import { compareBaselineFromFiles, createBaselineFromFiles } from "../src/node-baseline.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => {
    await rm(path, { recursive: true, force: true });
  }));
});

function issue(id: string): TVDoctorIssue {
  return {
    id,
    rule: `navigation.${id}`,
    title: `Finding ${id}`,
    description: "A deterministic navigation finding.",
    severity: "high",
    confidence: "deterministic",
    pack: "navigation",
    screen: "home",
    expected: "Focus should move.",
    observed: "Focus did not move.",
    transition: null,
    evidence: [{ kind: "deterministic-failure", summary: "The focus remained unchanged.", source: null, artifact: null }],
    reproduction: { status: "unavailable", reason: "No stable replay was recorded." },
  };
}

function report(runId: string, issues: readonly TVDoctorIssue[]) {
  return buildTVDoctorReportV1({
    run: {
      id: runId,
      tvdoctorVersion: "0.1.0",
      mode: "quick",
      status: "completed",
      startedAt: "2026-09-08T12:00:00.000Z",
      completedAt: "2026-09-08T12:00:01.000Z",
      durationMs: 1_000,
    },
    target: { name: "Fixture", platform: "web", location: "https://example.test/app", environment: {} },
    coverage: {
      screenStatesDiscovered: 1,
      focusStatesDiscovered: 1,
      transitionsTested: 1,
      actionsSent: 1,
      capabilitiesObserved: ["remote-input", "ui-tree"],
      packs: [{ pack: "navigation", status: "completed" }],
      budget: {
        maxActions: 10,
        maxStates: 10,
        maxDepth: 2,
        maxDurationMs: 10_000,
        maxRepetitiveItems: 1,
        exhausted: [],
      },
    },
    issues,
    artifacts: [],
    replays: [],
  });
}

const inventory = {
  status: "complete" as const,
  screens: [{ key: "home", label: "Home" }],
  focusTargets: [{ key: "hero", screenKey: "home", role: "button", name: "Play" }],
  transitions: [],
  latencies: [],
};

describe("baseline file adapter", () => {
  it("creates and compares versioned baseline files without changing issue ordering", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-baseline-cli-"));
    temporaryDirectories.push(root);
    const firstReport = join(root, "first-report.json");
    const currentReport = join(root, "current-report.json");
    const inventoryPath = join(root, "inventory.json");
    const baselinePath = join(root, "baseline.json");
    const comparisonPath = join(root, "comparison.json");
    const known = issue("TVDOCTOR-NAV-KNOWN00000000000000000000001");
    const added = issue("TVDOCTOR-NAV-ADDED00000000000000000000001");
    await writeFile(firstReport, renderReportJson(report("baseline-run", [known])));
    await writeFile(currentReport, renderReportJson(report("current-run", [added, known])));
    await writeFile(inventoryPath, JSON.stringify(inventory));

    await expect(createBaselineFromFiles({
      reportPath: firstReport,
      inventoryPath,
      outputPath: baselinePath,
    })).resolves.toMatchObject({ issueCount: 1, outputPath: baselinePath });
    const compared = await compareBaselineFromFiles({
      baselinePath,
      reportPath: currentReport,
      inventoryPath,
      outputPath: comparisonPath,
    });
    expect(compared).toMatchObject({
      status: "regressed",
      shouldFail: true,
      newIssues: 1,
      resolvedIssues: 0,
      unchangedIssues: 1,
    });
    expect(JSON.parse(await readFile(comparisonPath, "utf8"))).toMatchObject({
      schemaVersion: "tvdoctor.comparison/v1",
      status: "regressed",
    });
  });

  it("refuses to overwrite a reviewed baseline", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-baseline-no-clobber-"));
    temporaryDirectories.push(root);
    const reportPath = join(root, "report.json");
    const inventoryPath = join(root, "inventory.json");
    const outputPath = join(root, "baseline.json");
    await writeFile(reportPath, renderReportJson(report("baseline-run", [])));
    await writeFile(inventoryPath, JSON.stringify(inventory));
    await writeFile(outputPath, "reviewed");
    await expect(createBaselineFromFiles({ reportPath, inventoryPath, outputPath }))
      .rejects.toMatchObject({ code: "EEXIST" });
    await expect(readFile(outputPath, "utf8")).resolves.toBe("reviewed");
  });
});
