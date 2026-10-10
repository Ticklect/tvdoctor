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

const DIRECTIONAL_KEYS: ReadonlySet<string> = new Set(["UP", "DOWN", "LEFT", "RIGHT"]);

export function navigationIssues(report: TVDoctorReportV1): readonly TVDoctorIssue[] {
  return report.issues.filter((issue) => issue.pack === "navigation" || issue.transition !== null);
}

export function directionalNavigationIssues(report: TVDoctorReportV1): readonly TVDoctorIssue[] {
  return navigationIssues(report).filter((issue) => (
    issue.transition !== null && DIRECTIONAL_KEYS.has(issue.transition.action)
  ));
}

export function currentRunReferenceLabel(
  issue: TVDoctorIssue,
  subject: "behavior" | "target",
): string {
  if (issue.confidence === "heuristic") {
    return `Candidate ${subject} (heuristic; not a confirmed product expectation)`;
  }
  if (issue.confidence === "inference") {
    return `Candidate ${subject} (inferred; not a confirmed product expectation)`;
  }
  if (issue.confidence === "unobservable") {
    return `Reference ${subject} (unverified)`;
  }
  return `Reference ${subject}`;
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

export function availableRunArtifactPath(
  report: TVDoctorReportV1,
  id: string,
): string | null {
  const artifact = report.artifacts.find((candidate) => candidate.id === id);
  return artifact?.status === "available" ? artifact.path : null;
}

/**
 * Conservative product impact copy derived only from evidence class/rule.
 * It intentionally avoids guessing application intent, accessibility support,
 * or physical-device behaviour that the run did not establish.
 */
export function findingImpactStatement(issue: TVDoctorIssue): string {
  if (issue.rule === "remote.startup-blocker" || issue.confidence === "unobservable") {
    return "This check did not produce enough observable evidence, so absence of a stronger finding must not be treated as a pass.";
  }
  if (issue.confidence === "heuristic" || issue.confidence === "inference") {
    return "This observed pattern can indicate inconsistent remote navigation, but the report does not establish the product's intended focus behaviour; review it against the intended navigation model.";
  }
  if (issue.pack === "navigation" || issue.transition !== null) {
    return "The recorded remote-navigation path did not match the report's evidence-backed reference behaviour, which can make the tested control path unreliable for D-pad use within the observed coverage.";
  }
  return "The recorded observation differs from the report's evidence-backed reference behaviour and should be reviewed before relying on this tested path.";
}

export function reproductionTimeline(issue: TVDoctorIssue): readonly string[] {
  if (issue.reproduction.status !== "available") {
    return [`Reproduction unavailable: ${issue.reproduction.reason}`];
  }
  const inputs = issue.reproduction.originalSequence.map((step) => (
    step.repeat === 1 ? step.key : `${step.key} × ${String(step.repeat)}`
  ));
  const assertion = issue.transition === null
    ? []
    : [`Assertion: ${issue.transition.fromElement ?? "unobserved"} + ${issue.transition.action} → expected ${issue.transition.expectedElement ?? "unobserved"}; observed ${issue.transition.observedElement ?? "unobserved"}.`];
  return [
    `Reset: ${issue.reproduction.resetStrategy}`,
    ...inputs.map((input) => `Input: ${input}`),
    ...assertion,
  ];
}

export function artifactHref(path: string): string {
  return path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

export type FindingActionability = "VERIFIED" | "REVIEW" | "UNTESTED";

export type NavigationCoverageStatus = "available" | "partial" | "unavailable";

export function findingActionability(issue: TVDoctorIssue): FindingActionability {
  if (issue.severity === "info" || issue.rule === "remote.startup-blocker" || issue.confidence === "unobservable") {
    return "UNTESTED";
  }
  if (issue.confidence === "deterministic"
    && issue.evidence.some((evidence) => evidence.kind === "deterministic-failure")
    && issue.reproduction.status === "available"
    && issue.reproduction.confidence === "deterministic") {
    return "VERIFIED";
  }
  return "REVIEW";
}

export function actionabilityCounts(
  report: TVDoctorReportV1,
): Readonly<Record<FindingActionability, number>> {
  return {
    VERIFIED: report.issues.filter((issue) => findingActionability(issue) === "VERIFIED").length,
    REVIEW: report.issues.filter((issue) => findingActionability(issue) === "REVIEW").length,
    UNTESTED: report.issues.filter((issue) => findingActionability(issue) === "UNTESTED").length,
  };
}

export function navigationCoverageStatus(report: TVDoctorReportV1): NavigationCoverageStatus {
  const navigationPack = report.coverage.packs.find((pack) => pack.pack === "navigation");
  if (navigationPack === undefined || report.coverage.transitionsTested === 0) return "unavailable";
  return navigationPack.status === "completed" ? "available" : "partial";
}

export function navigationCoverageStatement(report: TVDoctorReportV1): string {
  switch (navigationCoverageStatus(report)) {
    case "available":
      return `Navigation coverage available: ${String(report.coverage.transitionsTested)} remote transitions tested.`;
    case "partial":
      return `Navigation coverage partial: ${String(report.coverage.transitionsTested)} remote transitions tested before the run stopped.`;
    case "unavailable":
      return "Navigation coverage unavailable: no remote transitions were tested. This run cannot certify D-pad navigation.";
  }
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
