import type {
  ActionOutcome,
  EvidenceKind,
  FocusTarget,
  RemoteKey,
} from "@tvdoctor/protocol";
import type { ExplorationResult } from "./explorer-contracts.js";
import type { MatchConfidence } from "./fingerprint.js";
import {
  NAVIGATION_DIAGNOSTIC_RULES,
  type NavigationDiagnosticClassification,
  type NavigationDiagnosticFinding,
  type NavigationDiagnostics,
  type NavigationElementMetadata,
} from "./navigation-diagnostics.js";
import { diagnoseNavigation } from "./navigation-diagnostics.js";
import {
  compareText,
  coverageSummary,
  observedCycles,
  shortestKnownPath,
  stableFocusKey,
  stableScreenKey,
  verifiedPathsToFocus,
  type NavigationFocusGraphCoverageSummary,
  type NavigationFocusGraphCycle,
} from "./navigation-focus-graph-analysis.js";

export type {
  NavigationFocusGraphCoverageSummary,
  NavigationFocusGraphCycle,
  NavigationFrontierCategory,
  NavigationFrontierReason,
} from "./navigation-focus-graph-analysis.js";

export const NAVIGATION_FOCUS_GRAPH_VERSION = "tvdoctor.navigation-focus-graph/v1" as const;
export const NAVIGATION_FOCUS_GRAPH_VERSION_V2 = "tvdoctor.navigation-focus-graph/v2" as const;

export const NAVIGATION_FOCUS_GRAPH_ACTIONS = [
  "UP",
  "DOWN",
  "LEFT",
  "RIGHT",
  "SELECT",
  "BACK",
] as const satisfies readonly RemoteKey[];

export type NavigationFocusGraphAction = (typeof NAVIGATION_FOCUS_GRAPH_ACTIONS)[number];

export type NavigationObservationEvidenceClassification =
  | "verified-fact"
  | "unobservable";

export type NavigationFocusObservation =
  | {
    readonly status: "present";
    readonly element: NavigationElementMetadata;
    readonly reason: null;
    readonly evidenceClassification: "verified-fact";
  }
  | {
    readonly status: "missing";
    readonly element: null;
    readonly reason: null;
    readonly evidenceClassification: "verified-fact";
  }
  | {
    readonly status: "unavailable";
    readonly element: null;
    readonly reason: string;
    readonly evidenceClassification: "unobservable";
  };

export interface NavigationFocusGraphScreen {
  /** Stable structural screen fingerprint. */
  readonly key: string;
  readonly confidence: MatchConfidence;
  readonly firstSeenPath: readonly RemoteKey[];
  /** Stable FocusState keys belonging to this structural screen. */
  readonly focusTargetKeys: readonly string[];
}

export interface NavigationFocusGraphTarget {
  /** Stable combined screen/focus fingerprint. */
  readonly key: string;
  readonly screenKey: string;
  readonly focusFingerprint: string;
  readonly confidence: MatchConfidence;
  readonly firstSeenPath: readonly RemoteKey[];
  readonly observation: NavigationFocusObservation;
}

export interface NavigationFocusGraphTransition {
  /** Stable semantic edge key; repeated observations of the same edge are collapsed. */
  readonly key: string;
  readonly fromScreenKey: string;
  readonly fromFocusTargetKey: string;
  readonly action: NavigationFocusGraphAction;
  /** Null only when the observed destination was not registered, for example at a state budget edge. */
  readonly toScreenKey: string | null;
  readonly toFocusTargetKey: string | null;
  readonly observedScreenKey: string;
  readonly observedFocusTargetKey: string;
  readonly outcome: ActionOutcome;
  /** Exact root-to-observation remote sequence. */
  readonly reproductionPath: readonly RemoteKey[];
  readonly evidenceClassification: NavigationObservationEvidenceClassification;
}

export const NAVIGATION_FOCUS_GRAPH_PROBLEM_KINDS = [
  "missing-focus",
  "self-loop",
  "unreachable-target",
  "focus-trap",
  "overlay-focus-leak",
  "broken-back",
  "unexpected-jump",
] as const;

