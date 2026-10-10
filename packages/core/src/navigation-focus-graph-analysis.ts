import type { ActionOutcome, RemoteKey } from "@tvdoctor/protocol";
import type { ExplorationResult, ExplorationTerminationReason } from "./explorer-contracts.js";

export type NavigationFrontierCategory = "budget" | "safety" | "capability" | "termination";

export type NavigationFrontierReason = ExplorationTerminationReason | "repetition-compression";

export interface NavigationFocusGraphCoverageSummary {
  readonly observedScreens: number;
  readonly observedFocusTargets: number;
  readonly observedTransitions: number;
  /** Focus-state keys for which every configured graph action was successfully applied. */
  readonly locallyCompleteFocusTargetKeys: readonly string[];
  readonly frontier: {
    readonly status: "complete" | "deferred";
    readonly category: NavigationFrontierCategory | null;
    readonly reason: NavigationFrontierReason;
    readonly remainingFrontierEntries: number;
    readonly remainingCandidateActions: number;
    readonly deferredStates: number;
  };
}

export interface NavigationFocusGraphCycle {
  /** Stable focus-state keys in one observed strongly-connected component. */
  readonly focusTargetKeys: readonly string[];
  /** Stable observed transition keys entirely inside the component. */
  readonly transitionKeys: readonly string[];
}

interface ObservedTransition {
  readonly key: string;
  readonly fromFocusTargetKey: string;
  readonly toFocusTargetKey: string | null;
  readonly outcome: ActionOutcome;
  readonly evidenceClassification: "verified-fact" | "unobservable";
}

export function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function comparePath(left: readonly RemoteKey[], right: readonly RemoteKey[]): number {
  return left.length - right.length
    || compareText(JSON.stringify(left), JSON.stringify(right));
}

export function shortestKnownPath(paths: readonly (readonly RemoteKey[])[]): readonly RemoteKey[] {
  const candidate = [...paths].sort(comparePath)[0];
  return candidate === undefined ? [] : [...candidate];
}

export function verifiedPathsToFocus(
  result: ExplorationResult,
  focusStateId: string,
  fallback: readonly RemoteKey[],
): readonly (readonly RemoteKey[])[] {
  return [
    fallback,
    ...result.graph.actions
      .filter((attempt) => (
        attempt.toFocusStateId === focusStateId
        && attempt.actionResult.outcome === "applied"
      ))
      .map((attempt) => attempt.actionSequence),
  ];
}

export function stableScreenKey(
  screenKeyById: ReadonlyMap<string, string>,
  screenStateId: string,
): string {
  const key = screenKeyById.get(screenStateId);
  if (key === undefined) {
    throw new Error(`Navigation diagnostic references unknown screen state ${screenStateId}.`);
  }
  return key;
}

export function stableFocusKey(
  focusKeyById: ReadonlyMap<string, string>,
  focusStateId: string | null,
): string | null {
  if (focusStateId === null) return null;
  const key = focusKeyById.get(focusStateId);
  if (key === undefined) {
    throw new Error(`Navigation diagnostic references unknown focus state ${focusStateId}.`);
  }
  return key;
}

function locallyCompleteFocusKeys(
  result: ExplorationResult,
  configuredActions: readonly RemoteKey[],
  focusKeyById: ReadonlyMap<string, string>,
): readonly string[] {
  if (configuredActions.length === 0) return [];
  return result.graph.focus.states.flatMap((state): readonly string[] => {
    const applied = new Set(
      result.graph.actions
        .filter((attempt) => (
          attempt.fromFocusStateId === state.id
          && attempt.actionResult.key === attempt.key
          && attempt.actionResult.outcome === "applied"
        ))
        .map((attempt) => attempt.key),
    );
    if (!configuredActions.every((action) => applied.has(action))) return [];
    const key = stableFocusKey(focusKeyById, state.id);
    return key === null ? [] : [key];
  }).sort(compareText);
}

function frontierCategory(result: ExplorationResult): NavigationFrontierCategory | null {
  if ((result.statistics.deferredStates ?? 0) > 0 && result.termination.complete) return "safety";
  switch (result.termination.reason) {
    case "max-actions":
    case "max-states":
    case "max-depth":
    case "max-duration":
      return "budget";
    case "remote-input-unavailable":
    case "restoration-unavailable":
    case "restoration-failed":
    case "settling-exhausted":
      return "capability";
    case "queue-exhausted":
      return null;
    default:
      return "termination";
  }
}

