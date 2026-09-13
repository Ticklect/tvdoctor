import {
  availableObservation,
  type ActionResult,
  type Capability,
  type StateSnapshot,
  type TVDoctorDriver,
} from "@tvdoctor/protocol";
import { describe, expect, it } from "vitest";

import { pressAndObserve } from "../src/action-settling.js";

function snapshot(id: string): StateSnapshot {
  return {
    capturedAt: "2026-09-13T18:00:00.000Z",
    location: availableObservation(`app://${id}`),
    focusedElement: availableObservation(null),
    uiTree: availableObservation([]),
  };
}

function driverFor(result: ActionResult, fallback: StateSnapshot, calls: { snapshots: number }): TVDoctorDriver {
  return {
    capabilities: async () => new Set<Capability>(["remote-input", "ui-tree"]),
    press: async () => result,
    snapshot: async () => {
      calls.snapshots += 1;
      return fallback;
    },
    reset: async () => undefined,
  };
}

describe("driver-attested settling", () => {
  it("uses a verified post-action observation without secondary stable-snapshot polls", async () => {
    const settled = snapshot("verified");
    const calls = { snapshots: 0 };
    const result: ActionResult = {
      key: "RIGHT",
      outcome: "applied",
      timing: { inputSentAtMs: 1 },
      postActionSnapshot: settled,
      settlingProof: {
        kind: "driver-verified",
        source: "test-driver",
        observationVersion: "test/v1",
      },
    };

    const observation = await pressAndObserve(driverFor(result, snapshot("fallback"), calls), "RIGHT", {
      strategy: "stable-snapshot",
      maxSnapshots: 6,
      requiredStableSnapshots: 3,
      pollIntervalMs: 250,
      wait: async () => undefined,
    });

    expect(observation).toMatchObject({
      snapshot: settled,
      snapshotsCaptured: 0,
      snapshotsObserved: 1,
      reusedDriverObservation: true,
      settled: true,
    });
    expect(calls.snapshots).toBe(0);
  });

  it("does not trust a post-action observation when explicit proof is absent", async () => {
    const initial = snapshot("initial");
    const stable = snapshot("stable");
    const calls = { snapshots: 0 };
    const result: ActionResult = {
      key: "RIGHT",
      outcome: "applied",
      timing: { inputSentAtMs: 1 },
      postActionSnapshot: initial,
    };

    const observation = await pressAndObserve(driverFor(result, stable, calls), "RIGHT", {
      strategy: "stable-snapshot",
      maxSnapshots: 3,
      requiredStableSnapshots: 2,
      equivalent: () => true,
      wait: async () => undefined,
    });

    expect(observation.snapshotsObserved).toBe(2);
    expect(observation.snapshotsCaptured).toBe(1);
    expect(calls.snapshots).toBe(1);
  });
});
