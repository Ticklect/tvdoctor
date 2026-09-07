import { NAVIGATION_DIAGNOSTIC_RULES } from "./navigation-diagnostic-contracts.js";
import {
  focusedTarget,
  metadataForTarget,
  sameSequence,
  sequenceWith,
} from "./navigation-diagnostic-context.js";
import {
  actionSource,
  diagnosticTarget,
  elementLabel,
  issue,
  type NavigationRuleContext,
} from "./navigation-diagnostic-findings.js";

export function addBackBehaviourFindings(
  { result, resetStrategy, append: add }: NavigationRuleContext,
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
