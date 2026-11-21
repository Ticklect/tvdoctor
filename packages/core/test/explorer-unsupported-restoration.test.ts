import {
  availableObservation,
  type Capability,
  type RemoteKey,
  type StateSnapshot,
  type TVDoctorDriver,
} from "@tvdoctor/protocol";
import { describe, expect, it } from "vitest";

import { diagnoseNavigation, explore, type ExplorationResult } from "../src/index.js";

function snapshot(focus: string): StateSnapshot {
  return {
    capturedAt: "2026-10-09T00:00:00.000Z",
    location: availableObservation("app://navigation-test"),
    focusedElement: availableObservation({ stableId: focus, role: "button", name: focus }),
    uiTree: availableObservation([]),
  };
}

/**
 * Unsupported keys are never dispatched. An applied key can still mutate
 * invisible history while leaving the semantic focus unchanged, and therefore
 * must retain the root refresh that isolates the next sibling action.
 */
class UnsupportedAndHiddenActionDriver implements TVDoctorDriver {
  focus = "root";
  dirty = false;
  resets = 0;
  presses = 0;

  async capabilities(): Promise<ReadonlySet<Capability>> {
    return new Set(["remote-input", "ui-tree"]);
  }

  async reset(): Promise<void> {
    this.resets += 1;
    this.focus = "root";
    this.dirty = false;
  }

  async snapshot(): Promise<StateSnapshot> {
    return snapshot(this.focus);
  }

  async press(key: RemoteKey) {
    this.presses += 1;
    if (key === "SELECT" || key === "BACK") {
      return { key, outcome: "unsupported" as const, timing: { inputSentAtMs: this.presses } };
    }
    if (this.focus === "root" && key === "UP") this.dirty = true;
    if (this.focus === "root" && key === "RIGHT") {
      this.focus = this.dirty ? "contaminated" : "expected";
    }
    return { key, outcome: "applied" as const, timing: { inputSentAtMs: this.presses } };
  }
}

function semanticActions(result: ExplorationResult) {
  return result.graph.actions.map((action) => ({
    key: action.key,
    outcome: action.actionResult.outcome,
    from: action.beforeSnapshot.focusedElement.status === "available"
      ? action.beforeSnapshot.focusedElement.value?.stableId : null,
    to: action.afterSnapshot.focusedElement.status === "available"
      ? action.afterSnapshot.focusedElement.value?.stableId : null,
  }));
}

async function run(mode: "root-only" | "verified-local") {
  const driver = new UnsupportedAndHiddenActionDriver();
  const result = await explore(driver, {
    profile: "deep",
    actions: ["SELECT", "BACK", "UP", "RIGHT"],
    replayActions: ["UP", "RIGHT"],
    restorationMode: mode,
    budgets: { maxActions: 40, maxStates: 10, maxDepth: 1, maxDurationMs: 10_000 },
    settling: { strategy: "driver" },
    monotonicNow: () => 0,
  });
  return { driver, result };
}

describe("unsupported Deep inputs and restoration overhead", () => {
  it("keeps exact traversal while omitting needless root refresh for unsupported self-loops", async () => {
    const baseline = await run("root-only");
    const local = await run("verified-local");

    // Unsupported inputs and the explicit depth cap correctly leave coverage
    // incomplete in both modes, even though every attempted key was observed.
    expect(baseline.result.termination).toMatchObject({ reason: "max-depth", complete: false });
    expect(local.result.termination).toEqual(baseline.result.termination);
    expect(semanticActions(local.result)).toEqual(semanticActions(baseline.result));
    expect(local.result.graph.focus.states.map((state) => state.stateFingerprint).sort()).toEqual(
      baseline.result.graph.focus.states.map((state) => state.stateFingerprint).sort(),
    );
    expect(local.result.graph.screens.states.map((state) => state.fingerprint.value).sort()).toEqual(
      baseline.result.graph.screens.states.map((state) => state.fingerprint.value).sort(),
    );
    expect(diagnoseNavigation(local.result).findings.map((finding) => finding.issue.id).sort()).toEqual(
      diagnoseNavigation(baseline.result).findings.map((finding) => finding.issue.id).sort(),
    );

    expect(local.driver.focus).toBe("expected");
    expect(local.result.statistics.resetCount).toBe(2);
    expect(local.result.statistics.resetCount).toBeLessThan(baseline.result.statistics.resetCount);
    expect(local.result.statistics.physicalActions).toBe(local.driver.presses);
    expect(baseline.result.statistics.physicalActions).toBe(baseline.driver.presses);
    expect(local.result.statistics.replayActions).toBe(0);
  });
});