export type NavigationFocusGraphProblemKind =
  (typeof NAVIGATION_FOCUS_GRAPH_PROBLEM_KINDS)[number];

export const NAVIGATION_FOCUS_GRAPH_V2_PROBLEM_KINDS = [
  ...NAVIGATION_FOCUS_GRAPH_PROBLEM_KINDS,
  "directional-asymmetry",
  "focus-not-visible",
  "focus-escape",
  "stale-focus",
] as const;

export type NavigationFocusGraphV2ProblemKind =
  (typeof NAVIGATION_FOCUS_GRAPH_V2_PROBLEM_KINDS)[number];

export interface NavigationFocusGraphEndpoint {
  readonly screenKey: string;
  readonly focusTargetKey: string | null;
  readonly element: NavigationElementMetadata | null;
}

export interface NavigationFocusGraphProblem {
  readonly kind: NavigationFocusGraphProblemKind;
  readonly issueId: string;
  readonly rule: string;
  readonly evidenceClassification: NavigationDiagnosticClassification;
  readonly evidenceKinds: readonly EvidenceKind[];
  readonly source: NavigationFocusGraphEndpoint;
  readonly target: NavigationFocusGraphEndpoint & {
    readonly expectedElement: NavigationElementMetadata | null;
    readonly observedElement: NavigationElementMetadata | null;
  };
  /** Exact remote sequence attached to the diagnostic witness. */
  readonly reproductionPath: readonly RemoteKey[];
  /** True only when the diagnostic required and proved complete local expansion. */
  readonly locallyComplete: boolean | null;
}

export interface NavigationFocusGraphV2Problem extends Omit<NavigationFocusGraphProblem, "kind"> {
  readonly kind: NavigationFocusGraphV2ProblemKind;
}

export interface NavigationFocusGraph {
  readonly schemaVersion: typeof NAVIGATION_FOCUS_GRAPH_VERSION;
  readonly coverage: "complete" | "partial";
  /** Navigation actions represented by this graph that were configured for exploration. */
  readonly configuredActions: readonly NavigationFocusGraphAction[];
  readonly screens: readonly NavigationFocusGraphScreen[];
  readonly focusTargets: readonly NavigationFocusGraphTarget[];
  readonly transitions: readonly NavigationFocusGraphTransition[];
  /** Evidence-backed navigation defects with their original diagnostic certainty. */
  readonly problems: readonly NavigationFocusGraphProblem[];
}

export interface NavigationFocusGraphV2Screen extends NavigationFocusGraphScreen {
  /** Shortest root-relative path among verified observations retained by this run. */
  readonly shortestKnownPath: readonly RemoteKey[];
}

export interface NavigationFocusGraphV2Target extends NavigationFocusGraphTarget {
  /** Shortest root-relative path among verified observations retained by this run. */
  readonly shortestKnownPath: readonly RemoteKey[];
}

export interface NavigationFocusGraphV2 extends Omit<
  NavigationFocusGraph,
  "schemaVersion" | "screens" | "focusTargets" | "problems"
> {
  readonly schemaVersion: typeof NAVIGATION_FOCUS_GRAPH_VERSION_V2;
  readonly screens: readonly NavigationFocusGraphV2Screen[];
  readonly focusTargets: readonly NavigationFocusGraphV2Target[];
  readonly problems: readonly NavigationFocusGraphV2Problem[];
  readonly coverageSummary: NavigationFocusGraphCoverageSummary;
  /** Observed cycles are analysis only; their presence does not imply a defect. */
  readonly cycles: readonly NavigationFocusGraphCycle[];
}

const GRAPH_ACTIONS: ReadonlySet<RemoteKey> = new Set(NAVIGATION_FOCUS_GRAPH_ACTIONS);

function elementMetadata(target: FocusTarget): NavigationElementMetadata {
  return {
    stableId: target.stableId ?? null,
    role: target.role ?? null,
    name: target.name ?? null,
    bounds: target.bounds ?? null,
  };
}

