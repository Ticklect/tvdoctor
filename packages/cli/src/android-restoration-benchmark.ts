import type { ExplorationResult } from "@tvdoctor/core";
import type { AndroidStateSnapshot, AndroidUiNodeSnapshot } from "@tvdoctor/driver-android";
import type { RemoteKey } from "@tvdoctor/protocol";
import type { JsonValue } from "@tvdoctor/reporters";

export type AndroidRestorationBenchmarkMode = "verified-local" | "verified-live-only";
export interface AndroidRestorationBenchmarkPolicyState {
  readonly focusStateId: string;
  readonly safeActions: readonly RemoteKey[];
  readonly reusedSafeActions: readonly RemoteKey[];
}

function stableIdBase(value: string | null): string | null {
  if (value === null) return null;
  return value.replace(/#[^#]*$/u, "").slice(0, 256);
}

function compactText(value: string | null): string | null {
  if (value === null) return null;
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length === 0 ? null : compact.slice(0, 256);
}

function flatten(nodes: readonly AndroidUiNodeSnapshot[]): readonly AndroidUiNodeSnapshot[] {
  const result: AndroidUiNodeSnapshot[] = [];
  const pending = [...nodes];
  while (pending.length > 0 && result.length < 2_048) {
    const node = pending.shift();
    if (node === undefined) break;
    result.push(node);
    pending.push(...node.children);
  }
  return result;
}

function control(node: AndroidUiNodeSnapshot | undefined): JsonValue | null {
  if (node === undefined) return null;
  return {
    stableId: node.stableId,
    stableIdBase: stableIdBase(node.stableId),
    name: compactText(node.name),
    text: compactText(node.text),
    role: compactText(node.role),
    focusable: node.focusable,
    clickable: node.clickable,
  };
}

function stateEvidence(state: ExplorationResult["graph"]["focus"]["states"][number]): JsonValue {
  const snapshot = state.representativeSnapshot as AndroidStateSnapshot;
  const nodes = snapshot.uiTree.status === "available" ? flatten(snapshot.uiTree.value) : [];
  const focusedStableId = snapshot.focusedElement.status === "available"
    ? snapshot.focusedElement.value?.stableId ?? null
    : null;
  const focused = nodes.find((node) => node.focused === true)
    ?? nodes.find((node) => focusedStableId !== null && node.stableId === focusedStableId);
  const actionable = nodes
    .filter((node) => node.visible !== false && node.enabled !== false
      && (node.focusable === true || node.clickable === true))
    .slice(0, 256)
    .map((node) => control(node));
  return {
    id: state.id,
    screenStateId: state.screenStateId,
    firstSeenDepth: state.firstSeenDepth,
    path: state.discoveredBy,
    stateFingerprint: state.stateFingerprint,
    focusFingerprint: state.fingerprint.value,
    location: snapshot.location.status === "available" ? snapshot.location.value : null,
    focusedControl: control(focused),
    actionableControls: actionable,
    actionableControlCount: actionable.length,
  };
}

export function buildAndroidRestorationBenchmarkEvidence(
  result: ExplorationResult,
  targetPackage: string,
  mode: AndroidRestorationBenchmarkMode,
  policyStates: readonly AndroidRestorationBenchmarkPolicyState[],
): JsonValue {
  const sourceStateIds = new Set(result.graph.actions.map((action) => action.fromFocusStateId));
  const attemptedByState = new Map<string, Set<RemoteKey>>();
  for (const action of result.graph.actions) {
    const attempted = attemptedByState.get(action.fromFocusStateId) ?? new Set<RemoteKey>();
    attempted.add(action.key);
    attemptedByState.set(action.fromFocusStateId, attempted);
  }
  const completedPolicyStates = policyStates.filter((state) => {
    const attempted = attemptedByState.get(state.focusStateId) ?? new Set<RemoteKey>();
    const reused = new Set(state.reusedSafeActions);
    return state.safeActions.every((key) => attempted.has(key) || reused.has(key));
  });
  const failedRestorationDestinations = new Set(
    (result.restorationDiagnostics ?? [])
      .filter((entry) => entry.status === "failed")
      .map((entry) => entry.destinationStateId),
  );
  const restorationCycles = new Map<number, { successful: boolean; destinationStateId: string }>();
  for (const entry of result.restorationDiagnostics ?? []) {
    const cycle = restorationCycles.get(entry.restorationCycleNumber) ?? {
      successful: false,
      destinationStateId: entry.destinationStateId,
    };
    cycle.successful ||= entry.status === "success";
    restorationCycles.set(entry.restorationCycleNumber, cycle);
  }
  return JSON.parse(JSON.stringify({
    schema: "tvdoctor.android-restoration-product-value/v1",
    targetPackage,
    restorationMode: mode,
    focusStates: result.graph.focus.states.map((state) => stateEvidence(state)),
    screens: result.graph.screens.states.map((screen) => ({
      id: screen.id,
      firstSeenDepth: screen.firstSeenDepth,
      path: screen.discoveredBy,
      location: screen.representativeSnapshot.location.status === "available"
        ? screen.representativeSnapshot.location.value
        : null,
    })),
    transitions: result.graph.actions.map((action) => ({
      id: action.id,
      fromFocusStateId: action.fromFocusStateId,
      toFocusStateId: action.toFocusStateId,
      fromScreenStateId: action.fromScreenStateId,
      toScreenStateId: action.toScreenStateId,
      action: action.key,
      path: action.actionSequence,
      outcome: action.actionResult.outcome,
    })),
    branchEvidence: {
      discoveredStates: result.graph.focus.states.length,
      enteredPolicyStates: policyStates.length,
      completedPolicyStates: completedPolicyStates.map((state) => state.focusStateId),
      expandedSourceStates: sourceStateIds.size,
      restorationFailureDestinations: [...failedRestorationDestinations],
      terminalRestorationFailureDestinations: [...restorationCycles.values()]
        .filter((cycle) => !cycle.successful)
        .map((cycle) => cycle.destinationStateId),
    },
    statistics: result.statistics,
    termination: result.termination,
  })) as JsonValue;
}
