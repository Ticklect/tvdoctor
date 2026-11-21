import type {
  ElementBounds,
  RemoteKey,
  StateSnapshot,
} from "@tvdoctor/protocol";
import type { ExplorationActionAttempt } from "./graph.js";
import { NAVIGATION_DIAGNOSTIC_RULES } from "./navigation-diagnostic-contracts.js";
import {
  finiteBounds,
  flattenSnapshot,
  focusedTarget,
  metadataForNode,
  metadataForTarget,
  nodeIdentity,
  targetIdentity,
} from "./navigation-diagnostic-context.js";
import {
  actionSource,
  diagnosticTarget,
  elementLabel,
  issue,
  type NavigationRuleContext,
} from "./navigation-diagnostic-findings.js";

const INVERSE_DIRECTION: Readonly<Partial<Record<RemoteKey, RemoteKey>>> = {
  UP: "DOWN",
  DOWN: "UP",
  LEFT: "RIGHT",
  RIGHT: "LEFT",
};

interface TruncationMetadata {
  readonly status: "available" | "unavailable";
  readonly value?: { readonly truncated?: unknown };
}

interface ViewportMetadata {
  readonly status: "available" | "unavailable";
  readonly value?: {
    readonly width?: unknown;
    readonly height?: unknown;
  };
}

function applied(attempt: ExplorationActionAttempt): boolean {
  return attempt.actionResult.key === attempt.key
    && attempt.actionResult.outcome === "applied"
    && attempt.toScreenStateId !== null
    && attempt.toFocusStateId !== null;
}

function treeComplete(snapshot: StateSnapshot): boolean {
  const candidate = snapshot as StateSnapshot & {
    readonly uiTreeMetadata?: TruncationMetadata;
    readonly hierarchyMetadata?: TruncationMetadata;
  };
  const metadata = candidate.uiTreeMetadata ?? candidate.hierarchyMetadata;
  return metadata?.status === "available"
    && metadata.value?.truncated === false;
}

function viewportBounds(snapshot: StateSnapshot): ElementBounds | null {
  const metadata = (snapshot as StateSnapshot & { readonly viewport?: ViewportMetadata }).viewport;
  if (metadata?.status !== "available") return null;
  const width = metadata.value?.width;
  const height = metadata.value?.height;
  if (typeof width !== "number"
    || typeof height !== "number"
    || !Number.isFinite(width)
    || !Number.isFinite(height)
    || width <= 0
    || height <= 0) return null;
  return { x: 0, y: 0, width, height };
}

function fullyOutside(bounds: ElementBounds, viewport: ElementBounds): boolean {
  return bounds.x + bounds.width <= viewport.x
    || bounds.y + bounds.height <= viewport.y
    || bounds.x >= viewport.x + viewport.width
    || bounds.y >= viewport.y + viewport.height;
}

function locationChanged(before: StateSnapshot, after: StateSnapshot): boolean {
  return before.location.status === "available"
    && after.location.status === "available"
    && before.location.value !== after.location.value;
}

export function addDirectionalAsymmetryFindings(
  { result, resetStrategy, append: add }: NavigationRuleContext,
): void {
  const attempts = result.graph.actions.filter(applied);
  for (const forward of attempts) {
    const inverse = INVERSE_DIRECTION[forward.key];
    if (inverse === undefined
      || forward.toFocusStateId === null
      || forward.toScreenStateId === null
      || forward.toFocusStateId === forward.fromFocusStateId
      || forward.toScreenStateId !== forward.fromScreenStateId) continue;

    const reverse = attempts.find((candidate) => (
      candidate.fromScreenStateId === forward.toScreenStateId
      && candidate.fromFocusStateId === forward.toFocusStateId
      && candidate.key === inverse
      && candidate.toScreenStateId === forward.fromScreenStateId
      && candidate.toFocusStateId !== null
    ));
    if (reverse === undefined
      || reverse.toFocusStateId === forward.fromFocusStateId) continue;

    const source = focusedTarget(reverse.beforeSnapshot);
    const expected = focusedTarget(forward.beforeSnapshot);
    const observed = focusedTarget(reverse.afterSnapshot);
    if (source === null || expected === null || observed === null) continue;
    const sourceElement = metadataForTarget(source);
    const expectedElement = metadataForTarget(expected);
    const observedElement = metadataForTarget(observed);
    const classification = "heuristic" as const;
    add({
      classification,
      issue: issue(
        NAVIGATION_DIAGNOSTIC_RULES.directionalAsymmetry,
        classification,
        "medium",
        "Opposite directional inputs are asymmetric",
        "TVDoctor directly observed a directional move and then the opposite direction from its destination, but the second move did not return to the original focus target. This is a review signal, not proof that inverse navigation was intended.",
        reverse.fromScreenStateId,
        `${inverse} may return to ${elementLabel(expectedElement) ?? "the prior focus target"}.`,
        `${inverse} moved to ${elementLabel(observedElement) ?? "a different focus target"}.`,
        {
          fromElement: elementLabel(sourceElement),
          action: inverse,
          expectedElement: elementLabel(expectedElement),
          observedElement: elementLabel(observedElement),
        },
        reverse.actionSequence,
        `${forward.key} was observed from ${elementLabel(expectedElement) ?? "the original target"} to ${elementLabel(sourceElement) ?? "the next target"}; the observed ${inverse} edge then reached ${elementLabel(observedElement) ?? "another target"}.`,
        reverse.id,
        resetStrategy,
        [{
          kind: "inference",
          summary: "Returning to the source on the inverse direction is a navigation-consistency heuristic, not an asserted product requirement.",
          source: forward.id,
          artifact: null,
        }],
      ),
      source: actionSource(reverse, "action-pair", forward.id),
      target: diagnosticTarget(
        reverse.toScreenStateId ?? reverse.fromScreenStateId,
        reverse.toFocusStateId,
        observedElement,
        expectedElement,
        observedElement,
      ),
    });
  }
}

