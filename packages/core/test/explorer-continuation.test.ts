import {
  availableObservation,
  type ActionResult,
  type Capability,
  type RemoteKey,
  type ResetStrategy,
  type StateSnapshot,
  type TVDoctorDriver,
  type UiNodeSnapshot,
} from "@tvdoctor/protocol";
import { describe, expect, it } from "vitest";

import { explore } from "../src/index.js";

type StateName = "A" | "B" | "C" | "D";

function focusNode(state: StateName, focused: boolean): UiNodeSnapshot {
  return {
    stableId: state,
    role: "button",
    name: state,
    text: state,
    bounds: { x: 100, y: 100, width: 160, height: 64 },
    visible: true,
    enabled: true,
    focusable: true,
    focused,
    modal: false,
    selectionState: null,
    valueNow: null,
    children: [],
  };
}

function snapshot(state: StateName, states: readonly StateName[]): StateSnapshot {
  return {
    capturedAt: "2026-09-19T12:00:00.000Z",
    location: availableObservation("app://home"),
    focusedElement: availableObservation({
      stableId: state,
      role: "button",
      name: state,
      bounds: { x: 100, y: 100, width: 160, height: 64 },
    }),
    uiTree: availableObservation([{
      stableId: "root",
      role: "main",
      name: "Root",
      text: null,
      bounds: null,
      visible: true,
      enabled: true,
      focusable: false,
      focused: false,
      modal: false,
      selectionState: null,
      valueNow: null,
      children: states.map((candidate) => focusNode(candidate, candidate === state)),
    }]),
  };
}

class ContinuationDriver implements TVDoctorDriver {
  #state: StateName = "A";
  #sequence = 0;

  readonly eventLog: string[] = [];
  readonly states: readonly StateName[];
  readonly transitions: Readonly<Record<StateName, Partial<Record<RemoteKey, StateName>>>>;
  readonly clock: { now: number; readonly resetCost: number; readonly actionCost: number } | undefined;

  constructor(
    states: readonly StateName[],
    transitions: Readonly<Record<StateName, Partial<Record<RemoteKey, StateName>>>>,
    clock?: { now: number; readonly resetCost: number; readonly actionCost: number },
  ) {
    this.states = states;
    this.transitions = transitions;
    this.clock = clock;
  }

  async capabilities(): Promise<ReadonlySet<Capability>> {
    return new Set(["remote-input", "ui-tree"]);
  }

  async press(key: RemoteKey): Promise<ActionResult> {
    this.#sequence += 1;
    this.eventLog.push(`press:${this.#state}:${key}`);
    this.#state = this.transitions[this.#state][key] ?? this.#state;
    if (this.clock !== undefined) this.clock.now += this.clock.actionCost;
    return { key, outcome: "applied", timing: { inputSentAtMs: this.#sequence } };
  }

  async snapshot(): Promise<StateSnapshot> {
    return snapshot(this.#state, this.states);
  }

  async reset(strategy: ResetStrategy): Promise<void> {
    void strategy;
    this.eventLog.push("reset");
    this.#state = "A";
    if (this.clock !== undefined) this.clock.now += this.clock.resetCost;
  }
}

describe("explorer resumable expansion", () => {
  it("reports zero restoration cycles when exploration exits before the restorer is created", async () => {
    const driver: TVDoctorDriver = {
      async capabilities() {
        return new Set<Capability>();
      },
      async press(key) {
        return { key, outcome: "unsupported", timing: { inputSentAtMs: 0 } };
      },
      async snapshot() {
        return snapshot("A", ["A"]);
      },
    };

    const result = await explore(driver, { monotonicNow: () => 0 });

    expect(result.termination.reason).toBe("remote-input-unavailable");
    expect(result.statistics.restorationCycles).toBe(0);
  });

  it("expands an exact-live child before resuming sibling actions without replaying the source", async () => {
    const driver = new ContinuationDriver(
      ["A", "B", "C"],
      {
        A: { RIGHT: "B", DOWN: "C", UP: "A", LEFT: "A" },
        B: { RIGHT: "B", DOWN: "B", UP: "B", LEFT: "A" },
        C: { RIGHT: "C", DOWN: "C", UP: "C", LEFT: "A" },
        D: {},
      },
    );
    const actionSelectionCalls = new Map<string, number>();

    const result = await explore(driver, {
      actions: ["RIGHT", "DOWN", "UP", "LEFT"],
      restorationMode: "verified-local",
      refreshVisibleSelfLoops: false,
      actionsForState: (context) => {
        actionSelectionCalls.set(
          context.focusStateId,
          (actionSelectionCalls.get(context.focusStateId) ?? 0) + 1,
        );
        return context.defaultActions;
      },
      budgets: { maxActions: 30, maxStates: 10, maxDepth: 2, maxDurationMs: 10_000 },
      monotonicNow: () => 0,
    });

    const presses = driver.eventLog.filter((entry) => entry.startsWith("press:"));
    expect(result.termination).toEqual({ reason: "queue-exhausted", complete: true });
    expect(result.statistics).toMatchObject({
      focusStates: 3,
      resetCount: 1,
      replayActions: 0,
      physicalActions: 12,
      explorationActions: 12,
    });
    expect(presses.indexOf("press:B:RIGHT")).toBeLessThan(presses.indexOf("press:A:DOWN"));
    expect(actionSelectionCalls.size).toBe(3);
    expect([...actionSelectionCalls.values()]).toEqual([1, 1, 1]);
  });

  it("uses the live branch to reach deeper states before an expensive-reset duration budget expires", async () => {
    const clock = { now: 0, resetCost: 10, actionCost: 1 };
    const driver = new ContinuationDriver(
      ["A", "B", "C", "D"],
      {
        A: { RIGHT: "B", LEFT: "A" },
        B: { RIGHT: "C", LEFT: "A" },
        C: { RIGHT: "D", LEFT: "B" },
        D: { RIGHT: "D", LEFT: "C" },
      },
      clock,
    );

    const result = await explore(driver, {
      actions: ["RIGHT", "UP", "LEFT"],
      restorationMode: "verified-local",
      refreshVisibleSelfLoops: false,
      budgets: { maxActions: 30, maxStates: 10, maxDepth: 4, maxDurationMs: 14 },
      monotonicNow: () => clock.now,
    });

    expect(result.termination).toMatchObject({ reason: "max-duration", complete: false });
    expect(result.statistics).toMatchObject({
      maximumPathDepth: 3,
      resetCount: 1,
      replayActions: 0,
    });
    expect(result.graph.focus.states.some((state) => (
      state.representativeSnapshot.focusedElement.status === "available"
      && state.representativeSnapshot.focusedElement.value?.stableId === "D"
    ))).toBe(true);
  });
});
