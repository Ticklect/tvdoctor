import {
  COVERAGE_BUDGETS,
  EVIDENCE_KINDS,
  ISSUE_SEVERITIES,
  REPORT_SCHEMA_VERSION_V1,
  parseTVDoctorReportV1,
  type ArtifactDescriptor,
  type Capability,
  type IssueEvidence,
  type NavigationTransitionEvidence,
  type RemoteReproduction,
  type ReportCoverageSummary,
  type ReportRunSummary,
  type ReportTargetSummary,
  type TVDoctorIssue,
  type TVDoctorReplayV1,
  type TVDoctorReportV1,
} from "@tvdoctor/protocol";
import {
  isSensitiveEnvironmentKey,
  sanitiseTargetLocation,
  sanitiseUntrustedText,
} from "./security.js";
import { stableJson, type JsonValue } from "./stable-json.js";

export interface TVDoctorReportV1Input {
  readonly run: ReportRunSummary;
  readonly target: ReportTargetSummary;
  readonly coverage: ReportCoverageSummary;
  readonly issues: readonly TVDoctorIssue[];
  readonly artifacts?: readonly ArtifactDescriptor[];
  readonly replays?: readonly TVDoctorReplayV1[];
}

const SEVERITY_ORDER = new Map(ISSUE_SEVERITIES.map((severity, index) => [severity, index]));
const BUDGET_ORDER = new Map(COVERAGE_BUDGETS.map((budget, index) => [budget, index]));
const EVIDENCE_ORDER = new Map(EVIDENCE_KINDS.map((kind, index) => [kind, index]));
const PROTOTYPE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function requiredText(value: string, fallback = "[REDACTED]"): string {
  const safe = sanitiseUntrustedText(value);
  return safe.length === 0 ? fallback : safe;
}

function nullableText(value: string | null): string | null {
  if (value === null) return null;
  const safe = sanitiseUntrustedText(value);
  return safe.length === 0 ? null : safe;
}

function normaliseTransition(
  transition: NavigationTransitionEvidence | null,
): NavigationTransitionEvidence | null {
  if (transition === null) return null;
  return {
    fromElement: nullableText(transition.fromElement),
    action: transition.action,
    expectedElement: nullableText(transition.expectedElement),
    observedElement: nullableText(transition.observedElement),
  };
}

function normaliseEvidence(evidence: IssueEvidence): IssueEvidence {
  return {
    kind: evidence.kind,
    summary: requiredText(evidence.summary),
    source: nullableText(evidence.source),
    artifact: evidence.artifact,
  };
}

function normaliseReproduction(reproduction: RemoteReproduction): RemoteReproduction {
  if (reproduction.status === "unavailable") {
    return { status: "unavailable", reason: requiredText(reproduction.reason) };
  }
  return {
    status: "available",
    resetStrategy: reproduction.resetStrategy,
    originalSequence: reproduction.originalSequence.map((step) => ({ ...step })),
    minimizedSequence: reproduction.minimizedSequence?.map((step) => ({ ...step })) ?? null,
    confidence: reproduction.confidence,
    artifact: reproduction.artifact,
  };
}

function normaliseIssue(issue: TVDoctorIssue): TVDoctorIssue {
  return {
    id: issue.id,
    rule: issue.rule,
    title: requiredText(issue.title),
    description: requiredText(issue.description),
    severity: issue.severity,
    confidence: issue.confidence,
    pack: issue.pack,
    screen: nullableText(issue.screen),
    expected: requiredText(issue.expected),
    observed: requiredText(issue.observed),
    transition: normaliseTransition(issue.transition),
    evidence: issue.evidence
      .map((entry) => normaliseEvidence(entry))
      .sort((left, right) => (
        (EVIDENCE_ORDER.get(left.kind) ?? 99) - (EVIDENCE_ORDER.get(right.kind) ?? 99)
        || compareText(left.source ?? "", right.source ?? "")
        || compareText(left.artifact ?? "", right.artifact ?? "")
        || compareText(left.summary, right.summary)
      )),
    reproduction: normaliseReproduction(issue.reproduction),
  };
}

function normaliseEnvironment(
  environment: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const result = Object.create(null) as Record<string, string>;
  for (const [rawKey, rawValue] of Object.entries(environment).sort(([left], [right]) => compareText(left, right))) {
    const key = requiredText(rawKey);
    if (PROTOTYPE_KEYS.has(key)) {
      throw new TypeError("Environment cannot contain prototype-sensitive keys.");
    }
    if (Object.hasOwn(result, key)) throw new TypeError("Environment keys collide after sanitisation.");
    result[key] = isSensitiveEnvironmentKey(key) ? "[REDACTED]" : sanitiseUntrustedText(rawValue);
  }
  return result;
}

function normaliseTarget(target: ReportTargetSummary): ReportTargetSummary {
  return {
    name: requiredText(target.name),
    platform: target.platform,
    location: requiredText(sanitiseTargetLocation(target.location)),
    environment: normaliseEnvironment(target.environment),
  };
}

function normaliseCoverage(coverage: ReportCoverageSummary): ReportCoverageSummary {
  const capabilities = [...coverage.capabilitiesObserved]
    .sort((left, right) => compareText(left, right)) as Capability[];
  return {
    screenStatesDiscovered: coverage.screenStatesDiscovered,
    focusStatesDiscovered: coverage.focusStatesDiscovered,
    transitionsTested: coverage.transitionsTested,
    actionsSent: coverage.actionsSent,
    capabilitiesObserved: capabilities,
    packs: [...coverage.packs]
      .map((pack) => ({ ...pack }))
      .sort((left, right) => compareText(left.pack, right.pack)),
    budget: {
      ...coverage.budget,
      exhausted: [...coverage.budget.exhausted]
        .sort((left, right) => (BUDGET_ORDER.get(left) ?? 99) - (BUDGET_ORDER.get(right) ?? 99)),
    },
  };
}