function focusObservation(
  result: ExplorationResult,
  focusStateId: string,
): NavigationFocusObservation {
  const state = result.graph.focus.states.find((candidate) => candidate.id === focusStateId);
  if (state === undefined) {
    throw new Error(`Navigation graph references unknown focus state ${focusStateId}.`);
  }
  const observation = state.representativeSnapshot.focusedElement;
  if (observation.status === "unavailable") {
    return {
      status: "unavailable",
      element: null,
      reason: observation.reason,
      evidenceClassification: "unobservable",
    };
  }
  if (observation.value === null) {
    return {
      status: "missing",
      element: null,
      reason: null,
      evidenceClassification: "verified-fact",
    };
  }
  return {
    status: "present",
    element: elementMetadata(observation.value),
    reason: null,
    evidenceClassification: "verified-fact",
  };
}

function shortestPathFirst(
  left: NavigationFocusGraphTransition,
  right: NavigationFocusGraphTransition,
): number {
  return left.reproductionPath.length - right.reproductionPath.length
    || compareText(JSON.stringify(left.reproductionPath), JSON.stringify(right.reproductionPath));
}

function problemKind(finding: NavigationDiagnosticFinding): NavigationFocusGraphProblemKind | null {
  switch (finding.issue.rule) {
    case NAVIGATION_DIAGNOSTIC_RULES.lostFocus:
      return "missing-focus";
    case NAVIGATION_DIAGNOSTIC_RULES.selfLoop:
      return "self-loop";
    case NAVIGATION_DIAGNOSTIC_RULES.unreachable:
      return "unreachable-target";
    case NAVIGATION_DIAGNOSTIC_RULES.focusTrap:
      return "focus-trap";
    case NAVIGATION_DIAGNOSTIC_RULES.overlayFocusLeak:
      return "overlay-focus-leak";
    case NAVIGATION_DIAGNOSTIC_RULES.backBehaviour:
      return "broken-back";
    case NAVIGATION_DIAGNOSTIC_RULES.unexpectedJump:
      return "unexpected-jump";
    default:
      return null;
  }
}

function problemKindV2(finding: NavigationDiagnosticFinding): NavigationFocusGraphV2ProblemKind | null {
  const v1 = problemKind(finding);
  if (v1 !== null) return v1;
  switch (finding.issue.rule) {
    case NAVIGATION_DIAGNOSTIC_RULES.directionalAsymmetry:
      return "directional-asymmetry";
    case NAVIGATION_DIAGNOSTIC_RULES.focusVisibility:
      return "focus-not-visible";
    case NAVIGATION_DIAGNOSTIC_RULES.focusEscape:
      return "focus-escape";
    case NAVIGATION_DIAGNOSTIC_RULES.staleFocus:
      return "stale-focus";
    default:
      return null;
  }
}

function graphProblems(
  diagnostics: NavigationDiagnostics,
  screenKeyById: ReadonlyMap<string, string>,
  focusKeyById: ReadonlyMap<string, string>,
): readonly NavigationFocusGraphProblem[] {
  return diagnostics.findings.flatMap((finding): readonly NavigationFocusGraphProblem[] => {
    const kind = problemKind(finding);
    if (kind === null) return [];
    return [{
      kind,
      issueId: finding.issue.id,
      rule: finding.issue.rule,
      evidenceClassification: finding.classification,
      evidenceKinds: [...new Set(finding.issue.evidence.map((evidence) => evidence.kind))],
      source: {
        screenKey: stableScreenKey(screenKeyById, finding.source.screenStateId),
        focusTargetKey: stableFocusKey(focusKeyById, finding.source.focusStateId),
        element: finding.source.element,
      },
      target: {
        screenKey: stableScreenKey(screenKeyById, finding.target.screenStateId),
        focusTargetKey: stableFocusKey(focusKeyById, finding.target.focusStateId),
        element: finding.target.element,
        expectedElement: finding.target.expectedElement,
        observedElement: finding.target.observedElement,
      },
      reproductionPath: finding.source.actionSequence,
      locallyComplete: finding.source.locallyComplete,
    }];
  }).sort((left, right) => compareText(left.issueId, right.issueId));
}

