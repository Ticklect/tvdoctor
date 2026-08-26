import {
  type CoverageBudget,
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
  const base = `tvdoctor replay ${issueId} --report report.json`;
  return replayTargetOverrideRequired(report)
    ? `${base} --target <ORIGINAL_URL>`
    : base;
}

export function hasDeterministicCliReplay(
  report: TVDoctorReportV1,
  issue: TVDoctorIssue,
): boolean {
  return issue.confidence === "deterministic"
    && issue.reproduction.status === "available"
    && issue.reproduction.confidence === "deterministic"
    && report.replays.some((replay) => replay.issueId === issue.id);
}

function packDurationContext(pack: string): string {
  if (pack === "navigation") return "Navigation exploration";
  const knownPackNames: Readonly<Record<string, string>> = {
    accessibility: "Accessibility exploration",
    crashes: "Crash observation",
    layout: "Layout exploration",
    navigation: "Navigation exploration",
    performance: "Performance exploration",
    search: "Search exploration",
    settings: "Settings exploration",
    streaming: "Streaming journey",
    web: "Web diagnostics",
  };
  return knownPackNames[pack] ?? `${pack} pack`;
}

export function exhaustedBudgetReason(
  report: TVDoctorReportV1,
  budget: CoverageBudget,
): string {
  if (budget !== "duration") {
    return `${budget.slice(0, 1).toUpperCase()}${budget.slice(1)} budget exhausted.`;
  }
  const context = report.coverage.packs.length === 0
    ? "Duration"
    : [...report.coverage.packs]
        .map((pack) => packDurationContext(pack.pack))
        .sort((left, right) => left.localeCompare(right))
        .join(" and ")
      + " duration";
  const maximum = report.coverage.budget.maxDurationMs;
  return maximum === null
    ? `${context} budget exhausted.`
    : `${context} budget exhausted: ${String(maximum / 1_000)} seconds.`;
}

export function exhaustedBudgetReasons(report: TVDoctorReportV1): readonly string[] {
  return report.coverage.budget.exhausted.map((budget) => exhaustedBudgetReason(report, budget));
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

export type FindingActionability = "FIX NOW" | "REVIEW" | "SETUP / INFO";

export function findingActionability(issue: TVDoctorIssue): FindingActionability {
  if (issue.severity === "info" || issue.rule === "remote.startup-blocker") return "SETUP / INFO";
  if (issue.confidence === "deterministic"
    && (issue.severity === "critical" || issue.severity === "high" || issue.severity === "medium")) {
    return "FIX NOW";
  }
  return "REVIEW";
}

export interface IssuePatternSummary {
  readonly rule: string;
  readonly label: string;
  readonly count: number;
  readonly stateCount: number;
  readonly issueIds: readonly string[];
}

export function issuePatterns(report: TVDoctorReportV1): readonly IssuePatternSummary[] {
  const groups = new Map<string, TVDoctorIssue[]>();
  for (const issue of report.issues) {
    const group = groups.get(issue.rule) ?? [];
    group.push(issue);
    groups.set(issue.rule, group);
  }
  return [...groups.entries()]
    .map(([rule, issues]) => ({
      rule,
      label: rule.replace(/^remote\./u, "").replaceAll("-", " "),
      count: issues.length,
      stateCount: new Set(issues.map((issue) => issue.screen ?? "unobserved")).size,
      issueIds: issues.map((issue) => issue.id),
    }))
    .filter((group) => group.count > 1)
    .sort((left, right) => right.count - left.count || left.rule.localeCompare(right.rule));
}
