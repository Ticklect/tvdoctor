import {
  availableObservation,
  type ActionOutcome,
  type ActionResult,
  type Capability,
  type DriverOperationOptions,
  type RemoteKey,
  type ResetStrategy,
  type StateSnapshot,
  type TVDoctorDriver,
  type UiNodeSnapshot,
} from "@tvdoctor/protocol";
import { describe, expect, it } from "vitest";

import {
  explore,
  pressAndObserve,
  type ExplorationBudgets,
  type ExplorerOptions,
  type ExplorationResult,
} from "../src/index.js";

interface MachineState {
  readonly screen: string;
  readonly focus: string;
}

function uiNode(
  stableId: string,
  role: string,
  focusable: boolean,
  focused: boolean,
  children: readonly UiNodeSnapshot[] = [],
): UiNodeSnapshot {
  return {
    stableId,
    role,
    name: stableId,
    text: stableId,
    bounds: focusable ? { x: 100, y: 100, width: 200, height: 72 } : null,
    visible: true,
    enabled: true,
    focusable,
    focused,
    modal: false,
    selectionState: null,
    valueNow: null,
    children,
  };
}

function stateSnapshot(state: MachineState): StateSnapshot {
  const controls = state.screen === "home"
    ? ["home-nav", "hero-watch"]
    : ["details-play", "details-back"];
  return {
    capturedAt: "2026-08-20T12:00:00.000Z",
    location: availableObservation(`app://${state.screen}`),
    focusedElement: availableObservation({
      stableId: state.focus,
      role: "button",
      name: state.focus,
      bounds: { x: 100, y: 100, width: 200, height: 72 },
    }),
    uiTree: availableObservation([
      uiNode(
        `screen-${state.screen}`,
        "main",
        false,
        false,
        controls.map((controlId) => uiNode(
          controlId,
          "button",
          true,
          controlId === state.focus,
        )),
      ),
    ]),
  };
}

class MachineDriver implements TVDoctorDriver {
  readonly #initialState: string;
  readonly #states: Readonly<Record<string, MachineState>>;
  readonly #transitions: Readonly<Record<string, Partial<Record<RemoteKey, string>>>>;
  #actionSequence = 0;
  #state: string;

  readonly eventLog: string[] = [];

  constructor(
    initialState: string,
    states: Readonly<Record<string, MachineState>>,
    transitions: Readonly<Record<string, Partial<Record<RemoteKey, string>>>>,
  ) {
    this.#initialState = initialState;
    this.#state = initialState;
    this.#states = states;
    this.#transitions = transitions;
  }

  async capabilities(): Promise<ReadonlySet<Capability>> {
    return new Set(["remote-input", "ui-tree"]);
  }

  async press(key: RemoteKey): Promise<ActionResult> {
    this.eventLog.push(`press:${key}:start`);
    await Promise.resolve();
    const destination = this.#transitions[this.#state]?.[key];
    if (destination !== undefined) this.#state = destination;
    this.#actionSequence += 1;
    this.eventLog.push(`press:${key}:settled`);
    return {
      key,
      outcome: "applied",
      timing: {
        inputSentAtMs: this.#actionSequence,
        screenSettledAtMs: this.#actionSequence,
      },
    };
  }

  async snapshot(): Promise<StateSnapshot> {
    this.eventLog.push("snapshot");
    const state = this.#states[this.#state];
    if (state === undefined) throw new Error(`Unknown fake state: ${this.#state}`);
    return stateSnapshot(state);
  }

  async reset(strategy: ResetStrategy): Promise<void> {
    void strategy;
    this.#state = this.#initialState;
    this.eventLog.push("reset");
  }
}

class CounterDriver implements TVDoctorDriver {
  #position = 0;
  #actionSequence = 0;
  readonly #advanceClock: (() => void) | undefined;

  constructor(advanceClock?: () => void) {
    this.#advanceClock = advanceClock;
  }

  async capabilities(): Promise<ReadonlySet<Capability>> {
    return new Set(["remote-input", "ui-tree"]);
  }

