import type { ExplorationActionAttempt } from "./graph.js";
import { NAVIGATION_DIAGNOSTIC_RULES } from "./navigation-diagnostic-contracts.js";
import {
  REQUIRED_DIRECTIONAL_KEYS,
  configured,
  flattenSnapshot,
  focusNode,
  focusedTarget,
  inSubtree,
  localCoverage,
  metadataForNode,
  metadataForTarget,
  nodeIdentity,
  normalise,
  reachedIdentitiesForScreen,
  sameSequence,
  shortestAttempt,
  subtreeText,
  visibleDialog,
} from "./navigation-diagnostic-context.js";
import {
  actionSource,
  diagnosticTarget,
  elementLabel,
  issue,
  type NavigationRuleContext,
} from "./navigation-diagnostic-findings.js";

const HEURISTIC_TRAP_APPLIED_KEYS = [...REQUIRED_DIRECTIONAL_KEYS, "BACK"] as const;
const DISMISS_CONTROL_ROLES: ReadonlySet<string> = new Set(["button", "link"]);
const DISMISS_SEMANTICS = /\b(?:close|dismiss)\b/u;

export function addFocusTrapFindings(
  { result, resetStrategy, append: add }: NavigationRuleContext,
): void {
  if (!configured(result, [...REQUIRED_DIRECTIONAL_KEYS, "SELECT", "BACK"])) return;

  for (const screen of result.graph.screens.states) {
    const coverage = localCoverage(result, screen);
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
    const dialogElement = metadataForNode(dialog.node);
    if (coverage.complete) {
      if (coverage.attempts.some((attempt) => !destinationRemainsInsideDialog(attempt))) continue;
      const backAttempts = coverage.attempts.filter((attempt) => attempt.key === "BACK");
      if (backAttempts.length !== screen.focusStateIds.length
        || backAttempts.some((attempt) => !destinationRemainsInsideDialog(attempt))) continue;

      const proof = shortestAttempt(backAttempts);
      if (proof === null) continue;
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
      continue;
    }

    const attemptsFor = (focusStateId: string, key: ExplorationActionAttempt["key"]): readonly ExplorationActionAttempt[] => (
      coverage.attempts.filter((attempt) => attempt.fromFocusStateId === focusStateId && attempt.key === key)
    );
    const appliedAttempts: ExplorationActionAttempt[] = [];
    let appliedCoverageComplete = true;
    for (const focusStateId of screen.focusStateIds) {
      for (const key of HEURISTIC_TRAP_APPLIED_KEYS) {
        const matches = attemptsFor(focusStateId, key);
        const attempt = matches[0];
        if (matches.length !== 1
          || attempt === undefined
          || attempt.actionResult.key !== key
          || attempt.actionResult.outcome !== "applied"
          || attempt.toFocusStateId === null
          || attempt.toScreenStateId === null
          || !destinationRemainsInsideDialog(attempt)) {
          appliedCoverageComplete = false;
          break;
        }
        appliedAttempts.push(attempt);
      }
      if (!appliedCoverageComplete) break;
      const selectAttempts = attemptsFor(focusStateId, "SELECT");
      const selectAttempt = selectAttempts[0];
      if (selectAttempts.length !== 1
        || selectAttempt === undefined
        || selectAttempt.actionResult.key !== "SELECT"
        || selectAttempt.actionResult.outcome !== "unsupported") {
        appliedCoverageComplete = false;
        break;
      }
    }
    if (!appliedCoverageComplete) continue;

    const reached = reachedIdentitiesForScreen(result, screen.id);
    const dismissCandidates = nodes.filter((candidate) => {
      if (!inSubtree(candidate, dialog)) return false;
      const node = candidate.node;
      if (node.visible !== true
        || node.enabled !== true
        || node.focusable !== false
        || !DISMISS_CONTROL_ROLES.has(normalise(node.role))) return false;
      const identity = nodeIdentity(node);
      if (identity === null || reached.has(identity)) return false;
      const semantics = normalise([node.stableId, node.name, node.text].filter((value) => value !== null).join(" "));
      return DISMISS_SEMANTICS.test(semantics);
    });
    if (dismissCandidates.length !== 1) continue;

    const backAttempts = appliedAttempts.filter((attempt) => attempt.key === "BACK");
    const proof = shortestAttempt(backAttempts);
    if (proof === null) continue;
    const sourceElement = focusedTarget(proof.beforeSnapshot);
    const sourceMetadata = sourceElement === null ? null : metadataForTarget(sourceElement);
    const observedElement = focusedTarget(proof.afterSnapshot);
    if (observedElement === null) continue;
    const observedMetadata = metadataForTarget(observedElement);
    const dismissMetadata = metadataForNode(dismissCandidates[0]?.node ?? dialog.node);
    const classification = "heuristic";
    add({
      classification,
      issue: issue(
        NAVIGATION_DIAGNOSTIC_RULES.focusTrap,
        classification,
        "high",
        "Dialog may be a remote focus trap",
        "Every directional action and Back was applied from every reached focus state and remained inside the entered dialog. Select was explicitly unsupported at every state, while a visible enabled close or dismiss control is pointer-only.",
        screen.id,
        "A documented remote action, including activation where safe, exits the dialog.",
        "Tested directional actions and Back remain in the dialog; activation was withheld and the observed dismiss affordance is not remote-focusable.",
        {
          fromElement: elementLabel(sourceMetadata),
          action: "BACK",
          expectedElement: elementLabel(dismissMetadata),
          observedElement: elementLabel(observedMetadata),
        },
        proof.actionSequence,
        `${String(screen.focusStateIds.length)} focus states have complete applied directional and Back coverage inside the dialog; Select is unsupported for every state and ${elementLabel(dismissMetadata) ?? "one close control"} is visible, enabled, and non-focusable.`,
        proof.id,
        resetStrategy,
      ),
      source: actionSource(proof, "action-attempt", entry.id, false),
      target: diagnosticTarget(
        screen.id,
        proof.toFocusStateId,
        dialogElement,
        dismissMetadata,
        observedMetadata,
      ),
    });
  }
}

