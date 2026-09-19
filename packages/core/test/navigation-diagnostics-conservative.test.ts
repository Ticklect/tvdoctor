import {
  availableObservation,
  type ActionOutcome,
  type ElementBounds,
  type FocusTarget,
  type RemoteKey,
  type StateSnapshot,
  type UiNodeSnapshot,
} from "@tvdoctor/protocol";
import { describe, expect, it } from "vitest";

import {
  diagnoseNavigation,
  NAVIGATION_DIAGNOSTIC_RULES,
  type ExplorationActionAttempt,
  type ExplorationResult,
  type FocusState,
  type ScreenState,
} from "../src/index.js";

interface TestState {
  readonly id: string;
  readonly screenId: string;
  readonly discoveredBy: readonly RemoteKey[];
  readonly snapshot: StateSnapshot;
}

interface ActionDefinition {
  readonly from: string;
  readonly to: string;
  readonly key: RemoteKey;
  readonly outcome?: ActionOutcome;
  readonly sequence?: readonly RemoteKey[];
}

function node(
  stableId: string | null,
  role: string | null,
  bounds: ElementBounds | null,
  options: {
    readonly children?: readonly UiNodeSnapshot[];
    readonly enabled?: boolean;
    readonly focusable?: boolean;
    readonly focused?: boolean;
    readonly modal?: boolean;
    readonly name?: string | null;
    readonly text?: string | null;
    readonly visible?: boolean;
  } = {},
): UiNodeSnapshot {
  return {
    stableId,
    role,
    name: options.name === undefined ? stableId : options.name,
    text: options.text ?? null,
    bounds,
    visible: options.visible ?? true,
    enabled: options.enabled ?? true,
    focusable: options.focusable ?? false,
    focused: options.focused ?? false,
    modal: options.modal ?? false,
    selectionState: null,
    valueNow: null,
    children: options.children ?? [],
  };
}

function control(
  stableId: string,
  bounds: ElementBounds,
  focused = false,
  options: {
    readonly focusable?: boolean;
    readonly name?: string;
  } = {},
): UiNodeSnapshot {
  return node(stableId, "button", bounds, {
    focusable: options.focusable ?? true,
    focused,
    name: options.name ?? stableId,
  });
}

function target(stableId: string, bounds: ElementBounds): FocusTarget {
  return { stableId, role: "button", name: stableId, bounds };
}

function snapshot(
  location: string,
  focus: FocusTarget,
  tree: readonly UiNodeSnapshot[],
): StateSnapshot {
  return {
    capturedAt: "2026-09-19T12:00:00.000Z",
    location: availableObservation(location),
    focusedElement: availableObservation(focus),
    uiTree: availableObservation(tree),
  };
}

function stateFingerprint(id: string): FocusState["fingerprint"] {
  return {
    value: `fingerprint-${id}`,
    confidence: "high",
    signals: ["stable-identifiers"],
  };
}

