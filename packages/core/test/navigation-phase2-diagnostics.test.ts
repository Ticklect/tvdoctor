import {
  availableObservation,
  unavailableObservation,
  type RemoteKey,
  type StateSnapshot,
  type UiNodeSnapshot,
} from "@tvdoctor/protocol";
import { describe, expect, it } from "vitest";

import {
  createNavigationFocusGraph,
  createNavigationFocusGraphV2,
  diagnoseNavigation,
  NAVIGATION_DIAGNOSTIC_RULES,
  type ExplorationActionAttempt,
  type ExplorationResult,
  type FocusState,
  type ScreenState,
} from "../src/index.js";

interface StateDefinition {
  readonly id: string;
  readonly screenId: string;
  readonly discoveredBy: readonly RemoteKey[];
  readonly snapshot: StateSnapshot;
}

interface ActionDefinition {
  readonly from: string;
  readonly to: string;
  readonly key: RemoteKey;
  readonly outcome?: ExplorationActionAttempt["actionResult"]["outcome"];
  readonly sequence?: readonly RemoteKey[];
}

function uiNode(
  id: string,
  x: number,
  options: {
    readonly focused?: boolean;
    readonly visible?: boolean;
  } = {},
): UiNodeSnapshot {
  return {
    stableId: id,
    role: "button",
    name: id,
    text: null,
    bounds: { x, y: 0, width: 100, height: 60 },
    visible: options.visible ?? true,
    enabled: true,
    focusable: true,
    focused: options.focused ?? false,
    modal: false,
    selectionState: null,
    valueNow: null,
    children: [],
  };
}

function snapshot(
  location: string,
  focusId: string | null,
  tree: readonly UiNodeSnapshot[],
  options: {
    readonly treeComplete?: boolean;
    readonly treeUnavailable?: boolean;
    readonly viewport?: { readonly width: number; readonly height: number };
  } = {},
): StateSnapshot {
  const focusedNode = focusId === null
    ? null
    : tree.find((candidate) => candidate.stableId === focusId);
  const focusedElement = focusId === null
    ? null
    : {
      stableId: focusId,
      role: "button",
      name: focusId,
      bounds: focusedNode?.bounds ?? { x: 0, y: 0, width: 100, height: 60 },
    };
  return {
    capturedAt: "2026-09-30T19:00:00.000Z",
    location: availableObservation(`app://${location}`),
    focusedElement: availableObservation(focusedElement),
    uiTree: options.treeUnavailable
      ? unavailableObservation("ui tree unavailable")
      : availableObservation(tree),
    ...(options.treeComplete === undefined
      ? {}
      : {
        uiTreeMetadata: availableObservation({ truncated: !options.treeComplete }),
      }),
    ...(options.viewport === undefined
      ? {}
      : {
        viewport: availableObservation({
          ...options.viewport,
          deviceScaleFactor: 1,
          scrollX: 0,
          scrollY: 0,
        }),
      }),
  } as StateSnapshot;
}

function result(
  states: readonly StateDefinition[],
  actions: readonly ActionDefinition[],
  actionOrder: readonly RemoteKey[],
): ExplorationResult {
  const stateById = new Map(states.map((state) => [state.id, state]));
  const focusStates: FocusState[] = states.map((state) => ({
    id: state.id,
    screenStateId: state.screenId,
    fingerprint: { value: `focus-${state.id}`, confidence: "high", signals: ["stable-identifiers"] },
    stateFingerprint: `state-${state.id}`,
    confidence: "high",
    firstSeenDepth: state.discoveredBy.length,
    discoveredBy: state.discoveredBy,
    representativeSnapshot: state.snapshot,
  }));
  const screenIds = [...new Set(states.map((state) => state.screenId))];
  const screens: ScreenState[] = screenIds.map((screenId) => {
    const members = states.filter((state) => state.screenId === screenId);
    const first = members[0];
    if (first === undefined) throw new Error("A test screen requires a representative state.");
    return {
      id: screenId,
      fingerprint: { value: `screen-${screenId}`, confidence: "high", signals: ["stable-identifiers"] },
      firstSeenDepth: first.discoveredBy.length,
      discoveredBy: first.discoveredBy,
      representativeSnapshot: first.snapshot,
      focusStateIds: members.map((member) => member.id),
    };
  });
  const screenById = new Map(screens.map((screen) => [screen.id, screen]));
  const focusById = new Map(focusStates.map((state) => [state.id, state]));
  const attempts: ExplorationActionAttempt[] = actions.map((definition, index) => {
    const from = stateById.get(definition.from);
    const to = stateById.get(definition.to);
    const toFocus = focusById.get(definition.to);
    const toScreen = to === undefined ? undefined : screenById.get(to.screenId);
    if (from === undefined || to === undefined || toFocus === undefined || toScreen === undefined) {
      throw new Error("Unknown state in test action.");
    }
    return {
      id: `action-${String(index + 1).padStart(3, "0")}`,
      fromScreenStateId: from.screenId,
      fromFocusStateId: from.id,
      toScreenStateId: to.screenId,
      toFocusStateId: to.id,
      key: definition.key,
      actionSequence: definition.sequence ?? [...from.discoveredBy, definition.key],
      actionResult: {
        key: definition.key,
        outcome: definition.outcome ?? "applied",
        timing: { inputSentAtMs: index + 1 },
      },
      beforeSnapshot: from.snapshot,
      afterSnapshot: to.snapshot,
      observedFingerprint: {
        screen: toScreen.fingerprint,
        focus: toFocus.fingerprint,
        stateValue: toFocus.stateFingerprint,
        confidence: "high",
      },
    };
  });
  return {
    graph: {
      screens: { states: screens, transitions: [] },
      focus: { states: focusStates, transitions: [] },
      actions: attempts,
    },
    termination: { reason: "queue-exhausted", complete: true },
    budgets: { maxActions: 100, maxStates: 100, maxDepth: 20, maxDurationMs: 10_000 },
    actionOrder,
    statistics: {
      physicalActions: attempts.length,
      explorationActions: attempts.length,
      replayActions: 0,
      resetCount: 0,
      replayRestorations: 0,
      visitedStates: focusStates.length,
      screenStates: screens.length,
      focusStates: focusStates.length,
      maximumQueueSize: focusStates.length,
      pendingStates: 0,
      elapsedMs: 1,
      averagePathDepth: 0,
      maximumPathDepth: 0,
      averageReplayLength: 0,
      maximumReplayLength: 0,
      timings: {
        resetMs: 0,
        pathReplayMs: 0,
        driverPressMs: 0,
        actionDispatchMs: 0,
        focusSettlingMs: 0,
        screenSettlingMs: 0,
        snapshotCaptureMs: 0,
        semanticNormalizationMs: 0,
        graphBookkeepingMs: 0,
      },
    },
  };
}

