import * as core from "../src/index.js";
import { availableObservation, type StateSnapshot } from "@tvdoctor/protocol";
import type { ExplorationResult, FocusState, ScreenState } from "../src/index.js";
import { describe, expect, it } from "vitest";

function snapshot(id: string): StateSnapshot {
  return {
    capturedAt: "2026-09-30T19:00:00.000Z",
    location: availableObservation("app://home"),
    focusedElement: availableObservation({
      stableId: id,
      role: "button",
      name: id,
      bounds: { x: id === "a" ? 0 : 120, y: 0, width: 100, height: 60 },
    }),
    uiTree: availableObservation([]),
  };
}

function result(complete = true): ExplorationResult {
  const aSnapshot = snapshot("a");
  const bSnapshot = snapshot("b");
  const states: FocusState[] = [
    {
      id: "focus-a",
      screenStateId: "screen-home",
      fingerprint: { value: "focus-a", confidence: "high", signals: ["stable-identifiers"] },
      stateFingerprint: "state-a",
      confidence: "high",
      firstSeenDepth: 0,
      discoveredBy: [],
      representativeSnapshot: aSnapshot,
    },
    {
      id: "focus-b",
      screenStateId: "screen-home",
      fingerprint: { value: "focus-b", confidence: "high", signals: ["stable-identifiers"] },
      stateFingerprint: "state-b",
      confidence: "high",
      firstSeenDepth: 2,
      // Deliberately longer than another verified observed path below.
      discoveredBy: ["DOWN", "RIGHT"],
      representativeSnapshot: bSnapshot,
    },
  ];
  const screen: ScreenState = {
    id: "screen-home",
    fingerprint: { value: "screen-home", confidence: "high", signals: ["stable-identifiers"] },
    firstSeenDepth: 0,
    discoveredBy: [],
    representativeSnapshot: aSnapshot,
    focusStateIds: states.map((state) => state.id),
  };
  const stateA = states[0];
  const stateB = states[1];
  if (stateA === undefined || stateB === undefined) {
    throw new Error("V2 graph fixture requires two focus states.");
  }
  const attempt = (
    id: string,
    from: FocusState,
    to: FocusState,
    key: "LEFT" | "RIGHT",
    sequence: readonly ("LEFT" | "RIGHT")[],
  ) => ({
    id,
    fromScreenStateId: "screen-home",
    fromFocusStateId: from.id,
    toScreenStateId: "screen-home",
    toFocusStateId: to.id,
    key,
    actionSequence: sequence,
    actionResult: { key, outcome: "applied" as const, timing: { inputSentAtMs: 1 } },
    beforeSnapshot: from.representativeSnapshot,
    afterSnapshot: to.representativeSnapshot,
    observedFingerprint: {
      screen: screen.fingerprint,
      focus: to.fingerprint,
      stateValue: to.stateFingerprint,
      confidence: "high" as const,
    },
  });
  return {
    graph: {
      screens: { states: [screen], transitions: [] },
      focus: { states, transitions: [] },
      actions: [
        attempt("a-right-b", stateA, stateB, "RIGHT", ["RIGHT"]),
        attempt("a-left-a", stateA, stateA, "LEFT", ["LEFT"]),
        attempt("b-left-a", stateB, stateA, "LEFT", ["RIGHT", "LEFT"]),
        attempt("b-right-b", stateB, stateB, "RIGHT", ["RIGHT", "RIGHT"]),
      ],
    },
    termination: complete
      ? { reason: "queue-exhausted", complete: true }
      : {
        reason: "max-actions",
        complete: false,
        remainingFrontierEntries: 3,
        remainingCandidateActions: 5,
      },
    budgets: { maxActions: 4, maxStates: 10, maxDepth: 4, maxDurationMs: 10_000 },
    actionOrder: ["LEFT", "RIGHT"],
    statistics: {
      physicalActions: 4,
      explorationActions: 4,
      replayActions: 0,
      resetCount: 0,
      replayRestorations: 0,
      visitedStates: 2,
      screenStates: 1,
      focusStates: 2,
      maximumQueueSize: 2,
      pendingStates: complete ? 0 : 3,
      elapsedMs: 1,
      averagePathDepth: 1,
      maximumPathDepth: 2,
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

describe("navigation focus graph v2", () => {
  it("exports a separately versioned graph builder instead of widening v1", () => {
    expect(core).toHaveProperty("NAVIGATION_FOCUS_GRAPH_VERSION_V2", "tvdoctor.navigation-focus-graph/v2");
    expect(core).toHaveProperty("createNavigationFocusGraphV2");
    expect(core.NAVIGATION_FOCUS_GRAPH_VERSION).toBe("tvdoctor.navigation-focus-graph/v1");
  });

  it("derives shortest-known verified paths, local completion, and observed cycles", () => {
    const graph = core.createNavigationFocusGraphV2(result());

    expect(graph.focusTargets.find((target) => target.key === "state-b")?.shortestKnownPath).toEqual(["RIGHT"]);
    expect(graph.screens[0]?.shortestKnownPath).toEqual([]);
    expect(graph.coverageSummary).toMatchObject({
      observedScreens: 1,
      observedFocusTargets: 2,
      observedTransitions: 4,
      locallyCompleteFocusTargetKeys: ["state-a", "state-b"],
      frontier: {
        status: "complete",
        category: null,
        reason: "queue-exhausted",
        remainingFrontierEntries: 0,
        remainingCandidateActions: 0,
        deferredStates: 0,
      },
    });
    expect(graph.cycles).toEqual([
      expect.objectContaining({ focusTargetKeys: ["state-a", "state-b"] }),
    ]);
  });

  it("labels only known budget-deferred frontier work on a partial run", () => {
    const graph = core.createNavigationFocusGraphV2(result(false));

    expect(graph.coverage).toBe("partial");
    expect(graph.coverageSummary.frontier).toEqual({
      status: "deferred",
      category: "budget",
      reason: "max-actions",
      remainingFrontierEntries: 3,
      remainingCandidateActions: 5,
      deferredStates: 0,
    });
  });

  it("does not call focus expansion locally complete when SELECT was blocked", () => {
    const base = result();
    const navigation: ExplorationResult = {
      ...base,
      graph: {
        ...base.graph,
        actions: base.graph.actions.map((attempt) => attempt.id === "a-left-a"
          ? { ...attempt, actionResult: { ...attempt.actionResult, outcome: "unsupported" as const } }
          : attempt),
      },
      termination: { reason: "queue-exhausted", complete: false },
    };
    const graph = core.createNavigationFocusGraphV2(navigation);
    expect(graph.coverage).toBe("partial");
    expect(graph.coverageSummary.frontier).toMatchObject({ status: "complete", reason: "queue-exhausted" });
    expect(graph.coverageSummary.locallyCompleteFocusTargetKeys).toEqual(["state-b"]);
  });

  it("classifies capability, termination, and deliberate deferred frontiers without claiming graph completion", () => {
    const basePartial = result(false);
    const capability = core.createNavigationFocusGraphV2({
      ...basePartial,
      termination: {
        reason: "remote-input-unavailable",
        complete: false,
        remainingFrontierEntries: 2,
        remainingCandidateActions: 2,
      },
    });
    expect(capability.coverageSummary.frontier).toMatchObject({
      status: "deferred",
      category: "capability",
      reason: "remote-input-unavailable",
    });

    const interrupted = core.createNavigationFocusGraphV2({
      ...basePartial,
      termination: {
        reason: "interrupted",
        complete: false,
        remainingFrontierEntries: 1,
        remainingCandidateActions: 1,
      },
    });
    expect(interrupted.coverageSummary.frontier).toMatchObject({
      status: "deferred",
      category: "termination",
      reason: "interrupted",
    });

    const deliberatelyDeferred = core.createNavigationFocusGraphV2({
      ...result(),
      statistics: {
        ...result().statistics,
        deferredStates: 2,
      },
    });
    expect(deliberatelyDeferred.coverage).toBe("partial");
    expect(deliberatelyDeferred.coverageSummary.frontier).toEqual({
      status: "deferred",
      category: "safety",
      reason: "repetition-compression",
      remainingFrontierEntries: 0,
      remainingCandidateActions: 0,
      deferredStates: 2,
    });
  });
});
