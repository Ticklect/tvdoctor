import type { ResetStrategy } from "./driver.js";
import type { RemoteKey } from "./remote-key.js";

export const ISSUE_SEVERITIES = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
] as const;

export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];

const ISSUE_SEVERITY_SET: ReadonlySet<string> = new Set(ISSUE_SEVERITIES);

export function isIssueSeverity(value: unknown): value is IssueSeverity {
  return typeof value === "string" && ISSUE_SEVERITY_SET.has(value);
}

export const ISSUE_CONFIDENCES = [
  "deterministic",
  "heuristic",
  "inference",
  "unobservable",
] as const;

export type IssueConfidence = (typeof ISSUE_CONFIDENCES)[number];

const ISSUE_CONFIDENCE_SET: ReadonlySet<string> = new Set(ISSUE_CONFIDENCES);

export function isIssueConfidence(value: unknown): value is IssueConfidence {
  return typeof value === "string" && ISSUE_CONFIDENCE_SET.has(value);
}

export const EVIDENCE_KINDS = [
  "verified-fact",
  "deterministic-failure",
  "heuristic-warning",
  "inference",
  "unobservable",
] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

const EVIDENCE_KIND_SET: ReadonlySet<string> = new Set(EVIDENCE_KINDS);

export function isEvidenceKind(value: unknown): value is EvidenceKind {
  return typeof value === "string" && EVIDENCE_KIND_SET.has(value);
}

export interface IssueEvidence {
  readonly kind: EvidenceKind;
  readonly summary: string;
  readonly source: string | null;
  readonly artifact: string | null;
}

export interface NavigationTransitionEvidence {
  readonly fromElement: string | null;
  readonly action: RemoteKey;
  readonly expectedElement: string | null;
  readonly observedElement: string | null;
}

export interface RemotePressStep {
  readonly key: RemoteKey;
  readonly repeat: number;
}

export const REPRODUCTION_CONFIDENCES = [
  "deterministic",
  "best-effort",
] as const;

export type ReproductionConfidence =
  (typeof REPRODUCTION_CONFIDENCES)[number];

export interface AvailableRemoteReproduction {
  readonly status: "available";
  readonly resetStrategy: ResetStrategy;
  readonly originalSequence: readonly RemotePressStep[];
  readonly minimizedSequence: readonly RemotePressStep[] | null;
  readonly confidence: ReproductionConfidence;
  readonly artifact: string | null;
}

export interface UnavailableRemoteReproduction {
  readonly status: "unavailable";
  readonly reason: string;
}

export type RemoteReproduction =
  | AvailableRemoteReproduction
  | UnavailableRemoteReproduction;

export interface TVDoctorIssue {
  readonly id: string;
  readonly rule: string;
  readonly title: string;
  readonly description: string;
  readonly severity: IssueSeverity;
  readonly confidence: IssueConfidence;
  readonly pack: string;
  readonly screen: string | null;
  readonly expected: string;
  readonly observed: string;
  readonly transition: NavigationTransitionEvidence | null;
  readonly evidence: readonly IssueEvidence[];
  readonly reproduction: RemoteReproduction;
}
