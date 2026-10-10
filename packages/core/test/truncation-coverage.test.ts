import {
  availableObservation,
  type ActionOutcome,
  type ActionResult,
  type Capability,
  type RemoteKey,
  type ResetStrategy,
  type StateSnapshot,
  type TVDoctorDriver,
  type UiNodeSnapshot,
} from "@tvdoctor/protocol";
import { describe, expect, it } from "vitest";

import { createNavigationFocusGraphV2, explore } from "../src/index.js";
import { computeSnapshotFingerprint } from "../src/fingerprint.js";

type Focus = "A" | "B";
type TruncationReason = "captured-nodes" | "scanned-nodes" | "depth" | "text";

function node(id: Focus, focused: boolean): UiNodeSnapshot {
  return {
    stableId: id,
    role: "button",
    name: id,
    text: id,
    bounds: { x: 10, y: 10, width: 120, height: 44 },
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

function snapshot(focus: Focus, reasons?: readonly TruncationReason[]): StateSnapshot {
  const base: StateSnapshot = {
    capturedAt: "2026-10-08T12:00:00.000Z",
    location: availableObservation("app://truncation-fixture"),
    focusedElement: availableObservation({
      stableId: focus, role: "button", name: focus, bounds: { x: 10, y: 10, width: 120, height: 44 },
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
      children: [node("A", focus === "A"), node("B", focus === "B")],
    }]),
  };
  if (reasons === undefined) return base;
  return {
    ...base,
    // WebStateSnapshot extends the protocol snapshot without changing that
    // platform-neutral interface. Use real Observation metadata shape.
    uiTreeMetadata: availableObservation({
      capturedNodeCount: 750,
      truncated: reasons.length > 0,
      truncationReasons: reasons,
    }),
  } as StateSnapshot;
}

class CoverageDriver implements TVDoctorDriver {
  #focus: Focus = "A";
  readonly presses: RemoteKey[] = [];
  readonly reasons: Readonly<Partial<Record<Focus, readonly TruncationReason[]>>>;
  readonly selectOutcome: ActionOutcome;

  constructor(
    reasons: Readonly<Partial<Record<Focus, readonly TruncationReason[]>>> = {},
    selectOutcome: ActionOutcome = "applied",
  ) {
    this.reasons = reasons;
    this.selectOutcome = selectOutcome;
  }

  async capabilities(): Promise<ReadonlySet<Capability>> {
    return new Set(["remote-input", "ui-tree"]);
  }

  async reset(strategy: ResetStrategy): Promise<void> {
    void strategy;
    this.#focus = "A";
  }

  async snapshot(): Promise<StateSnapshot> {
    return snapshot(this.#focus, this.reasons[this.#focus]);
  }

  async press(key: RemoteKey): Promise<ActionResult> {
    this.presses.push(key);
    const outcome = key === "SELECT" ? this.selectOutcome : "applied";
    if (outcome === "applied" && key === "RIGHT") this.#focus = "B";
    return { key, outcome, timing: { inputSentAtMs: this.presses.length } };
  }
}

async function scan(
  driver: TVDoctorDriver,
  actions: readonly RemoteKey[] = ["RIGHT"],
  maxActions = 15,
) {
  return explore(driver, {
    actions,
    restorationMode: "root-only",
    refreshVisibleSelfLoops: false,
    budgets: { maxActions, maxStates: 10, maxDepth: 2, maxDurationMs: 10_000 },
    monotonicNow: () => 0,
  });
}

describe("driver-truncated UI-tree coverage", () => {
  it.each(["captured-nodes", "scanned-nodes", "depth"] as const)(
    "does not report complete coverage when the driver omits %s structure",
    async (reason) => {
      const result = await scan(new CoverageDriver({ A: [reason] }));
      expect(result.graph.focus.states).toHaveLength(2);
      expect(result.termination).toMatchObject({ reason: "queue-exhausted", complete: false });
      expect(result.termination.detail).toContain(reason);
      expect(result.termination.detail).toMatch(/unobserved controls may remain/iu);
    },
  );

  it("detects omissions first appearing in a post-action destination snapshot", async () => {
    const result = await scan(new CoverageDriver({ B: ["captured-nodes", "text"] }));
    expect(result.termination).toMatchObject({ reason: "queue-exhausted", complete: false });
    expect(result.termination.detail).toContain("captured-nodes");
    expect(result.graph.actions.length).toBeGreaterThan(0);
  });

  it("does not treat text-only clipping as proof of omitted navigable controls", async () => {
    const result = await scan(new CoverageDriver({ A: ["text"], B: ["text"] }));
    expect(result.termination).toEqual({ reason: "queue-exhausted", complete: true });
  });

  it("does not impose web metadata requirements on other platform drivers", async () => {
    const result = await scan(new CoverageDriver());
    expect(result.termination).toEqual({ reason: "queue-exhausted", complete: true });
  });

  it("reports an untested navigation edge when SELECT is withheld as unsupported", async () => {
    const result = await scan(new CoverageDriver({}, "unsupported"), ["SELECT"]);
    expect(result.termination).toMatchObject({ reason: "queue-exhausted", complete: false });
    expect(result.termination.detail).toContain("SELECT:unsupported");
    expect(result.graph.actions).toHaveLength(1);
    const graph = createNavigationFocusGraphV2(result);
    expect(graph.coverage).toBe("partial");
    expect(graph.coverageSummary.frontier).toMatchObject({
      status: "complete",
      category: null,
      reason: "queue-exhausted",
      remainingFrontierEntries: 0,
      remainingCandidateActions: 0,
    });
  });

  it.each(["failed", "inconclusive"] as const)(
    "retains the driver-error incomplete outcome when SELECT is %s",
    async (outcome) => {
      const result = await scan(new CoverageDriver({}, outcome), ["SELECT"]);
      expect(result.termination).toMatchObject({ reason: "driver-error", complete: false });
      expect(result.graph.actions).toHaveLength(0);
    },
  );

  it("does not mistake an applied SELECT self-loop for an unsupported navigation edge", async () => {
    const result = await scan(new CoverageDriver(), ["SELECT"]);
    expect(result.termination).toEqual({ reason: "queue-exhausted", complete: true });
    expect(result.graph.actions).toHaveLength(1);
  });

  it("preserves max-actions as the cause while also reporting omitted structure", async () => {
    const result = await scan(
      new CoverageDriver({ B: ["captured-nodes"] }),
      ["RIGHT", "DOWN"],
      1,
    );
    expect(result.termination).toMatchObject({
      reason: "max-actions",
      complete: false,
    });
    expect(result.termination.detail).toContain("Bounded-incomplete");
    expect(result.termination.detail).toContain("captured-nodes");
    expect(result.statistics.physicalActions).toBe(1);
  });
});

describe("non-repeated settings-list fingerprint coverage", () => {
  function menu(ids: readonly string[], withRowWrappers: boolean): StateSnapshot {
    const controls = ids.map((id, index): UiNodeSnapshot => {
      const item: UiNodeSnapshot = {
        ...node("B", false), stableId: id, name: id, text: id, focused: false,
      };
      return withRowWrappers
        ? {
          ...node("B", false),
          stableId: `row-${String(index + 1)}`,
          role: "group",
          focusable: false,
          children: [item],
        }
        : item;
    });
    return {
      ...snapshot("A"),
      uiTree: availableObservation([{
        ...node("A", false),
        role: "main",
        focusable: false,
        children: [
          { ...node("A", true), stableId: "back", name: "Back" },
          { ...node("B", false), stableId: "settings-list", role: "list", focusable: false,
            children: controls },
        ],
      }]),
    };
  }

  it.each([false, true])(
    "does not merge different static menus with identical Back focus (row wrappers: %s)",
    (withRowWrappers) => {
      const network = computeSnapshotFingerprint(menu(["network", "privacy"], withRowWrappers));
      const account = computeSnapshotFingerprint(menu(["account", "display"], withRowWrappers));
      expect(network.focusIdentity).toBe(account.focusIdentity);
      expect(network.screenIdentity).not.toBe(account.screenIdentity);
      expect(network.stateIdentity).not.toBe(account.stateIdentity);
    },
  );

  it("still normalises numeric repeated carousel cards across virtualised rebinding", () => {
    const one = computeSnapshotFingerprint(menu(["movie-1", "movie-2"], false));
    const scrolled = computeSnapshotFingerprint(menu(["movie-2", "movie-3"], false));
    expect(one.screenIdentity).toBe(scrolled.screenIdentity);
  });
});