function normaliseArtifact(artifact: ArtifactDescriptor): ArtifactDescriptor {
  if (artifact.status === "available") return { ...artifact };
  return { ...artifact, reason: requiredText(artifact.reason) };
}

function normaliseReplay(replay: TVDoctorReplayV1): TVDoctorReplayV1 {
  return {
    schemaVersion: replay.schemaVersion,
    id: replay.id,
    issueId: replay.issueId,
    reset: { ...replay.reset },
    steps: replay.steps.map((step) => ({ ...step })),
    assertion: {
      ...replay.assertion,
      fromElement: nullableText(replay.assertion.fromElement),
      expectedElement: nullableText(replay.assertion.expectedElement),
      observedElement: nullableText(replay.assertion.observedElement),
    },
  };
}

function stepsMatch(
  left: readonly { readonly key: string; readonly repeat: number }[],
  right: readonly { readonly key: string; readonly repeat: number }[],
): boolean {
  return left.length === right.length && left.every((step, index) => {
    const other = right[index];
    return other !== undefined && step.key === other.key && step.repeat === other.repeat;
  });
}

function assertReportCrossLinks(report: TVDoctorReportV1): void {
  const availableByPath = new Map<string, ArtifactDescriptor>();
  for (const artifact of report.artifacts) {
    if (artifact.status !== "available") continue;
    if (availableByPath.has(artifact.path)) {
      throw new TypeError(`Multiple available artifacts use path ${artifact.path}.`);
    }
    availableByPath.set(artifact.path, artifact);
  }

  for (const issue of report.issues) {
    for (const evidence of issue.evidence) {
      if (evidence.artifact !== null && !availableByPath.has(evidence.artifact)) {
        throw new TypeError(`Issue ${issue.id} references missing evidence artifact ${evidence.artifact}.`);
      }
    }
    if (issue.reproduction.status === "available" && issue.reproduction.artifact !== null) {
      const artifact = availableByPath.get(issue.reproduction.artifact);
      if (artifact === undefined || artifact.kind !== "replay") {
        throw new TypeError(`Issue ${issue.id} references a missing or non-replay reproduction artifact.`);
      }
    }

    const replays = report.replays.filter((replay) => replay.issueId === issue.id);
    if (replays.length > 1) throw new TypeError(`Issue ${issue.id} has multiple embedded replays.`);
    const replay = replays[0];
    if (replay === undefined) continue;
    if (issue.reproduction.status !== "available") {
      throw new TypeError(`Issue ${issue.id} has an embedded replay but reproduction is unavailable.`);
    }
    if (!stepsMatch(replay.steps, issue.reproduction.originalSequence)) {
      throw new TypeError(`Issue ${issue.id} replay steps do not match its original reproduction sequence.`);
    }
    if (replay.reset.strategy !== issue.reproduction.resetStrategy) {
      throw new TypeError(`Issue ${issue.id} replay reset strategy does not match its reproduction.`);
    }
    const transition = issue.transition;
    if (transition === null
      || replay.assertion.action !== transition.action
      || replay.assertion.fromElement !== transition.fromElement
      || replay.assertion.expectedElement !== transition.expectedElement
      || replay.assertion.observedElement !== transition.observedElement) {
      throw new TypeError(`Issue ${issue.id} replay assertion does not match its transition evidence.`);
    }
  }
}

/** Validate the protocol shape plus reporter-owned artifact/replay cross-links. */
export function validateTVDoctorReportV1(report: TVDoctorReportV1): TVDoctorReportV1 {
  const valid = parseTVDoctorReportV1(report);
  assertReportCrossLinks(valid);
  return valid;
}

export function buildTVDoctorReportV1(input: TVDoctorReportV1Input): TVDoctorReportV1 {
  const report: TVDoctorReportV1 = {
    schemaVersion: REPORT_SCHEMA_VERSION_V1,
    run: {
      ...input.run,
      tvdoctorVersion: requiredText(input.run.tvdoctorVersion),
    },
    target: normaliseTarget(input.target),
    coverage: normaliseCoverage(input.coverage),
    issues: input.issues
      .map((issue) => normaliseIssue(issue))
      .sort((left, right) => (
        (SEVERITY_ORDER.get(left.severity) ?? 99) - (SEVERITY_ORDER.get(right.severity) ?? 99)
        || compareText(left.rule, right.rule)
        || compareText(left.id, right.id)
      )),
    artifacts: [...(input.artifacts ?? [])]
      .map((artifact) => normaliseArtifact(artifact))
      .sort((left, right) => compareText(left.id, right.id) || compareText(left.kind, right.kind)),
    replays: [...(input.replays ?? [])]
      .map((replay) => normaliseReplay(replay))
      .sort((left, right) => compareText(left.issueId, right.issueId) || compareText(left.id, right.id)),
  };
  return validateTVDoctorReportV1(report);
}

/**
 * Validate caller-owned report data, then rebuild it into a fresh, canonical,
 * redacted model suitable for any public output boundary.
 */
export function sanitiseReportForOutput(report: TVDoctorReportV1): TVDoctorReportV1 {
  const valid = validateTVDoctorReportV1(report);
  return buildTVDoctorReportV1({
    run: valid.run,
    target: valid.target,
    coverage: valid.coverage,
    issues: valid.issues,
    artifacts: valid.artifacts,
    replays: valid.replays,
  });
}

export function renderReportJson(report: TVDoctorReportV1): string {
  const safe = sanitiseReportForOutput(report);
  return stableJson(safe as unknown as JsonValue);
}
