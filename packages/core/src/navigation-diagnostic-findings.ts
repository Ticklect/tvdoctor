import type {
  RemoteKey,
  ResetStrategy,
  TVDoctorIssue,
} from "@tvdoctor/protocol";
import type { ExplorationResult } from "./explorer-contracts.js";
import type { ExplorationActionAttempt } from "./graph.js";
import type {
  NavigationDiagnosticClassification,
  NavigationDiagnosticRule,
  NavigationDiagnosticSource,
  NavigationDiagnosticSourceKind,
  NavigationDiagnosticTarget,
  NavigationElementMetadata,
} from "./navigation-diagnostic-contracts.js";
import { focusedTarget, metadataForTarget } from "./navigation-diagnostic-context.js";

export interface FindingCandidate {
  readonly classification: NavigationDiagnosticClassification;
  readonly issue: TVDoctorIssue;
  readonly source: NavigationDiagnosticSource;
  readonly target: NavigationDiagnosticTarget;
}

export type FindingCandidateAppender = (candidate: FindingCandidate) => void;

export interface NavigationRuleContext {
  readonly result: ExplorationResult;
  readonly resetStrategy: ResetStrategy;
  readonly append: FindingCandidateAppender;
}

export function elementLabel(element: NavigationElementMetadata | null): string | null {
  if (element === null) return null;
  const stableId = element.stableId?.trim();
  if (stableId !== undefined && stableId.length > 0) return stableId;
  const name = element.name?.trim();
  if (name !== undefined && name.length > 0) return name;
  const role = element.role?.trim();
  return role !== undefined && role.length > 0 ? role : null;
}

export function sequenceSteps(sequence: readonly RemoteKey[]): TVDoctorIssue["reproduction"] {
  const steps: { key: RemoteKey; repeat: number }[] = [];
  for (const key of sequence) {
    const previous = steps.at(-1);
    if (previous?.key === key) {
      previous.repeat += 1;
    } else {
      steps.push({ key, repeat: 1 });
    }
  }
  return {
    status: "available",
    resetStrategy: "reload",
    originalSequence: steps,
    minimizedSequence: null,
    confidence: "deterministic",
    artifact: null,
  };
}

export function reproduction(
  sequence: readonly RemoteKey[],
  classification: NavigationDiagnosticClassification,
  resetStrategy: ResetStrategy,
): TVDoctorIssue["reproduction"] {
  const base = sequenceSteps(sequence);
  if (base.status !== "available") return base;
  return {
    ...base,
    resetStrategy,
    confidence: classification === "deterministic" ? "deterministic" : "best-effort",
  };
}

export function issue(
  rule: NavigationDiagnosticRule,
  classification: NavigationDiagnosticClassification,
  severity: TVDoctorIssue["severity"],
  title: string,
  description: string,
  screenStateId: string,
  expected: string,
  observed: string,
  transition: TVDoctorIssue["transition"],
  sequence: readonly RemoteKey[],
  evidenceSummary: string,
  evidenceSource: string | null,
  resetStrategy: ResetStrategy,
  additionalEvidence: TVDoctorIssue["evidence"] = [],
): TVDoctorIssue {
  return {
    id: "TVDOCTOR-NAV-PENDING",
    rule,
    title,
    description,
    severity,
    confidence: classification,
    pack: "navigation",
    screen: screenStateId,
    expected,
    observed,
    transition,
    evidence: [
      {
        kind: classification === "deterministic" ? "deterministic-failure" : "heuristic-warning",
        summary: evidenceSummary,
        source: evidenceSource,
        artifact: null,
      },
      ...additionalEvidence,
    ],
    reproduction: reproduction(sequence, classification, resetStrategy),
  };
}

export function actionSource(
  attempt: ExplorationActionAttempt,
  kind: NavigationDiagnosticSourceKind = "action-attempt",
  relatedActionAttemptId: string | null = null,
  locallyComplete: boolean | null = null,
): NavigationDiagnosticSource {
  const sourceTarget = focusedTarget(attempt.beforeSnapshot);
  return {
    kind,
    screenStateId: attempt.fromScreenStateId,
    focusStateId: attempt.fromFocusStateId,
    element: sourceTarget === null ? null : metadataForTarget(sourceTarget),
    actionAttemptId: attempt.id,
    relatedActionAttemptId,
    actionSequence: attempt.actionSequence,
    locallyComplete,
  };
}

export function diagnosticTarget(
  screenStateId: string,
  focusStateId: string | null,
  element: NavigationElementMetadata | null,
  expectedElement: NavigationElementMetadata | null,
  observedElement: NavigationElementMetadata | null,
): NavigationDiagnosticTarget {
  return {
    screenStateId,
    focusStateId,
    element,
    expectedElement,
    observedElement,
  };
}
