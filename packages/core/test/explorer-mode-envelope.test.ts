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

import { EXPLORATION_BUDGET_PROFILES, explore, type ExplorationProfile } from "../src/index.js";
import { normaliseExplorerOptions } from "../src/explorer-options.js";

const MODES = [
  { profile: "quick", actions: 300, states: 75, depth: 8, duration: 30_000, cards: 1 },
  { profile: "standard", actions: 2_500, states: 250, depth: 16, duration: 120_000, cards: 2 },
  { profile: "deep", actions: 10_000, states: 1_000, depth: 32, duration: 1_800_000, cards: null },
] as const satisfies readonly {
  readonly profile: ExplorationProfile;
  readonly actions: number;
  readonly states: number;
  readonly depth: number;
  readonly duration: number;
  readonly cards: number | null;
}[];

type Machine = "self-loop" | "chain" | "branch" | "delayed-branch" | "carousel";
interface SyntheticClock {
  now: number;
  resetCost: number;
  actionCost: number;
  snapshotCost: number;
}

function button(id: string, focused: boolean): UiNodeSnapshot {
  return {
    stableId: id, role: "button", name: id, text: id,
    bounds: { x: 10, y: 20, width: 140, height: 60 },
    visible: true, enabled: true, focusable: true, focused,
    modal: false, selectionState: null, valueNow: null, children: [],
  };
}

class ModeDriver implements TVDoctorDriver {
  readonly mode: Machine;
  readonly clock: SyntheticClock;
  readonly pressed: RemoteKey[] = [];
  readonly cardCount: number;
  readonly branchAfterDepth: number;
  #path = "";
  #cardIndex = 0;

  constructor(mode: Machine, clock?: Partial<SyntheticClock>, cardCount = 6, branchAfterDepth = 0) {
    this.mode = mode;
    this.clock = { now: 0, resetCost: 0, actionCost: 0, snapshotCost: 0, ...clock };
    this.cardCount = cardCount;
    this.branchAfterDepth = branchAfterDepth;
  }

  async capabilities(): Promise<ReadonlySet<Capability>> {
    return new Set(["remote-input", "ui-tree"]);
  }

  async reset(strategy: ResetStrategy): Promise<void> {
    void strategy;
    this.#path = "";
    this.#cardIndex = 0;
    this.clock.now += this.clock.resetCost;
  }

