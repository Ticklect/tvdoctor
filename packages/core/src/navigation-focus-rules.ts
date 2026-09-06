import type { FocusTarget, UiNodeSnapshot } from "@tvdoctor/protocol";
import type { ExplorationActionAttempt, FocusState } from "./graph.js";
import type { StateSnapshot } from "@tvdoctor/protocol";
import { NAVIGATION_DIAGNOSTIC_RULES } from "./navigation-diagnostic-contracts.js";
import {
  DIRECTIONAL_KEYS,
  INTERACTIVE_ROLES,
  REQUIRED_DIRECTIONAL_KEYS,
  activeNodes,
  alignedAdjacent,
  attemptSemanticIdentity,
  compareText,
  configured,
  directionalCandidate,
  finiteBounds,
  flattenSnapshot,
  focusNode,
  focusedTarget,
  geometricCandidates,
  isTvFocusable,
  localCoverage,
  metadataForNode,
  metadataForTarget,
  nodeIdentity,
  normalise,
  parentNode,
  reachedIdentitiesForScreen,
  targetIdentity,
  type DirectionalCandidate,
  type IndexedNode,
} from "./navigation-diagnostic-context.js";
import {
  actionSource,
  diagnosticTarget,
  elementLabel,
  issue,
  type NavigationRuleContext,
} from "./navigation-diagnostic-findings.js";

interface UnreachableWitness {
  readonly attempt: ExplorationActionAttempt;
  readonly direction: DirectionalCandidate;
  readonly candidateNode: UiNodeSnapshot;
  readonly observed: FocusTarget;
}

export function addLostFocusFindings(
  { result, resetStrategy, append: add }: NavigationRuleContext,
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

export function addSelfLoopFindings(
  { result, resetStrategy, append: add }: NavigationRuleContext,
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

export function addUnreachableFindings(
  { result, resetStrategy, append: add }: NavigationRuleContext,
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
        || !isTvFocusable(focusedNode.node)) {
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
          || !isTvFocusable(sourceIndexed.node)
          || !finiteBounds(sourceIndexed.node.bounds)) continue;
        const observedNodes = activeNodes(attempt.afterSnapshot);
        const observedIndexed = focusNode(attempt.afterSnapshot, observedNodes);
        if (observedIndexed === null
          || nodeIdentity(observedIndexed.node) !== observedIdentity
          || observedIndexed.node.visible !== true
          || observedIndexed.node.enabled !== true
          || !isTvFocusable(observedIndexed.node)) continue;
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

export function addUnexpectedJumpFindings(
  { result, resetStrategy, append: add }: NavigationRuleContext,
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
