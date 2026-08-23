import { readFile, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { parseTVDoctorReportJson, type TVDoctorReportV1 } from "@tvdoctor/protocol";
import { createNodeAuditOperation } from "../src/index.js";

interface SeedManifest {
  readonly defects: readonly {
    readonly id: string;
    readonly expectedRule: string;
  }[];
}

interface StageLedger {
  readonly web: {
    readonly status: string;
    readonly stages: readonly {
      readonly stage: string;
      readonly status: string;
      readonly detail: string;
      readonly observations: readonly {
        readonly kind: string;
        readonly status: string;
        readonly detail: string;
      }[];
    }[];
  };
  readonly streaming: {
    readonly status: string;
    readonly stages: readonly {
      readonly stage: string;
      readonly status: string;
      readonly sequence: readonly string[];
    }[];
  };
}

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = resolve(packageDirectory, "../../..");
const artifactRoot = resolve(workspaceDirectory, "artifacts/milestone-7-gate");
const manifestPath = resolve(workspaceDirectory, "fixtures/broken-streaming-web/seeded-defects.json");
const M7_SEEDS = new Set([
  "fixture-card-focus-indicator-weak",
  "fixture-player-settings-clipped",
  "fixture-search-submit-pointer-only",
  "fixture-player-settings-slow-open",
  "fixture-startup-console-error",
]);
const EXPECTED_RULES = [
  "crash.console-error",
  "focus.visibility",
  "layout.viewport-clipping",
  "performance.menu-response",
  "search.remote-flow",
] as const;
const M7_PACKS = [
  "search",
  "settings",
  "accessibility",
  "layout",
  "performance",
  "crashes",
] as const;

function requireBaseURL(baseURL: string | undefined): string {
  if (baseURL === undefined) throw new Error("The M7 fixture URL is required.");
  return baseURL;
}

function availableArtifact(report: TVDoctorReportV1, path: string) {
  return report.artifacts.find((artifact) => artifact.status === "available" && artifact.path === path);
}

test("M7 runs six independent web stages and proves exactly the five remaining fixture seeds", async ({
  baseURL,
}) => {
  test.slow();
  await rm(artifactRoot, { recursive: true, force: true });
  const target = requireBaseURL(baseURL);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as SeedManifest;
  const expectedSeeds = manifest.defects.filter((defect) => M7_SEEDS.has(defect.id));
  expect(expectedSeeds).toHaveLength(5);
  expect(expectedSeeds.map((defect) => defect.expectedRule).sort()).toEqual([...EXPECTED_RULES].sort());

  const result = await createNodeAuditOperation()({
    target,
    packs: M7_PACKS,
    mode: "standard",
    outputPath: artifactRoot,
    searchQuery: "N",
  });
  expect(result.status, result.details.join("\n")).toBe("completed");
  expect(result.issueCount).toBe(5);
  expect(result.highestSeverity).toBe("medium");
  expect(result.reportPath).not.toBeNull();

  const report = parseTVDoctorReportJson(await readFile(result.reportPath ?? "", "utf8"));
  expect(report.schemaVersion).toBe("tvdoctor.report/v1");
  if (report.schemaVersion !== "tvdoctor.report/v1") throw new Error("M7 requires report/v1.");
  expect(report.run.status).toBe("completed");
  expect(report.coverage.packs).toEqual(
    M7_PACKS.map((pack) => ({ pack, status: "completed" }))
      .sort((left, right) => left.pack.localeCompare(right.pack)),
  );
  expect(report.coverage.budget.exhausted).toEqual([]);
  expect(report.issues.map((issue) => issue.rule).sort()).toEqual([...EXPECTED_RULES].sort());
  expect(new Set(report.issues.map((issue) => issue.id)).size).toBe(5);
  expect(report.issues.every((issue) => issue.severity === "medium")).toBe(true);
  expect(report.issues.find((issue) => issue.rule === "focus.visibility")?.confidence).toBe("heuristic");
  expect(report.issues.filter((issue) => issue.rule !== "focus.visibility").every((issue) => (
    issue.confidence === "deterministic"
  ))).toBe(true);
  expect(report.issues.every((issue) => issue.reproduction.status === "unavailable")).toBe(true);
  expect(report.replays).toEqual([]);

  for (const issue of report.issues) {
    const descriptors = report.artifacts.filter((artifact) => artifact.id.startsWith(`${issue.id}:`));
    expect(descriptors, issue.id).toHaveLength(8);
    for (const slot of [
      "before-screenshot",
      "after-screenshot",
      "ui-excerpt",
      "transition",
      "console-log",
      "navigation-path",
    ]) {
      const artifact = descriptors.find((candidate) => candidate.id === `${issue.id}:${slot}`);
      expect(artifact, `${issue.id}:${slot}`).toMatchObject({ status: "available" });
      if (artifact?.status === "available") {
        const metadata = await stat(resolve(artifactRoot, ...artifact.path.split("/")));
        expect(metadata.isFile()).toBe(true);
        expect(metadata.size).toBe(artifact.byteLength);
      }
    }
    expect(descriptors.find((artifact) => artifact.id === `${issue.id}:replay`))
      .toMatchObject({ status: "unavailable" });
    expect(descriptors.find((artifact) => artifact.id === `${issue.id}:trace`))
      .toMatchObject({ status: "unavailable" });
    expect(issue.evidence.every((entry) => entry.artifact !== null)).toBe(true);
    for (const evidence of issue.evidence) {
      expect(availableArtifact(report, evidence.artifact ?? ""), evidence.artifact ?? "missing").toBeDefined();
    }
  }

  for (const file of ["report.html", "report.md", "ai-report.md", "stage-ledger.json", "inventory.json"]) {
    const metadata = await stat(resolve(artifactRoot, file));
    expect(metadata.isFile(), file).toBe(true);
    expect(metadata.size, file).toBeGreaterThan(0);
  }
  const ledger = JSON.parse(await readFile(resolve(artifactRoot, "stage-ledger.json"), "utf8")) as StageLedger;
  expect(ledger.web.status).toBe("complete");
  expect(ledger.web.stages.map((stage) => stage.stage)).toEqual([
    "search",
    "settings",
    "accessibility",
    "layout",
    "performance",
    "crash",
  ]);
  expect(ledger.web.stages.map((stage) => stage.status)).toEqual([
    "failed",
    "passed",
    "failed",
    "failed",
    "failed",
    "failed",
  ]);
  const settings = ledger.web.stages.find((stage) => stage.stage === "settings");
  expect(settings?.detail).toMatch(/without activating ambiguous, destructive, account, or payment/iu);
  const accessibility = ledger.web.stages.find((stage) => stage.stage === "accessibility");
  expect(accessibility?.observations.find((entry) => entry.kind === "accessibility-tree"))
    .toMatchObject({ status: "partial" });
  const streamingSettings = ledger.streaming.stages.find((stage) => stage.stage === "settings");
  expect(streamingSettings?.sequence.at(-1)).toBe("SELECT");
  expect(streamingSettings?.sequence.length).toBeGreaterThan(1);
});
