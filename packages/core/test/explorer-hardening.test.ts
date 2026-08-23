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

import {
  EXPLORATION_BUDGET_PROFILES,
  explore,
  pressAndObserve,
} from "../src/index.js";

function node(
  stableId: string,
  role: string,
  focusable: boolean,
  focused: boolean,
  children: readonly UiNodeSnapshot[] = [],
  x = 100,
): UiNodeSnapshot {
  return {
    stableId,
    role,
    name: stableId,
    text: stableId,
    bounds: focusable ? { x, y: 200, width: 180, height: 72 } : null,
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

function carouselSnapshot(position: number, defect: boolean, size: number): StateSnapshot {
  if (defect) {
    return {
      capturedAt: "2026-08-22T12:00:00.000Z",
      location: availableObservation("app://defect"),
      focusedElement: availableObservation({
        stableId: "defect-confirm",
        role: "button",
        name: "Defect confirmation",
        bounds: { x: 100, y: 200, width: 180, height: 72 },
      }),
      uiTree: availableObservation([
        node("defect-screen", "main", false, false, [
          node("defect-confirm", "button", true, true),
        ]),
      ]),
    };
  }
  const cards = Array.from({ length: size }, (_, index) => (
    node(`stress-card-${String(index + 1)}`, "button", true, index === position, [], 100 + index * 196)
  ));
  return {
    capturedAt: "2026-08-22T12:00:00.000Z",
    location: availableObservation("app://home"),
    focusedElement: availableObservation({
      stableId: `stress-card-${String(position + 1)}`,
      role: "button",
      name: `Movie ${String(position + 1)}`,
      bounds: { x: 100 + position * 196, y: 200, width: 180, height: 72 },
    }),
    uiTree: availableObservation([
      node("home-screen", "main", false, false, [
        node("stress-row", "list", false, false, cards),
      ]),
    ]),
  };
}

class CarouselDriver implements TVDoctorDriver {
  #position = 0;
  #defect = false;
  #sequence = 0;
  readonly size: number;

  constructor(size: number) {
    this.size = size;
  }

  async capabilities(): Promise<ReadonlySet<Capability>> {
    return new Set(["remote-input", "ui-tree"]);
  }

  async press(key: RemoteKey): Promise<ActionResult> {
    this.#sequence += 1;
    if (!this.#defect && key === "RIGHT") {
      this.#position = Math.min(this.#position + 1, this.size - 1);
    } else if (!this.#defect && key === "SELECT") {
      this.#defect = true;
    }
    return { key, outcome: "applied", timing: { inputSentAtMs: this.#sequence } };
  }

  async snapshot(): Promise<StateSnapshot> {
    return carouselSnapshot(this.#position, this.#defect, this.size);
  }

  async reset(strategy: ResetStrategy): Promise<void> {
    void strategy;
    this.#position = 0;
    this.#defect = false;
  }
}

function focusStableId(snapshot: StateSnapshot): string | null {
  return snapshot.focusedElement.status === "available"
    ? snapshot.focusedElement.value?.stableId ?? null
    : null;
}

describe("M8 explorer hardening", () => {
  it("publishes strict quick, standard, and deep resource profiles", async () => {
    expect(EXPLORATION_BUDGET_PROFILES.quick).toEqual({
      maxActions: 300,
      maxStates: 75,
      maxDepth: 8,
      maxDurationMs: 30_000,
    });
    expect(EXPLORATION_BUDGET_PROFILES.standard.maxActions)
      .toBeLessThan(EXPLORATION_BUDGET_PROFILES.deep.maxActions);

    const result = await explore(new CarouselDriver(4), {
      profile: "quick",
      actions: ["SELECT"],
      budgets: { maxActions: 5 },
      monotonicNow: () => 0,
    });
    expect(result.budgets).toEqual({ ...EXPLORATION_BUDGET_PROFILES.quick, maxActions: 5 });
    expect(result.statistics.physicalActions).toBeLessThanOrEqual(5);
  });

  it("compresses a large repeated row while retaining the same reachable defect", async () => {
    const common = {
      actions: ["RIGHT", "SELECT"] as const,
      budgets: {
        maxActions: 500,
        maxStates: 100,
        maxDepth: 8,
        maxDurationMs: 10_000,
      },
      monotonicNow: () => 0,
    };
    const baseline = await explore(new CarouselDriver(200), common);
    const hardened = await explore(new CarouselDriver(200), {
      ...common,
      frontierStrategy: "priority",
      repetitionCompression: {
        enabled: true,
        maxRepresentativesPerGroup: 1,
        maxExpandedRepresentativesPerGroup: 1,
      },
    });

    const includesDefect = (result: Awaited<ReturnType<typeof explore>>): boolean => (
      result.graph.focus.states.some((state) => (
        focusStableId(state.representativeSnapshot) === "defect-confirm"
      ))
    );
    expect(includesDefect(baseline)).toBe(true);
    expect(includesDefect(hardened)).toBe(true);
    expect(hardened.statistics).toMatchObject({
      compressedStates: 1,
      deferredStates: 1,
    });
    expect(hardened.statistics.focusStates).toBeLessThan(baseline.statistics.focusStates);
    expect(hardened.statistics.physicalActions).toBeLessThan(baseline.statistics.physicalActions);
    expect(hardened.graph.focus.states.filter((state) => (
      focusStableId(state.representativeSnapshot)?.startsWith("stress-card-") === true
    ))).toHaveLength(1);
  });

  it("uses a deterministic priority frontier and counts exact repeats", async () => {
    const run = async () => explore(new CarouselDriver(6), {
      actions: ["RIGHT", "SELECT"],
      budgets: {
        maxActions: 40,
        maxStates: 20,
        maxDepth: 2,
        maxDurationMs: 10_000,
      },
      frontierStrategy: "priority",
      repetitionCompression: { enabled: false },
      monotonicNow: () => 0,
    });
    const first = await run();
    const second = await run();

    expect(second).toEqual(first);
    // Root discovers a same-screen card and a new defect screen. New-screen
    // priority expands the defect before the queued card at the same depth.
    expect(focusStableId(first.graph.actions[2]?.beforeSnapshot as StateSnapshot))
      .toBe("defect-confirm");
    expect(first.statistics.repeatedStates).toBeGreaterThan(0);
  });

  it("supports bounded stable-snapshot settling and fails closed when it cannot converge", async () => {
    let phase = 0;
    const stableDriver: TVDoctorDriver = {
      async capabilities() {
        return new Set<Capability>(["remote-input", "ui-tree"]);
      },
      async press(key) {
        phase = 0;
        return { key, outcome: "applied", timing: { inputSentAtMs: 1 } };
      },
      async snapshot() {
        phase += 1;
        return carouselSnapshot(Math.min(phase, 2), false, 4);
      },
      async reset(strategy) {
        void strategy;
        phase = -1;
      },
    };
    const observation = await pressAndObserve(stableDriver, "RIGHT", {
      strategy: "stable-snapshot",
      maxSnapshots: 4,
      requiredStableSnapshots: 2,
      wait: async () => undefined,
    });
    expect(observation).toMatchObject({ snapshotsCaptured: 3, settled: true });
    expect(focusStableId(observation.snapshot)).toBe("stress-card-3");

    let snapshotSequence = 0;
    const neverStable = new CarouselDriver(10);
    const driver: TVDoctorDriver = {
      capabilities: () => neverStable.capabilities(),
      press: (key) => neverStable.press(key),
      async snapshot() {
        snapshotSequence += 1;
        return carouselSnapshot(snapshotSequence % 3, false, 10);
      },
      async reset(strategy) {
        snapshotSequence = 0;
        await neverStable.reset(strategy);
      },
    };
    const result = await explore(driver, {
      actions: ["RIGHT"],
      budgets: { maxActions: 5, maxStates: 5, maxDepth: 2, maxDurationMs: 10_000 },
      settling: {
        strategy: "stable-snapshot",
        maxSnapshots: 3,
        requiredStableSnapshots: 2,
        wait: async () => undefined,
      },
      monotonicNow: () => 0,
    });
    expect(result.termination).toEqual({ reason: "settling-exhausted", complete: false });
    expect(result.statistics).toMatchObject({
      physicalActions: 1,
      settlingPolls: 2,
      unsettledActions: 1,
    });
  });

  it("rejects unsafe hardening configuration before driver work", async () => {
    const driver = new CarouselDriver(4);
    await expect(explore(driver, {
      repetitionCompression: {
        maxRepresentativesPerGroup: 1,
        maxExpandedRepresentativesPerGroup: 2,
      },
    })).rejects.toThrow("must not exceed");
    await expect(explore(driver, {
      settling: { strategy: "stable-snapshot", maxSnapshots: 1, requiredStableSnapshots: 2 },
    })).rejects.toThrow("requiredStableSnapshots");
  });
});
