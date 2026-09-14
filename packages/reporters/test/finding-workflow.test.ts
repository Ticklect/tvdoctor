import { describe, expect, it } from "vitest";

import { buildTVDoctorReportV1, findingWorkflow } from "../src/index.js";
import { sampleIssue, sampleReportInput } from "./sample.js";

function reportWith(issue = sampleIssue(), includeReplay = true) {
  const input = sampleReportInput();
  return buildTVDoctorReportV1({
    ...input,
    issues: [issue],
    replays: includeReplay ? input.replays : [],
  });
}

describe("finding workflow", () => {
  it("marks a deterministic failure with failure evidence and embedded replay as replay ready", () => {
    expect(findingWorkflow(reportWith(), sampleIssue())).toMatchObject({
      state: "verified-replay-ready",
      label: "Verified · Replay ready",
    });
  });

  it("keeps a deterministic failure verified when its replay is unavailable", () => {
    const issue = sampleIssue();
    const report = reportWith(issue, false);
    expect(findingWorkflow(report, issue)).toMatchObject({
      state: "verified-replay-unavailable",
      label: "Verified · Replay unavailable",
      replayCommand: null,
    });
  });

  it("does not claim replay readiness without deterministic-failure evidence", () => {
    const issue = { ...sampleIssue(), evidence: [] };
    expect(findingWorkflow(reportWith(issue), issue)).toMatchObject({
      state: "verified-replay-unavailable",
      label: "Verified · Replay unavailable",
      replayCommand: null,
    });
  });

  it("classifies non-deterministic findings as needs review", () => {
    const issue = { ...sampleIssue(), confidence: "heuristic" as const };
    expect(findingWorkflow(reportWith(issue), issue)).toMatchObject({
      state: "needs-review",
      label: "Needs review",
    });
  });

  it("classifies info and startup-blocker findings as setup/info", () => {
    const info = sampleIssue("TVDOCTOR-NAV-11111111111111111111111111111111", "info");
    expect(findingWorkflow(reportWith(info), info).state).toBe("setup-info");

    const blocker = {
      ...sampleIssue("TVDOCTOR-NAV-22222222222222222222222222222222"),
      rule: "remote.startup-blocker",
    };
    expect(findingWorkflow(reportWith(blocker), blocker).state).toBe("setup-info");
  });
});
