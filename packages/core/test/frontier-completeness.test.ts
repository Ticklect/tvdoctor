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

type Focus = "A" | "B" | "C";

function node(id: Focus, focused: boolean): UiNodeSnapshot {
  return {
    stableId: id,
    role: "button",
    name: id,
    text: id,
    bounds: { x: 0, y: 0, width: 100, height: 50 },
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

function snapshot(focus: Focus): StateSnapshot {
  return {
    capturedAt: "2026-10-08T00:00:00.000Z",
    location: availableObservation("app://fixture"),
    focusedElement: availableObservation({ stableId: focus, role: "button", name: focus }),
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
      children: ["A", "B", "C"].map((id) => node(id as Focus, id === focus)),
    }]),
  };
}

class FrontierDriver implements TVDoctorDriver {
  #focus: Focus = "A";
  readonly presses: string[] = [];
  readonly transitions: Readonly<Record<Focus, Partial<Record<RemoteKey, Focus>>>>;

  constructor(transitions: Readonly<Record<Focus, Partial<Record<RemoteKey, Focus>>>>) {
    this.transitions = transitions;
  }

  async capabilities(): Promise<ReadonlySet<Capability>> {
    return new Set(["remote-input", "ui-tree"]);
  }

  async reset(strategy: ResetStrategy): Promise<void> {
    void strategy;
    this.#focus = "A";
  }

  async snapshot(): Promise<StateSnapshot> {
    return snapshot(this.#focus);
  }

  async press(key: RemoteKey): Promise<ActionResult> {
    this.presses.push(`${this.#focus}:${key}`);
    this.#focus = this.transitions[this.#focus][key] ?? this.#focus;
    return { key, outcome: "applied", timing: { inputSentAtMs: this.presses.length } };
  }
}

describe("exploration frontier completeness accounting", () => {
  it("keeps the next queued state when its action budget is already exhausted", async () => {
    const driver = new FrontierDriver({
      A: { RIGHT: "B" },
      B: {},
      C: {},
    });
    const result = await explore(driver, {
      actions: ["RIGHT", "DOWN", "LEFT"],
      restorationMode: "verified-local",
      opportunisticFrontier: true,
      refreshVisibleSelfLoops: false,
      budgets: { maxActions: 1, maxStates: 10, maxDepth: 2, maxDurationMs: 10_000 },
      monotonicNow: () => 0,
    });

    expect(result.statistics.physicalActions).toBe(1);
    expect(result.termination).toMatchObject({
      reason: "max-actions",
      complete: false,
      remainingFrontierEntries: 2, // B's three actions and A's two remaining siblings
      remainingCandidateActions: 5,
    });
    expect(result.statistics.pendingStates).toBe(2);
    expect(driver.presses).toEqual(["A:RIGHT"]);
  });

  it("counts the unfinished active sibling after replay uses the final allowed action", async () => {
    const driver = new FrontierDriver({
      A: { RIGHT: "B", DOWN: "C" },
      B: {},
      C: {},
    });
    const result = await explore(driver, {
      actions: ["RIGHT", "DOWN"],
      budgets: { maxActions: 5, maxStates: 10, maxDepth: 2, maxDurationMs: 10_000 },
      monotonicNow: () => 0,
    });

    expect(result.statistics).toMatchObject({
      physicalActions: 5,
      explorationActions: 3,
      replayActions: 2,
      pendingStates: 2,
    });
    expect(result.termination).toMatchObject({
      reason: "max-actions",
      complete: false,
      remainingFrontierEntries: 2,
      remainingCandidateActions: 3, // B:DOWN plus two C actions
    });
    expect(driver.presses).not.toContain("B:DOWN");
  });

  it("retains the actions of a skipped unsafe replay branch after other work completes", async () => {
    const driver = new FrontierDriver({
      A: { SELECT: "B", RIGHT: "C" },
      B: {},
      C: {},
    });
    const result = await explore(driver, {
      actions: ["SELECT", "RIGHT"],
      replayActions: ["RIGHT"],
      restorationMode: "verified-local",
      refreshVisibleSelfLoops: false,
      budgets: { maxActions: 30, maxStates: 10, maxDepth: 2, maxDurationMs: 10_000 },
      monotonicNow: () => 0,
    });

    expect(result.termination).toMatchObject({
      reason: "restoration-unavailable",
      complete: false,
      restorationRejectionReason: "unsafe-root-replay",
      remainingFrontierEntries: 1,
      remainingCandidateActions: 2,
    });
    expect(result.termination.detail).toMatch(/unsafe.*SELECT|SELECT.*unsafe/iu);
    expect(result.statistics.pendingStates).toBe(1);
    expect(result.graph.focus.states).toHaveLength(3);
    expect(result.graph.actions.filter((action) => action.fromFocusStateId === "focus-0002")).toHaveLength(0);
    expect(driver.presses.filter((press) => press === "A:SELECT")).toHaveLength(1);
  });

  it("counts blocked restoration work alongside the currently interrupted action suffix", async () => {
    const driver = new FrontierDriver({
      A: { SELECT: "B", RIGHT: "C" },
      B: {},
      C: {},
    });
    const result = await explore(driver, {
      actions: ["SELECT", "RIGHT"],
      replayActions: ["RIGHT"],
      restorationMode: "verified-local",
      refreshVisibleSelfLoops: false,
      budgets: { maxActions: 4, maxStates: 10, maxDepth: 2, maxDurationMs: 10_000 },
      monotonicNow: () => 0,
    });

    expect(result.termination).toMatchObject({
      reason: "max-actions",
      complete: false,
      remainingFrontierEntries: 2, // blocked B and in-progress C
      remainingCandidateActions: 3, // B has 2 untested keys; C has 1
    });
    expect(result.statistics).toMatchObject({
      physicalActions: 4,
      pendingStates: 2,
    });
    expect(result.restorationDiagnostics?.some((diagnostic) => (
      diagnostic.status === "failed"
      && diagnostic.rejectionReason === "unsafe-root-replay"
    ))).toBe(true);
  });

  it("reports only the hook-selected actions when the clock expires before the first press", async () => {
    const driver = new FrontierDriver({ A: {}, B: {}, C: {} });
    let now = 0;
    const result = await explore(driver, {
      actions: ["UP", "RIGHT", "DOWN"],
      actionsForState: () => {
        now = 10;
        return ["RIGHT"];
      },
      budgets: { maxActions: 30, maxStates: 10, maxDepth: 2, maxDurationMs: 10 },
      monotonicNow: () => now,
    });

    expect(result.termination).toMatchObject({
      reason: "max-duration",
      complete: false,
      remainingFrontierEntries: 1,
      remainingCandidateActions: 1,
    });
    expect(result.statistics.pendingStates).toBe(1);
    expect(driver.presses).toEqual([]);
  });
});