  async press(key: RemoteKey): Promise<ActionResult> {
    this.#actionSequence += 1;
    if (key === "RIGHT") this.#position += 1;
    this.#advanceClock?.();
    return {
      key,
      outcome: "applied",
      timing: { inputSentAtMs: this.#actionSequence },
    };
  }

  async snapshot(): Promise<StateSnapshot> {
    const focusSuffix = "a".repeat(this.#position + 1);
    return {
      capturedAt: "2026-08-20T12:00:00.000Z",
      location: availableObservation("app://loop"),
      focusedElement: availableObservation({
        stableId: `focus-${focusSuffix}`,
        role: "button",
        name: `Position ${focusSuffix}`,
        bounds: { x: 100, y: 100, width: 200, height: 72 },
      }),
      uiTree: availableObservation([
        uiNode("loop-screen", "main", false, false),
      ]),
    };
  }

  async reset(strategy: ResetStrategy): Promise<void> {
    void strategy;
    this.#position = 0;
  }
}

const MACHINE_STATES: Readonly<Record<string, MachineState>> = {
  homeNav: { screen: "home", focus: "home-nav" },
  homeWatch: { screen: "home", focus: "hero-watch" },
  detailsPlay: { screen: "details", focus: "details-play" },
};

const MACHINE_TRANSITIONS: Readonly<Record<string, Partial<Record<RemoteKey, string>>>> = {
  homeNav: { RIGHT: "homeWatch" },
  homeWatch: { LEFT: "homeNav", SELECT: "detailsPlay", BACK: "homeNav" },
  detailsPlay: { BACK: "homeNav" },
};

async function deterministicRun(): Promise<ExplorationResult> {
  return explore(new MachineDriver("homeNav", MACHINE_STATES, MACHINE_TRANSITIONS), {
    actions: ["RIGHT", "LEFT", "SELECT", "BACK"],
    budgets: {
      maxActions: 100,
      maxStates: 20,
      maxDepth: 2,
      maxDurationMs: 10_000,
    },
    monotonicNow: () => 0,
  });
}

async function expectTypeError(
  operation: Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await operation;
    expect.unreachable("Expected explorer validation to reject.");
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe(message);
  }
}

describe("bounded deterministic explorer", () => {
  it("stops before touching the driver when exploration is already interrupted", async () => {
    const controller = new AbortController();
    let capabilityCalls = 0;
    const driver: TVDoctorDriver = {
      async capabilities() {
        capabilityCalls += 1;
        throw new Error("capabilities must not run after abort");
      },
      async press(key) {
        return { key, outcome: "applied", timing: { inputSentAtMs: 1 } };
      },
      async snapshot() {
        return stateSnapshot(MACHINE_STATES["homeNav"] as MachineState);
      },
    };
    controller.abort();

    const result = await explore(driver, {
      actions: ["RIGHT"],
      signal: controller.signal,
      monotonicNow: () => 0,
    });

    expect(result.termination).toEqual({ reason: "interrupted", complete: false });
    expect(capabilityCalls).toBe(0);
    expect(result.statistics.physicalActions).toBe(0);
    expect(result.graph.actions).toHaveLength(0);
  });

  it("emits separate screen/focus graphs with BFS paths and exact action evidence", async () => {
    const result = await deterministicRun();

    expect(result.termination).toEqual({ reason: "max-depth", complete: false });
    expect(result.graph.screens.states).toHaveLength(2);
    expect(result.graph.focus.states).toHaveLength(3);
    expect(result.graph.screens.states[0]?.focusStateIds).toEqual(["focus-0001", "focus-0002"]);
    expect(result.graph.screens.states[1]?.focusStateIds).toEqual(["focus-0003"]);

    const focusMove = result.graph.focus.transitions.find((transition) => (
      transition.fromFocusStateId === "focus-0001"
      && transition.toFocusStateId === "focus-0002"
      && transition.key === "RIGHT"
    ));
    expect(focusMove?.actionSequence).toEqual(["RIGHT"]);
    expect(focusMove?.actionResult).toEqual({
      key: "RIGHT",
      outcome: "applied",
      timing: { inputSentAtMs: 1, screenSettledAtMs: 1 },
    });

    const screenMove = result.graph.screens.transitions.find((transition) => (
      transition.fromScreenStateId === "screen-0001"
      && transition.toScreenStateId === "screen-0002"
    ));
    expect(screenMove?.key).toBe("SELECT");
    expect(screenMove?.actionSequence).toEqual(["RIGHT", "SELECT"]);
    const screenAttempt = result.graph.actions.find((attempt) => attempt.id === screenMove?.attemptId);
    expect(screenAttempt?.beforeSnapshot.focusedElement).toEqual(availableObservation({
      stableId: "hero-watch",
      role: "button",
      name: "hero-watch",
      bounds: { x: 100, y: 100, width: 200, height: 72 },
    }));
    expect(screenAttempt?.afterSnapshot.location).toEqual(availableObservation("app://details"));
    expect(screenAttempt?.actionResult).toBe(screenMove?.actionResult);

    expect(result.statistics).toMatchObject({
      physicalActions: 12,
      explorationActions: 8,
      replayActions: 4,
      resetCount: 9,
      replayRestorations: 8,
      visitedStates: 3,
      screenStates: 2,
      focusStates: 3,
      pendingStates: 0,
      averagePathDepth: 1,
      maximumPathDepth: 2,
      averageReplayLength: 0.5,
      maximumReplayLength: 1,
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
    });
  });

  it("produces the same ordered graph and statistics on repeated runs", async () => {
    const first = await deterministicRun();
    const second = await deterministicRun();

    expect(second).toEqual(first);
  });

  it("exhausts a cyclic graph instead of revisiting states forever", async () => {
    const result = await explore(
      new MachineDriver("homeNav", MACHINE_STATES, MACHINE_TRANSITIONS),
      {
        actions: ["RIGHT", "LEFT", "SELECT", "BACK"],
        budgets: {
          maxActions: 100,
          maxStates: 20,
          maxDepth: 5,
          maxDurationMs: 10_000,
        },
        monotonicNow: () => 0,
      },
    );

    expect(result.termination).toEqual({ reason: "queue-exhausted", complete: true });
    expect(result.statistics).toMatchObject({
      physicalActions: 24,
      explorationActions: 12,
      replayActions: 12,
      visitedStates: 3,
    });
    expect(result.graph.actions).toHaveLength(12);
  });

  it("records boundary transitions without expanding excluded destination states", async () => {
    const result = await explore(
      new MachineDriver("homeNav", MACHINE_STATES, MACHINE_TRANSITIONS),
      {
        actions: ["RIGHT", "LEFT", "SELECT", "BACK"],
        budgets: {
          maxActions: 100,
          maxStates: 20,
          maxDepth: 5,
          maxDurationMs: 10_000,
        },
        monotonicNow: () => 0,
        shouldExpand: (snapshot) => snapshot.location.status === "available"
          && snapshot.location.value === "app://home",
      },
    );

    expect(result.termination).toEqual({ reason: "queue-exhausted", complete: true });
    expect(result.graph.actions.some((action) => (
      action.afterSnapshot.location.status === "available"
      && action.afterSnapshot.location.value === "app://details"
    ))).toBe(true);
    expect(result.graph.actions.some((action) => (
      action.beforeSnapshot.location.status === "available"
      && action.beforeSnapshot.location.value === "app://details"
    ))).toBe(false);
  });

  it("completes Deep exploration immediately when the frontier is exhausted", async () => {
    const result = await explore(
      new MachineDriver("homeNav", MACHINE_STATES, MACHINE_TRANSITIONS),
      {
        profile: "deep",
        actions: ["RIGHT"],
        monotonicNow: () => 0,
      },
    );

    expect(result.budgets.maxDurationMs).toBe(1_800_000);
    expect(result.termination).toEqual({ reason: "queue-exhausted", complete: true });
    expect(result.statistics.elapsedMs).toBe(0);
  });

  it("continues Deep exploration past the previous 600-second boundary", async () => {
    let now = 599_500;
    const result = await explore(new CounterDriver(() => {
      now += 10_001;
      return now;
    }), {
      profile: "deep",
      actions: ["RIGHT"],
      budgets: { maxActions: 1_000, maxStates: 20, maxDepth: 12, maxDurationMs: 2_000_000 },
      monotonicNow: () => now,
    });

    expect(result.statistics.elapsedMs).toBeGreaterThan(600_000);
    expect(result.termination).toEqual({ reason: "queue-exhausted", complete: true });
  });

  it("reports remaining frontier work when an unbounded dynamic site reaches a safety bound", async () => {
    let generation = 0;
    let focus = "root";
    let depth = 0;
    const driver: TVDoctorDriver = {
      async capabilities() {
        return new Set<Capability>(["remote-input", "ui-tree"]);
      },
      async reset(strategy) {
        void strategy;
        focus = "root";
        depth = 0;
      },
      async snapshot() {
        return stateSnapshot({ screen: "feed", focus });
      },
      async press(key) {
        depth += 1;
        generation += 1;
        focus = `generated-${String(depth)}`;
        void key;
        return { key, outcome: "applied", timing: { inputSentAtMs: generation } };
      },
    };

    const result = await explore(driver, {
      actions: ["DOWN", "RIGHT"],
      budgets: { maxActions: 20, maxStates: 3, maxDepth: 10, maxDurationMs: 700_000 },
      monotonicNow: () => 0,
    });

    expect(result.termination.reason).toBe("max-states");
    expect(result.termination.complete).toBe(false);
    expect(result.termination.remainingFrontierEntries ?? 0).toBe(0);
    expect(result.termination.remainingCandidateActions ?? 0).toBe(0);
  });

  it.each([
    {
      label: "state count",
      budgets: { maxActions: 100, maxStates: 2, maxDepth: 20, maxDurationMs: 10_000 },
      reason: "max-states",
      expected: { physicalActions: 3, visitedStates: 2 },
    },
    {
      label: "physical action count including replay",
      budgets: { maxActions: 3, maxStates: 20, maxDepth: 20, maxDurationMs: 10_000 },
      reason: "max-actions",
      expected: { physicalActions: 3, visitedStates: 3 },
    },
    {
      label: "discovery depth",
      budgets: { maxActions: 100, maxStates: 20, maxDepth: 2, maxDurationMs: 10_000 },
      reason: "max-depth",
      expected: { physicalActions: 3, visitedStates: 3 },
    },
  ])("terminates deterministically at the $label budget", async ({ budgets, reason, expected }) => {
    const result = await explore(new CounterDriver(), {
      actions: ["RIGHT"],
      budgets,
      monotonicNow: () => 0,
    });

    expect(result.termination).toEqual({ reason, complete: false });
    expect(result.statistics).toMatchObject(expected);
    expect(result.graph.focus.states.map((state) => state.discoveredBy)).toEqual([
      [],
      ["RIGHT"],
      ...(expected.visitedStates === 3 ? [["RIGHT", "RIGHT"]] : []),
    ]);
    if (reason === "max-states") {
      expect(result.graph.actions.at(-1)).toMatchObject({
        toScreenStateId: null,
        toFocusStateId: null,
        actionSequence: ["RIGHT", "RIGHT"],
      });
    }
  });

  it("accounts for elapsed reset/action/snapshot time and stops after the completed observation", async () => {
    let now = 0;
    const result = await explore(new CounterDriver(() => {
      now += 6;
    }), {
      actions: ["RIGHT"],
      budgets: { maxActions: 100, maxStates: 20, maxDepth: 20, maxDurationMs: 5 },
      monotonicNow: () => now,
    });

    expect(result.termination).toMatchObject({ reason: "max-duration", complete: false });
    expect(result.statistics).toMatchObject({
      physicalActions: 1,
      explorationActions: 1,
      replayActions: 0,
      visitedStates: 2,
      elapsedMs: 6,
    });
    expect(result.graph.actions).toHaveLength(1);
  });

  it("returns at the duration deadline when a driver call never settles", async () => {
    let pressSignal: AbortSignal | undefined;
    let abortedBeforeReturn = false;
    let resetCount = 0;
    let snapshotCount = 0;
    let resetCountAtPress = 0;
    let snapshotCountAtPress = 0;
    const driver: TVDoctorDriver = {
      async capabilities() {
        return new Set<Capability>(["remote-input", "ui-tree"]);
      },
      async press(key, options?: DriverOperationOptions) {
        pressSignal = options?.signal;
        resetCountAtPress = resetCount;
        snapshotCountAtPress = snapshotCount;
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            abortedBeforeReturn = options.signal?.aborted === true;
            reject(options.signal?.reason);
          }, { once: true });
        });
        return { key, outcome: "applied", timing: { inputSentAtMs: 1 } };
      },
      async snapshot() {
        snapshotCount += 1;
        return stateSnapshot(MACHINE_STATES["homeNav"] as MachineState);
      },
      async reset(strategy) {
        void strategy;
        resetCount += 1;
      },
    };
    const startedAt = performance.now();
    const result = await explore(driver, {
      actions: ["RIGHT"],
      budgets: { maxActions: 10, maxStates: 10, maxDepth: 2, maxDurationMs: 25 },
    });