function graphProblemsV2(
  diagnostics: NavigationDiagnostics,
  screenKeyById: ReadonlyMap<string, string>,
  focusKeyById: ReadonlyMap<string, string>,
): readonly NavigationFocusGraphV2Problem[] {
  return diagnostics.findings.flatMap((finding): readonly NavigationFocusGraphV2Problem[] => {
    const kind = problemKindV2(finding);
    if (kind === null) return [];
    return [{
      kind,
      issueId: finding.issue.id,
      rule: finding.issue.rule,
      evidenceClassification: finding.classification,
      evidenceKinds: [...new Set(finding.issue.evidence.map((evidence) => evidence.kind))],
      source: {
        screenKey: stableScreenKey(screenKeyById, finding.source.screenStateId),
        focusTargetKey: stableFocusKey(focusKeyById, finding.source.focusStateId),
        element: finding.source.element,
      },
      target: {
        screenKey: stableScreenKey(screenKeyById, finding.target.screenStateId),
        focusTargetKey: stableFocusKey(focusKeyById, finding.target.focusStateId),
        element: finding.target.element,
        expectedElement: finding.target.expectedElement,
        observedElement: finding.target.observedElement,
      },
      reproductionPath: finding.source.actionSequence,
      locallyComplete: finding.source.locallyComplete,
    }];
  }).sort((left, right) => compareText(left.issueId, right.issueId));
}

/**
 * Builds the stable, JSON-safe navigation/focus model used by downstream
 * automation. Runtime graph counters and action-attempt IDs are intentionally
 * excluded; structural/focus fingerprints and semantic issue IDs are retained.
 */
export function createNavigationFocusGraph(
  result: ExplorationResult,
  diagnostics: NavigationDiagnostics = diagnoseNavigation(result),
): NavigationFocusGraph {
  const screenKeyById = new Map(
    result.graph.screens.states.map((state) => [state.id, state.fingerprint.value]),
  );
  const focusKeyById = new Map(
    result.graph.focus.states.map((state) => [state.id, state.stateFingerprint]),
  );

  const screens = result.graph.screens.states.map((screen): NavigationFocusGraphScreen => ({
    key: screen.fingerprint.value,
    confidence: screen.fingerprint.confidence,
    firstSeenPath: screen.discoveredBy,
    focusTargetKeys: screen.focusStateIds
      .map((focusStateId) => stableFocusKey(focusKeyById, focusStateId))
      .filter((key): key is string => key !== null)
      .sort(compareText),
  })).sort((left, right) => compareText(left.key, right.key));

  const focusTargets = result.graph.focus.states.map((focus): NavigationFocusGraphTarget => ({
    key: focus.stateFingerprint,
    screenKey: stableScreenKey(screenKeyById, focus.screenStateId),
    focusFingerprint: focus.fingerprint.value,
    confidence: focus.confidence,
    firstSeenPath: focus.discoveredBy,
    observation: focusObservation(result, focus.id),
  })).sort((left, right) => compareText(left.key, right.key));

  const transitionByKey = new Map<string, NavigationFocusGraphTransition>();
  for (const attempt of result.graph.actions) {
    if (!GRAPH_ACTIONS.has(attempt.key)) continue;
    const action = attempt.key as NavigationFocusGraphAction;
    const fromScreenKey = stableScreenKey(screenKeyById, attempt.fromScreenStateId);
    const fromFocusTargetKey = stableFocusKey(focusKeyById, attempt.fromFocusStateId);
    if (fromFocusTargetKey === null) {
      throw new Error(`Navigation action ${attempt.id} has no source focus state.`);
    }
    const toScreenKey = attempt.toScreenStateId === null
      ? null
      : stableScreenKey(screenKeyById, attempt.toScreenStateId);
    const toFocusTargetKey = stableFocusKey(focusKeyById, attempt.toFocusStateId);
    const observedScreenKey = attempt.observedFingerprint.screen.value;
    const observedFocusTargetKey = attempt.observedFingerprint.stateValue;
    const key = JSON.stringify([
      fromScreenKey,
      fromFocusTargetKey,
      action,
      toScreenKey,
      toFocusTargetKey,
      observedScreenKey,
      observedFocusTargetKey,
      attempt.actionResult.outcome,
    ]);
    const candidate: NavigationFocusGraphTransition = {
      key,
      fromScreenKey,
      fromFocusTargetKey,
      action,
      toScreenKey,
      toFocusTargetKey,
      observedScreenKey,
      observedFocusTargetKey,
      outcome: attempt.actionResult.outcome,
      reproductionPath: attempt.actionSequence,
      evidenceClassification: attempt.actionResult.outcome === "inconclusive"
        || attempt.afterSnapshot.focusedElement.status === "unavailable"
        ? "unobservable"
        : "verified-fact",
    };
    const previous = transitionByKey.get(key);
    if (previous === undefined || shortestPathFirst(candidate, previous) < 0) {
      transitionByKey.set(key, candidate);
    }
  }
  const transitions = [...transitionByKey.values()].sort((left, right) => compareText(left.key, right.key));

  return {
    schemaVersion: NAVIGATION_FOCUS_GRAPH_VERSION,
    coverage: result.termination.complete ? "complete" : "partial",
    configuredActions: NAVIGATION_FOCUS_GRAPH_ACTIONS.filter((action) => (
      result.actionOrder.includes(action)
    )),
    screens,
    focusTargets,
    transitions,
    problems: graphProblems(diagnostics, screenKeyById, focusKeyById),
  };
}

