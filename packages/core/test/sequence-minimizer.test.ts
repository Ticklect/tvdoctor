import type { RemoteKey } from "@tvdoctor/protocol";
import { describe, expect, it } from "vitest";

import {
  explore,
  minimizeActionSequence,
  minimizeGraphSequence,
} from "../src/index.js";
import {
  availableObservation,
  type ActionResult,
  type Capability,
  type ResetStrategy,
  type StateSnapshot,
  type TVDoctorDriver,
  type UiNodeSnapshot,
} from "@tvdoctor/protocol";

function snapshot(position: number): StateSnapshot {
  const control = (index: number): UiNodeSnapshot => ({
    stableId: `control-${String(index)}`,
    role: "button",
    name: `Control ${String(index)}`,
    text: null,
    bounds: { x: index * 100, y: 100, width: 80, height: 60 },
    visible: true,
    enabled: true,
    focusable: true,
    focused: index === position,
    modal: false,
    selectionState: null,
    valueNow: null,
    children: [],
  });
  return {
    capturedAt: "2026-08-22T12:00:00.000Z",
    location: availableObservation("app://sequence"),
    focusedElement: availableObservation({
      stableId: `control-${String(position)}`,
      role: "button",
      name: `Control ${String(position)}`,
      bounds: { x: position * 100, y: 100, width: 80, height: 60 },
    }),
    uiTree: availableObservation([control(0), control(1), control(2)]),
  };
}

class ThreePositionDriver implements TVDoctorDriver {
  #position = 0;
  #sequence = 0;

  async capabilities(): Promise<ReadonlySet<Capability>> {
    return new Set(["remote-input", "ui-tree"]);
  }

  async press(key: RemoteKey): Promise<ActionResult> {
    this.#sequence += 1;
    if (key === "RIGHT") this.#position = Math.min(2, this.#position + 1);
    if (key === "LEFT") this.#position = Math.max(0, this.#position - 1);
    return { key, outcome: "applied", timing: { inputSentAtMs: this.#sequence } };
  }

  async snapshot(): Promise<StateSnapshot> {
    return snapshot(this.#position);
  }

  async reset(strategy: ResetStrategy): Promise<void> {
    void strategy;
    this.#position = 0;
  }
}

describe("exact sequence minimisation", () => {
  it("removes actions only after an exact semantic oracle accepts the candidate", async () => {
    const finalPosition = (sequence: readonly RemoteKey[]): number => sequence.reduce((position, key) => (
      key === "RIGHT" ? Math.min(2, position + 1) : key === "LEFT" ? Math.max(0, position - 1) : position
    ), 0);
    const original = ["RIGHT", "LEFT", "RIGHT", "RIGHT"] as const;
    const expected = finalPosition(original);
    const result = await minimizeActionSequence(
      original,
      (candidate) => finalPosition(candidate) === expected,
      { preserveFinalAction: true },
    );

    expect(result).toMatchObject({
      status: "minimized",
      minimizedSequence: ["RIGHT", "RIGHT"],
      removedActions: 2,
      semanticsPreserved: true,
    });
    expect(original).toEqual(["RIGHT", "LEFT", "RIGHT", "RIGHT"]);
  });

  it("minimises to the identical observed graph state and rejects ambiguous evidence", async () => {
    const graph = await explore(new ThreePositionDriver(), {
      actions: ["RIGHT", "LEFT"],
      budgets: { maxActions: 100, maxStates: 10, maxDepth: 4, maxDurationMs: 10_000 },
      monotonicNow: () => 0,
    });
    const minimized = await minimizeGraphSequence(
      graph.graph,
      ["RIGHT", "LEFT", "RIGHT", "RIGHT"],
      { preserveFinalAction: true },
    );
    expect(minimized).toMatchObject({
      status: "minimized",
      minimizedSequence: ["RIGHT", "RIGHT"],
      semanticsPreserved: true,
    });

    const ambiguous = {
      ...graph.graph,
      focus: {
        ...graph.graph.focus,
        transitions: [
          ...graph.graph.focus.transitions,
          {
            ...(graph.graph.focus.transitions[0] as NonNullable<
              (typeof graph.graph.focus.transitions)[number]
            >),
            toFocusStateId: "different-state",
          },
        ],
      },
    };
    await expect(minimizeGraphSequence(ambiguous, ["RIGHT"]))
      .resolves.toMatchObject({ status: "baseline-rejected", semanticsPreserved: false });
  });

  it("reports check-budget exhaustion without returning an unproved candidate", async () => {
    const result = await minimizeActionSequence(
      ["UP", "DOWN", "LEFT", "RIGHT", "SELECT"],
      () => true,
      { maxChecks: 1 },
    );
    expect(result).toMatchObject({
      status: "max-checks",
      minimizedSequence: ["UP", "DOWN", "LEFT", "RIGHT", "SELECT"],
      checks: 1,
      semanticsPreserved: true,
    });
  });
});
