import {
  availableObservation,
  NAVIGATION_KEYS,
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
  prepareStartup,
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

    const activated = await pressAndObserve(stableDriver, "SELECT", {
      strategy: "stable-snapshot",
      maxSnapshots: 4,
      requiredStableSnapshots: 2,
      keyOverrides: {
        SELECT: { maxSnapshots: 4, requiredStableSnapshots: 3 },
      },
      wait: async () => undefined,
    });
    expect(activated).toMatchObject({ snapshotsCaptured: 4, settled: true });

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

  it("does not report queue exhaustion when tolerated exploration actions remain unobserved", async () => {
    const driver: TVDoctorDriver = {
      async capabilities() {
        return new Set<Capability>(["remote-input"]);
      },
      async press(key) {
        unobservedCount += 1;
        return {
          key,
          outcome: "inconclusive",
          message: "observation lost",
          timing: { inputSentAtMs: unobservedCount },
        };
      },
      async snapshot() {
        return carouselSnapshot(0, false, 4);
      },
      async reset() {
        return undefined;
      },
    };
    let unobservedCount = 0;
    const observedActionCounts: number[] = [];
    const result = await explore(driver, {
      allowUnsettledActions: true,
      onProgress: (progress) => observedActionCounts.push(progress.physicalActions),
      budgets: { maxActions: 10, maxStates: 5, maxDepth: 2, maxDurationMs: 10_000 },
      monotonicNow: (() => {
        let now = 0;
        return () => now += 10;
      })(),
    });

    expect(result.termination).toMatchObject({ reason: "settling-exhausted", complete: false });
    expect(result.statistics.unsettledActions).toBe(NAVIGATION_KEYS.length);
    expect(observedActionCounts).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("keeps a configured repeated-group representative in the expanded graph", async () => {
    const result = await explore(new CarouselDriver(8), {
      profile: "quick",
      actions: ["RIGHT"],
      budgets: EXPLORATION_BUDGET_PROFILES.quick,
      frontierStrategy: "priority",
      repetitionCompression: {
        enabled: true,
        maxRepresentativesPerGroup: 1,
        maxExpandedRepresentativesPerGroup: 1,
      },
      monotonicNow: () => 0,
    });

    const rootId = result.graph.focus.states[0]?.id;
    expect(result.termination.complete).toBe(true);
    expect(result.statistics.deferredStates).toBeGreaterThan(0);
    expect(rootId).toBeDefined();
    expect(result.graph.actions.some((action) => action.fromFocusStateId === rootId)).toBe(true);
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

  it("honours explicit stable-snapshot bounds without driver-default rejection", async () => {
    let phase = 0;
    const stableDriver: TVDoctorDriver = {
      async capabilities() {
        return new Set<Capability>(["remote-input"]);
      },
      async press(key) {
        phase = 0;
        return { key, outcome: "applied", timing: { inputSentAtMs: 1 } };
      },
      async snapshot() {
        phase += 1;
        return carouselSnapshot(Math.min(phase, 3), false, 4);
      },
      async reset(strategy) {
        void strategy;
        phase = -1;
      },
    };

    await expect(explore(stableDriver, {
      actions: ["RIGHT"],
      budgets: { maxActions: 2, maxStates: 4, maxDepth: 1, maxDurationMs: 10_000 },
      settling: {
        strategy: "stable-snapshot",
        maxSnapshots: 3,
        pollIntervalMs: 20,
        requiredStableSnapshots: 2,
      },
      monotonicNow: () => 0,
    })).resolves.toMatchObject({ termination: { reason: "settling-exhausted" } });
  });
});

function startupControl(
  stableId: string,
  name: string,
  focused: boolean,
  children: readonly UiNodeSnapshot[] = [],
): UiNodeSnapshot {
  return {
    stableId,
    role: stableId === "consent-dialog" ? "dialog" : "button",
    name,
    text: name,
    bounds: { x: 10, y: 10, width: 100, height: 40 },
    visible: true,
    enabled: true,
    focusable: stableId !== "consent-dialog",
    focused,
    modal: stableId === "consent-dialog",
    selectionState: null,
    valueNow: null,
    children,
  };
}

function startupSnapshot(focusedId: string | null): StateSnapshot {
  const reject = startupControl("reject-consent", "Reject nonessential", focusedId === "reject-consent");
  const accept = startupControl("accept-consent", "Accept", focusedId === "accept-consent");
  const dialog = startupControl("consent-dialog", "Privacy choice", focusedId === "consent-dialog", [reject, accept]);
  void dialog;
  return {
    capturedAt: "2026-08-25T12:00:00.000Z",
    location: availableObservation("https://example.test/"),
    focusedElement: availableObservation(focusedId === null ? null : {
      stableId: focusedId,
      role: "button",
      name: focusedId,
      bounds: { x: 10, y: 10, width: 100, height: 40 },
    }),
    uiTree: availableObservation([dialog]),
  };
}

class StartupConsentDriver implements TVDoctorDriver {
  readonly pressed: string[] = [];
  resetCount = 0;
  choice: "accepted" | "rejected" | null = null;
  focus = "reject-consent";

  async capabilities() {
    return new Set<Capability>(["remote-input", "ui-tree"]);
  }

  async reset() {
    this.resetCount += 1;
    this.focus = this.choice === null ? "reject-consent" : "catalogue-home";
  }

  async press(key: RemoteKey) {
    this.pressed.push(key);
    if (this.choice === null && key === "RIGHT") this.focus = "accept-consent";
    if (this.choice === null && key === "SELECT") {
      this.choice = this.focus === "accept-consent" ? "accepted" : "rejected";
      this.focus = "catalogue-home";
    }
    return { key, outcome: "applied" as const, timing: { inputSentAtMs: this.pressed.length } };
  }

  async snapshot() {
    if (this.choice !== null) {
      return {
        ...startupSnapshot("catalogue-home"),
        uiTree: availableObservation([startupControl("catalogue", "Catalogue", false)]),
        focusedElement: availableObservation({
          stableId: "catalogue-home",
          role: "button",
          name: "catalogue-home",
          bounds: { x: 10, y: 10, width: 100, height: 40 },
        }),
      };
    }
    return startupSnapshot(this.focus);
  }
}

describe("startup preparation", () => {
  const stability = {
    maxSnapshots: 3,
    requiredStableSnapshots: 2,
    pollIntervalMs: 0,
    timeoutMs: 1_000,
  };

  it("records a consent wall without changing state under observation-only policy", async () => {
    const driver = new StartupConsentDriver();
    const result = await prepareStartup(driver, {
      policy: { kind: "observe" },
      stability,
      monotonicNow: () => 0,
      wait: async () => undefined,
    });

    expect(result.status).toBe("setup-blocker");
    expect(result.blockers[0]).toMatchObject({ kind: "consent-wall" });
    expect(result.controls.map((control) => control.stableId)).toEqual([
      "reject-consent",
      "accept-consent",
    ]);
    expect(driver.pressed).toEqual([]);
    expect(driver.choice).toBeNull();
  });

  it("executes an explicit policy and verifies fresh resets before exploration", async () => {
    const driver = new StartupConsentDriver();
    const result = await prepareStartup(driver, {
      policy: { kind: "remote-sequence", actions: ["RIGHT", "SELECT"] },
      stability,
      monotonicNow: () => 0,
      wait: async () => undefined,
    });

    expect(result.status).toBe("ready");
    expect(driver.choice).toBe("accepted");
    expect(driver.pressed).toEqual(["RIGHT", "SELECT"]);
    expect(driver.resetCount).toBeGreaterThanOrEqual(3);
    await expect(result.restoreToPreparedState?.()).resolves.toBeTruthy();
  });

  it("fails closed when startup never reaches canonical stability", async () => {
    let generation = 0;
    const driver: TVDoctorDriver = {
      capabilities: async () => new Set(["remote-input", "ui-tree"]),
      reset: async () => undefined,
      press: async (key) => ({ key, outcome: "applied", timing: { inputSentAtMs: 1 } }),
      snapshot: async () => {
        generation += 1;
        return startupSnapshot(`unstable-${String(generation)}`);
      },
    };
    const result = await prepareStartup(driver, {
      stability,
      monotonicNow: () => 0,
      wait: async () => undefined,
    });

    expect(result.status).toBe("unstable");
  });
});
