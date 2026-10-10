import {
  availableObservation,
  unavailableObservation,
  type ActionResult,
  type AppReference,
  type Capability,
  type RemoteKey,
  type ResetStrategy,
  type StateSnapshot,
  type TVDoctorDriver,
} from "@tvdoctor/protocol";
import { describe, expect, it } from "vitest";

import { DRIVER_CONFORMANCE_LIMITS, runDriverConformance } from "../src/index.js";

function snapshot(focus = "root"): StateSnapshot {
  return {
    capturedAt: "2026-10-06T20:00:00.000Z",
    location: availableObservation("fixture://safe"),
    focusedElement: availableObservation({ stableId: focus, role: "button", name: focus }),
    uiTree: availableObservation([{
      stableId: focus,
      role: "button",
      name: focus,
      text: focus,
      bounds: { x: 0, y: 0, width: 100, height: 40 },
      visible: true,
      enabled: true,
      focusable: true,
      focused: true,
      modal: false,
      selectionState: null,
      valueNow: null,
      children: [],
    }]),
  };
}

class FixtureDriver implements TVDoctorDriver {
  readonly pressed: RemoteKey[] = [];
  readonly launches: AppReference[] = [];
  readonly resets: ResetStrategy[] = [];
  focus = "root";

  async capabilities(): Promise<ReadonlySet<Capability>> {
    return new Set(["remote-input", "ui-tree", "launch"]);
  }

  async launch(app: AppReference): Promise<void> {
    this.launches.push(app);
    this.focus = "root";
  }

  async reset(strategy: ResetStrategy): Promise<void> {
    this.resets.push(strategy);
    this.focus = "root";
  }

  async snapshot(): Promise<StateSnapshot> {
    return snapshot(this.focus);
  }

  async press(key: RemoteKey): Promise<ActionResult> {
    this.pressed.push(key);
    this.focus = key === "RIGHT" ? "right" : this.focus;
    const inputSentAtMs = 1_000;
    return {
      key,
      outcome: "applied",
      timing: {
        inputSentAtMs,
        firstResponseAtMs: inputSentAtMs + 1,
        focusSettledAtMs: inputSentAtMs + 2,
        screenSettledAtMs: inputSentAtMs + 3,
      },
      postActionSnapshot: snapshot(this.focus),
    };
  }
}

describe("runDriverConformance", () => {
  it("exercises only caller-supplied safe fixture operations and returns structured passes", async () => {
    const driver = new FixtureDriver();
    const result = await runDriverConformance(driver, {
      app: { id: "safe-fixture", launchUri: "fixture://safe" },
      resetStrategy: "relaunch",
      remoteKeys: ["RIGHT", "LEFT"],
      expectations: {
        requiredCapabilities: ["remote-input", "ui-tree"],
        initialSnapshot: {
          location: "fixture://safe",
          focusedElementStableId: "root",
          uiTree: "available",
        },
        afterResetSnapshot: { focusedElementStableId: "root" },
      },
    });

    expect(result.status).toBe("pass");
    expect(result.counts.fail).toBe(0);
    expect(result.actionsRequested).toBe(2);
    expect(result.actionsAttempted).toBe(2);
    expect(driver.pressed).toEqual(["RIGHT", "LEFT"]);
    expect(driver.resets).toEqual(["relaunch"]);
    expect(driver.launches).toHaveLength(1);
  });

  it("reports unavailable optional contract surfaces without converting them to passes", async () => {
    const driver: TVDoctorDriver = {
      capabilities: async () => new Set<Capability>(["ui-tree"]),
      snapshot: async () => ({
        ...snapshot(),
        focusedElement: unavailableObservation("fixture intentionally hides focus"),
      }),
      press: async (key) => ({ key, outcome: "unsupported", timing: { inputSentAtMs: 1 } }),
    };

    const result = await runDriverConformance(driver, {
      app: { id: "safe-fixture" },
      resetStrategy: "reload",
      remoteKeys: ["RIGHT"],
      expectations: {
        requiredCapabilities: ["remote-input"],
        initialSnapshot: { focusedElementStableId: "root" },
      },
    });

    expect(result.status).toBe("unavailable");
    expect(result.actionsAttempted).toBe(0);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "launch", status: "unavailable" }),
      expect.objectContaining({ id: "reset", status: "unavailable" }),
      expect.objectContaining({ id: "action.0", status: "unavailable" }),
      expect.objectContaining({ id: "snapshot.initial.focus", status: "unavailable" }),
    ]));
  });

  it("fails closed on malformed ActionResult timing and malformed or cyclic snapshots", async () => {
    const badSnapshot = snapshot() as StateSnapshot & { loop?: unknown };
    badSnapshot.loop = badSnapshot;
    const driver: TVDoctorDriver = {
      capabilities: async () => new Set<Capability>(["remote-input"]),
      snapshot: async () => badSnapshot,
      press: async (key) => ({
        key,
        outcome: "applied",
        timing: { inputSentAtMs: 5, screenSettledAtMs: 4 },
      }),
    };

    const result = await runDriverConformance(driver, { remoteKeys: ["RIGHT"] });

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "snapshot.initial.shape", status: "fail" }),
      expect.objectContaining({ id: "action.0", status: "fail" }),
    ]));
  });

  it("keeps unsupported actions unavailable and inconclusive actions failed", async () => {
    let outcome: ActionResult["outcome"] = "unsupported";
    const driver: TVDoctorDriver = {
      capabilities: async () => new Set<Capability>(["remote-input"]),
      snapshot: async () => snapshot(),
      press: async (key) => ({ key, outcome, timing: { inputSentAtMs: 1 } }),
    };

    const unsupported = await runDriverConformance(driver, { remoteKeys: ["RIGHT"] });
    expect(unsupported.status).toBe("unavailable");
    expect(unsupported.checks).toContainEqual(expect.objectContaining({
      id: "action.0",
      status: "unavailable",
    }));

    outcome = "inconclusive";
    const inconclusive = await runDriverConformance(driver, { remoteKeys: ["RIGHT"] });
    expect(inconclusive.status).toBe("fail");
    expect(inconclusive.checks).toContainEqual(expect.objectContaining({
      id: "action.0",
      status: "fail",
    }));
  });

  it("bounds caller input before touching the driver and rejects clear-data at runtime", async () => {
    const driver = new FixtureDriver();
    const tooMany = Array.from({ length: DRIVER_CONFORMANCE_LIMITS.maxRemoteKeys + 1 }, () => "RIGHT" as const);

    await expect(runDriverConformance(driver, { remoteKeys: tooMany })).rejects.toThrow(/at most/u);
    await expect(runDriverConformance(driver, {
      resetStrategy: "clear-data" as never,
    })).rejects.toThrow(/reload or relaunch/u);
    expect(driver.pressed).toEqual([]);
    expect(driver.resets).toEqual([]);
  });
});
