import { performance } from "node:perf_hooks";
import {
  availableObservation,
  type ActionResult,
  type Capability,
  type RemoteKey,
  type StateSnapshot,
  type TVDoctorDriver,
  type UiNodeSnapshot,
} from "@tvdoctor/protocol";
import { describe, expect, it } from "vitest";
import { diagnoseNavigation, explore, type ExplorationRestorationMode, type ExplorationResult } from "../src/index.js";

const KEYS = ["UP", "DOWN", "LEFT", "RIGHT"] as const;
const ROWS = 6;
const COLUMNS = 4;
const SCREEN_NAMES = ["Home", "Library", "Search", "Settings", "Live", "Profile"] as const;

function canonicalFocus(snapshot: StateSnapshot): string {
  const focused = snapshot.focusedElement;
  const location = snapshot.location;
  return `${location.status === "available" ? location.value : "unavailable"}/${focused.status === "available" ? focused.value?.stableId : "unavailable"}`;
}

function canonicalResult(result: ExplorationResult) {
  const stateById = new Map(result.graph.focus.states.map((state) => [
    state.id, canonicalFocus(state.representativeSnapshot),
  ]));
  return {
    screens: result.graph.screens.states.map((state) => state.fingerprint.value).sort(),
    focus: result.graph.focus.states.map((state) => state.stateFingerprint).sort(),
    actions: result.graph.actions.map((action) => (
      `${canonicalFocus(action.beforeSnapshot)}:${action.key}:${action.actionResult.outcome}:${canonicalFocus(action.afterSnapshot)}`
    )).sort(),
    transitions: [...result.graph.focus.transitions, ...result.graph.screens.transitions]
      .map((transition) => (
        `${stateById.get(transition.fromFocusStateId)}:${transition.key}:${transition.actionResult.outcome}:${stateById.get(transition.toFocusStateId)}`
      )).sort(),
    findings: diagnoseNavigation(result).findings.map((finding) => (
      `${finding.issue.id}:${finding.issue.rule}:${finding.classification}:${finding.issue.severity}`
    )).sort(),
  };
}

class MultiScreenGridDriver implements TVDoctorDriver {
  row = 0;
  column = 0;
  presses = 0;
  resets = 0;

  async capabilities(): Promise<ReadonlySet<Capability>> {
    return new Set(["remote-input", "ui-tree"]);
  }

  async reset(): Promise<void> {
    this.resets += 1;
    this.row = 0;
    this.column = 0;
  }

  async press(key: RemoteKey): Promise<ActionResult> {
    this.presses += 1;
    switch (key) {
      case "UP": this.row = (this.row + ROWS - 1) % ROWS; break;
      case "DOWN": this.row = (this.row + 1) % ROWS; break;
      case "LEFT": this.column = (this.column + COLUMNS - 1) % COLUMNS; break;
      case "RIGHT": this.column = (this.column + 1) % COLUMNS; break;
      default: break;
    }
    return { key, outcome: "applied", timing: { inputSentAtMs: this.presses } };
  }

  async snapshot(): Promise<StateSnapshot> {
    const controls: UiNodeSnapshot[] = Array.from({ length: 32 }, (_, index) => {
      const isControl = index < COLUMNS;
      return {
        stableId: isControl ? `control-${String(index)}` : `decoration-${String(index)}`,
        role: isControl ? "button" : "text",
        name: `Item ${String(index)}`,
        text: `Item ${String(index)}`,
        bounds: { x: (index % 8) * 90, y: Math.floor(index / 8) * 70, width: 80, height: 60 },
        visible: true,
        enabled: isControl,
        focusable: isControl,
        focused: isControl && index === this.column,
        modal: false,
        selectionState: null,
        valueNow: null,
        children: [],
      };
    });
    return {
      capturedAt: "2026-10-10T00:00:00.000Z",
      location: availableObservation(`app://complex/${SCREEN_NAMES[this.row] ?? "Home"}`),
      focusedElement: availableObservation({
        stableId: `control-${String(this.column)}`,
        name: `Item ${String(this.column)}`,
        role: "button",
        bounds: { x: this.column * 90, y: 0, width: 80, height: 60 },
      }),
      uiTree: availableObservation(controls),
    };
  }
}

async function run(mode: ExplorationRestorationMode, maxActions = 1_500) {
  const driver = new MultiScreenGridDriver();
  const started = performance.now();
  const result = await explore(driver, {
    profile: "deep",
    actions: KEYS,
    restorationMode: mode,
    opportunisticFrontier: false,
    repetitionCompression: { enabled: false },
    budgets: { maxActions, maxStates: 60, maxDepth: 12, maxDurationMs: 120_000 },
    settling: { strategy: "driver" },
  });
  return { result, driver, elapsedMs: performance.now() - started };
}

describe("complex six-screen replay A/B", () => {
  it("preserves every focus, screen, transition and finding across restoration strategies", async () => {
    const baseline = await run("root-only");
    const local = await run("verified-local");

    expect(baseline.result.termination).toEqual({ reason: "queue-exhausted", complete: true });
    expect(local.result.termination).toEqual(baseline.result.termination);
    expect(baseline.result.graph.screens.states).toHaveLength(ROWS);
    expect(baseline.result.graph.focus.states).toHaveLength(ROWS * COLUMNS);
    expect(baseline.result.graph.actions).toHaveLength(ROWS * COLUMNS * KEYS.length);
    expect(canonicalResult(local.result)).toEqual(canonicalResult(baseline.result));
    expect(local.result.statistics.physicalActions).toBe(local.driver.presses);
    expect(baseline.result.statistics.physicalActions).toBe(baseline.driver.presses);
    expect(local.result.statistics.resetCount).toBe(local.driver.resets);
    expect(baseline.result.statistics.resetCount).toBe(baseline.driver.resets);
    expect(local.result.statistics.replayActions).toBeLessThan(baseline.result.statistics.replayActions);
    console.info(JSON.stringify({
      fixture: "six-screen-24-focus-grid",
      rootOnly: {
        resets: baseline.driver.resets,
        explorationActions: baseline.result.statistics.explorationActions,
        replayActions: baseline.result.statistics.replayActions,
        physicalActions: baseline.driver.presses,
        elapsedMs: +baseline.elapsedMs.toFixed(1),
      },
      verifiedLocal: {
        resets: local.driver.resets,
        explorationActions: local.result.statistics.explorationActions,
        replayActions: local.result.statistics.replayActions,
        physicalActions: local.driver.presses,
        elapsedMs: +local.elapsedMs.toFixed(1),
      },
    }));
  });

  it("keeps incomplete frontiers explicit when the physical action ceiling is reached", async () => {
    for (const mode of ["root-only", "verified-local"] as const) {
      const { result, driver } = await run(mode, 27);
      expect(result.termination).toMatchObject({ reason: "max-actions", complete: false });
      expect(result.termination.remainingCandidateActions).toBeGreaterThan(0);
      expect(result.statistics.physicalActions).toBe(driver.presses);
      expect(driver.presses).toBeLessThanOrEqual(27);
    }
  });
});
