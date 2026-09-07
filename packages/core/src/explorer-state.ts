import type { RemoteKey, StateSnapshot, UiNodeSnapshot } from "@tvdoctor/protocol";

import type { NormalisedRepetitionCompressionOptions } from "./explorer-contracts.js";
import type { ComputedSnapshotFingerprint } from "./fingerprint.js";
import type { ScreenState } from "./graph.js";

export interface MutableScreenState {
  readonly id: string;
  readonly identity: string;
  readonly fingerprint: ScreenState["fingerprint"];
  readonly firstSeenDepth: number;
  readonly discoveredBy: readonly RemoteKey[];
  readonly representativeSnapshot: StateSnapshot;
  readonly focusStateIds: string[];
}

export interface InternalFocusState {
  readonly id: string;
  readonly screenStateId: string;
  readonly identity: string;
  readonly fingerprint: ComputedSnapshotFingerprint;
  readonly firstSeenDepth: number;
  readonly discoveredBy: readonly RemoteKey[];
  readonly representativeSnapshot: StateSnapshot;
  readonly repetitionGroup: string | null;
  readonly frontierPriority: number;
  scheduled: boolean;
}

export interface RegisteredState {
  readonly state: InternalFocusState;
  readonly isNew: boolean;
  readonly newScreen: boolean;
}

export interface RepetitionGroup {
  readonly key: string;
  readonly representatives: InternalFocusState[];
  expandedRepresentatives: number;
}

export function explorerId(prefix: string, sequence: number): string {
  return `${prefix}-${String(sequence).padStart(4, "0")}`;
}

export function sequenceWith(
  sequence: readonly RemoteKey[],
  key: RemoteKey,
): readonly RemoteKey[] {
  return [...sequence, key];
}

function snapshotNodeCount(snapshot: StateSnapshot): number | null {
  if (snapshot.uiTree.status !== "available") return null;
  const count = (nodes: readonly UiNodeSnapshot[]): number => nodes.reduce(
    (total, node) => total + 1 + count(node.children),
    0,
  );
  return count(snapshot.uiTree.value);
}

function snapshotStructure(snapshot: StateSnapshot): readonly string[] | null {
  if (snapshot.uiTree.status !== "available") return null;
  const flatten = (nodes: readonly UiNodeSnapshot[], depth: number): readonly string[] => nodes.flatMap((node) => [
    `${String(depth)}:${node.stableId ?? ""}|${node.role ?? ""}|${String(node.visible)}|${String(node.enabled)}|${String(node.focusable)}|${String(node.modal)}`,
    ...flatten(node.children, depth + 1),
  ]);
  return flatten(snapshot.uiTree.value, 0);
}

export function snapshotDifference(expected: StateSnapshot, observed: StateSnapshot): string {
  const expectedLocation = expected.location.status === "available"
    ? expected.location.value
    : "unavailable";
  const observedLocation = observed.location.status === "available"
    ? observed.location.value
    : "unavailable";
  const expectedFocus = expected.focusedElement.status === "available"
    ? expected.focusedElement.value?.stableId ?? expected.focusedElement.value?.role ?? "none"
    : "unavailable";
  const observedFocus = observed.focusedElement.status === "available"
    ? observed.focusedElement.value?.stableId ?? observed.focusedElement.value?.role ?? "none"
    : "unavailable";
  const expectedNodes = snapshotNodeCount(expected);
  const observedNodes = snapshotNodeCount(observed);
  const expectedStructure = snapshotStructure(expected);
  const observedStructure = snapshotStructure(observed);
  let firstDifference = "";
  if (expectedStructure !== null && observedStructure !== null) {
    const differenceIndex = expectedStructure.findIndex(
      (value, index) => value !== observedStructure[index],
    );
    if (differenceIndex >= 0) {
      firstDifference = ` First structural difference at node ${String(differenceIndex + 1)}: ${expectedStructure[differenceIndex]} -> ${observedStructure[differenceIndex] ?? "missing"}.`;
    } else if (expectedStructure.length !== observedStructure.length) {
      firstDifference = ` First structural difference at node ${String(Math.min(expectedStructure.length, observedStructure.length) + 1)}: tree length changed.`;
    }
  }
  const locationDifference = expectedLocation === observedLocation
    ? ""
    : ` Location ${expectedLocation} -> ${observedLocation}.`;
  return `UI nodes ${String(expectedNodes ?? "unavailable")} -> ${String(observedNodes ?? "unavailable")}; focus ${expectedFocus} -> ${observedFocus}.${locationDifference}${firstDifference}`;
}