export function addFocusVisibilityFindings(
  { result, resetStrategy, append: add }: NavigationRuleContext,
): void {
  for (const attempt of result.graph.actions) {
    if (!applied(attempt) || attempt.afterSnapshot.uiTree.status !== "available") continue;
    const focused = focusedTarget(attempt.afterSnapshot);
    if (focused === null) continue;
    const identity = targetIdentity(focused);
    if (identity === null) continue;
    const matching = flattenSnapshot(attempt.afterSnapshot).filter((candidate) => (
      nodeIdentity(candidate.node) === identity
    ));
    const matched = matching[0];
    if (matching.length !== 1 || matched === undefined || matched.node.focused !== true) continue;

    const hidden = matched.node.visible === false;
    const bounds = matched.node.bounds;
    const viewport = viewportBounds(attempt.afterSnapshot);
    const outsideViewport = matched.node.visible === true
      && finiteBounds(bounds)
      && viewport !== null
      && fullyOutside(bounds, viewport);
    if (!hidden && !outsideViewport) continue;

    const element = metadataForNode(matched.node);
    const classification = "deterministic" as const;
    const reason = hidden ? "explicitly hidden" : "completely outside the observed viewport";
    add({
      classification,
      issue: issue(
        NAVIGATION_DIAGNOSTIC_RULES.focusVisibility,
        classification,
        "high",
        hidden ? "Focus is on a hidden control" : "Focus is outside the visible viewport",
        hidden
          ? "The same observed UI hierarchy marks the exactly matched focused node as not visible."
          : "The exactly matched focused node has finite bounds completely outside an explicitly observed viewport.",
        attempt.toScreenStateId ?? attempt.fromScreenStateId,
        "The focused target remains visibly present in the observed TV viewport.",
        `${elementLabel(element) ?? "The focused target"} is ${reason}.`,
        {
          fromElement: elementLabel(actionSource(attempt).element),
          action: attempt.key,
          expectedElement: elementLabel(element),
          observedElement: elementLabel(element),
        },
        attempt.actionSequence,
        hidden
          ? "The post-action focused target exactly matched one UI node whose visible flag was false and whose focused flag was true."
          : "The post-action focused target exactly matched one visible focused UI node whose finite rectangle did not intersect the explicitly observed viewport.",
        attempt.id,
        resetStrategy,
      ),
      source: actionSource(attempt),
      target: diagnosticTarget(
        attempt.toScreenStateId ?? attempt.fromScreenStateId,
        attempt.toFocusStateId,
        element,
        element,
        element,
      ),
    });
  }
}

export function addFocusEscapeAndStaleFindings(
  { result, resetStrategy, append: add }: NavigationRuleContext,
): void {
  for (const attempt of result.graph.actions) {
    if (!applied(attempt)
      || attempt.afterSnapshot.uiTree.status !== "available"
      || !treeComplete(attempt.afterSnapshot)) continue;
    const observed = focusedTarget(attempt.afterSnapshot);
    if (observed === null) continue;
    const identity = targetIdentity(observed);
    if (identity === null) continue;
    const matches = flattenSnapshot(attempt.afterSnapshot).filter((candidate) => (
      nodeIdentity(candidate.node) === identity
    ));
    if (matches.length !== 0) continue;

    const observedElement = metadataForTarget(observed);
    const sourceTarget = focusedTarget(attempt.beforeSnapshot);
    const sourceElement = sourceTarget === null ? null : metadataForTarget(sourceTarget);
    const changedScreen = attempt.toScreenStateId !== attempt.fromScreenStateId
      || locationChanged(attempt.beforeSnapshot, attempt.afterSnapshot);
    const rule = changedScreen
      ? NAVIGATION_DIAGNOSTIC_RULES.staleFocus
      : NAVIGATION_DIAGNOSTIC_RULES.focusEscape;
    const classification = "deterministic" as const;
    add({
      classification,
      issue: issue(
        rule,
        classification,
        "high",
        changedScreen
          ? "Focused target is stale after navigation"
          : "Focused target escaped the observed UI tree",
        changedScreen
          ? "After a screen or route change, the driver reported a focused target that was not present anywhere in the simultaneously observed complete UI hierarchy."
          : "The driver reported a focused target that was not present anywhere in the simultaneously observed complete UI hierarchy.",
        attempt.toScreenStateId ?? attempt.fromScreenStateId,
        "The reported focused target is present in the complete post-action UI hierarchy.",
        `${elementLabel(observedElement) ?? "The reported focused target"} is not present in the complete observed UI tree.`,
        {
          fromElement: elementLabel(sourceElement),
          action: attempt.key,
          expectedElement: null,
          observedElement: elementLabel(observedElement),
        },
        attempt.actionSequence,
        "The post-action UI hierarchy was explicitly marked non-truncated, yet no node matched the reported focused target identity.",
        attempt.id,
        resetStrategy,
      ),
      source: actionSource(attempt),
      target: diagnosticTarget(
        attempt.toScreenStateId ?? attempt.fromScreenStateId,
        attempt.toFocusStateId,
        observedElement,
        null,
        observedElement,
      ),
    });
  }
}
