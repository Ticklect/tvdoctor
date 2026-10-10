import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  availableObservation,
  type ActionResult,
  type Capability,
  type RemoteKey,
  type StateSnapshot,
  type TVDoctorDriver,
  type UiNodeSnapshot,
} from "@tvdoctor/protocol";
import {
  diagnoseNavigation,
  explore,
  type ExplorationRestorationMode,
  type ExplorationResult,
} from "../src/index.js";

type Focus = "A" | "B" | "C" | "D";
const ACTIONS = ["UP", "DOWN", "LEFT", "RIGHT"] as const;
const NEXT: Readonly<Record<Focus, Readonly<Record<(typeof ACTIONS)[number], Focus>>>> = {
  A: { UP: "D", DOWN: "C", LEFT: "B", RIGHT: "B" },
  B: { UP: "C", DOWN: "D", LEFT: "A", RIGHT: "A" },
  C: { UP: "B", DOWN: "A", LEFT: "D", RIGHT: "D" },
  D: { UP: "A", DOWN: "B", LEFT: "C", RIGHT: "C" },
};

function snapshot(focus: Focus): StateSnapshot {
  const controls: UiNodeSnapshot[] = (["A", "B", "C", "D"] as const).map((id) => ({
    stableId: id,
    role: "button",
    name: id,
    text: id,
    bounds: { x: 100, y: 100, width: 160, height: 64 },
    visible: true,
    enabled: true,
    focusable: true,
    focused: id === focus,
    modal: false,
    selectionState: null,
    valueNow: null,
    children: [],
  }));
  return {
    capturedAt: "2026-10-08T00:00:00.000Z",
    location: availableObservation("app://deterministic-web-navigation"),
    focusedElement: availableObservation({
      stableId: focus,
      name: focus,
      role: "button",
      bounds: { x: 100, y: 100, width: 160, height: 64 },
    }),
    uiTree: availableObservation(controls),
  };
}

const resetDelayMs = 3;
class StableWebMachine implements TVDoctorDriver {
  focus: Focus = "A";
  resets = 0;
  presses = 0;
  async capabilities(): Promise<ReadonlySet<Capability>> {
    return new Set(["remote-input", "ui-tree"]);
  }
  async reset(): Promise<void> {
    this.resets++;
    await new Promise<void>((resolve) => setTimeout(resolve, resetDelayMs));
    this.focus = "A";
  }
  async press(key: RemoteKey): Promise<ActionResult> {
    this.presses++;
    if (key in NEXT[this.focus]) {
      this.focus = NEXT[this.focus][key as (typeof ACTIONS)[number]];
    }
    return { key, outcome: "applied", timing: { inputSentAtMs: 0, screenSettledAtMs: 0 } };
  }
  async snapshot(): Promise<StateSnapshot> {
    return snapshot(this.focus);
  }
}

function canonicalGraph(result: ExplorationResult): readonly string[] {
  // Discovery/queue priorities may assign different numeric state IDs. Compare
  // every actual semantic transition, not implementation-dependent graph order.
  return result.graph.actions.map((entry) => {
    const before = entry.beforeSnapshot.focusedElement;
    const after = entry.afterSnapshot.focusedElement;
    return `${before.status === "available" ? before.value?.stableId : "missing"}:${entry.key}->${after.status === "available" ? after.value?.stableId : "missing"}:${entry.actionResult.outcome}`;
  }).sort();
}

function canonicalFindings(result: ExplorationResult): readonly string[] {
  return diagnoseNavigation(result).findings.map((finding) => (
    `${finding.issue.id}:${finding.issue.rule}:${finding.classification}:${finding.issue.severity}`
  )).sort();
}

async function run(mode: ExplorationRestorationMode, maxActions = 100) {
  const driver = new StableWebMachine();
  const start = performance.now();
  const result = await explore(driver, {
    profile: "standard",
    actions: ACTIONS,
    restorationMode: mode,
    allowRootRestorationFallback: true,
    refreshVisibleSelfLoops: true,
    repetitionCompression: { enabled: false },
    budgets: { maxActions, maxStates: 20, maxDepth: 5, maxDurationMs: 20_000 },
    settling: { strategy: "driver" },
  });
  return {
    result,
    elapsedMs: performance.now() - start,
    resets: driver.resets,
    presses: driver.presses,
  };
}

describe("web navigation opt-in restoration A/B", () => {
  it("preserves exact semantic graph and findings while reducing resets and replay actions", async () => {
    const baseline = await run("root-only");
    const live = await run("verified-live-only");
    const optimised = await run("verified-local");
    expect(baseline.result.termination.complete).toBe(true);
    expect(live.result.termination.complete).toBe(true);
    expect(optimised.result.termination.complete).toBe(true);
    expect(canonicalGraph(optimised.result)).toEqual(canonicalGraph(baseline.result));
    expect(canonicalGraph(live.result)).toEqual(canonicalGraph(baseline.result));
    expect(canonicalFindings(optimised.result)).toEqual(canonicalFindings(baseline.result));
    expect(canonicalFindings(live.result)).toEqual(canonicalFindings(baseline.result));
    expect(optimised.resets).toBeLessThan(baseline.resets);
    expect(optimised.result.statistics.replayActions).toBeLessThan(baseline.result.statistics.replayActions);
    for (const sample of [baseline, live, optimised]) {
      expect(sample.result.statistics.resetCount).toBe(sample.resets);
      expect(sample.result.statistics.physicalActions).toBe(sample.presses);
      expect(sample.result.statistics.physicalActions).toBe(
        sample.result.statistics.explorationActions + sample.result.statistics.replayActions,
      );
    }
    // Performance.now is reported for A/B observation; a timing threshold is
    // deliberately not asserted because CI timer scheduling is variable.
    console.info(JSON.stringify({
      fixture: "four-focus-web-navigation",
      baseline: { resets: baseline.resets, replayActions: baseline.result.statistics.replayActions, elapsedMs: +baseline.elapsedMs.toFixed(1) },
      verifiedLive: { resets: live.resets, replayActions: live.result.statistics.replayActions, elapsedMs: +live.elapsedMs.toFixed(1) },
      verifiedLocal: { resets: optimised.resets, replayActions: optimised.result.statistics.replayActions, elapsedMs: +optimised.elapsedMs.toFixed(1) },
    }));
  });

  it("never claims complete coverage when the real press budget is exhausted", async () => {
    for (const mode of ["root-only", "verified-live-only", "verified-local"] as const) {
      const { result, presses } = await run(mode, 5);
      expect(result.termination.complete).toBe(false);
      expect(result.termination.reason).toBe("max-actions");
      expect(presses).toBeLessThanOrEqual(5);
      expect(result.statistics.physicalActions).toBe(presses);
    }
  });
});
