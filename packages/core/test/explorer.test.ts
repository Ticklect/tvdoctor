import {
  availableObservation,
  type ActionOutcome,
  type ActionResult,
  type Capability,
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

describe("bounded deterministic explorer", () => {
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
      visitedStates: 3,
      screenStates: 2,
      focusStates: 3,
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

    expect(result.termination).toEqual({ reason: "max-duration", complete: false });
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
    const never = new Promise<void>(() => undefined);
    const driver: TVDoctorDriver = {
      async capabilities() {
        return new Set<Capability>(["remote-input", "ui-tree"]);
      },
      async press(key) {
        await never;
        return { key, outcome: "applied", timing: { inputSentAtMs: 1 } };
      },
      async snapshot() {
        return stateSnapshot(MACHINE_STATES["homeNav"] as MachineState);
      },
      async reset(strategy) {
        void strategy;
      },
    };
    const startedAt = performance.now();
    const result = await explore(driver, {
      actions: ["RIGHT"],
      budgets: { maxActions: 10, maxStates: 10, maxDepth: 2, maxDurationMs: 25 },
    });

    expect(result.termination).toEqual({ reason: "max-duration", complete: false });
    expect(result.statistics.physicalActions).toBe(1);
    expect(performance.now() - startedAt).toBeLessThan(250);
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

    expect(result.termination).toEqual({ reason: "replay-diverged", complete: false });
    expect(result.statistics).toMatchObject({ physicalActions: 0, visitedStates: 1 });
    expect(result.graph.actions).toHaveLength(0);
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
    ["unknown action", { actions: ["POWER"] as unknown as readonly RemoteKey[] }, /known remote keys/u],
    ["duplicate actions", { actions: ["RIGHT", "RIGHT"] }, /duplicates/u],
    ["unknown profile", { profile: "turbo" as never }, /profile/u],
    ["unknown frontier strategy", { frontierStrategy: "random" as never }, /frontierStrategy/u],
    ["unknown reset strategy", { resetStrategy: "factory-reset" as never }, /resetStrategy/u],
    ["non-function restore hook", { restoreInitialState: 1 as never }, /restoreInitialState/u],
    ["non-function clock hook", { monotonicNow: 1 as never }, /monotonicNow/u],
    ["non-function settling wait hook", { settling: { wait: 1 as never } }, /wait/u],
    ["non-function settling comparison hook", { settling: { equivalent: 1 as never } }, /equivalent/u],
    ["non-boolean compression flag", { repetitionCompression: { enabled: "yes" as never } }, /enabled/u],
    ["non-finite clock result", { monotonicNow: () => Number.NaN }, /finite/u],
  ] as const)("rejects %s", async (_label, options, message) => {
    await expect(explore(new CounterDriver(), options as ExplorerOptions)).rejects.toThrow(message);
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