/**
 * Versioned extension point for richer derived navigation analysis. V1 remains
 * frozen so downstream consumers never receive a silently widened contract.
 */
export function createNavigationFocusGraphV2(
  result: ExplorationResult,
  diagnostics: NavigationDiagnostics = diagnoseNavigation(result),
): NavigationFocusGraphV2 {
  const v1 = createNavigationFocusGraph(result, diagnostics);
  const focusKeyById = new Map(
    result.graph.focus.states.map((state) => [state.id, state.stateFingerprint]),
  );
  const screenKeyById = new Map(
    result.graph.screens.states.map((state) => [state.id, state.fingerprint.value]),
  );
  const focusStateByKey = new Map(
    result.graph.focus.states.map((state) => [state.stateFingerprint, state]),
  );
  const focusTargets = v1.focusTargets.map((target): NavigationFocusGraphV2Target => {
    const state = focusStateByKey.get(target.key);
    if (state === undefined) {
      throw new Error(`Navigation graph references unknown focus key ${target.key}.`);
    }
    return {
      ...target,
      shortestKnownPath: shortestKnownPath(verifiedPathsToFocus(result, state.id, state.discoveredBy)),
    };
  });
  const shortestPathByFocusKey = new Map(
    focusTargets.map((target) => [target.key, target.shortestKnownPath]),
  );
  const screens = v1.screens.map((screen): NavigationFocusGraphV2Screen => ({
    ...screen,
    shortestKnownPath: shortestKnownPath([
      screen.firstSeenPath,
      ...screen.focusTargetKeys.flatMap((focusKey): readonly (readonly RemoteKey[])[] => {
        const path = shortestPathByFocusKey.get(focusKey);
        return path === undefined ? [] : [path];
      }),
    ]),
  }));
  const summary = coverageSummary(
    result,
    v1.configuredActions,
    focusKeyById,
    v1.transitions.length,
  );
  return {
    ...v1,
    schemaVersion: NAVIGATION_FOCUS_GRAPH_VERSION_V2,
    coverage: result.termination.complete && (result.statistics.deferredStates ?? 0) === 0
      ? "complete" : "partial",
    screens,
    focusTargets,
    problems: graphProblemsV2(diagnostics, screenKeyById, focusKeyById),
    coverageSummary: summary,
    cycles: observedCycles(v1.transitions),
  };
}
