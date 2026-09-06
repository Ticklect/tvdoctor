import type {
  ElementBounds,
  RemoteKey,
  ResetStrategy,
  TVDoctorIssue,
} from "@tvdoctor/protocol";

export const NAVIGATION_DIAGNOSTIC_RULES = {
  lostFocus: "remote.lost-focus",
  unreachable: "remote.reachability",
  selfLoop: "remote.self-loop",
  focusTrap: "remote.focus-trap",
  consentWall: "remote.consent-wall",
  overlayFocusLeak: "remote.overlay-focus-leak",
  backBehaviour: "remote.back-behaviour",
  unexpectedJump: "remote.unexpected-jump",
} as const;

export type NavigationDiagnosticRule =
  (typeof NAVIGATION_DIAGNOSTIC_RULES)[keyof typeof NAVIGATION_DIAGNOSTIC_RULES];

export type NavigationDiagnosticClassification = "deterministic" | "heuristic";

export type NavigationDiagnosticSourceKind =
  | "action-attempt"
  | "action-pair"
  | "focus-state"
  | "screen-analysis";

/** Platform-neutral element evidence copied from an observed snapshot. */
export interface NavigationElementMetadata {
  readonly stableId: string | null;
  readonly role: string | null;
  readonly name: string | null;
  readonly bounds: ElementBounds | null;
}

export interface NavigationDiagnosticSource {
  readonly kind: NavigationDiagnosticSourceKind;
  readonly screenStateId: string;
  readonly focusStateId: string | null;
  readonly element: NavigationElementMetadata | null;
  readonly actionAttemptId: string | null;
  readonly relatedActionAttemptId: string | null;
  readonly actionSequence: readonly RemoteKey[];
  /** Null when local expansion is not a prerequisite for the rule. */
  readonly locallyComplete: boolean | null;
}

export interface NavigationDiagnosticTarget {
  readonly screenStateId: string;
  readonly focusStateId: string | null;
  /** The control or region implicated by the finding. */
  readonly element: NavigationElementMetadata | null;
  readonly expectedElement: NavigationElementMetadata | null;
  readonly observedElement: NavigationElementMetadata | null;
}

/** A core finding wraps the canonical protocol issue with graph-native evidence. */
export interface NavigationDiagnosticFinding {
  readonly classification: NavigationDiagnosticClassification;
  readonly issue: TVDoctorIssue;
  readonly source: NavigationDiagnosticSource;
  readonly target: NavigationDiagnosticTarget;
}

export interface NavigationDiagnostics {
  readonly findings: readonly NavigationDiagnosticFinding[];
  readonly deterministicFindings: readonly NavigationDiagnosticFinding[];
  readonly heuristicFindings: readonly NavigationDiagnosticFinding[];
}

export interface NavigationDiagnosticOptions {
  readonly resetStrategy?: ResetStrategy;
}