export function coverageSummary(
  result: ExplorationResult,
  configuredActions: readonly RemoteKey[],
  focusKeyById: ReadonlyMap<string, string>,
  observedTransitionCount: number,
): NavigationFocusGraphCoverageSummary {
  const deferredStates = result.statistics.deferredStates ?? 0;
  // Frontier exhaustion and verified navigation coverage are different facts.
  // A safety-withheld SELECT or truncated observer may leave no queued states,
  // but still leave unverified edges. Report an empty *known frontier* without
  // ever upgrading the separate overall coverage status to complete.
  const frontierExhausted = result.termination.reason === "queue-exhausted"
    && (result.termination.remainingFrontierEntries ?? 0) === 0
    && (result.termination.remainingCandidateActions ?? 0) === 0
    && deferredStates === 0;
  return {
    observedScreens: result.graph.screens.states.length,
    observedFocusTargets: result.graph.focus.states.length,
    observedTransitions: observedTransitionCount,
    locallyCompleteFocusTargetKeys: locallyCompleteFocusKeys(result, configuredActions, focusKeyById),
    frontier: {
      status: frontierExhausted ? "complete" : "deferred",
      category: frontierExhausted ? null : frontierCategory(result),
      reason: deferredStates > 0 && result.termination.complete
        ? "repetition-compression"
        : result.termination.reason,
      remainingFrontierEntries: result.termination.remainingFrontierEntries ?? 0,
      remainingCandidateActions: result.termination.remainingCandidateActions ?? 0,
      deferredStates,
    },
  };
}

export function observedCycles(
  transitions: readonly ObservedTransition[],
): readonly NavigationFocusGraphCycle[] {
  const eligible = transitions.filter((transition) => (
    transition.outcome === "applied"
    && transition.evidenceClassification === "verified-fact"
    && transition.toFocusTargetKey !== null
  ));
  const nodeSet = new Set<string>();
  const adjacency = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  for (const transition of eligible) {
    const from = transition.fromFocusTargetKey;
    const to = transition.toFocusTargetKey;
    if (to === null) continue;
    nodeSet.add(from);
    nodeSet.add(to);
    adjacency.set(from, [...(adjacency.get(from) ?? []), to]);
    reverse.set(to, [...(reverse.get(to) ?? []), from]);
    if (!adjacency.has(to)) adjacency.set(to, []);
    if (!reverse.has(from)) reverse.set(from, []);
  }

  const nodes = [...nodeSet].sort(compareText);
  const visited = new Set<string>();
  const finishOrder: string[] = [];
  for (const start of nodes) {
    if (visited.has(start)) continue;
    visited.add(start);
    const stack: { node: string; index: number }[] = [{ node: start, index: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame === undefined) break;
      const neighbours = adjacency.get(frame.node) ?? [];
      const next = neighbours[frame.index];
      if (next !== undefined) {
        frame.index += 1;
        if (!visited.has(next)) {
          visited.add(next);
          stack.push({ node: next, index: 0 });
        }
        continue;
      }
      finishOrder.push(frame.node);
      stack.pop();
    }
  }

  const assigned = new Set<string>();
  const components: string[][] = [];
  for (const start of [...finishOrder].reverse()) {
    if (assigned.has(start)) continue;
    assigned.add(start);
    const component: string[] = [];
    const stack = [start];
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined) break;
      component.push(node);
      for (const next of reverse.get(node) ?? []) {
        if (assigned.has(next)) continue;
        assigned.add(next);
        stack.push(next);
      }
    }
    components.push(component.sort(compareText));
  }

  return components.flatMap((focusTargetKeys): readonly NavigationFocusGraphCycle[] => {
    const keySet = new Set(focusTargetKeys);
    const transitionKeys = eligible
      .filter((transition) => (
        transition.toFocusTargetKey !== null
        && keySet.has(transition.fromFocusTargetKey)
        && keySet.has(transition.toFocusTargetKey)
      ))
      .map((transition) => transition.key)
      .sort(compareText);
    const isCycle = focusTargetKeys.length > 1 || eligible.some((transition) => (
      transition.fromFocusTargetKey === focusTargetKeys[0]
      && transition.toFocusTargetKey === focusTargetKeys[0]
    ));
    return isCycle ? [{ focusTargetKeys, transitionKeys }] : [];
  }).sort((left, right) => compareText(
    JSON.stringify(left.focusTargetKeys),
    JSON.stringify(right.focusTargetKeys),
  ));
}