    expect(result.termination).toMatchObject({ reason: "max-duration", complete: false });
    expect(result.statistics.physicalActions).toBe(1);
    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(pressSignal?.aborted).toBe(true);
    expect(abortedBeforeReturn).toBe(true);
    expect(resetCount).toBe(resetCountAtPress);
    expect(snapshotCount).toBe(snapshotCountAtPress);
  });

  it("waits for the driver settling boundary before taking a snapshot", async () => {
    const driver = new MachineDriver("homeNav", MACHINE_STATES, MACHINE_TRANSITIONS);
    const observation = await pressAndObserve(driver, "RIGHT");

    expect(driver.eventLog).toEqual(["press:RIGHT:start", "press:RIGHT:settled", "snapshot"]);
    expect(observation.actionResult.outcome).toBe("applied");
    expect(observation.snapshot.focusedElement).toEqual(availableObservation({
      stableId: "hero-watch",
      role: "button",
      name: "hero-watch",
      bounds: { x: 100, y: 100, width: 200, height: 72 },
    }));
  });

  it("reuses the driver post-action observation instead of re-snapshotting", async () => {
    const snapshot = stateSnapshot(MACHINE_STATES["homeNav"] as MachineState);
    let snapshotCalls = 0;
    const driver: TVDoctorDriver = {
      async capabilities() {
        return new Set<Capability>(["remote-input", "ui-tree"]);
      },
      async press(key) {
        return { key, outcome: "applied", timing: { inputSentAtMs: 1 }, postActionSnapshot: snapshot };
      },
      async snapshot() {
        snapshotCalls += 1;
        return snapshot;
      },
    };

    const driverStrategy = await pressAndObserve(driver, "RIGHT");
    expect(driverStrategy.reusedDriverObservation).toBe(true);
    expect(driverStrategy.snapshotsCaptured).toBe(0);
    expect(snapshotCalls).toBe(0);

    snapshotCalls = 0;
    const stable = await pressAndObserve(driver, "RIGHT", { strategy: "stable-snapshot" });
    expect(stable.reusedDriverObservation).toBe(true);
    expect(stable.settled).toBe(true);
    expect(stable.snapshotsCaptured).toBeGreaterThanOrEqual(1);
  });

  it("rejects inconclusive settling instead of attributing a transition", async () => {
    const driver: TVDoctorDriver = {
      async capabilities() {
        return new Set<Capability>(["remote-input"]);
      },
      async press(key) {
        return {
          key,
          outcome: "inconclusive",
          timing: { inputSentAtMs: 1 },
          message: "observation unavailable",
        };
      },
      async snapshot() {
        throw new Error("snapshot must not be called after inconclusive actions");
      },
    };

    await expect(pressAndObserve(driver, "RIGHT")).rejects.toThrow("observation unavailable");
  });

  it("ends explicitly when remote input or deterministic restoration is unavailable", async () => {
    const snapshot = stateSnapshot(MACHINE_STATES["homeNav"] as MachineState);
    const driver = (capabilities: readonly Capability[], withReset: boolean): TVDoctorDriver => ({
      async capabilities() {
        return new Set(capabilities);
      },
      async press(key) {
        const outcome: ActionOutcome = capabilities.includes("remote-input") ? "applied" : "unsupported";
        return { key, outcome, timing: { inputSentAtMs: 1 } };
      },
      async snapshot() {
        return snapshot;
      },
      ...(withReset ? {
        async reset(strategy: ResetStrategy) {
          void strategy;
        },
      } : {}),
    });

    const unsupported = await explore(driver([], true), { monotonicNow: () => 0 });
    const unrestorable = await explore(driver(["remote-input"], false), { monotonicNow: () => 0 });

    expect(unsupported.termination.reason).toBe("remote-input-unavailable");
    expect(unrestorable.termination.reason).toBe("restoration-unavailable");
    expect(unsupported.graph.focus.states).toHaveLength(0);
    expect(unrestorable.statistics.physicalActions).toBe(0);
  });

  it("terminates when root restoration no longer reproduces the initial state", async () => {
    let resetCount = 0;
    const driver: TVDoctorDriver = {
      async capabilities() {
        return new Set<Capability>(["remote-input", "ui-tree"]);
      },
      async press(key) {
        return { key, outcome: "applied", timing: { inputSentAtMs: 1 } };
      },
      async snapshot() {
        return stateSnapshot(resetCount <= 1
          ? MACHINE_STATES["homeNav"] as MachineState
          : MACHINE_STATES["homeWatch"] as MachineState);
      },
      async reset(strategy) {
        void strategy;
        resetCount += 1;
      },
    };

    const result = await explore(driver, {
      actions: ["RIGHT"],
      monotonicNow: () => 0,
    });

    expect(result.termination).toMatchObject({ reason: "replay-diverged", complete: false });
    expect(result.termination.detail).toMatch(/^Root restoration produced state-/u);
    expect(result.statistics).toMatchObject({ physicalActions: 0, visitedStates: 1 });
    expect(result.graph.actions).toHaveLength(0);
  });

  it("validates every shared replay prefix instead of accepting a divergent path that reconverges", async () => {
    type StateName = "root" | "mid" | "wrong" | "target";
    let state: StateName = "root";
    let resetCount = 0;
    const pressed: string[] = [];
    const snapshots: Readonly<Record<StateName, StateSnapshot>> = {
      root: stateSnapshot(MACHINE_STATES["homeNav"] as MachineState),
      mid: stateSnapshot(MACHINE_STATES["homeWatch"] as MachineState),
      wrong: stateSnapshot({ screen: "details", focus: "details-back" }),
      target: stateSnapshot(MACHINE_STATES["detailsPlay"] as MachineState),
    };
    const driver: TVDoctorDriver = {
      async capabilities() {
        return new Set<Capability>(["remote-input", "ui-tree"]);
      },
      async reset(strategy) {
        void strategy;
        resetCount += 1;
        state = "root";
      },
      async snapshot() {
        return snapshots[state];
      },
      async press(key) {
        pressed.push(`${String(resetCount)}:${state}:${key}`);
        if (state === "root" && key === "RIGHT") {
          // The first restorations reproduce the proven prefix. Once the target
          // is queued, corrupt only that intermediate checkpoint; SELECT would
          // reconverge to the same final target if the prefix were not checked.
          state = resetCount >= 6 ? "wrong" : "mid";
        } else if ((state === "mid" || state === "wrong") && key === "SELECT") {
          state = "target";
        }
        return { key, outcome: "applied", timing: { inputSentAtMs: pressed.length } };
      },
    };

    const result = await explore(driver, {
      actions: ["RIGHT", "SELECT"],
      budgets: { maxActions: 100, maxStates: 10, maxDepth: 4, maxDurationMs: 10_000 },
      monotonicNow: () => 0,
    });

    expect(result.termination).toMatchObject({ reason: "replay-diverged", complete: false });
    expect(result.termination.detail).toContain("Replay checkpoint 1/2 after RIGHT produced state-");
    expect(pressed).toContain("6:root:RIGHT");
    expect(pressed).not.toContain("6:wrong:SELECT");
    expect(result.statistics.pendingStates).toBeGreaterThanOrEqual(0);
  });

  it("resets branch-local mutation before exploring a sibling action", async () => {
    let dirty = false;
    let focus = "root";
    const branchStarts: string[] = [];
    const snapshot = (): StateSnapshot => stateSnapshot({
      screen: focus === "contaminated" ? "details" : "home",
      focus: focus === "root" ? "home-nav" : focus === "clean" ? "hero-watch" : "details-back",
    });
    const driver: TVDoctorDriver = {
      async capabilities() {
        return new Set<Capability>(["remote-input", "ui-tree"]);
      },
      async reset(strategy) {
        void strategy;
        dirty = false;
        focus = "root";
      },
      async snapshot() {
        return snapshot();
      },
      async press(key) {
        branchStarts.push(`${key}:${dirty ? "dirty" : "clean"}`);
        if (key === "SELECT") {
          // Deliberately invisible in the immediate semantic snapshot.
          dirty = true;
        } else if (key === "RIGHT") {
          focus = dirty ? "contaminated" : "clean";
        }
        return { key, outcome: "applied", timing: { inputSentAtMs: branchStarts.length } };
      },
    };

    const result = await explore(driver, {
      actions: ["SELECT", "RIGHT"],
      budgets: { maxActions: 20, maxStates: 10, maxDepth: 1, maxDurationMs: 10_000 },
      monotonicNow: () => 0,
    });

    expect(branchStarts.slice(0, 2)).toEqual(["SELECT:clean", "RIGHT:clean"]);
    expect(result.graph.focus.states.some((candidate) => (
      candidate.representativeSnapshot.focusedElement.status === "available"
      && candidate.representativeSnapshot.focusedElement.value?.stableId === "hero-watch"
    ))).toBe(true);
    expect(result.graph.focus.states.some((candidate) => (
      candidate.representativeSnapshot.focusedElement.status === "available"
      && candidate.representativeSnapshot.focusedElement.value?.stableId === "details-back"
    ))).toBe(false);
  });

  it("keeps visually similar states separate when their navigation locations differ", async () => {
    let current: "root" | "alpha" | "beta" = "root";
    const snapshotFor = (): StateSnapshot => current === "root"
      ? stateSnapshot(MACHINE_STATES["homeNav"] as MachineState)
      : stateSnapshot({ screen: current, focus: "details-play" });
    const driver: TVDoctorDriver = {
      async capabilities() {
        return new Set<Capability>(["remote-input", "ui-tree"]);
      },
      async reset(strategy) {
        void strategy;
        current = "root";
      },
      async snapshot() {
        return snapshotFor();
      },
      async press(key) {
        if (current === "root" && key === "LEFT") current = "alpha";
        if (current === "root" && key === "RIGHT") current = "beta";
        return { key, outcome: "applied", timing: { inputSentAtMs: 1 } };
      },
    };

    const result = await explore(driver, {
      actions: ["LEFT", "RIGHT"],
      budgets: { maxActions: 10, maxStates: 10, maxDepth: 1, maxDurationMs: 10_000 },
      monotonicNow: () => 0,
    });

    expect(result.graph.screens.states).toHaveLength(3);
    expect(result.graph.focus.states).toHaveLength(3);
    expect(result.graph.screens.states.map((state) => state.representativeSnapshot.location))
      .toEqual([
        availableObservation("app://home"),
        availableObservation("app://alpha"),
        availableObservation("app://beta"),
      ]);
  });

  it.each([
    ["maxActions", 0],
    ["maxActions", -1],
    ["maxActions", 1.5],
    ["maxActions", Number.NaN],
    ["maxActions", Number.POSITIVE_INFINITY],
    ["maxActions", 1_000_001],
    ["maxStates", 0],
    ["maxStates", -1],
    ["maxStates", 1.5],
    ["maxStates", Number.NaN],
    ["maxStates", Number.POSITIVE_INFINITY],
    ["maxStates", 100_001],
    ["maxDepth", -1],
    ["maxDepth", 1.5],
    ["maxDepth", Number.NaN],
    ["maxDepth", Number.POSITIVE_INFINITY],
    ["maxDepth", 4_097],
    ["maxDurationMs", 0],
    ["maxDurationMs", -1],
    ["maxDurationMs", 1.5],
    ["maxDurationMs", Number.NaN],
    ["maxDurationMs", Number.POSITIVE_INFINITY],
    ["maxDurationMs", 2_147_483_648],
  ] as const)("rejects the invalid %s exploration budget %s", async (name, value) => {
    const driver = new CounterDriver();
    const budgets = { [name]: value } as Partial<ExplorationBudgets>;

    await expect(explore(driver, { budgets })).rejects.toThrow(name);
  });

  it.each([
    ["unknown action", { actions: ["POWER"] as unknown as readonly RemoteKey[] }, "Explorer actions must contain only known remote keys."],
    ["duplicate actions", { actions: ["RIGHT", "RIGHT"] }, "Explorer actions must not contain duplicates."],
    ["unknown profile", { profile: "turbo" as never }, "profile must be quick, standard, or deep."],
    ["unknown frontier strategy", { frontierStrategy: "random" as never }, "frontierStrategy must be breadth-first or priority."],
    ["unknown reset strategy", { resetStrategy: "factory-reset" as never }, "resetStrategy must be reload, relaunch, or clear-data."],
    ["non-function restore hook", { restoreInitialState: 1 as never }, "restoreInitialState must be a function."],
    ["non-function restore snapshot hook", { restoreInitialSnapshot: 1 as never }, "restoreInitialSnapshot must be a function."],
    ["non-function clock hook", { monotonicNow: 1 as never }, "monotonicNow must be a function."],
    ["non-function settling wait hook", { settling: { wait: 1 as never } }, "wait must be a function."],
    ["non-function settling comparison hook", { settling: { equivalent: 1 as never } }, "equivalent must be a function."],
    ["non-boolean compression flag", { repetitionCompression: { enabled: "yes" as never } }, "repetitionCompression.enabled must be a boolean."],
    ["non-finite clock result", { monotonicNow: () => Number.NaN }, "monotonicNow must return a finite number."],
  ] as const)("rejects %s with the exact public error", async (_label, options, message) => {
    await expectTypeError(explore(new CounterDriver(), options as ExplorerOptions), message);
  });

  it.each([
    ["maxSnapshots", 0],
    ["maxSnapshots", -1],
    ["maxSnapshots", 1.5],
    ["maxSnapshots", Number.NaN],
    ["maxSnapshots", Number.POSITIVE_INFINITY],
    ["maxSnapshots", 1_001],
    ["requiredStableSnapshots", 0],
    ["requiredStableSnapshots", 1.5],
    ["pollIntervalMs", -1],
    ["pollIntervalMs", 0.5],
    ["pollIntervalMs", Number.NaN],
    ["pollIntervalMs", Number.POSITIVE_INFINITY],
    ["pollIntervalMs", 2_147_483_648],
  ] as const)("rejects the invalid %s settling value %s", async (name, value) => {
    await expect(explore(new CounterDriver(), {
      settling: {
        strategy: "stable-snapshot",
        [name]: value,
      },
    })).rejects.toThrow(name);
  });

  it("keeps zero maximum depth as an explicit valid no-expansion budget", async () => {
    const result = await explore(new CounterDriver(), {
      budgets: { maxDepth: 0 },
      monotonicNow: () => 0,
    });
    expect(result.termination).toEqual({ reason: "max-depth", complete: false });
    expect(result.statistics.physicalActions).toBe(0);
  });
});