function findingFor(run: ExplorationResult, rule: string) {
  return diagnoseNavigation(run).findings.find((finding) => finding.issue.rule === rule);
}

describe("phase 2 navigation diagnostics", () => {
  it("reports a fully observed inverse-direction asymmetry as heuristic only", () => {
    const tree = [uiNode("a", 0), uiNode("b", 120), uiNode("c", 240)];
    const run = result([
      { id: "a", screenId: "home", discoveredBy: [], snapshot: snapshot("home", "a", tree) },
      { id: "b", screenId: "home", discoveredBy: ["RIGHT"], snapshot: snapshot("home", "b", tree) },
      { id: "c", screenId: "home", discoveredBy: ["RIGHT", "LEFT"], snapshot: snapshot("home", "c", tree) },
    ], [
      { from: "a", to: "b", key: "RIGHT" },
      { from: "b", to: "c", key: "LEFT" },
    ], ["LEFT", "RIGHT"]);

    const finding = findingFor(run, NAVIGATION_DIAGNOSTIC_RULES.directionalAsymmetry);
    expect(finding).toMatchObject({
      classification: "heuristic",
      issue: {
        confidence: "heuristic",
        transition: { action: "LEFT", fromElement: "b", expectedElement: "a", observedElement: "c" },
      },
      source: { relatedActionAttemptId: "action-001" },
    });
    expect(createNavigationFocusGraph(run).problems.map((problem) => problem.issueId))
      .not.toContain(finding?.issue.id);
    expect(createNavigationFocusGraphV2(run).problems).toContainEqual(expect.objectContaining({
      kind: "directional-asymmetry",
      issueId: finding?.issue.id,
      evidenceClassification: "heuristic",
    }));

    const symmetric = result([
      { id: "a", screenId: "home", discoveredBy: [], snapshot: snapshot("home", "a", tree) },
      { id: "b", screenId: "home", discoveredBy: ["RIGHT"], snapshot: snapshot("home", "b", tree) },
    ], [
      { from: "a", to: "b", key: "RIGHT" },
      { from: "b", to: "a", key: "LEFT" },
    ], ["LEFT", "RIGHT"]);
    expect(findingFor(symmetric, NAVIGATION_DIAGNOSTIC_RULES.directionalAsymmetry)).toBeUndefined();

    const inconclusiveReverse = result([
      { id: "a", screenId: "home", discoveredBy: [], snapshot: snapshot("home", "a", tree) },
      { id: "b", screenId: "home", discoveredBy: ["RIGHT"], snapshot: snapshot("home", "b", tree) },
      { id: "c", screenId: "home", discoveredBy: ["RIGHT", "LEFT"], snapshot: snapshot("home", "c", tree) },
    ], [
      { from: "a", to: "b", key: "RIGHT" },
      { from: "b", to: "c", key: "LEFT", outcome: "inconclusive" },
    ], ["LEFT", "RIGHT"]);
    expect(findingFor(inconclusiveReverse, NAVIGATION_DIAGNOSTIC_RULES.directionalAsymmetry)).toBeUndefined();
  });

  it("reports an exactly focused hidden node, and off-screen focus only with explicit viewport evidence", () => {
    const before = snapshot("home", "source", [uiNode("source", 0, { focused: true })]);
    const hidden = snapshot("home", "hidden", [uiNode("hidden", 120, { focused: true, visible: false })]);
    const hiddenRun = result([
      { id: "source", screenId: "home", discoveredBy: [], snapshot: before },
      { id: "hidden", screenId: "home", discoveredBy: ["RIGHT"], snapshot: hidden },
    ], [{ from: "source", to: "hidden", key: "RIGHT" }], ["RIGHT"]);
    expect(findingFor(hiddenRun, NAVIGATION_DIAGNOSTIC_RULES.focusVisibility)).toMatchObject({
      classification: "deterministic",
      issue: { observed: expect.stringMatching(/hidden/u) },
    });

    const offscreenTree = [uiNode("far", 1_400, { focused: true })];
    const offscreen = snapshot("home", "far", offscreenTree, { viewport: { width: 1280, height: 720 } });
    const offscreenRun = result([
      { id: "source", screenId: "home", discoveredBy: [], snapshot: before },
      { id: "far", screenId: "home", discoveredBy: ["RIGHT"], snapshot: offscreen },
    ], [{ from: "source", to: "far", key: "RIGHT" }], ["RIGHT"]);
    expect(findingFor(offscreenRun, NAVIGATION_DIAGNOSTIC_RULES.focusVisibility)).toMatchObject({
      classification: "deterministic",
      issue: { observed: expect.stringMatching(/viewport/u) },
    });

    const noViewport = snapshot("home", "far", offscreenTree);
    const noViewportRun = result([
      { id: "source", screenId: "home", discoveredBy: [], snapshot: before },
      { id: "far", screenId: "home", discoveredBy: ["RIGHT"], snapshot: noViewport },
    ], [{ from: "source", to: "far", key: "RIGHT" }], ["RIGHT"]);
    expect(findingFor(noViewportRun, NAVIGATION_DIAGNOSTIC_RULES.focusVisibility)).toBeUndefined();
  });

  it("distinguishes same-screen focus escape from stale focus after a route change and requires a complete UI tree", () => {
    const source = snapshot("home", "source", [uiNode("source", 0, { focused: true })], { treeComplete: true });
    const escaped = snapshot("home", "ghost", [uiNode("other", 120)], { treeComplete: true });
    const escapeRun = result([
      { id: "source", screenId: "home", discoveredBy: [], snapshot: source },
      { id: "ghost", screenId: "home", discoveredBy: ["RIGHT"], snapshot: escaped },
    ], [{ from: "source", to: "ghost", key: "RIGHT" }], ["RIGHT"]);
    expect(findingFor(escapeRun, NAVIGATION_DIAGNOSTIC_RULES.focusEscape)).toMatchObject({
      classification: "deterministic",
    });
    expect(findingFor(escapeRun, NAVIGATION_DIAGNOSTIC_RULES.staleFocus)).toBeUndefined();

    const stale = snapshot("details", "source", [uiNode("play", 0, { focused: false })], { treeComplete: true });
    const staleRun = result([
      { id: "source", screenId: "home", discoveredBy: [], snapshot: source },
      { id: "stale", screenId: "details", discoveredBy: ["SELECT"], snapshot: stale },
    ], [{ from: "source", to: "stale", key: "SELECT" }], ["SELECT"]);
    expect(findingFor(staleRun, NAVIGATION_DIAGNOSTIC_RULES.staleFocus)).toMatchObject({
      classification: "deterministic",
      issue: { observed: expect.stringMatching(/not present/u) },
    });
    expect(findingFor(staleRun, NAVIGATION_DIAGNOSTIC_RULES.focusEscape)).toBeUndefined();

    const truncated = snapshot("details", "source", [uiNode("play", 0)], { treeComplete: false });
    const truncatedRun = result([
      { id: "source", screenId: "home", discoveredBy: [], snapshot: source },
      { id: "stale", screenId: "details", discoveredBy: ["SELECT"], snapshot: truncated },
    ], [{ from: "source", to: "stale", key: "SELECT" }], ["SELECT"]);
    expect(findingFor(truncatedRun, NAVIGATION_DIAGNOSTIC_RULES.staleFocus)).toBeUndefined();

    const unavailable = snapshot("details", "source", [], { treeUnavailable: true });
    const unavailableRun = result([
      { id: "source", screenId: "home", discoveredBy: [], snapshot: source },
      { id: "stale", screenId: "details", discoveredBy: ["SELECT"], snapshot: unavailable },
    ], [{ from: "source", to: "stale", key: "SELECT" }], ["SELECT"]);
    expect(findingFor(unavailableRun, NAVIGATION_DIAGNOSTIC_RULES.staleFocus)).toBeUndefined();
  });
});