function normaliseRepeatedIdentifier(value: string | null): string | null {
  if (value === null) return null;
  const normalised = value.normalize("NFKC").trim().toLowerCase();
  if (!/\d/u.test(normalised)) return null;
  return normalised.replace(/\d+/gu, "#");
}

function dimensionBucket(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value / 16)) : "?";
}

interface LocatedNode {
  readonly node: UiNodeSnapshot;
  readonly ancestors: readonly UiNodeSnapshot[];
  readonly siblings: readonly UiNodeSnapshot[];
}

function locateFocusedNode(snapshot: StateSnapshot): LocatedNode | null {
  if (snapshot.uiTree.status !== "available") return null;
  const focusedTarget = snapshot.focusedElement.status === "available"
    ? snapshot.focusedElement.value
    : null;
  const visit = (
    nodes: readonly UiNodeSnapshot[],
    ancestors: readonly UiNodeSnapshot[],
  ): LocatedNode | null => {
    for (const node of nodes) {
      const matchesTarget = focusedTarget !== null
        && focusedTarget !== undefined
        && focusedTarget.stableId !== undefined
        && node.stableId === focusedTarget.stableId;
      if (node.focused === true || matchesTarget) {
        return { node, ancestors, siblings: nodes };
      }
      const nested = visit(node.children, [...ancestors, node]);
      if (nested !== null) return nested;
    }
    return null;
  };
  return visit(snapshot.uiTree.value, []);
}

/**
 * Recognise only explicit generated sibling patterns (for example card-17).
 * Names/text are ignored because content titles differ between equivalent
 * carousel cells; role, interaction state, dimensions, and ancestry remain.
 */
export function repetitionGroupKey(
  snapshot: StateSnapshot,
  fingerprint: ComputedSnapshotFingerprint,
  compression: NormalisedRepetitionCompressionOptions,
): string | null {
  if (!compression.enabled) return null;
  const located = locateFocusedNode(snapshot);
  if (located === null || located.node.focusable !== true) return null;
  const identifierPattern = normaliseRepeatedIdentifier(located.node.stableId);
  if (identifierPattern === null) return null;
  const equivalentSiblings = located.siblings.filter((sibling) => (
    sibling.focusable === true
    && sibling.role === located.node.role
    && sibling.enabled === located.node.enabled
    && sibling.selectionState === located.node.selectionState
    && normaliseRepeatedIdentifier(sibling.stableId) === identifierPattern
  ));
  if (equivalentSiblings.length < compression.minimumEquivalentSiblings) return null;

  const ancestry = located.ancestors.map((ancestor) => (
    `${normaliseRepeatedIdentifier(ancestor.stableId) ?? ancestor.stableId ?? ""}:${ancestor.role ?? ""}`
  )).join("/");
  const bounds = located.node.bounds;
  const dimensions = bounds === null
    ? "?"
    // Horizontal carousels scroll as focus moves deeper into the rail, which
    // shifts the viewport-relative y coordinate without changing structural
    // identity. Width and height buckets are sufficient for equivalence.
    : `${dimensionBucket(bounds.width)},${dimensionBucket(bounds.height)}`;
  return [
    fingerprint.screenIdentity,
    ancestry,
    identifierPattern,
    located.node.role ?? "",
    String(located.node.enabled),
    // Visibility is excluded: horizontal scrolling changes which cards are in
    // the viewport without changing structural identity. A card scrolled out
    // of view is still the same interactive control as its visible siblings.
    "visible-excluded",
    located.node.selectionState ?? "",
    dimensions,
  ].join("\u001d");
}
