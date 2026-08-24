import {
  ISSUE_SEVERITIES,
  type ArtifactDescriptor,
  type RemotePressStep,
  type TVDoctorIssue,
  type TVDoctorReportV1,
} from "@tvdoctor/protocol";
import { issueOwnsArtifactId, sanitiseReportForOutput } from "./report-builder.js";

export function validReport(report: TVDoctorReportV1): TVDoctorReportV1 {
  return sanitiseReportForOutput(report);
}

export function issueCounts(report: TVDoctorReportV1): Readonly<Record<string, number>> {
  return Object.fromEntries(ISSUE_SEVERITIES.map((severity) => [
    severity,
    report.issues.filter((issue) => issue.severity === severity).length,
  ]));
}

export function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${String(durationMs)} ms`;
  const seconds = durationMs / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 1 : 2)} s`;
  return `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(1)}s`;
}

export function formatRemoteSequence(steps: readonly RemotePressStep[]): string {
  if (steps.length === 0) return "No remote input required.";
  return steps.map((step) => step.repeat === 1 ? step.key : `${step.key} × ${String(step.repeat)}`).join(" → ");
}

export function replayTargetOverrideRequired(report: TVDoctorReportV1): boolean {
  return report.target.environment["replayTargetOverride"] === "required";
}

export function replayCommand(report: TVDoctorReportV1, issueId: string): string {
  const base = `tvdoctor replay ${issueId}`;
  return replayTargetOverrideRequired(report)
    ? `${base} --target <ORIGINAL_URL>`
    : base;
}

export function artifactsForIssue(
  report: TVDoctorReportV1,
  issue: TVDoctorIssue,
): readonly ArtifactDescriptor[] {
  return report.artifacts.filter((artifact) => issueOwnsArtifactId(issue.id, artifact.id));
}

export function availableArtifactPath(
  artifacts: readonly ArtifactDescriptor[],
  suffix: string,
): string | null {
  const artifact = artifacts.find((candidate) => candidate.id.endsWith(`:${suffix}`));
  return artifact?.status === "available" ? artifact.path : null;
}

export function artifactHref(path: string): string {
  return path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}
