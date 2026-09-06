import type {
  ElementBounds,
  FocusTarget,
  RemoteKey,
  StateSnapshot,
  UiNodeSnapshot,
} from "@tvdoctor/protocol";
import type { ExplorationResult } from "./explorer-contracts.js";
import type { ExplorationActionAttempt, ScreenState } from "./graph.js";
import type { NavigationElementMetadata } from "./navigation-diagnostic-contracts.js";
import type { FindingCandidate } from "./navigation-diagnostic-findings.js";
import { flattenBoundedUiTree } from "./bounded-ui-tree.js";
import { createCanonicalSemanticIdentity } from "./semantic-issue-id.js";

export interface IndexedNode {
  readonly node: UiNodeSnapshot;
  readonly ancestors: readonly UiNodeSnapshot[];
  readonly order: number;
}

export interface LocalCoverage {
  readonly complete: boolean;
  readonly attempts: readonly ExplorationActionAttempt[];
}

export interface DirectionalCandidate {
  readonly indexed: IndexedNode;
  readonly score: number;
  readonly mainDistance: number;
  readonly crossOverlap: number;
}

export const DIRECTIONAL_KEYS: ReadonlySet<RemoteKey> = new Set([
  "UP",
  "DOWN",
  "LEFT",
  "RIGHT",
]);

export const REQUIRED_DIRECTIONAL_KEYS: readonly RemoteKey[] = [
  "UP",
  "DOWN",
  "LEFT",
  "RIGHT",
];

export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
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

export function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function normalise(value: string | null | undefined): string {
  return value?.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase() ?? "";
}

/**
 * An enabled visible node that is already focused is demonstrably reachable
 * by the TV application's programmatic/roving focus model even when its DOM
 * sequential-tab flag is false (for example tabindex=-1).
 */
export function isTvFocusable(node: UiNodeSnapshot): boolean {
  return node.focusable === true
    || (node.focused === true && node.visible === true && node.enabled === true);
}

export function semanticElementIdentity(element: NavigationElementMetadata | null): readonly string[] | null {
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
export function semanticScreenIdentity(screen: ScreenState | undefined): {
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
  for (const { node } of flattenBoundedUiTree(snapshot.uiTree.value)) {
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
  }
  return { location, landmarks: landmarks.slice(0, 32) };
}

export function semanticFindingIdentity(
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

export function finiteBounds(bounds: ElementBounds | null | undefined): bounds is ElementBounds {
  return bounds !== null
    && bounds !== undefined
    && Number.isFinite(bounds.x)
    && Number.isFinite(bounds.y)
    && Number.isFinite(bounds.width)
    && Number.isFinite(bounds.height)
    && bounds.width > 0
    && bounds.height > 0;
}

export function boundsIdentity(bounds: ElementBounds | null | undefined): string {
  if (!finiteBounds(bounds)) return "";
  return [bounds.x, bounds.y, bounds.width, bounds.height]
    .map((value) => String(Math.round(value * 10) / 10))
    .join(",");
}

export function nodeIdentity(node: UiNodeSnapshot): string | null {
  const stableId = normalise(node.stableId);
  if (stableId.length > 0) return `id:${stableId}`;
  const role = normalise(node.role);
  const name = normalise(node.name);
  const bounds = boundsIdentity(node.bounds);
  if (role.length === 0 || name.length === 0 || bounds.length === 0) return null;
  return `semantic:${role}|${name}|${bounds}`;
}

export function targetIdentity(target: FocusTarget): string | null {
  const stableId = normalise(target.stableId);
  if (stableId.length > 0) return `id:${stableId}`;
  const role = normalise(target.role);
  const name = normalise(target.name);
  const bounds = boundsIdentity(target.bounds);
  if (role.length === 0 || name.length === 0 || bounds.length === 0) return null;
  return `semantic:${role}|${name}|${bounds}`;
}

export function metadataForNode(node: UiNodeSnapshot): NavigationElementMetadata {
  return {
    stableId: node.stableId,
    role: node.role,
    name: node.name,
    bounds: node.bounds,
  };
}

export function metadataForTarget(target: FocusTarget): NavigationElementMetadata {
  return {
    stableId: target.stableId ?? null,
    role: target.role ?? null,
    name: target.name ?? null,
    bounds: target.bounds ?? null,
  };
}

export function focusedTarget(snapshot: StateSnapshot): FocusTarget | null {
  return snapshot.focusedElement.status === "available"
    ? snapshot.focusedElement.value
    : null;
}

export function flattenSnapshot(snapshot: StateSnapshot): readonly IndexedNode[] {
  if (snapshot.uiTree.status !== "available") return [];
  return flattenBoundedUiTree(snapshot.uiTree.value);
}

export function visibleDialog(nodes: readonly IndexedNode[]): IndexedNode | null {
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

export function inSubtree(candidate: IndexedNode, root: IndexedNode): boolean {
  return candidate.node === root.node || candidate.ancestors.includes(root.node);
}

export function activeNodes(snapshot: StateSnapshot): readonly IndexedNode[] {
  const nodes = flattenSnapshot(snapshot);
  const dialog = visibleDialog(nodes);
  return dialog === null ? nodes : nodes.filter((candidate) => inSubtree(candidate, dialog));
}

export function subtreeText(root: IndexedNode): string {
  const parts: string[] = [];
  for (const { node } of flattenBoundedUiTree([root.node])) {
    for (const value of [node.name, node.text]) {
      if (value !== null && value.trim().length > 0) parts.push(value);
    }
  }
  return normalise(parts.join(" "));
}

export function parentNode(indexed: IndexedNode): UiNodeSnapshot | null {
  return indexed.ancestors.at(-1) ?? null;
}

export function focusNode(snapshot: StateSnapshot, nodes: readonly IndexedNode[]): IndexedNode | null {
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


export function localCoverage(result: ExplorationResult, screen: ScreenState): LocalCoverage {
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

export function configured(result: ExplorationResult, required: readonly RemoteKey[]): boolean {
  const configuredKeys = new Set(result.actionOrder);
  return required.every((key) => configuredKeys.has(key));
}

export function directionalCandidate(
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

export function candidateComparator(left: DirectionalCandidate, right: DirectionalCandidate): number {
  if (left.score !== right.score) return left.score - right.score;
  return left.indexed.order - right.indexed.order;
}

export function geometricCandidates(
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

export function reachedIdentitiesForScreen(
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

export function intervalGap(startA: number, endA: number, startB: number, endB: number): number {
  return Math.max(0, Math.max(startA, startB) - Math.min(endA, endB));
}

/** A deliberately tight witness for controls that visually form one row/column. */
export function alignedAdjacent(left: ElementBounds, right: ElementBounds): boolean {
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

export function sameSequence(left: readonly RemoteKey[], right: readonly RemoteKey[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

export function sequenceWith(sequence: readonly RemoteKey[], key: RemoteKey): readonly RemoteKey[] {
  return [...sequence, key];
}

export function attemptSemanticIdentity(attempt: ExplorationActionAttempt): string {
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

export function shortestAttempt(attempts: readonly ExplorationActionAttempt[]): ExplorationActionAttempt | null {
  const ordered = [...attempts].sort((left, right) => (
    left.actionSequence.length - right.actionSequence.length
    || compareText(attemptSemanticIdentity(left), attemptSemanticIdentity(right))
  ));
  return ordered[0] ?? null;
}
