import {
  availableObservation,
  unavailableObservation,
  type FocusTarget,
  type RemoteKey,
  type StateSnapshot,
  type UiNodeSnapshot,
} from "@tvdoctor/protocol";
import { describe, expect, it } from "vitest";

import {
  diagnoseNavigation,
  NAVIGATION_DIAGNOSTIC_RULES,
  NAVIGATION_UI_TREE_LIMITS,
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

function node(
  stableId: string | null,
  role: string | null,
  bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null,
  options: {
    readonly children?: readonly UiNodeSnapshot[];
    readonly enabled?: boolean;
    readonly focusable?: boolean;
    readonly focused?: boolean;
    readonly modal?: boolean;
    readonly name?: string | null;
    readonly visible?: boolean;
  } = {},
): UiNodeSnapshot {
  return {
    stableId,
    role,
    name: options.name === undefined ? stableId : options.name,
    text: null,
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
  x: number,
  y: number,
  options: {
    readonly enabled?: boolean;
    readonly focusable?: boolean;
    readonly focused?: boolean;
  } = {},
): UiNodeSnapshot {
  return node(stableId, "button", { x, y, width: 100, height: 60 }, {
    enabled: options.enabled ?? true,
    focusable: options.focusable ?? true,
    focused: options.focused ?? false,
  });
}

function target(stableId: string, x: number, y: number): FocusTarget {
  return {
    stableId,
    role: "button",
    name: stableId,
    bounds: { x, y, width: 100, height: 60 },
  };
}

function snapshot(
  screenId: string,
  focus: FocusTarget | null,
  tree: readonly UiNodeSnapshot[],
): StateSnapshot {
  return {
    capturedAt: "2026-08-20T12:00:00.000Z",
    location: availableObservation(`app://${screenId}`),
    focusedElement: availableObservation(focus),
    uiTree: availableObservation(tree),
  };
}

function unavailableFocusSnapshot(
  screenId: string,
  tree: readonly UiNodeSnapshot[],
): StateSnapshot {
  return {
    capturedAt: "2026-08-20T12:00:00.000Z",
    location: availableObservation(`app://${screenId}`),
    focusedElement: unavailableObservation("focus observation unsupported"),
    uiTree: availableObservation(tree),
  };
}

function stateFingerprint(id: string): FocusState["fingerprint"] {
  return { value: `fingerprint-${id}`, confidence: "high", signals: ["stable-identifiers"] };
}

function makeResult(
  states: readonly TestState[],
  actionOrder: readonly RemoteKey[],
  actionDefinitions: readonly {
    readonly from: string;
    readonly to: string;
    readonly key: RemoteKey;
    readonly sequence?: readonly RemoteKey[];
  }[],
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
    if (representative === undefined) throw new Error("A test screen must have a state.");
    return {
      id: screenId,
      fingerprint: stateFingerprint(screenId),
      firstSeenDepth: representative.discoveredBy.length,
      discoveredBy: representative.discoveredBy,
      representativeSnapshot: representative.snapshot,
      focusStateIds: members.map((state) => state.id),
    };
  });
  const actions: ExplorationActionAttempt[] = actionDefinitions.map((definition, index) => {
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
        outcome: "applied",
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
    budgets: { maxActions: 100, maxStates: 100, maxDepth: 20, maxDurationMs: 10_000 },
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

function completeActions(stateIds: readonly string[], keys: readonly RemoteKey[]): readonly {
  readonly from: string;
  readonly to: string;
  readonly key: RemoteKey;
}[] {
  return stateIds.flatMap((stateId) => keys.map((key) => ({ from: stateId, to: stateId, key })));
}

function rules(result: ExplorationResult): readonly string[] {
  return diagnoseNavigation(result).findings.map((finding) => finding.issue.rule);
}

const ALL_KEYS: readonly RemoteKey[] = ["UP", "DOWN", "LEFT", "RIGHT", "SELECT", "BACK"];

interface JumpScenario {
  readonly states: readonly TestState[];
  readonly action: {
    readonly from: string;
    readonly to: string;
    readonly key: "RIGHT";
  };
}

function jumpScenario(
  internalPrefix: string,
  semanticPrefix: string,
  screenId: string,
  yOffset = 0,
  includeUnrelatedControl = false,
): JumpScenario {
  const sourceId = `${internalPrefix}-source`;
  const adjacentId = `${internalPrefix}-adjacent`;
  const distantId = `${internalPrefix}-distant`;
  const sourceElement = `${semanticPrefix}-source`;
  const adjacentElement = `${semanticPrefix}-adjacent`;
  const distantElement = `${semanticPrefix}-distant`;
  const tree = [node(`${semanticPrefix}-row`, "group", null, {
    children: [
      control(sourceElement, 0, yOffset, { focused: true }),
      control(adjacentElement, 120, yOffset),
      control(distantElement, 900, yOffset + 300),
      ...(includeUnrelatedControl
        ? [control(`${semanticPrefix}-unrelated`, -800, yOffset + 900)]
        : []),
    ],
  })];
  return {
    states: [
      {
        id: sourceId,
        screenId,
        discoveredBy: [],
        snapshot: snapshot(screenId, target(sourceElement, 0, yOffset), tree),
      },
      {
        id: adjacentId,
        screenId,
        discoveredBy: ["LEFT"],
        snapshot: snapshot(screenId, target(adjacentElement, 120, yOffset), tree),
      },
      {
        id: distantId,
        screenId,
        discoveredBy: ["RIGHT"],
        snapshot: snapshot(screenId, target(distantElement, 900, yOffset + 300), tree),
      },
    ],
    action: { from: sourceId, to: distantId, key: "RIGHT" },
  };
}

function findingIdForSource(result: ExplorationResult, stableId: string): string | undefined {
  return diagnoseNavigation(result).findings.find((finding) => (
    finding.source.element?.stableId === stableId
  ))?.issue.id;
}

describe("navigation diagnostics", () => {
  function resultForUntrustedTree(tree: readonly UiNodeSnapshot[]): ExplorationResult {
    const focused = control("focus", 0, 0, { focused: true });
    const state: TestState = {
      id: "focus-untrusted",
      screenId: "screen-untrusted",
      discoveredBy: [],
      snapshot: snapshot("untrusted", target("focus", 0, 0), [focused, ...tree]),
    };
    return makeResult([state], ALL_KEYS, completeActions([state.id], ALL_KEYS));
  }

  it("rejects cyclic driver snapshots with a bounded diagnostic error", () => {
    const children: UiNodeSnapshot[] = [];
    const cyclic = node("cyclic", "group", null, { children });
    children.push(cyclic);

    expect(() => diagnoseNavigation(resultForUntrustedTree([cyclic])))
      .toThrow(/repeated or cyclic node reference/u);
  });

  it("rejects a 10,000-level driver snapshot without recursive stack exhaustion", () => {
    let deep = node("depth-10000", "group", null);
    for (let depth = 9_999; depth >= 0; depth -= 1) {
      deep = node(`depth-${String(depth)}`, "group", null, { children: [deep] });
    }

    expect(() => diagnoseNavigation(resultForUntrustedTree([deep])))
      .toThrow(/navigation diagnostic depth limit/u);
  });

  it("enforces independent node and text bounds on untrusted snapshots", () => {
    const explosive = Array.from(
      { length: NAVIGATION_UI_TREE_LIMITS.maxNodes },
      (_, index) => node(`wide-${String(index)}`, "group", null),
    );
    expect(() => diagnoseNavigation(resultForUntrustedTree(explosive)))
      .toThrow(/navigation diagnostic node limit/u);

    const oversizedText: UiNodeSnapshot = {
      ...node("oversized", "group", null),
      text: "x".repeat(NAVIGATION_UI_TREE_LIMITS.maxTextLength + 1),
    };
    expect(() => diagnoseNavigation(resultForUntrustedTree([oversizedText])))
      .toThrow(/navigation diagnostic text limit/u);
  });

  it("rejects an unknown navigation reset strategy", () => {
    expect(() => diagnoseNavigation(
      resultForUntrustedTree([]),
      { resetStrategy: "factory-reset" as never },
    )).toThrow(/resetStrategy/u);
  });

  it("reports an observed non-null to null focus loss, but not unavailable focus", () => {
    const beforeTree = [node("root", "main", null, {
      children: [control("source", 0, 0, { focused: true }), control("other", 120, 0)],
    })];
    const afterTree = [node("root", "main", null, {
      children: [control("source", 0, 0), control("other", 120, 0)],
    })];
    const states: TestState[] = [
      { id: "focus-source", screenId: "screen-home", discoveredBy: [], snapshot: snapshot("home", target("source", 0, 0), beforeTree) },
      { id: "focus-none", screenId: "screen-home", discoveredBy: ["RIGHT"], snapshot: snapshot("home", null, afterTree) },
    ];
    const lost = makeResult(states, ["RIGHT"], [{ from: "focus-source", to: "focus-none", key: "RIGHT" }]);
    expect(rules(lost)).toContain(NAVIGATION_DIAGNOSTIC_RULES.lostFocus);
    expect(diagnoseNavigation(lost).findings.find((finding) => (
      finding.issue.rule === NAVIGATION_DIAGNOSTIC_RULES.lostFocus
    ))?.issue.id).toBe("TVDOCTOR-NAV-2937C7512311150D64592F97793458C1");

    const unavailableState: TestState = {
      id: "focus-unknown",
      screenId: "screen-home",
      discoveredBy: ["RIGHT"],
      snapshot: unavailableFocusSnapshot("home", afterTree),
    };
    const unavailable = makeResult(
      [states[0] as TestState, unavailableState],
      ["RIGHT"],
      [{ from: "focus-source", to: "focus-unknown", key: "RIGHT" }],
    );
    expect(rules(unavailable)).not.toContain(NAVIGATION_DIAGNOSTIC_RULES.lostFocus);
  });

  it("reports only a self-loop with a demonstrably reachable aligned focusable candidate", () => {
    const tree = [node("row", "group", null, {
      children: [control("source", 0, 0, { focused: true }), control("next", 120, 0)],
    })];
    const states: TestState[] = [
      { id: "focus-source", screenId: "screen-row", discoveredBy: [], snapshot: snapshot("row", target("source", 0, 0), tree) },
      { id: "focus-next", screenId: "screen-row", discoveredBy: ["DOWN"], snapshot: snapshot("row", target("next", 120, 0), tree) },
    ];
    const result = makeResult(states, ["RIGHT"], [{ from: "focus-source", to: "focus-source", key: "RIGHT" }]);
    const finding = diagnoseNavigation(result).findings.find((item) => item.issue.rule === NAVIGATION_DIAGNOSTIC_RULES.selfLoop);
    expect(finding?.issue.id).toBe("TVDOCTOR-NAV-2D6796445C199E680CD655BA5CB1EFF4");
    expect(finding?.target.expectedElement?.stableId).toBe("next");
    expect(finding?.issue.evidence.map((evidence) => evidence.kind)).toEqual([
      "deterministic-failure",
      "inference",
    ]);

    const unreachableCandidate = makeResult(
      [states[0] as TestState],
      ["RIGHT"],
      [{ from: "focus-source", to: "focus-source", key: "RIGHT" }],
    );
    expect(rules(unreachableCandidate)).not.toContain(NAVIGATION_DIAGNOSTIC_RULES.selfLoop);
  });

  it("reports a stable adjacent remote-unreachable sibling and ignores an ungrouped pointer-only control", () => {
    const tree = [node("root", "main", null, {
      children: [
        node("actions", "group", null, {
          children: [
            control("watch", 0, 0, { focused: true }),
            control("more-info", 120, 0, { focusable: false }),
          ],
        }),
        node("preview-region", "group", null, {
          children: [control("preview-pointer", 900, 500, { focusable: false })],
        }),
      ],
    })];
    const state: TestState = {
      id: "focus-watch",
      screenId: "screen-home",
      discoveredBy: ["RIGHT"],
      snapshot: snapshot("home", target("watch", 0, 0), tree),
    };
    const result = makeResult(
      [state],
      ALL_KEYS,
      completeActions([state.id], ALL_KEYS),
    );
    const unreachable = diagnoseNavigation(result).findings.filter((finding) => (
      finding.issue.rule === NAVIGATION_DIAGNOSTIC_RULES.unreachable
    ));
    expect(unreachable.map((finding) => finding.target.element?.stableId)).toEqual(["more-info"]);
    expect(unreachable[0]?.issue.id).toBe("TVDOCTOR-NAV-E21405ED4313F3F1C582666F75FAF1DD");
    expect(unreachable[0]?.source.locallyComplete).toBe(true);
    expect(unreachable[0]?.source).toMatchObject({
      kind: "action-attempt",
      actionAttemptId: "action-004",
      actionSequence: ["RIGHT", "RIGHT"],
      element: { stableId: "watch" },
    });
    expect(unreachable[0]?.issue.transition).toEqual({
      fromElement: "watch",
      action: "RIGHT",
      expectedElement: "more-info",
      observedElement: "watch",
    });
    expect(unreachable[0]?.issue.evidence[0]?.source).toBe("action-004");
    expect(unreachable[0]?.issue.reproduction).toMatchObject({
      status: "available",
      originalSequence: [{ key: "RIGHT", repeat: 2 }],
    });
  });

  it("accepts a visible enabled focused roving control even when sequential focusability is false", () => {
    const tree = [node("row", "group", null, {
      children: [
        control("roving-active", 0, 0, { focusable: false, focused: true }),
        control("unreachable", 120, 0, { focusable: false }),
      ],
    })];
    const state: TestState = {
      id: "focus-roving-active",
      screenId: "screen-roving",
      discoveredBy: [],
      snapshot: snapshot("roving", target("roving-active", 0, 0), tree),
    };
    const result = makeResult(
      [state],
      ALL_KEYS,
      completeActions([state.id], ALL_KEYS),
    );

    expect(diagnoseNavigation(result).deterministicFindings).toEqual([
      expect.objectContaining({
        issue: expect.objectContaining({ rule: NAVIGATION_DIAGNOSTIC_RULES.unreachable }),
        target: expect.objectContaining({
          element: expect.objectContaining({ stableId: "unreachable" }),
        }),
      }),
    ]);
  });

  it("uses the exact caption-like DOWN skip as non-empty reachability reproduction", () => {
    const captionTree = (focused: "background" | "font"): readonly UiNodeSnapshot[] => [
      node("caption-menu", "group", null, {
        children: [
          control("font", 0, 0, { focused: focused === "font" }),
          control("text-colour", 0, 120, { focusable: false }),
          control("background", 0, 240, { focused: focused === "background" }),
        ],
      }),
    ];
    const font: TestState = {
      id: "focus-font",
      screenId: "screen-captions",
      discoveredBy: ["SELECT", "DOWN"],
      snapshot: snapshot("captions", target("font", 0, 0), captionTree("font")),
    };
    const background: TestState = {
      id: "focus-background",
      screenId: "screen-captions",
      discoveredBy: ["SELECT", "DOWN", "DOWN"],
      snapshot: snapshot("captions", target("background", 0, 240), captionTree("background")),
    };
    const actions = completeActions([font.id, background.id], ALL_KEYS).map((action) => (
      action.from === font.id && action.key === "DOWN"
        ? { ...action, to: background.id }
        : action
    ));
    const result = makeResult([font, background], ALL_KEYS, actions);
    const unreachable = diagnoseNavigation(result).deterministicFindings.filter((finding) => (
      finding.issue.rule === NAVIGATION_DIAGNOSTIC_RULES.unreachable
    ));

    expect(unreachable.map((finding) => finding.target.element?.stableId)).toEqual(["text-colour"]);
    expect(unreachable[0]?.issue.id).toBe("TVDOCTOR-NAV-952E8EA142E550C5D049835FD451F851");
    expect(unreachable[0]?.source.actionSequence).toEqual(["SELECT", "DOWN", "DOWN"]);
    expect(unreachable[0]?.issue.transition).toEqual({
      fromElement: "font",
      action: "DOWN",
      expectedElement: "text-colour",
      observedElement: "background",
    });
    const reproduction = unreachable[0]?.issue.reproduction;
    expect(reproduction?.status).toBe("available");
    if (reproduction?.status === "available") {
      expect(reproduction.originalSequence).toEqual([
        { key: "SELECT", repeat: 1 },
        { key: "DOWN", repeat: 2 },
      ]);
      expect(reproduction.originalSequence).not.toHaveLength(0);
    }
  });

  it("suppresses reachability findings until every local state/action is resolved", () => {
    const tree = [node("actions", "group", null, {
      children: [
        control("watch", 0, 0, { focused: true }),
        control("more-info", 120, 0, { focusable: false }),
      ],
    })];
    const state: TestState = {
      id: "focus-watch",
      screenId: "screen-home",
      discoveredBy: [],
      snapshot: snapshot("home", target("watch", 0, 0), tree),
    };
    const incomplete = makeResult(
      [state],
      ALL_KEYS,
      completeActions([state.id], ALL_KEYS).slice(0, -1),
    );
    expect(rules(incomplete)).not.toContain(NAVIGATION_DIAGNOSTIC_RULES.unreachable);
  });

  it("does not call a disabled control or unavailable focus observation unreachable", () => {
    const tree = (candidateEnabled: boolean): readonly UiNodeSnapshot[] => [
      node("actions", "group", null, {
        children: [
          control("watch", 0, 0, { focused: true }),
          control("more-info", 120, 0, { enabled: candidateEnabled, focusable: false }),
        ],
      }),
    ];
    const disabled: TestState = {
      id: "focus-watch",
      screenId: "screen-home",
      discoveredBy: [],
      snapshot: snapshot("home", target("watch", 0, 0), tree(false)),
    };
    const disabledResult = makeResult(
      [disabled],
      ALL_KEYS,
      completeActions([disabled.id], ALL_KEYS),
    );
    expect(rules(disabledResult)).not.toContain(NAVIGATION_DIAGNOSTIC_RULES.unreachable);

    const unavailable: TestState = {
      ...disabled,
      snapshot: unavailableFocusSnapshot("home", tree(true)),
    };
    const unavailableResult = makeResult(
      [unavailable],
      ALL_KEYS,
      completeActions([unavailable.id], ALL_KEYS),
    );
    expect(rules(unavailableResult)).not.toContain(NAVIGATION_DIAGNOSTIC_RULES.unreachable);
  });

  it("reports an entered fully expanded modal trap and requires SELECT coverage", () => {
    const homeTree = [control("open-profile", 0, 0, { focused: true })];
    const modalTree = [node("profile-dialog", "dialog", { x: 100, y: 100, width: 500, height: 400 }, {
      children: [control("profile", 200, 220, { focused: true })],
      modal: true,
      name: "Choose a profile",
    })];
    const home: TestState = {
      id: "focus-home",
      screenId: "screen-home",
      discoveredBy: [],
      snapshot: snapshot("home", target("open-profile", 0, 0), homeTree),
    };
    const profile: TestState = {
      id: "focus-profile",
      screenId: "screen-profile",
      discoveredBy: ["SELECT"],
      snapshot: snapshot("profile", target("profile", 200, 220), modalTree),
    };
    const complete = makeResult(
      [home, profile],
      ALL_KEYS,
      [
        { from: home.id, to: profile.id, key: "SELECT" },
        ...completeActions([profile.id], ALL_KEYS),
      ],
    );
    expect(rules(complete)).toContain(NAVIGATION_DIAGNOSTIC_RULES.focusTrap);
    expect(diagnoseNavigation(complete).findings.find((finding) => (
      finding.issue.rule === NAVIGATION_DIAGNOSTIC_RULES.focusTrap
    ))?.issue.id).toBe("TVDOCTOR-NAV-1DA9753F61DD7E9BBB46391D86C5192F");

    const withoutSelect = ALL_KEYS.filter((key) => key !== "SELECT");
    const incomplete = makeResult(
      [home, profile],
      withoutSelect,
      [
        { from: home.id, to: profile.id, key: "SELECT" },
        ...completeActions([profile.id], withoutSelect),
      ],
    );
    expect(rules(incomplete)).not.toContain(NAVIGATION_DIAGNOSTIC_RULES.focusTrap);
    const rootModal = makeResult(
      [{ ...profile, discoveredBy: [] }],
      ALL_KEYS,
      completeActions([profile.id], ALL_KEYS),
    );
    expect(rules(rootModal)).not.toContain(NAVIGATION_DIAGNOSTIC_RULES.focusTrap);
  });

  it("suppresses traps for modeless roles, a real Back exit, and same-screen focus behind the modal", () => {
    const home: TestState = {
      id: "focus-home",
      screenId: "screen-home",
      discoveredBy: [],
      snapshot: snapshot("home", target("open", 0, 0), [control("open", 0, 0, { focused: true })]),
    };
    const dialogTree = (modal: boolean, focused: "behind" | "inside"): readonly UiNodeSnapshot[] => [
      node("root", "main", null, {
        children: [
          control("behind", 0, 0, { focused: focused === "behind" }),
          node("dialog", "dialog", { x: 100, y: 100, width: 500, height: 400 }, {
            children: [control("inside", 200, 220, { focused: focused === "inside" })],
            modal,
            name: "Dialog",
          }),
        ],
      }),
    ];
    const inside = (modal: boolean): TestState => ({
      id: "focus-inside",
      screenId: "screen-dialog",
      discoveredBy: ["SELECT"],
      snapshot: snapshot("dialog", target("inside", 200, 220), dialogTree(modal, "inside")),
    });

    const modeless = inside(false);
    const modelessResult = makeResult(
      [home, modeless],
      ALL_KEYS,
      [
        { from: home.id, to: modeless.id, key: "SELECT" },
        ...completeActions([modeless.id], ALL_KEYS),
      ],
    );
    expect(rules(modelessResult)).not.toContain(NAVIGATION_DIAGNOSTIC_RULES.focusTrap);

    const modal = inside(true);
    const withBackExit = makeResult(
      [home, modal],
      ALL_KEYS,
      [
        { from: home.id, to: modal.id, key: "SELECT" },
        ...completeActions([modal.id], ALL_KEYS).map((action) => (
          action.key === "BACK" ? { ...action, to: home.id } : action
        )),
      ],
    );
    expect(rules(withBackExit)).not.toContain(NAVIGATION_DIAGNOSTIC_RULES.focusTrap);

    const behind: TestState = {
      id: "focus-behind",
      screenId: "screen-dialog",
      discoveredBy: ["SELECT", "RIGHT"],
      snapshot: snapshot("dialog", target("behind", 0, 0), dialogTree(true, "behind")),
    };
    const focusLeak = makeResult(
      [home, modal, behind],
      ALL_KEYS,
      [
        { from: home.id, to: modal.id, key: "SELECT" },
        ...completeActions([modal.id, behind.id], ALL_KEYS).map((action) => (
          action.from === modal.id && action.key === "RIGHT"
            ? { ...action, to: behind.id }
            : action
        )),
      ],
    );
    expect(rules(focusLeak)).not.toContain(NAVIGATION_DIAGNOSTIC_RULES.focusTrap);
  });

  it("reports focus outside a newly appearing dialog and ignores a pre-existing dialog", () => {
    const behind = control("opener", 0, 0, { focused: true });
    const dialog = node("settings-dialog", "dialog", { x: 300, y: 100, width: 500, height: 500 }, {
      children: [control("dialog-control", 380, 180)],
      modal: true,
      name: "Settings",
    });
    const before = snapshot("home", target("opener", 0, 0), [node("root", "main", null, { children: [behind] })]);
    const after = snapshot("settings", target("opener", 0, 0), [node("root", "main", null, { children: [behind, dialog] })]);
    const states: TestState[] = [
      { id: "focus-opener", screenId: "screen-home", discoveredBy: [], snapshot: before },
      { id: "focus-leaked", screenId: "screen-settings", discoveredBy: ["SELECT"], snapshot: after },
    ];
    const opened = makeResult(states, ["SELECT"], [{ from: "focus-opener", to: "focus-leaked", key: "SELECT" }]);
    expect(rules(opened)).toContain(NAVIGATION_DIAGNOSTIC_RULES.overlayFocusLeak);
    expect(diagnoseNavigation(opened).findings.find((finding) => (
      finding.issue.rule === NAVIGATION_DIAGNOSTIC_RULES.overlayFocusLeak
    ))?.issue.id).toBe("TVDOCTOR-NAV-40FE24C422FB43D8EA647382CCDC80B4");

    const preExistingStates: TestState[] = [
      { id: "focus-opener", screenId: "screen-home", discoveredBy: [], snapshot: after },
      { id: "focus-leaked", screenId: "screen-settings", discoveredBy: ["SELECT"], snapshot: after },
    ];
    const unchanged = makeResult(preExistingStates, ["SELECT"], [{ from: "focus-opener", to: "focus-leaked", key: "SELECT" }]);
    expect(rules(unchanged)).not.toContain(NAVIGATION_DIAGNOSTIC_RULES.overlayFocusLeak);

    const modelessDialog = node("settings-dialog", "dialog", { x: 300, y: 100, width: 500, height: 500 }, {
      children: [control("dialog-control", 380, 180)],
      modal: false,
      name: "Settings",
    });
    const modelessAfter = snapshot("settings", target("opener", 0, 0), [
      node("root", "main", null, { children: [behind, modelessDialog] }),
    ]);
    const modelessStates: TestState[] = [
      { id: "focus-opener", screenId: "screen-home", discoveredBy: [], snapshot: before },
      { id: "focus-leaked", screenId: "screen-settings", discoveredBy: ["SELECT"], snapshot: modelessAfter },
    ];
    const modeless = makeResult(modelessStates, ["SELECT"], [{ from: "focus-opener", to: "focus-leaked", key: "SELECT" }]);
    expect(rules(modeless)).not.toContain(NAVIGATION_DIAGNOSTIC_RULES.overlayFocusLeak);
  });

  it("reports only an explicitly identified root consent modal", () => {
    const consentTree = [
      node("catalogue", "main", null, {
        children: [control("behind", 0, 0)],
      }),
      node("consent-dialog", "dialog", { x: 100, y: 100, width: 500, height: 400 }, {
        children: [control("accept-consent", 200, 220, { focused: true })],
        modal: true,
        name: "Privacy choice",
      }),
    ];
    const consent = makeResult(
      [{
        id: "focus-consent",
        screenId: "screen-consent",
        discoveredBy: [],
        snapshot: snapshot("consent", target("accept-consent", 200, 220), consentTree),
      }],
      ["RIGHT"],
      [],
    );
    expect(rules(consent)).toContain(NAVIGATION_DIAGNOSTIC_RULES.consentWall);
    const finding = diagnoseNavigation(consent).findings.find((candidate) => (
      candidate.issue.rule === NAVIGATION_DIAGNOSTIC_RULES.consentWall
    ));
    expect(finding?.issue.transition).toBeNull();
    expect(finding?.issue.reproduction).toMatchObject({
      status: "unavailable",
    });

    const genericTree = [
      node("settings-dialog", "dialog", { x: 100, y: 100, width: 500, height: 400 }, {
        children: [control("accept-settings", 200, 220, { focused: true })],
        modal: true,
        name: "Display settings",
      }),
    ];
    const generic = makeResult(
      [{
        id: "focus-settings",
        screenId: "screen-settings",
        discoveredBy: [],
        snapshot: snapshot("settings", target("accept-settings", 200, 220), genericTree),
      }],
      ["RIGHT"],
      [],
    );
    expect(rules(generic)).not.toContain(NAVIGATION_DIAGNOSTIC_RULES.consentWall);
  });

  it("reports immediate SELECT then BACK to a third screen only for the discovery entry", () => {
    const home = snapshot("home", target("card", 0, 0), [control("card", 0, 0, { focused: true })]);
    const details = snapshot("details", target("play", 0, 0), [control("play", 0, 0, { focused: true })]);
    const search = snapshot("search", target("query", 0, 0), [control("query", 0, 0, { focused: true })]);
    const states: TestState[] = [
      { id: "focus-card", screenId: "screen-home", discoveredBy: [], snapshot: home },
      { id: "focus-play", screenId: "screen-details", discoveredBy: ["SELECT"], snapshot: details },
      { id: "focus-query", screenId: "screen-search", discoveredBy: ["SELECT", "BACK"], snapshot: search },
    ];
    const result = makeResult(states, ["SELECT", "BACK"], [
      { from: "focus-card", to: "focus-play", key: "SELECT" },
      { from: "focus-play", to: "focus-query", key: "BACK" },
    ]);
    const finding = diagnoseNavigation(result).findings.find((item) => item.issue.rule === NAVIGATION_DIAGNOSTIC_RULES.backBehaviour);
    expect(finding?.issue.id).toBe("TVDOCTOR-NAV-C3CF541CC6D8DB3047D30BCA4927E36C");
    expect(finding?.source.relatedActionAttemptId).toBe("action-001");
    expect(finding?.issue.reproduction).toMatchObject({
      status: "available",
      originalSequence: [{ key: "SELECT", repeat: 1 }, { key: "BACK", repeat: 1 }],
    });

    const notDiscovery = makeResult(
      [states[0] as TestState, { ...(states[1] as TestState), discoveredBy: ["RIGHT", "SELECT"] }, states[2] as TestState],
      ["SELECT", "BACK"],
      [
        { from: "focus-card", to: "focus-play", key: "SELECT" },
        { from: "focus-play", to: "focus-query", key: "BACK" },
      ],
    );
    expect(rules(notDiscovery)).not.toContain(NAVIGATION_DIAGNOSTIC_RULES.backBehaviour);
  });

  it("keeps abnormal geometric jumps in the separate heuristic collection", () => {
    const tree = [node("row", "group", null, {
      children: [
        control("source", 0, 0, { focused: true }),
        control("adjacent", 120, 0),
        control("distant", 900, 300),
      ],
    })];
    const states: TestState[] = [
      { id: "focus-source", screenId: "screen-row", discoveredBy: [], snapshot: snapshot("row", target("source", 0, 0), tree) },
      { id: "focus-adjacent", screenId: "screen-row", discoveredBy: ["LEFT"], snapshot: snapshot("row", target("adjacent", 120, 0), tree) },
      { id: "focus-distant", screenId: "screen-row", discoveredBy: ["RIGHT"], snapshot: snapshot("row", target("distant", 900, 300), tree) },
    ];
    const result = makeResult(states, ["RIGHT"], [{ from: "focus-source", to: "focus-distant", key: "RIGHT" }]);
    const diagnostics = diagnoseNavigation(result);
    expect(diagnostics.deterministicFindings).toHaveLength(0);
    expect(diagnostics.heuristicFindings).toHaveLength(1);
    expect(diagnostics.heuristicFindings[0]?.issue).toMatchObject({
      rule: NAVIGATION_DIAGNOSTIC_RULES.unexpectedJump,
      confidence: "heuristic",
    });
    expect(diagnostics.heuristicFindings[0]?.issue.id).toMatch(/^TVDOCTOR-NAV-[0-9A-F]{32}$/u);
    expect(diagnostics.heuristicFindings[0]?.issue.id).toBe("TVDOCTOR-NAV-CFCFD82B8C9C10F7A8274E7D0D5BD8DB");
    expect(diagnostics.heuristicFindings[0]?.target.expectedElement?.stableId).toBe("adjacent");
    expect(diagnoseNavigation(result)).toEqual(diagnostics);
  });

  it("reports a verified off-axis jump but not a destination absent from the pre-action tree", () => {
    const beforeTree = [node("row", "group", null, {
      children: [
        control("source", 0, 0, { focused: true }),
        control("adjacent", 120, 0),
        control("off-axis", 260, 900),
      ],
    })];
    const sourceState: TestState = {
      id: "focus-source",
      screenId: "screen-row",
      discoveredBy: [],
      snapshot: snapshot("row", target("source", 0, 0), beforeTree),
    };
    const adjacentState: TestState = {
      id: "focus-adjacent",
      screenId: "screen-row",
      discoveredBy: ["LEFT"],
      snapshot: snapshot("row", target("adjacent", 120, 0), beforeTree),
    };
    const offAxisState: TestState = {
      id: "focus-off-axis",
      screenId: "screen-row",
      discoveredBy: ["RIGHT"],
      snapshot: snapshot("row", target("off-axis", 260, 900), beforeTree),
    };
    const verified = makeResult(
      [sourceState, adjacentState, offAxisState],
      ["RIGHT"],
      [{ from: sourceState.id, to: offAxisState.id, key: "RIGHT" }],
    );
    expect(rules(verified)).toContain(NAVIGATION_DIAGNOSTIC_RULES.unexpectedJump);
    expect(diagnoseNavigation(verified).findings.find((finding) => (
      finding.issue.rule === NAVIGATION_DIAGNOSTIC_RULES.unexpectedJump
    ))?.issue.id).toBe("TVDOCTOR-NAV-DA7B7FF5A2FD08E9A2F8CD33BCDF0B25");

    const treeWithoutDestination = [node("row", "group", null, {
      children: [
        control("source", 0, 0, { focused: true }),
        control("adjacent", 120, 0),
      ],
    })];
    const destinationAbsent = makeResult(
      [{
        ...sourceState,
        snapshot: snapshot("row", target("source", 0, 0), treeWithoutDestination),
      }, adjacentState, offAxisState],
      ["RIGHT"],
      [{ from: sourceState.id, to: offAxisState.id, key: "RIGHT" }],
    );
    expect(rules(destinationAbsent)).not.toContain(NAVIGATION_DIAGNOSTIC_RULES.unexpectedJump);
  });

  it("keeps semantic issue IDs stable across graph IDs, ordering, and unrelated findings", () => {
    const primary = jumpScenario("z-primary", "primary", "screen-primary");
    const unrelated = jumpScenario("a-unrelated", "unrelated", "screen-unrelated", 500);
    const primaryResult = makeResult(primary.states, ["RIGHT"], [primary.action]);
    const primaryId = findingIdForSource(primaryResult, "primary-source");
    expect(primaryId).toMatch(/^TVDOCTOR-NAV-[0-9A-F]{32}$/u);
    expect(primaryId).toBe("TVDOCTOR-NAV-D9843108D9FFC4C44F76CEE272B9F1B8");

    const focusIdMap = new Map(
      primaryResult.graph.focus.states.map((state, index) => [state.id, `renamed-focus-${String(index + 1)}`]),
    );
    const renamedFocusId = (id: string): string => {
      const renamed = focusIdMap.get(id);
      if (renamed === undefined) throw new Error(`Missing renamed focus ID for ${id}.`);
      return renamed;
    };
    const oldScreen = primaryResult.graph.screens.states[0];
    if (oldScreen === undefined) throw new Error("Primary scenario must have one screen.");
    const renamedScreenId = "renamed-screen-9999";
    const renamedGraphIds: ExplorationResult = {
      ...primaryResult,
      graph: {
        screens: {
          states: [{
            ...oldScreen,
            id: renamedScreenId,
            focusStateIds: oldScreen.focusStateIds.map((id) => renamedFocusId(id)),
          }],
          transitions: [],
        },
        focus: {
          states: primaryResult.graph.focus.states.map((state) => ({
            ...state,
            id: renamedFocusId(state.id),
            screenStateId: renamedScreenId,
          })),
          transitions: [],
        },
        actions: primaryResult.graph.actions.map((attempt, index) => ({
          ...attempt,
          id: `renamed-action-${String(index + 1)}`,
          fromScreenStateId: renamedScreenId,
          toScreenStateId: renamedScreenId,
          fromFocusStateId: renamedFocusId(attempt.fromFocusStateId),
          toFocusStateId: attempt.toFocusStateId === null ? null : renamedFocusId(attempt.toFocusStateId),
        })),
      },
    };
    expect(findingIdForSource(renamedGraphIds, "primary-source")).toBe(primaryId);

    const extended = makeResult(
      [...unrelated.states, ...primary.states],
      ["RIGHT"],
      [unrelated.action, primary.action],
    );
    expect(findingIdForSource(extended, "primary-source")).toBe(primaryId);

    const sameScreenWithUnrelatedControl = jumpScenario(
      "changed-internal",
      "primary",
      "screen-primary",
      0,
      true,
    );
    const sameScreenExtended = makeResult(
      sameScreenWithUnrelatedControl.states,
      ["RIGHT"],
      [sameScreenWithUnrelatedControl.action],
    );
    expect(findingIdForSource(sameScreenExtended, "primary-source")).toBe(primaryId);

    const reordered: ExplorationResult = {
      ...extended,
      graph: {
        screens: {
          states: [...extended.graph.screens.states].reverse(),
          transitions: [...extended.graph.screens.transitions].reverse(),
        },
        focus: {
          states: [...extended.graph.focus.states].reverse(),
          transitions: [...extended.graph.focus.transitions].reverse(),
        },
        actions: [...extended.graph.actions].reverse(),
      },
    };
    const findingSignature = (result: ExplorationResult): readonly string[] => diagnoseNavigation(result).findings
      .map((finding) => `${finding.source.element?.stableId ?? "<none>"}|${finding.issue.id}`);
    expect(findingSignature(reordered)).toEqual(findingSignature(extended));
  });

  it("does not collide when independently diagnosed semantic issues are merged", () => {
    const first = jumpScenario("first-internal", "first", "screen-first");
    const second = jumpScenario("second-internal", "second", "screen-second", 500);
    const firstId = findingIdForSource(
      makeResult(first.states, ["RIGHT"], [first.action]),
      "first-source",
    );
    const secondId = findingIdForSource(
      makeResult(second.states, ["RIGHT"], [second.action]),
      "second-source",
    );
    expect(firstId).toMatch(/^TVDOCTOR-NAV-[0-9A-F]{32}$/u);
    expect(secondId).toMatch(/^TVDOCTOR-NAV-[0-9A-F]{32}$/u);
    expect(firstId).toBe("TVDOCTOR-NAV-18762654A2C096A8F5A3081AA8C97BA4");
    expect(secondId).toBe("TVDOCTOR-NAV-E6F6378C7248E138A63F65D2A894563C");
    expect(secondId).not.toBe(firstId);
    expect(new Set([firstId, secondId]).size).toBe(2);
  });
});