  async press(key: RemoteKey): Promise<ActionResult> {
    this.pressed.push(key);
    if (this.mode === "chain" && key === "RIGHT") this.#path += "R";
    if (this.mode === "branch" && (key === "RIGHT" || key === "DOWN")) {
      this.#path += key === "RIGHT" ? "R" : "D";
    }
    if (this.mode === "delayed-branch" && (key === "RIGHT"
      || (key === "DOWN" && this.#path.length >= this.branchAfterDepth))) {
      this.#path += key === "RIGHT" ? "R" : "D";
    }
    if (this.mode === "carousel" && key === "RIGHT") {
      this.#cardIndex = Math.min(this.#cardIndex + 1, this.cardCount - 1);
    }
    this.clock.now += this.clock.actionCost;
    return { key, outcome: "applied", timing: { inputSentAtMs: this.pressed.length } };
  }

  async snapshot(): Promise<StateSnapshot> {
    this.clock.now += this.clock.snapshotCost;
    const focus = this.mode === "carousel"
      ? `poster-${String(this.#cardIndex + 1)}`
      : this.mode === "self-loop" ? "home" : `node-${this.#path || "root"}`;
    const controls = this.mode === "carousel"
      ? Array.from({ length: this.cardCount }, (_, index) => button(
        `poster-${String(index + 1)}`,
        index === this.#cardIndex,
      ))
      : [button(focus, true)];
    const root: UiNodeSnapshot = {
      ...button("root", false),
      role: this.mode === "carousel" ? "list" : "main",
      focusable: false,
      children: controls,
    };
    return {
      capturedAt: "2026-10-08T21:00:00.000Z",
      location: availableObservation(this.mode === "carousel" || this.mode === "self-loop"
        ? "https://example.test/home"
        : `https://example.test/branch/${this.#path || "root"}`),
      focusedElement: availableObservation({
        stableId: focus, role: "button", name: focus,
        bounds: { x: 10, y: 20, width: 140, height: 60 },
      }),
      uiTree: availableObservation([root]),
    };
  }
}

describe("exploration mode resource envelopes", () => {
  it.each(MODES)(
    "$profile sets $duration ms / $actions actions / $states states / depth $depth without hidden scaling",
    ({ profile, actions, states, depth, duration, cards }) => {
      expect(EXPLORATION_BUDGET_PROFILES[profile]).toEqual({
        maxDurationMs: duration,
        maxActions: actions,
        maxStates: states,
        maxDepth: depth,
      });
      const normalised = normaliseExplorerOptions({ profile });
      expect(normalised.budgets).toEqual(EXPLORATION_BUDGET_PROFILES[profile]);
      expect(normalised.frontierStrategy).toBe("priority");
      expect(normalised.opportunisticFrontier).toBe(false);
      expect(normalised.repetitionCompression).toMatchObject({
        enabled: profile !== "deep",
        maxRepresentativesPerGroup: cards ?? 4,
        maxExpandedRepresentativesPerGroup: profile === "deep" ? 2 : 1,
        minimumEquivalentSiblings: 3,
      });
    },
  );

  it.each(MODES)("terminates $profile at the exact injected $duration ms deadline", async ({
    profile, duration,
  }) => {
    // Reset/replay costs are zero here so the first application action alone
    // crosses the chosen profile's deadline, without sleeping.
    const driver = new ModeDriver("chain", { actionCost: duration });
    const result = await explore(driver, {
      profile,
      actions: ["RIGHT", "DOWN"],
      monotonicNow: () => driver.clock.now,
    });
    expect(result.budgets.maxDurationMs).toBe(duration);
    expect(result.termination).toMatchObject({ reason: "max-duration", complete: false });
    expect(result.statistics.elapsedMs).toBe(duration);
    expect(result.statistics.physicalActions).toBe(1);
    expect(driver.pressed).toEqual(["RIGHT"]);
    expect(result.termination.remainingFrontierEntries).toBeGreaterThanOrEqual(1);
    expect(result.termination.remainingCandidateActions).toBeGreaterThanOrEqual(1);
  });

  it.each(MODES)("stops $profile at the deadline during initial reset with zero presses", async ({
    profile, duration,
  }) => {
    const driver = new ModeDriver("self-loop", { resetCost: duration });
    const result = await explore(driver, { profile, monotonicNow: () => driver.clock.now });
    expect(result.termination).toEqual({ reason: "max-duration", complete: false });
    expect(result.statistics.elapsedMs).toBe(duration);
    expect(result.statistics.physicalActions).toBe(0);
    expect(result.graph.focus.states).toHaveLength(0);
  });

  it.each(MODES)("does not stop $profile one simulated millisecond before the deadline", async ({
    profile, duration,
  }) => {
    const driver = new ModeDriver("self-loop", { actionCost: duration - 1 });
    const result = await explore(driver, {
      profile,
      actions: ["RIGHT"],
      monotonicNow: () => driver.clock.now,
    });
    expect(result.statistics.elapsedMs).toBe(duration - 1);
    expect(result.statistics.physicalActions).toBe(1);
    expect(result.termination).toEqual({ reason: "queue-exhausted", complete: true });
  });

  it.each(MODES)("reports true completion on $profile when no pending actions remain", async ({
    profile, duration,
  }) => {
    const driver = new ModeDriver("self-loop");
    const result = await explore(driver, {
      profile,
      actions: ["RIGHT"],
      monotonicNow: () => driver.clock.now,
    });
    expect(result.budgets.maxDurationMs).toBe(duration);
    expect(result.termination).toEqual({ reason: "queue-exhausted", complete: true });
    expect(result.statistics).toMatchObject({ physicalActions: 1, pendingStates: 0 });
    expect(result.graph.actions).toHaveLength(1);
  });

  it.each(MODES)("honours a $profile action ceiling on an unfinished sibling", async ({
    profile,
  }) => {
    const driver = new ModeDriver("self-loop");
    const result = await explore(driver, {
      profile,
      actions: ["UP", "DOWN", "RIGHT"],
      budgets: { maxActions: 1 },
      monotonicNow: () => driver.clock.now,
    });
    expect(result.budgets).toEqual({
      ...EXPLORATION_BUDGET_PROFILES[profile],
      maxActions: 1,
    });
    expect(result.termination).toMatchObject({
      reason: "max-actions", complete: false,
      remainingFrontierEntries: 1, remainingCandidateActions: 2,
    });
    expect(result.statistics.physicalActions).toBe(1);
  });

  it.each(MODES)("honours a $profile state ceiling and records the excluded edge", async ({
    profile,
  }) => {
    const driver = new ModeDriver("chain");
    const result = await explore(driver, {
      profile,
      actions: ["RIGHT"],
      budgets: { maxStates: 2 },
      monotonicNow: () => driver.clock.now,
    });
    expect(result.termination).toMatchObject({ reason: "max-states", complete: false });
    expect(result.statistics.focusStates).toBe(2);
    expect(result.graph.actions.at(-1)).toMatchObject({
      toFocusStateId: null,
      actionSequence: ["RIGHT", "RIGHT"],
    });
    expect(result.budgets.maxStates).toBe(2);
  });

  it.each(MODES)("honours a $profile discovery-depth ceiling without claiming completion", async ({
    profile,
  }) => {
    const driver = new ModeDriver("chain");
    const result = await explore(driver, {
      profile,
      actions: ["RIGHT"],
      budgets: { maxDepth: 2 },
      monotonicNow: () => driver.clock.now,
    });
    expect(result.termination).toMatchObject({ reason: "max-depth", complete: false });
    expect(result.statistics.maximumPathDepth).toBe(2);
    expect(result.statistics.focusStates).toBe(3);
    expect(result.statistics.physicalActions).toBeLessThan(result.budgets.maxActions);
  });

  it.each(MODES)("uses the full $profile depth allowance before truncating expansion", async ({
    profile, depth,
  }) => {
    const driver = new ModeDriver("chain");
    const result = await explore(driver, {
      profile, actions: ["RIGHT"],
      monotonicNow: () => driver.clock.now,
    });
    expect(result.statistics.maximumPathDepth).toBe(depth);
    expect(result.statistics.focusStates).toBe(depth + 1);
    expect(result.termination).toMatchObject({ reason: "max-depth", complete: false });
  });

  it.each(MODES)(
    "enforces untouched $profile action/state/depth ceilings on a branching graph",
    async ({ profile, actions, states, depth }) => {
      const driver = new ModeDriver("branch");
      const result = await explore(driver, {
        profile,
        actions: ["RIGHT", "DOWN"],
        monotonicNow: () => driver.clock.now,
      });
      expect(result.budgets).toEqual(EXPLORATION_BUDGET_PROFILES[profile]);
      expect(result.termination.complete).toBe(false);
      expect(result.termination.reason).toBe(profile === "quick" ? "max-actions" : "max-states");
      expect(result.statistics.physicalActions).toBeLessThanOrEqual(actions);
      expect(result.statistics.focusStates).toBeLessThanOrEqual(states);
      expect(result.statistics.maximumPathDepth).toBeLessThanOrEqual(depth);
      expect(driver.pressed).toHaveLength(result.statistics.physicalActions);
      // A saturated, unfinished frontier is not a clean traversal exhaust.
      if (result.termination.reason === "max-actions") {
        expect(result.statistics.physicalActions).toBe(actions);
        expect(result.termination.remainingCandidateActions).toBeGreaterThan(0);
      }
      if (result.termination.reason === "max-states") {
        expect(result.statistics.focusStates).toBe(states);
      }
    },
  );

  it.each([
    { profile: "standard", branchAfterDepth: 8 },
    { profile: "deep", branchAfterDepth: 14 },
  ] as const)("reaches the unmodified $profile action cap despite a long replay corridor",
    async ({ profile, branchAfterDepth }) => {
      const driver = new ModeDriver("delayed-branch", undefined, 6, branchAfterDepth);
      const result = await explore(driver, {
        profile,
        actions: ["RIGHT", "DOWN"],
        monotonicNow: () => driver.clock.now,
      });
      expect(result.termination).toMatchObject({ reason: "max-actions", complete: false });
      expect(result.statistics.physicalActions).toBe(EXPLORATION_BUDGET_PROFILES[profile].maxActions);
      expect(result.statistics.focusStates).toBeLessThan(EXPLORATION_BUDGET_PROFILES[profile].maxStates);
      expect(result.termination.remainingCandidateActions).toBeGreaterThan(0);
    },
  );

  it.each(MODES)("allows per-field budget overrides without changing other $profile limits", ({
    profile, actions, states, depth, duration,
  }) => {
    const options = normaliseExplorerOptions({
      profile,
      budgets: { maxActions: actions - 1, maxDepth: depth - 1 },
    });
    expect(options.budgets).toEqual({
      maxActions: actions - 1,
      maxStates: states,
      maxDepth: depth - 1,
      maxDurationMs: duration,
    });
  });

  it("compresses repeated Quick/Standard carousel targets, but expands them in Deep", async () => {
    const run = async (profile: ExplorationProfile) => {
      const driver = new ModeDriver("carousel");
      return explore(driver, {
        profile,
        actions: ["RIGHT"],
        monotonicNow: () => driver.clock.now,
      });
    };
    const quick = await run("quick");
    const standard = await run("standard");
    const deep = await run("deep");
    expect(quick.statistics.compressedStates).toBeGreaterThan(0);
    // Standard admits a second representative but defers its expansion, so
    // a third card is never observed and does not increment compressedStates.
    expect(standard.statistics.compressedStates).toBe(0);
    expect(quick.statistics.deferredStates).toBeGreaterThan(0);
    expect(standard.statistics.deferredStates).toBeGreaterThan(0);
    // Compression may exhaust the runnable queue while distinct controls are
    // deferred. Consumers must check deferredStates, not queue exhaustion alone.
    expect(quick.termination.reason).toBe("queue-exhausted");
    expect(standard.termination.reason).toBe("queue-exhausted");
    expect(quick.termination.complete && quick.statistics.deferredStates === 0).toBe(false);
    expect(standard.termination.complete && standard.statistics.deferredStates === 0).toBe(false);
    expect(quick.statistics.focusStates).toBe(1);
    expect(standard.statistics.focusStates).toBe(2);
    expect(deep.statistics.compressedStates).toBe(0);
    expect(deep.statistics.deferredStates).toBe(0);
    expect(deep.statistics.focusStates).toBe(6);
    expect(deep.termination).toEqual({ reason: "queue-exhausted", complete: true });
  });

  it("lets Deep disable compression explicitly or Quick enable a wider representative envelope", () => {
    expect(normaliseExplorerOptions({ profile: "quick", repetitionCompression: { enabled: false } })
      .repetitionCompression.enabled).toBe(false);
    expect(normaliseExplorerOptions({ profile: "deep", repetitionCompression: { enabled: true } })
      .repetitionCompression).toMatchObject({
        enabled: true, maxRepresentativesPerGroup: 4, maxExpandedRepresentativesPerGroup: 2,
      });
  });
});
