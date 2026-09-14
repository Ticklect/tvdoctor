import type { TVDoctorIssue, TVDoctorReportV1 } from "@tvdoctor/protocol";

import { replayCommand } from "./render-helpers.js";

export type FindingWorkflowState =
  | "verified-replay-ready"
  | "verified-replay-unavailable"
  | "needs-review"
  | "setup-info";

export interface FindingWorkflow {
  readonly state: FindingWorkflowState;
  readonly label:
    | "Verified · Replay ready"
    | "Verified · Replay unavailable"
    | "Needs review"
    | "Setup / info";
  readonly replayCommand: string | null;
  readonly reason: string | null;
}

function hasDeterministicReplay(report: TVDoctorReportV1, issue: TVDoctorIssue): boolean {
  return issue.confidence === "deterministic"
    && issue.reproduction.status === "available"
    && issue.reproduction.confidence === "deterministic"
    && report.replays.some((replay) => replay.issueId === issue.id);
}

function hasDeterministicFailureEvidence(issue: TVDoctorIssue): boolean {
  return issue.evidence.some((evidence) => evidence.kind === "deterministic-failure");
}

export function findingWorkflow(
  report: TVDoctorReportV1,
  issue: TVDoctorIssue,
): FindingWorkflow {
  if (issue.severity === "info" || issue.rule === "remote.startup-blocker") {
    return {
      state: "setup-info",
      label: "Setup / info",
      replayCommand: null,
      reason: "This finding describes setup, coverage, or informational state rather than a replay-ready code defect.",
    };
  }

  if (issue.confidence !== "deterministic") {
    return {
      state: "needs-review",
      label: "Needs review",
      replayCommand: null,
      reason: `The finding confidence is ${issue.confidence}; deterministic failure evidence is required before fix-task automation.`,
    };
  }

  if (hasDeterministicReplay(report, issue) && hasDeterministicFailureEvidence(issue)) {
    return {
      state: "verified-replay-ready",
      label: "Verified · Replay ready",
      replayCommand: replayCommand(report, issue.id),
      reason: null,
    };
  }

  return {
    state: "verified-replay-unavailable",
    label: "Verified · Replay unavailable",
    replayCommand: null,
    reason: hasDeterministicFailureEvidence(issue)
      ? "The failure is deterministic, but a complete portable deterministic replay was not embedded."
      : "The observation is deterministic, but deterministic-failure evidence is incomplete for a replay-ready fix task.",
  };
}
