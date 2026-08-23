import type {
  ElementBounds,
  FocusTarget,
  RemoteKey,
  ResetStrategy,
  StateSnapshot,
  TVDoctorIssue,
  UiNodeSnapshot,
} from "@tvdoctor/protocol";
import type { ExplorationResult } from "./explorer.js";
import type {
  ExplorationActionAttempt,
  FocusState,
  ScreenState,
} from "./graph.js";
import {
  createCanonicalSemanticIdentity,
  createSemanticIssueId,
} from "./semantic-issue-id.js";

export const NAVIGATION_DIAGNOSTIC_RULES = {
  lostFocus: "remote.lost-focus",
  unreachable: "remote.reachability",
  selfLoop: "remote.self-loop",
  focusTrap: "remote.focus-trap",
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

interface IndexedNode {
  readonly node: UiNodeSnapshot;
  readonly ancestors: readonly UiNodeSnapshot[];
  readonly order: number;
}

interface LocalCoverage {
  readonly complete: boolean;
  readonly attempts: readonly ExplorationActionAttempt[];
}

interface DirectionalCandidate {
  readonly indexed: IndexedNode;
  readonly score: number;
  readonly mainDistance: number;
  readonly crossOverlap: number;
}

interface UnreachableWitness {
  readonly attempt: ExplorationActionAttempt;
  readonly direction: DirectionalCandidate;
  readonly candidateNode: UiNodeSnapshot;
  readonly observed: FocusTarget;
}

interface FindingCandidate {
  readonly classification: NavigationDiagnosticClassification;
  readonly issue: TVDoctorIssue;
  readonly source: NavigationDiagnosticSource;
  readonly target: NavigationDiagnosticTarget;
}

const DIRECTIONAL_KEYS: ReadonlySet<RemoteKey> = new Set([
  "UP",
  "DOWN",
  "LEFT",
  "RIGHT",
]);

const REQUIRED_DIRECTIONAL_KEYS: readonly RemoteKey[] = [
  "UP",
  "DOWN",
  "LEFT",
  "RIGHT",
];

const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "menuitem",
  "option",
  "radio",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

const DIALOG_ROLES: ReadonlySet<string> = new Set(["alertdialog", "dialog"]);

const RULE_ORDER: Readonly<Record<NavigationDiagnosticRule, number>> = {
  [NAVIGATION_DIAGNOSTIC_RULES.lostFocus]: 0,
  [NAVIGATION_DIAGNOSTIC_RULES.selfLoop]: 1,
  [NAVIGATION_DIAGNOSTIC_RULES.unreachable]: 2,
  [NAVIGATION_DIAGNOSTIC_RULES.focusTrap]: 3,
  [NAVIGATION_DIAGNOSTIC_RULES.overlayFocusLeak]: 4,
  [NAVIGATION_DIAGNOSTIC_RULES.backBehaviour]: 5,
  [NAVIGATION_DIAGNOSTIC_RULES.unexpectedJump]: 6,
};

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalise(value: string | null | undefined): string {
  return value?.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase() ?? "";
}

function semanticElementIdentity(element: NavigationElementMetadata | null): readonly string[] | null {
  if (element === null) return null;
  const stableId = normalise(element.stableId);
  if (stableId.length > 0) return ["stable-id", stableId];

  const role = normalise(element.role);
  const name = normalise(element.name);
  if (role.length > 0 || name.length > 0) return ["semantic", role, name];

  const bounds = boundsIdentity(element.bounds);
  return bounds.length > 0 ? ["bounds", bounds] : ["unknown"];
}

const SCREEN_LANDMARK_ROLES: ReadonlySet<string> = new Set([
  "alertdialog",
  "dialog",
  "heading",
  "main",
]);

/**
 * Keeps issue identity tied to semantic screen context without coupling it to
 * every sibling control in the structural exploration fingerprint. Controls
 * may be added, removed, or reordered during ordinary product development and
 * must not churn an otherwise identical finding ID.
 */
function semanticScreenIdentity(screen: ScreenState | undefined): {
  readonly location: string | null;
  readonly landmarks: readonly (readonly string[])[];
} | null {
  if (screen === undefined) return null;
  const snapshot = screen.representativeSnapshot;
  const location = snapshot.location.status === "available"
    ? normalise(snapshot.location.value.split(/[?#]/u, 1)[0]) || null
    : null;
  if (snapshot.uiTree.status !== "available") return { location, landmarks: [] };

  const landmarks: string[][] = [];
  const visit = (node: UiNodeSnapshot): void => {
    const role = normalise(node.role);
    if (node.visible !== false && SCREEN_LANDMARK_ROLES.has(role)) {
      const name = normalise(node.name ?? node.text);
      const landmark = [role, name];
      if (!landmarks.some((existing) => (
        existing[0] === landmark[0] && existing[1] === landmark[1]
      ))) {
        landmarks.push(landmark);
      }
    }
    for (const child of node.children) visit(child);
  };
  for (const node of snapshot.uiTree.value) visit(node);
  return { location, landmarks: landmarks.slice(0, 32) };
}

function semanticFindingIdentity(
  candidate: FindingCandidate,
  screenById: ReadonlyMap<string, ScreenState>,
): string {
  const transition = candidate.issue.transition;
  return createCanonicalSemanticIdentity([
    ["version", 2],
    ["rule", candidate.issue.rule],
    ["sourceScreen", semanticScreenIdentity(screenById.get(candidate.source.screenStateId))],
    ["targetScreen", semanticScreenIdentity(screenById.get(candidate.target.screenStateId))],
    ["sourceElement", semanticElementIdentity(candidate.source.element)],
    ["targetElement", semanticElementIdentity(candidate.target.element)],
    ["expectedElement", semanticElementIdentity(candidate.target.expectedElement)],
    ["observedElement", semanticElementIdentity(candidate.target.observedElement)],
    ["transition", transition === null ? null : {
      action: transition.action,
      fromElement: normalise(transition.fromElement),
      expectedElement: normalise(transition.expectedElement),
      observedElement: normalise(transition.observedElement),
    }],
  ]);
}

function finiteBounds(bounds: ElementBounds | null | undefined): bounds is ElementBounds {
  return bounds !== null
    && bounds !== undefined
    && Number.isFinite(bounds.x)
    && Number.isFinite(bounds.y)
    && Number.isFinite(bounds.width)
    && Number.isFinite(bounds.height)
    && bounds.width > 0
    && bounds.height > 0;
}

function boundsIdentity(bounds: ElementBounds | null | undefined): string {
  if (!finiteBounds(bounds)) return "";
  return [bounds.x, bounds.y, bounds.width, bounds.height]
    .map((value) => String(Math.round(value * 10) / 10))
    .join(",");
}

function nodeIdentity(node: UiNodeSnapshot): string | null {
  const stableId = normalise(node.stableId);
  if (stableId.length > 0) return `id:${stableId}`;
  const role = normalise(node.role);
  const name = normalise(node.name);
  const bounds = boundsIdentity(node.bounds);
  if (role.length === 0 || name.length === 0 || bounds.length === 0) return null;
  return `semantic:${role}|${name}|${bounds}`;
}

function targetIdentity(target: FocusTarget): string | null {
  const stableId = normalise(target.stableId);
  if (stableId.length > 0) return `id:${stableId}`;
  const role = normalise(target.role);
  const name = normalise(target.name);
  const bounds = boundsIdentity(target.bounds);
  if (role.length === 0 || name.length === 0 || bounds.length === 0) return null;
  return `semantic:${role}|${name}|${bounds}`;
}

function metadataForNode(node: UiNodeSnapshot): NavigationElementMetadata {
  return {
    stableId: node.stableId,
    role: node.role,
    name: node.name,
    bounds: node.bounds,
  };
}

function metadataForTarget(target: FocusTarget): NavigationElementMetadata {
  return {
    stableId: target.stableId ?? null,
    role: target.role ?? null,
    name: target.name ?? null,
    bounds: target.bounds ?? null,
  };
}

function focusedTarget(snapshot: StateSnapshot): FocusTarget | null {
  return snapshot.focusedElement.status === "available"
    ? snapshot.focusedElement.value
    : null;
}

function flattenSnapshot(snapshot: StateSnapshot): readonly IndexedNode[] {
  if (snapshot.uiTree.status !== "available") return [];
  const indexed: IndexedNode[] = [];
  const visit = (node: UiNodeSnapshot, ancestors: readonly UiNodeSnapshot[]): void => {
    indexed.push({ node, ancestors, order: indexed.length });
    const nextAncestors = [...ancestors, node];
    for (const child of node.children) visit(child, nextAncestors);
  };
  for (const node of snapshot.uiTree.value) visit(node, []);
  return indexed;
}

function visibleDialog(nodes: readonly IndexedNode[]): IndexedNode | null {
  let selected: IndexedNode | null = null;
  for (const candidate of nodes) {
    if (candidate.node.visible !== true
      || candidate.node.modal !== true
      || !DIALOG_ROLES.has(normalise(candidate.node.role))) continue;
    if (selected === null || candidate.ancestors.length > selected.ancestors.length) {
      selected = candidate;
    }
  }
  return selected;
}

function inSubtree(candidate: IndexedNode, root: IndexedNode): boolean {
  return candidate.node === root.node || candidate.ancestors.includes(root.node);
}

function activeNodes(snapshot: StateSnapshot): readonly IndexedNode[] {
  const nodes = flattenSnapshot(snapshot);
  const dialog = visibleDialog(nodes);
  return dialog === null ? nodes : nodes.filter((candidate) => inSubtree(candidate, dialog));
}

function parentNode(indexed: IndexedNode): UiNodeSnapshot | null {
  return indexed.ancestors.at(-1) ?? null;
}

function focusNode(snapshot: StateSnapshot, nodes: readonly IndexedNode[]): IndexedNode | null {
  const target = focusedTarget(snapshot);
  if (target === null) return null;
  const identity = targetIdentity(target);
  if (identity === null) return null;
  const matching = nodes.filter((candidate) => nodeIdentity(candidate.node) === identity);
  const matched = matching[0];
  if (matching.length !== 1 || matched === undefined) return null;
  const explicitlyFocused = nodes.filter((candidate) => candidate.node.focused === true);
  if (explicitlyFocused.length > 0
    && (explicitlyFocused.length !== 1 || explicitlyFocused[0]?.node !== matched.node)) return null;
  return matched;
}

function elementLabel(element: NavigationElementMetadata | null): string | null {
  if (element === null) return null;
  const stableId = element.stableId?.trim();
  if (stableId !== undefined && stableId.length > 0) return stableId;
  const name = element.name?.trim();
  if (name !== undefined && name.length > 0) return name;
  const role = element.role?.trim();
  return role !== undefined && role.length > 0 ? role : null;
}

function sequenceSteps(sequence: readonly RemoteKey[]): TVDoctorIssue["reproduction"] {
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

function reproduction(
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

function issue(
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

function actionSource(
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

function diagnosticTarget(
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

function localCoverage(result: ExplorationResult, screen: ScreenState): LocalCoverage {
  const sourceIds = new Set(screen.focusStateIds);
  const attempts = result.graph.actions.filter((attempt) => sourceIds.has(attempt.fromFocusStateId));
  if (screen.focusStateIds.length === 0 || result.actionOrder.length === 0) {
    return { complete: false, attempts };
  }

  for (const focusStateId of screen.focusStateIds) {
    for (const key of result.actionOrder) {
      const matching = attempts.filter((attempt) => (
        attempt.fromFocusStateId === focusStateId && attempt.key === key
      ));
      const attempt = matching[0];
      if (matching.length !== 1
        || attempt === undefined
        || attempt.actionResult.key !== key
        || attempt.actionResult.outcome !== "applied"
        || attempt.toFocusStateId === null
        || attempt.toScreenStateId === null) {
        return { complete: false, attempts };
      }
    }
  }
  return { complete: true, attempts };
}

function configured(result: ExplorationResult, required: readonly RemoteKey[]): boolean {
  const configuredKeys = new Set(result.actionOrder);
  return required.every((key) => configuredKeys.has(key));
}

function directionalCandidate(
  key: RemoteKey,
  source: ElementBounds,
  indexed: IndexedNode,
): DirectionalCandidate | null {
  const target = indexed.node.bounds;
  if (!finiteBounds(target)) return null;

  const sourceCenterX = source.x + source.width / 2;
  const sourceCenterY = source.y + source.height / 2;
  const targetCenterX = target.x + target.width / 2;
  const targetCenterY = target.y + target.height / 2;
  const horizontal = key === "LEFT" || key === "RIGHT";
  const mainDelta = horizontal ? targetCenterX - sourceCenterX : targetCenterY - sourceCenterY;
  const signedMainDistance = key === "LEFT" || key === "UP" ? -mainDelta : mainDelta;
  if (signedMainDistance <= 1) return null;

  const crossDelta = horizontal
    ? Math.abs(targetCenterY - sourceCenterY)
    : Math.abs(targetCenterX - sourceCenterX);
  const sourceCrossStart = horizontal ? source.y : source.x;
  const sourceCrossEnd = sourceCrossStart + (horizontal ? source.height : source.width);
  const targetCrossStart = horizontal ? target.y : target.x;
  const targetCrossEnd = targetCrossStart + (horizontal ? target.height : target.width);
  const crossOverlap = Math.max(
    0,
    Math.min(sourceCrossEnd, targetCrossEnd) - Math.max(sourceCrossStart, targetCrossStart),
  );
  const crossGap = Math.max(
    0,
    Math.max(sourceCrossStart, targetCrossStart) - Math.min(sourceCrossEnd, targetCrossEnd),
  );
  if (crossOverlap === 0 && crossDelta > signedMainDistance) return null;

  return {
    indexed,
    score: signedMainDistance + crossDelta * 2 + crossGap * 4,
    mainDistance: signedMainDistance,
    crossOverlap,
  };
}

function candidateComparator(left: DirectionalCandidate, right: DirectionalCandidate): number {
  if (left.score !== right.score) return left.score - right.score;
  return left.indexed.order - right.indexed.order;
}

function geometricCandidates(
  snapshot: StateSnapshot,
  key: RemoteKey,
  source: FocusTarget,
): readonly DirectionalCandidate[] {
  if (!finiteBounds(source.bounds)) return [];
  const sourceIdentity = targetIdentity(source);
  const candidates: DirectionalCandidate[] = [];
  for (const indexed of activeNodes(snapshot)) {
    if (indexed.node.visible !== true || indexed.node.focusable !== true) continue;
    if (sourceIdentity !== null && nodeIdentity(indexed.node) === sourceIdentity) continue;
    const candidate = directionalCandidate(key, source.bounds, indexed);
    if (candidate !== null) candidates.push(candidate);
  }
  return candidates.sort(candidateComparator);
}

function reachedIdentitiesForScreen(
  result: ExplorationResult,
  screenStateId: string,
): ReadonlySet<string> {
  const identities = new Set<string>();
  for (const state of result.graph.focus.states) {
    if (state.screenStateId !== screenStateId) continue;
    const target = focusedTarget(state.representativeSnapshot);
    const identity = target === null ? null : targetIdentity(target);
    if (identity !== null) identities.add(identity);
  }
  return identities;
}

function intervalGap(startA: number, endA: number, startB: number, endB: number): number {
  return Math.max(0, Math.max(startA, startB) - Math.min(endA, endB));
}

/** A deliberately tight witness for controls that visually form one row/column. */
function alignedAdjacent(left: ElementBounds, right: ElementBounds): boolean {
  const verticalOverlap = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y),
  );
  const horizontalOverlap = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x),
  );
  const horizontalGap = intervalGap(left.x, left.x + left.width, right.x, right.x + right.width);
  const verticalGap = intervalGap(left.y, left.y + left.height, right.y, right.y + right.height);
  const sameRow = verticalOverlap >= Math.min(left.height, right.height) * 0.5
    && horizontalGap <= Math.max(64, Math.min(left.width, right.width));
  const sameColumn = horizontalOverlap >= Math.min(left.width, right.width) * 0.5
    && verticalGap <= Math.max(64, Math.min(left.height, right.height));
  return sameRow || sameColumn;
}

function sameSequence(left: readonly RemoteKey[], right: readonly RemoteKey[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function sequenceWith(sequence: readonly RemoteKey[], key: RemoteKey): readonly RemoteKey[] {
  return [...sequence, key];
}

function attemptSemanticIdentity(attempt: ExplorationActionAttempt): string {
  const before = focusedTarget(attempt.beforeSnapshot);
  const after = focusedTarget(attempt.afterSnapshot);
  const beforeLocation = attempt.beforeSnapshot.location.status === "available"
    ? normalise(attempt.beforeSnapshot.location.value)
    : null;
  const afterLocation = attempt.afterSnapshot.location.status === "available"
    ? normalise(attempt.afterSnapshot.location.value)
    : null;
  return JSON.stringify({
    key: attempt.key,
    outcome: attempt.actionResult.outcome,
    sequence: attempt.actionSequence,
    beforeLocation,
    afterLocation,
    before: before === null ? null : semanticElementIdentity(metadataForTarget(before)),
    after: after === null ? null : semanticElementIdentity(metadataForTarget(after)),
  });
}

function shortestAttempt(attempts: readonly ExplorationActionAttempt[]): ExplorationActionAttempt | null {
  const ordered = [...attempts].sort((left, right) => (
    left.actionSequence.length - right.actionSequence.length
    || compareText(attemptSemanticIdentity(left), attemptSemanticIdentity(right))
  ));
  return ordered[0] ?? null;
}

function addLostFocusFindings(
  result: ExplorationResult,
  resetStrategy: ResetStrategy,
  add: (candidate: FindingCandidate) => void,
): void {
  for (const attempt of result.graph.actions) {
    const before = focusedTarget(attempt.beforeSnapshot);
    if (attempt.actionResult.outcome !== "applied"
      || attempt.actionResult.key !== attempt.key
      || before === null
      || attempt.afterSnapshot.focusedElement.status !== "available"
      || attempt.afterSnapshot.focusedElement.value !== null) continue;

    const contradictoryFocus = flattenSnapshot(attempt.afterSnapshot)
      .some((candidate) => candidate.node.focused === true);
    const focusCouldRemain = activeNodes(attempt.afterSnapshot)
      .some((candidate) => candidate.node.visible === true && candidate.node.focusable === true);
    if (contradictoryFocus || !focusCouldRemain) continue;

    const sourceElement = metadataForTarget(before);
    const observedScreen = attempt.toScreenStateId ?? attempt.fromScreenStateId;
    const classification = "deterministic";
    add({
      classification,
      issue: issue(
        NAVIGATION_DIAGNOSTIC_RULES.lostFocus,
        classification,
        "high",
        "Remote action loses focus",
        "A previously focused control was followed by an explicit observation that no meaningful focus target remained.",
        observedScreen,
        "A meaningful focus target remains after the remote action.",
        "The driver explicitly observed no focused element.",
        {
          fromElement: elementLabel(sourceElement),
          action: attempt.key,
          expectedElement: null,
          observedElement: null,
        },
        attempt.actionSequence,
        `${attempt.key} changed an available non-null focus observation to an available null observation.`,
        attempt.id,
        resetStrategy,
      ),
      source: actionSource(attempt),
      target: diagnosticTarget(
        observedScreen,
        attempt.toFocusStateId,
        null,
        null,
        null,
      ),
    });
  }
}

function addSelfLoopFindings(
  result: ExplorationResult,
  resetStrategy: ResetStrategy,
  add: (candidate: FindingCandidate) => void,
): void {
  for (const attempt of result.graph.actions) {
    if (!DIRECTIONAL_KEYS.has(attempt.key)
      || attempt.actionResult.outcome !== "applied"
      || attempt.actionResult.key !== attempt.key
      || attempt.toScreenStateId !== attempt.fromScreenStateId
      || attempt.toFocusStateId !== attempt.fromFocusStateId) continue;
    const source = focusedTarget(attempt.beforeSnapshot);
    if (source === null || !finiteBounds(source.bounds)) continue;
    const sourceBounds = source.bounds;
    const scopedNodes = activeNodes(attempt.beforeSnapshot);
    const sourceIndexed = focusNode(attempt.beforeSnapshot, scopedNodes);
    if (sourceIndexed === null) continue;
    const sourceParent = parentNode(sourceIndexed);
    const reachable = reachedIdentitiesForScreen(result, attempt.fromScreenStateId);
    const best = geometricCandidates(attempt.beforeSnapshot, attempt.key, source)
      .find((candidate) => {
        const identity = nodeIdentity(candidate.indexed.node);
        return identity !== null
          && reachable.has(identity)
          && parentNode(candidate.indexed) === sourceParent
          && candidate.crossOverlap > 0
          && finiteBounds(candidate.indexed.node.bounds)
          && alignedAdjacent(sourceBounds, candidate.indexed.node.bounds);
      });
    if (best === undefined) continue;

    const sourceElement = metadataForTarget(source);
    const expectedElement = metadataForNode(best.indexed.node);
    const classification = "deterministic";
    add({
      classification,
      issue: issue(
        NAVIGATION_DIAGNOSTIC_RULES.selfLoop,
        classification,
        "medium",
        "Directional action loops on the same control",
        "Focus remained on the same control even though the pre-action snapshot contained a visible, focusable control in the requested direction.",
        attempt.fromScreenStateId,
        `Move toward ${elementLabel(expectedElement) ?? "the visible directional candidate"}.`,
        `Focus remained on ${elementLabel(sourceElement) ?? "the source control"}.`,
        {
          fromElement: elementLabel(sourceElement),
          action: attempt.key,
          expectedElement: elementLabel(expectedElement),
          observedElement: elementLabel(sourceElement),
        },
        attempt.actionSequence,
        `${attempt.key} produced a same-state transition while a visible, focusable geometric candidate was present.`,
        attempt.id,
        resetStrategy,
        [{
          kind: "inference",
          summary: `Shared parent grouping and aligned geometry suggest ${elementLabel(expectedElement) ?? "the adjacent control"} is the likely intended destination.`,
          source: attempt.id,
          artifact: null,
        }],
      ),
      source: actionSource(attempt),
      target: diagnosticTarget(
        attempt.fromScreenStateId,
        attempt.fromFocusStateId,
        expectedElement,
        expectedElement,
        sourceElement,
      ),
    });
  }
}

function addUnreachableFindings(
  result: ExplorationResult,
  resetStrategy: ResetStrategy,
  add: (candidate: FindingCandidate) => void,
): void {
  if (!configured(result, REQUIRED_DIRECTIONAL_KEYS)) return;
  const focusById = new Map(result.graph.focus.states.map((state) => [state.id, state]));

  for (const screen of result.graph.screens.states) {
    const coverage = localCoverage(result, screen);
    if (!coverage.complete) continue;

    const states = screen.focusStateIds
      .map((focusStateId) => focusById.get(focusStateId))
      .filter((state): state is FocusState => state !== undefined);
    const reached = new Set<string>();
    let observationsComplete = states.length === screen.focusStateIds.length;
    for (const state of states) {
      if (state.representativeSnapshot.uiTree.status !== "available"
        || state.representativeSnapshot.focusedElement.status !== "available"
        || state.representativeSnapshot.focusedElement.value === null) {
        observationsComplete = false;
        break;
      }
      const target = focusedTarget(state.representativeSnapshot);
      const identity = target === null ? null : targetIdentity(target);
      if (identity === null) {
        observationsComplete = false;
        break;
      }
      const focusedNode = focusNode(
        state.representativeSnapshot,
        activeNodes(state.representativeSnapshot),
      );
      if (focusedNode === null
        || nodeIdentity(focusedNode.node) !== identity
        || focusedNode.node.visible !== true
        || focusedNode.node.enabled !== true
        || focusedNode.node.focusable !== true) {
        observationsComplete = false;
        break;
      }
      reached.add(identity);
    }
    if (!observationsComplete) continue;

    const candidates = new Map<string, { readonly indexed: IndexedNode; readonly snapshot: StateSnapshot }>();
    for (const state of states) {
      const scopedNodes = activeNodes(state.representativeSnapshot);
      for (const indexed of scopedNodes) {
        const node = indexed.node;
        if (node.visible !== true
          || node.enabled !== true
          || node.focusable !== false
          || !INTERACTIVE_ROLES.has(normalise(node.role))
          || normalise(node.stableId).length === 0
          || !finiteBounds(node.bounds)) continue;
        const identity = nodeIdentity(node);
        if (identity === null || candidates.has(identity)) continue;
        const sameIdentityCount = scopedNodes.filter((candidate) => (
          nodeIdentity(candidate.node) === identity
        )).length;
        if (sameIdentityCount !== 1) continue;
        candidates.set(identity, { indexed, snapshot: state.representativeSnapshot });
      }
    }

    for (const [identity, candidate] of candidates) {
      if (reached.has(identity)) continue;
      const candidateBounds = candidate.indexed.node.bounds;
      if (!finiteBounds(candidateBounds)) continue;
      const witnesses: UnreachableWitness[] = [];
      for (const attempt of coverage.attempts) {
        if (!DIRECTIONAL_KEYS.has(attempt.key)
          || attempt.actionSequence.at(-1) !== attempt.key
          || attempt.actionResult.key !== attempt.key
          || attempt.actionResult.outcome !== "applied"
          || attempt.toScreenStateId !== screen.id) continue;
        const sourceTarget = focusedTarget(attempt.beforeSnapshot);
        const observedTarget = focusedTarget(attempt.afterSnapshot);
        const sourceIdentity = sourceTarget === null ? null : targetIdentity(sourceTarget);
        const observedIdentity = observedTarget === null ? null : targetIdentity(observedTarget);
        if (sourceTarget === null
          || observedTarget === null
          || sourceIdentity === null
          || observedIdentity === null
          || observedIdentity === identity
          || !finiteBounds(sourceTarget.bounds)) continue;

        const scopedNodes = activeNodes(attempt.beforeSnapshot);
        const sourceIndexed = focusNode(attempt.beforeSnapshot, scopedNodes);
        if (sourceIndexed === null
          || nodeIdentity(sourceIndexed.node) !== sourceIdentity
          || sourceIndexed.node.visible !== true
          || sourceIndexed.node.enabled !== true
          || sourceIndexed.node.focusable !== true
          || !finiteBounds(sourceIndexed.node.bounds)) continue;
        const observedNodes = activeNodes(attempt.afterSnapshot);
        const observedIndexed = focusNode(attempt.afterSnapshot, observedNodes);
        if (observedIndexed === null
          || nodeIdentity(observedIndexed.node) !== observedIdentity
          || observedIndexed.node.visible !== true
          || observedIndexed.node.enabled !== true
          || observedIndexed.node.focusable !== true) continue;
        const matchingCandidates = scopedNodes.filter((indexed) => (
          nodeIdentity(indexed.node) === identity
          && indexed.node.visible === true
          && indexed.node.enabled === true
          && indexed.node.focusable === false
          && finiteBounds(indexed.node.bounds)
        ));
        const witnessedCandidate = matchingCandidates[0];
        if (matchingCandidates.length !== 1 || witnessedCandidate === undefined) continue;
        if (parentNode(sourceIndexed) !== parentNode(witnessedCandidate)
          || !finiteBounds(witnessedCandidate.node.bounds)
          || !alignedAdjacent(sourceTarget.bounds, witnessedCandidate.node.bounds)) continue;
        const direction = directionalCandidate(
          attempt.key,
          sourceTarget.bounds,
          witnessedCandidate,
        );
        if (direction === null) continue;
        witnesses.push({
          attempt,
          direction,
          candidateNode: witnessedCandidate.node,
          observed: observedTarget,
        });
      }
      witnesses.sort((left, right) => (
        left.attempt.actionSequence.length - right.attempt.actionSequence.length
        || left.direction.score - right.direction.score
        || compareText(
          attemptSemanticIdentity(left.attempt),
          attemptSemanticIdentity(right.attempt),
        )
      ));
      const witness = witnesses[0];
      if (witness === undefined) continue;

      const node = witness.candidateNode;
      const targetElement = metadataForNode(node);
      const sourceTarget = focusedTarget(witness.attempt.beforeSnapshot);
      if (sourceTarget === null) continue;
      const sourceElement = metadataForTarget(sourceTarget);
      const observedElement = metadataForTarget(witness.observed);
      const classification = "deterministic";
      add({
        classification,
        issue: issue(
          NAVIGATION_DIAGNOSTIC_RULES.unreachable,
          classification,
          "medium",
          "Visible interactive control is remote-unreachable",
          "The control is visible and semantically interactive, but it is not the target of any discovered focus state after the screen was locally expanded for every configured remote action.",
          screen.id,
          `${witness.attempt.key} should reach ${elementLabel(targetElement) ?? "the visible interactive control"}.`,
          `${witness.attempt.key} moved to ${elementLabel(observedElement) ?? "a different control"}, skipping the candidate.`,
          {
            fromElement: elementLabel(sourceElement),
            action: witness.attempt.key,
            expectedElement: elementLabel(targetElement),
            observedElement: elementLabel(observedElement),
          },
          witness.attempt.actionSequence,
          `${witness.attempt.key} from ${elementLabel(sourceElement) ?? "the reached sibling"} skipped the aligned candidate and focused ${elementLabel(observedElement) ?? "another control"}; all local states were fully expanded.`,
          witness.attempt.id,
          resetStrategy,
        ),
        source: actionSource(witness.attempt, "action-attempt", null, true),
        target: diagnosticTarget(
          screen.id,
          witness.attempt.toFocusStateId,
          targetElement,
          targetElement,
          observedElement,
        ),
      });
    }
  }
}

function addFocusTrapFindings(
  result: ExplorationResult,
  resetStrategy: ResetStrategy,
  add: (candidate: FindingCandidate) => void,
): void {
  if (!configured(result, [...REQUIRED_DIRECTIONAL_KEYS, "SELECT", "BACK"])) return;

  for (const screen of result.graph.screens.states) {
    const coverage = localCoverage(result, screen);
    if (!coverage.complete) continue;
    const nodes = flattenSnapshot(screen.representativeSnapshot);
    const dialog = visibleDialog(nodes);
    if (dialog === null) continue;
    const dialogIdentity = nodeIdentity(dialog.node);
    if (dialogIdentity === null) continue;

    const destinationRemainsInsideDialog = (attempt: ExplorationActionAttempt): boolean => {
      if (attempt.toScreenStateId !== screen.id
        || attempt.afterSnapshot.uiTree.status !== "available"
        || attempt.afterSnapshot.focusedElement.status !== "available"
        || attempt.afterSnapshot.focusedElement.value === null) return false;
      const afterNodes = flattenSnapshot(attempt.afterSnapshot);
      const afterDialog = visibleDialog(afterNodes);
      if (afterDialog === null || nodeIdentity(afterDialog.node) !== dialogIdentity) return false;
      const afterFocus = focusNode(attempt.afterSnapshot, afterNodes);
      return afterFocus !== null && inSubtree(afterFocus, afterDialog);
    };

    const incoming = result.graph.actions.filter((attempt) => (
      attempt.fromScreenStateId !== screen.id
      && attempt.toScreenStateId === screen.id
      && attempt.actionSequence.at(-1) === attempt.key
      && attempt.actionResult.key === attempt.key
      && attempt.actionResult.outcome === "applied"
      && destinationRemainsInsideDialog(attempt)
      && (() => {
        const beforeDialog = visibleDialog(flattenSnapshot(attempt.beforeSnapshot));
        return beforeDialog === null || nodeIdentity(beforeDialog.node) !== dialogIdentity;
      })()
    ));
    const entry = shortestAttempt(incoming);
    if (entry === null) continue;
    if (coverage.attempts.some((attempt) => !destinationRemainsInsideDialog(attempt))) continue;
    const backAttempts = coverage.attempts.filter((attempt) => attempt.key === "BACK");
    if (backAttempts.length !== screen.focusStateIds.length
      || backAttempts.some((attempt) => !destinationRemainsInsideDialog(attempt))) continue;

    const proof = shortestAttempt(backAttempts);
    if (proof === null) continue;
    const dialogElement = metadataForNode(dialog.node);
    const sourceElement = focusedTarget(proof.beforeSnapshot);
    const sourceMetadata = sourceElement === null ? null : metadataForTarget(sourceElement);
    const observedElement = focusedTarget(proof.afterSnapshot);
    if (observedElement === null) continue;
    const observedMetadata = metadataForTarget(observedElement);
    const classification = "deterministic";
    add({
      classification,
      issue: issue(
        NAVIGATION_DIAGNOSTIC_RULES.focusTrap,
        classification,
        "high",
        "Remote focus is trapped in a dialog",
        "Every local focus state in the entered dialog was expanded, no configured remote action exits it, and Back remains inside it.",
        screen.id,
        "Back or another documented remote action exits the dialog.",
        "All locally expanded actions, including Back, remain in the dialog screen.",
        {
          fromElement: elementLabel(sourceMetadata),
          action: "BACK",
          expectedElement: null,
          observedElement: elementLabel(observedMetadata),
        },
        proof.actionSequence,
        `${String(screen.focusStateIds.length)} focus states have complete local action coverage and none has a remote exit.`,
        proof.id,
        resetStrategy,
      ),
      source: actionSource(proof, "action-attempt", entry.id, true),
      target: diagnosticTarget(
        screen.id,
        proof.toFocusStateId,
        dialogElement,
        null,
        observedMetadata,
      ),
    });
  }
}

function addOverlayFocusLeakFindings(
  result: ExplorationResult,
  resetStrategy: ResetStrategy,
  add: (candidate: FindingCandidate) => void,
): void {
  for (const state of result.graph.focus.states) {
    const snapshot = state.representativeSnapshot;
    const nodes = flattenSnapshot(snapshot);
    const dialog = visibleDialog(nodes);
    if (dialog === null) continue;
    const focused = focusNode(snapshot, nodes);
    if (focused === null || inSubtree(focused, dialog)) continue;

    const discovery = shortestAttempt(result.graph.actions.filter((attempt) => (
      attempt.toFocusStateId === state.id && sameSequence(attempt.actionSequence, state.discoveredBy)
    )));
    if (discovery === null) continue;
    const beforeDialog = visibleDialog(flattenSnapshot(discovery.beforeSnapshot));
    const beforeDialogIdentity = beforeDialog === null ? null : nodeIdentity(beforeDialog.node);
    const dialogIdentity = nodeIdentity(dialog.node);
    if (beforeDialog !== null
      && (beforeDialogIdentity === dialogIdentity || (beforeDialogIdentity === null && dialogIdentity === null))) {
      continue;
    }
    const focusedElement = metadataForNode(focused.node);
    const dialogElement = metadataForNode(dialog.node);
    const classification = "deterministic";
    const transition = {
      fromElement: elementLabel(actionSource(discovery).element),
      action: discovery.key,
      expectedElement: elementLabel(dialogElement),
      observedElement: elementLabel(focusedElement),
    };
    add({
      classification,
      issue: issue(
        NAVIGATION_DIAGNOSTIC_RULES.overlayFocusLeak,
        classification,
        "high",
        "Focus remains behind a visible dialog",
        "The snapshot contains a visible dialog, but its exactly matched focused node is outside that dialog subtree.",
        state.screenStateId,
        `Focus moves inside ${elementLabel(dialogElement) ?? "the visible dialog"}.`,
        `Focus remains on ${elementLabel(focusedElement) ?? "a control behind the dialog"}.`,
        transition,
        state.discoveredBy,
        "The visible dialog and focused node were both present in the same UI hierarchy, and the focused node was not a dialog descendant.",
        discovery.id,
        resetStrategy,
      ),
      source: actionSource(discovery),
      target: diagnosticTarget(
        state.screenStateId,
        state.id,
        dialogElement,
        dialogElement,
        focusedElement,
      ),
    });
  }
}

function addBackBehaviourFindings(
  result: ExplorationResult,
  resetStrategy: ResetStrategy,
  add: (candidate: FindingCandidate) => void,
): void {
  const selectEntries = result.graph.actions.filter((attempt) => (
    attempt.key === "SELECT"
    && attempt.actionResult.key === "SELECT"
    && attempt.actionResult.outcome === "applied"
    && attempt.toScreenStateId !== null
    && attempt.toFocusStateId !== null
    && attempt.toScreenStateId !== attempt.fromScreenStateId
  ));
  const focusById = new Map(result.graph.focus.states.map((state) => [state.id, state]));

  for (const entry of selectEntries) {
    const enteredState = entry.toFocusStateId === null ? undefined : focusById.get(entry.toFocusStateId);
    if (enteredState === undefined || !sameSequence(enteredState.discoveredBy, entry.actionSequence)) continue;
    const expectedBackSequence = sequenceWith(entry.actionSequence, "BACK");
    const back = result.graph.actions.find((attempt) => (
      attempt.key === "BACK"
      && attempt.actionResult.key === "BACK"
      && attempt.actionResult.outcome === "applied"
      && attempt.fromScreenStateId === entry.toScreenStateId
      && attempt.fromFocusStateId === entry.toFocusStateId
      && sameSequence(attempt.actionSequence, expectedBackSequence)
    ));
    if (back === undefined
      || back.toScreenStateId === null
      || back.toScreenStateId === entry.fromScreenStateId
      || back.toScreenStateId === entry.toScreenStateId) continue;

    const enteredScreenStateId = entry.toScreenStateId;
    if (enteredScreenStateId === null) continue;
    const sourceTarget = focusedTarget(back.beforeSnapshot);
    const expectedTarget = focusedTarget(entry.beforeSnapshot);
    const observedTarget = focusedTarget(back.afterSnapshot);
    const sourceElement = sourceTarget === null ? null : metadataForTarget(sourceTarget);
    const expectedElement = expectedTarget === null ? null : metadataForTarget(expectedTarget);
    const observedElement = observedTarget === null ? null : metadataForTarget(observedTarget);
    const classification = "deterministic";
    add({
      classification,
      issue: issue(
        NAVIGATION_DIAGNOSTIC_RULES.backBehaviour,
        classification,
        "high",
        "Back returns to an unrelated screen",
        "Immediately after Select entered a new screen, Back navigated to neither the entry screen nor the entered screen.",
        enteredScreenStateId,
        `Return to ${entry.fromScreenStateId}.`,
        `Navigated to unrelated ${back.toScreenStateId}.`,
        {
          fromElement: elementLabel(sourceElement),
          action: "BACK",
          expectedElement: elementLabel(expectedElement),
          observedElement: elementLabel(observedElement),
        },
        back.actionSequence,
        `Select entered ${entry.toScreenStateId} from ${entry.fromScreenStateId}; the immediate Back observation reached ${back.toScreenStateId}.`,
        back.id,
        resetStrategy,
      ),
      source: actionSource(back, "action-pair", entry.id),
      target: diagnosticTarget(
        back.toScreenStateId,
        back.toFocusStateId,
        observedElement,
        expectedElement,
        observedElement,
      ),
    });
  }
}

function addUnexpectedJumpFindings(
  result: ExplorationResult,
  resetStrategy: ResetStrategy,
  add: (candidate: FindingCandidate) => void,
): void {
  for (const attempt of result.graph.actions) {
    if (!DIRECTIONAL_KEYS.has(attempt.key)
      || attempt.actionResult.key !== attempt.key
      || attempt.actionResult.outcome !== "applied"
      || attempt.toScreenStateId !== attempt.fromScreenStateId
      || attempt.toFocusStateId === null
      || attempt.toFocusStateId === attempt.fromFocusStateId) continue;

    const source = focusedTarget(attempt.beforeSnapshot);
    const observed = focusedTarget(attempt.afterSnapshot);
    if (source === null || observed === null || !finiteBounds(source.bounds)) continue;
    const sourceBounds = source.bounds;
    const scopedNodes = activeNodes(attempt.beforeSnapshot);
    const sourceIndexed = focusNode(attempt.beforeSnapshot, scopedNodes);
    if (sourceIndexed === null) continue;
    const sourceParent = parentNode(sourceIndexed);
    const observedIdentity = targetIdentity(observed);
    if (observedIdentity === null) continue;

    const candidates = geometricCandidates(attempt.beforeSnapshot, attempt.key, source);
    const observedCandidate = candidates.find((candidate) => (
      nodeIdentity(candidate.indexed.node) === observedIdentity
    ));
    // An especially bad jump can land outside the requested direction's cone.
    // Keep that case observable only when the destination itself is uniquely
    // verified as visible and focusable in the same pre-action hierarchy.
    const observedNodes = scopedNodes.filter((candidate) => (
      nodeIdentity(candidate.node) === observedIdentity
      && candidate.node.visible === true
      && candidate.node.focusable === true
      && finiteBounds(candidate.node.bounds)
    ));
    if (observedNodes.length !== 1) continue;
    const reachable = reachedIdentitiesForScreen(result, attempt.fromScreenStateId);
    const alternatives = candidates.filter((candidate) => {
      const identity = nodeIdentity(candidate.indexed.node);
      return identity !== null
        && identity !== observedIdentity
        && reachable.has(identity)
        && candidate.crossOverlap > 0
        && parentNode(candidate.indexed) === sourceParent
        && finiteBounds(candidate.indexed.node.bounds)
        && alignedAdjacent(sourceBounds, candidate.indexed.node.bounds);
    });
    const better = alternatives[0];
    if (better === undefined) continue;

    const sourceMainSize = attempt.key === "LEFT" || attempt.key === "RIGHT"
      ? sourceBounds.width
      : sourceBounds.height;
    const muchBetter = observedCandidate === undefined
      || (better.score <= observedCandidate.score * 0.45
        && observedCandidate.score - better.score >= Math.max(48, sourceMainSize * 0.75));
    if (!muchBetter) continue;

    const sourceElement = metadataForTarget(source);
    const observedElement = metadataForTarget(observed);
    const expectedElement = metadataForNode(better.indexed.node);
    const classification = "heuristic";
    add({
      classification,
      issue: issue(
        NAVIGATION_DIAGNOSTIC_RULES.unexpectedJump,
        classification,
        "medium",
        "Directional navigation makes an abnormal jump",
        "A much closer and better aligned visible focusable candidate was present in the same pre-action snapshot than the observed destination.",
        attempt.fromScreenStateId,
        `Move toward ${elementLabel(expectedElement) ?? "the nearer aligned control"}.`,
        `Focus moved to ${elementLabel(observedElement) ?? "a distant control"}.`,
        {
          fromElement: elementLabel(sourceElement),
          action: attempt.key,
          expectedElement: elementLabel(expectedElement),
          observedElement: elementLabel(observedElement),
        },
        attempt.actionSequence,
        `The preferred candidate geometry scored ${better.score.toFixed(1)} versus ${observedCandidate?.score.toFixed(1) ?? "not-directional"} for the observed destination.`,
        attempt.id,
        resetStrategy,
      ),
      source: actionSource(attempt),
      target: diagnosticTarget(
        attempt.fromScreenStateId,
        attempt.toFocusStateId,
        observedElement,
        expectedElement,
        observedElement,
      ),
    });
  }
}

/**
 * Applies conservative, fixture-independent navigation diagnostics to a frozen
 * exploration graph. It performs no driver I/O and returns a stable order.
 */
export function diagnoseNavigation(
  result: ExplorationResult,
  options: NavigationDiagnosticOptions = {},
): NavigationDiagnostics {
  const resetStrategy = options.resetStrategy ?? "reload";
  const screenById = new Map(
    result.graph.screens.states.map((state) => [state.id, state]),
  );
  const candidates = new Map<string, FindingCandidate>();
  const add = (candidate: FindingCandidate): void => {
    const identity = semanticFindingIdentity(candidate, screenById);
    if (!candidates.has(identity)) candidates.set(identity, candidate);
  };

  addLostFocusFindings(result, resetStrategy, add);
  addSelfLoopFindings(result, resetStrategy, add);
  addUnreachableFindings(result, resetStrategy, add);
  addFocusTrapFindings(result, resetStrategy, add);
  addOverlayFocusLeakFindings(result, resetStrategy, add);
  addBackBehaviourFindings(result, resetStrategy, add);
  addUnexpectedJumpFindings(result, resetStrategy, add);

  const ordered = [...candidates.entries()].sort(([leftIdentity, left], [rightIdentity, right]) => {
    const leftOrder = RULE_ORDER[left.issue.rule as NavigationDiagnosticRule] ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = RULE_ORDER[right.issue.rule as NavigationDiagnosticRule] ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || compareText(leftIdentity, rightIdentity);
  });
  const findings = ordered.map(([identity, candidate]): NavigationDiagnosticFinding => ({
    classification: candidate.classification,
    issue: {
      ...candidate.issue,
      id: createSemanticIssueId("NAV", identity),
    },
    source: candidate.source,
    target: candidate.target,
  }));

  return {
    findings,
    deterministicFindings: findings.filter((finding) => finding.classification === "deterministic"),
    heuristicFindings: findings.filter((finding) => finding.classification === "heuristic"),
  };
}
