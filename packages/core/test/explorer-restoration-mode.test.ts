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

function node(id: string, focused: boolean): UiNodeSnapshot {
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

function snapshot(id: string): StateSnapshot {
  return {
    capturedAt: "2026-09-13T00:00:00.000Z",
    location: availableObservation("app://restoration"),
    focusedElement: availableObservation({
      stableId: id,
      role: "button",
      name: id,
      bounds: { x: 0, y: 0, width: 100, height: 50 },
    }),
    uiTree: availableObservation([node(id, true)]),
  };
}

class SelfLoopDriver implements TVDoctorDriver {
  resets = 0;
  presses = 0;

  async capabilities(): Promise<ReadonlySet<Capability>> {
    return new Set(["remote-input", "ui-tree"]);
  }

  async press(key: RemoteKey): Promise<ActionResult> {
    this.presses += 1;
    return { key, outcome: "applied", timing: { inputSentAtMs: this.presses } };
  }

  async snapshot(): Promise<StateSnapshot> {
    return snapshot("root");
  }

  async reset(_strategy: ResetStrategy): Promise<void> {
    this.resets += 1;
  }
}

class OneShotDriftDriver implements TVDoctorDriver {
  state = "a";
  resets = 0;
  rightFromARuns = 0;
  presses = 0;

  async capabilities(): Promise<ReadonlySet<Capability>> {
    return new Set(["remote-input", "ui-tree"]);
  }

  async press(key: RemoteKey): Promise<ActionResult> {
    this.presses += 1;
    if (this.state === "a" && key === "RIGHT") {
      this.rightFromARuns += 1;
      this.state = this.rightFromARuns === 2 ? "drift" : "b";
    } else if (this.state === "a" && key === "LEFT") {
      this.state = "a";
    } else if (this.state === "b") {
      this.state = "b";
    }
    return { key, outcome: "applied", timing: { inputSentAtMs: this.presses } };
  }

  async snapshot(): Promise<StateSnapshot> {
    return snapshot(this.state);
  }

  async reset(_strategy: ResetStrategy): Promise<void> {
    this.resets += 1;
    this.state = "a";
  }
}

describe("verified local explorer restoration", () => {
  it("keeps root-only as the default and reuses an exact live state only when opted in", async () => {
    const rootOnlyDriver = new SelfLoopDriver();
    const rootOnly = await explore(rootOnlyDriver, { actions: ["UP", "DOWN"] });
    const localDriver = new SelfLoopDriver();
    const local = await explore(localDriver, {
      actions: ["UP", "DOWN"],
      restorationMode: "verified-local",
    });

    expect(rootOnly.graph.actions).toEqual(local.graph.actions);
    expect(rootOnly.statistics.resetCount).toBe(3);
    expect(rootOnly.statistics.verifiedStateReuses).toBe(0);
    expect(local.statistics.resetCount).toBe(1);
    expect(local.statistics.verifiedStateReuses).toBe(2);
    expect(local.statistics.restorationFallbacks).toBe(0);
  });

  it("rejects a drifting verified edge and falls back to canonical root replay", async () => {
    const driver = new OneShotDriftDriver();
    const result = await explore(driver, {
      actions: ["RIGHT", "LEFT"],
      restorationMode: "verified-local",
      budgets: { maxActions: 50, maxStates: 10, maxDepth: 3, maxDurationMs: 10_000 },
    });

    expect(result.termination).toEqual({ reason: "queue-exhausted", complete: true });
    expect(result.statistics.restorationFallbacks).toBe(1);
    expect(result.statistics.verifiedPathRestorations).toBeGreaterThanOrEqual(0);
    expect(driver.rightFromARuns).toBeGreaterThanOrEqual(3);
    expect(result.graph.focus.states.some((state) => state.representativeSnapshot.focusedElement.status === "available"
      && state.representativeSnapshot.focusedElement.value?.stableId === "drift")).toBe(false);
  });
});