function makeResult(
  states: readonly TestState[],
  actionOrder: readonly RemoteKey[],
  definitions: readonly ActionDefinition[],
): ExplorationResult {
  const stateById = new Map(states.map((state) => [state.id, state]));
  const screenIds = [...new Set(states.map((state) => state.screenId))];
  const focusStates: FocusState[] = states.map((state) => ({
    id: state.id,
    screenStateId: state.screenId,
    fingerprint: stateFingerprint(state.id),
    stateFingerprint: `state-${state.id}`,
    confidence: "high",
    firstSeenDepth: state.discoveredBy.length,
    discoveredBy: state.discoveredBy,
    representativeSnapshot: state.snapshot,
  }));
  const screenStates: ScreenState[] = screenIds.map((screenId) => {
    const members = states.filter((state) => state.screenId === screenId);
    const representative = members[0];
    if (representative === undefined) throw new Error("Test screen requires a representative state.");
    return {
      id: screenId,
      fingerprint: stateFingerprint(screenId),
      firstSeenDepth: representative.discoveredBy.length,
      discoveredBy: representative.discoveredBy,
      representativeSnapshot: representative.snapshot,
      focusStateIds: members.map((state) => state.id),
    };
  });
  const actions: ExplorationActionAttempt[] = definitions.map((definition, index) => {
    const from = stateById.get(definition.from);
    const to = stateById.get(definition.to);
    if (from === undefined || to === undefined) throw new Error("Unknown test action state.");
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
        screen: stateFingerprint(to.screenId),
        focus: stateFingerprint(to.id),
        stateValue: `state-${to.id}`,
        confidence: "high",
      },
    };
  });
  return {
    graph: {
      screens: { states: screenStates, transitions: [] },
      focus: { states: focusStates, transitions: [] },
      actions,
    },
    termination: { reason: "queue-exhausted", complete: true },
    budgets: { maxActions: 200, maxStates: 100, maxDepth: 20, maxDurationMs: 10_000 },
    actionOrder,
    statistics: {
      physicalActions: actions.length,
      explorationActions: actions.length,
      replayActions: 0,
      resetCount: 0,
      replayRestorations: 0,
      visitedStates: focusStates.length,
      screenStates: screenStates.length,
      focusStates: focusStates.length,
      maximumQueueSize: focusStates.length,
      pendingStates: 0,
      elapsedMs: 0,
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

function landmarkScreen(
  label: string,
  focusId: string,
  location = "app://tv",
): StateSnapshot {
  const bounds = { x: 20, y: 20, width: 100, height: 60 };
  return snapshot(location, target(focusId, bounds), [
    node(`main-${label.toLowerCase()}`, "main", null, {
      name: label,
      children: [control(focusId, bounds, true)],
    }),
  ]);
}

function unexpectedJumpFindings(result: ExplorationResult) {
  return diagnoseNavigation(result).findings.filter((finding) => (
    finding.issue.rule === NAVIGATION_DIAGNOSTIC_RULES.unexpectedJump
  ));
}

describe("conservative Back semantics", () => {
  it("reports Back only when Select entered a semantically different screen", () => {
    const states: TestState[] = [
      { id: "home", screenId: "screen-home", discoveredBy: [], snapshot: landmarkScreen("Home", "open-details") },
      { id: "details", screenId: "screen-details", discoveredBy: ["SELECT"], snapshot: landmarkScreen("Details", "details-play") },
      { id: "search", screenId: "screen-search", discoveredBy: ["SELECT", "BACK"], snapshot: landmarkScreen("Search", "search-query") },
    ];
    const result = makeResult(states, ["SELECT", "BACK"], [
      { from: "home", to: "details", key: "SELECT" },
      { from: "details", to: "search", key: "BACK" },
    ]);
    expect(diagnoseNavigation(result).findings).toContainEqual(expect.objectContaining({
      classification: "deterministic",
      issue: expect.objectContaining({ rule: NAVIGATION_DIAGNOSTIC_RULES.backBehaviour }),
    }));
  });

  it("suppresses structural screen-state churn inside the same semantic context", () => {
    const states: TestState[] = [
      {
        id: "search-empty",
        screenId: "screen-search-empty",
        discoveredBy: [],
        snapshot: landmarkScreen("Search", "search-key-n", "app://tv/search"),
      },
      {
        id: "search-populated",
        screenId: "screen-search-populated",
        discoveredBy: ["SELECT"],
        snapshot: landmarkScreen("Search", "search-key-n", "app://tv/search?query=n"),
      },
      {
        id: "home",
        screenId: "screen-home",
        discoveredBy: ["SELECT", "BACK"],
        snapshot: landmarkScreen("Home", "home-nav-home", "app://tv/home"),
      },
    ];
    const result = makeResult(states, ["SELECT", "BACK"], [
      { from: "search-empty", to: "search-populated", key: "SELECT" },
      { from: "search-populated", to: "home", key: "BACK" },
    ]);
    expect(diagnoseNavigation(result).findings.some((finding) => (
      finding.issue.rule === NAVIGATION_DIAGNOSTIC_RULES.backBehaviour
    ))).toBe(false);
  });
});

describe("rectangle-aware directional geometry", () => {
  function directionalState(
    id: string,
    screenId: string,
    discoveredBy: readonly RemoteKey[],
    focusId: string,
    focusBounds: ElementBounds,
    controls: readonly { readonly id: string; readonly bounds: ElementBounds }[],
  ): TestState {
    return {
      id,
      screenId,
      discoveredBy,
      snapshot: snapshot("app://tv/grid", target(focusId, focusBounds), [
        node("group", "group", null, {
          children: controls.map((candidate) => control(
            candidate.id,
            candidate.bounds,
            candidate.id === focusId,
          )),
        }),
      ]),
    };
  }

  it("does not flag a legitimate diagonal keypad edge with a small rectangle cross-gap", () => {
    const source = { x: 80, y: 0, width: 60, height: 60 };
    const space = { x: 20, y: 65, width: 120, height: 60 };
    const deletion = { x: 150, y: 65, width: 60, height: 60 };
    const controls = [
      { id: "key-o", bounds: source },
      { id: "key-space", bounds: space },
      { id: "key-delete", bounds: deletion },
    ];
    const states = [
      directionalState("source", "screen-grid", [], "key-o", source, controls),
      directionalState("space", "screen-grid", ["LEFT"], "key-space", space, controls),
      directionalState("delete", "screen-grid", ["DOWN"], "key-delete", deletion, controls),
    ];
    const result = makeResult(states, ["DOWN"], [{ from: "source", to: "delete", key: "DOWN" }]);
    expect(unexpectedJumpFindings(result)).toEqual([]);
  });

  it("does not use centre offset to penalize an edge target under a very wide source", () => {
    const source = { x: 0, y: 100, width: 600, height: 80 };
    const play = { x: 0, y: 0, width: 100, height: 60 };
    const watchlist = { x: 250, y: 0, width: 120, height: 60 };
    const controls = [
      { id: "episodes", bounds: source },
      { id: "play", bounds: play },
      { id: "watchlist", bounds: watchlist },
    ];
    const states = [
      directionalState("source", "screen-details", [], "episodes", source, controls),
      directionalState("play", "screen-details", ["UP"], "play", play, controls),
      directionalState("watchlist", "screen-details", ["RIGHT"], "watchlist", watchlist, controls),
    ];
    const result = makeResult(states, ["UP"], [{ from: "source", to: "play", key: "UP" }]);
    expect(unexpectedJumpFindings(result)).toEqual([]);
  });

  it("still reports a verified off-axis jump when an aligned reached alternative exists", () => {
    const source = { x: 0, y: 0, width: 100, height: 60 };
    const adjacent = { x: 120, y: 0, width: 100, height: 60 };
    const offAxis = { x: 260, y: 900, width: 100, height: 60 };
    const controls = [
      { id: "source", bounds: source },
      { id: "adjacent", bounds: adjacent },
      { id: "off-axis", bounds: offAxis },
    ];
    const states = [
      directionalState("source-state", "screen-row", [], "source", source, controls),
      directionalState("adjacent-state", "screen-row", ["LEFT"], "adjacent", adjacent, controls),
      directionalState("off-axis-state", "screen-row", ["RIGHT"], "off-axis", offAxis, controls),
    ];
    const result = makeResult(states, ["RIGHT"], [
      { from: "source-state", to: "off-axis-state", key: "RIGHT" },
    ]);
    expect(unexpectedJumpFindings(result)).toHaveLength(1);
    expect(unexpectedJumpFindings(result)[0]).toMatchObject({
      classification: "heuristic",
      target: {
        expectedElement: { stableId: "adjacent" },
        observedElement: { stableId: "off-axis" },
      },
    });
  });
});

describe("focus-trap evidence boundary", () => {
  const allKeys: readonly RemoteKey[] = ["UP", "DOWN", "LEFT", "RIGHT", "SELECT", "BACK"];
  const primaryBounds = { x: 100, y: 100, width: 120, height: 70 };
  const kidsBounds = { x: 240, y: 100, width: 120, height: 70 };
  const closeBounds = { x: 390, y: 60, width: 40, height: 40 };

  function modalTree(focusId: "profile-primary" | "profile-kids", closeFocusable = false): readonly UiNodeSnapshot[] {
    return [
      node("profile-dialog", "dialog", { x: 60, y: 50, width: 420, height: 240 }, {
        modal: true,
        name: "Choose a profile",
        children: [
          control("profile-primary", primaryBounds, focusId === "profile-primary"),
          control("profile-kids", kidsBounds, focusId === "profile-kids"),
          control("dialog-close", closeBounds, false, {
            focusable: closeFocusable,
            name: "Close dialog",
          }),
        ],
      }),
    ];
  }

  function modalStates(closeFocusable = false): readonly TestState[] {
    const homeBounds = { x: 10, y: 10, width: 120, height: 60 };
    return [
      {
        id: "home",
        screenId: "screen-home",
        discoveredBy: [],
        snapshot: snapshot("app://tv", target("open-profiles", homeBounds), [
          node("home-main", "main", null, {
            name: "Home",
            children: [control("open-profiles", homeBounds, true)],
          }),
        ]),
      },
      {
        id: "primary",
        screenId: "screen-profile",
        discoveredBy: ["SELECT"],
        snapshot: snapshot("app://tv", target("profile-primary", primaryBounds), modalTree("profile-primary", closeFocusable)),
      },
      {
        id: "kids",
        screenId: "screen-profile",
        discoveredBy: ["SELECT", "RIGHT"],
        snapshot: snapshot("app://tv", target("profile-kids", kidsBounds), modalTree("profile-kids", closeFocusable)),
      },
    ];
  }

  function modalActions(selectOutcome: ActionOutcome, backExit = false): readonly ActionDefinition[] {
    const local = (from: "primary" | "kids", key: RemoteKey, to: "primary" | "kids"): ActionDefinition => ({
      from,
      to,
      key,
      ...(key === "SELECT" ? { outcome: selectOutcome } : {}),
    });
    return [
      { from: "home", to: "primary", key: "SELECT" },
      local("primary", "UP", "primary"),
      local("primary", "DOWN", "primary"),
      local("primary", "LEFT", "primary"),
      local("primary", "RIGHT", "kids"),
      local("primary", "SELECT", "primary"),
      { from: "primary", to: backExit ? "home" : "primary", key: "BACK" },
      local("kids", "UP", "kids"),
      local("kids", "DOWN", "kids"),
      local("kids", "LEFT", "primary"),
      local("kids", "RIGHT", "kids"),
      local("kids", "SELECT", "kids"),
      { from: "kids", to: backExit ? "home" : "kids", key: "BACK" },
    ];
  }

  it("emits a heuristic trap only when Select is unsupported and a pointer-only dismiss control is visible", () => {
    const result = makeResult(modalStates(), allKeys, modalActions("unsupported"));
    const traps = diagnoseNavigation(result).findings.filter((finding) => (
      finding.issue.rule === NAVIGATION_DIAGNOSTIC_RULES.focusTrap
    ));
    expect(traps).toHaveLength(1);
    expect(traps[0]).toMatchObject({
      classification: "heuristic",
      issue: {
        confidence: "heuristic",
        evidence: [expect.objectContaining({ kind: "heuristic-warning" })],
      },
      target: {
        expectedElement: { stableId: "dialog-close" },
      },
    });
  });

  it("keeps fully applied Select evidence deterministic", () => {
    const result = makeResult(modalStates(), allKeys, modalActions("applied"));
    const traps = diagnoseNavigation(result).findings.filter((finding) => (
      finding.issue.rule === NAVIGATION_DIAGNOSTIC_RULES.focusTrap
    ));
    expect(traps).toHaveLength(1);
    expect(traps[0]?.classification).toBe("deterministic");
  });

  it("does not infer a heuristic trap without pointer-only dismiss evidence or when Back exits", () => {
    const focusableClose = makeResult(modalStates(true), allKeys, modalActions("unsupported"));
    const backExit = makeResult(modalStates(), allKeys, modalActions("unsupported", true));
    for (const result of [focusableClose, backExit]) {
      expect(diagnoseNavigation(result).findings.some((finding) => (
        finding.issue.rule === NAVIGATION_DIAGNOSTIC_RULES.focusTrap
      ))).toBe(false);
    }
  });

  it("does not treat failed Select as policy-withheld activation evidence", () => {
    const result = makeResult(modalStates(), allKeys, modalActions("failed"));
    expect(diagnoseNavigation(result).findings.some((finding) => (
      finding.issue.rule === NAVIGATION_DIAGNOSTIC_RULES.focusTrap
    ))).toBe(false);
  });
});