export function addOverlayFocusLeakFindings(
  { result, resetStrategy, append: add }: NavigationRuleContext,
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

export function addConsentWallFindings(
  { result, resetStrategy, append: add }: NavigationRuleContext,
): void {
  const initialState = result.graph.focus.states.find((state) => state.discoveredBy.length === 0);
  if (initialState === undefined) return;
  const snapshot = initialState.representativeSnapshot;
  const nodes = flattenSnapshot(snapshot);
  const dialog = visibleDialog(nodes);
  if (dialog === null) return;
  const focused = focusNode(snapshot, nodes);
  if (focused === null || !inSubtree(focused, dialog)) return;
  if (!/\b(?:consent|cookies?)\b|\bprivacy (?:choice|notice|settings|wall)\b/u.test(subtreeText(dialog))) {
    return;
  }

  const dialogElement = metadataForNode(dialog.node);
  const focusedElement = metadataForNode(focused.node);
  const classification = "deterministic" as const;
  const consentIssue = issue(
    NAVIGATION_DIAGNOSTIC_RULES.consentWall,
    classification,
    "medium",
    "Application starts behind a consent wall",
    "The initial focused state contains an explicitly identified visible modal consent surface; exploration cannot proceed into catalogue content without changing persistent consent state.",
    initialState.screenStateId,
    "The audit records the consent wall and explores only after the user-selected consent action is replayable from a fresh reset.",
    "The initial remote focus is inside a visible consent modal.",
    null,
    [],
    "The root snapshot contained one visible modal dialog, its semantic text explicitly identified consent or cookies, and exact focus matched a descendant control.",
    "screen-analysis",
    resetStrategy,
  );
  add({
    classification,
    issue: {
      ...consentIssue,
      reproduction: {
        status: "unavailable",
        reason: "A root consent wall is screen-state evidence; no single remote transition proves entry or exit.",
      },
    },
    source: {
      kind: "screen-analysis",
      screenStateId: initialState.screenStateId,
      focusStateId: initialState.id,
      element: dialogElement,
      actionAttemptId: null,
      relatedActionAttemptId: null,
      actionSequence: [],
      locallyComplete: null,
    },
    target: diagnosticTarget(
      initialState.screenStateId,
      initialState.id,
      dialogElement,
      null,
      focusedElement,
    ),
  });
}
