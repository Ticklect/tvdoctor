import { describe, expect, it, vi } from "vitest";
import {
  availableObservation,
  type StateSnapshot,
  type TVDoctorDriver,
} from "@tvdoctor/protocol";
import { PreparedStateDivergenceError } from "../src/errors.js";
import { prepareStartup } from "../src/startup.js";

function snapshot(id: string): StateSnapshot {
  return {
    capturedAt: "2026-10-08T12:00:00.000Z",
    location: availableObservation("https://example.test/"),
    focusedElement: availableObservation({ stableId: id, role: "button", name: id }),
    uiTree: availableObservation([{
      stableId: id, role: "button", name: id, text: id,
      bounds: { x: 20, y: 20, width: 160, height: 48 },
      visible: true, enabled: true, focusable: true, focused: true,
      modal: false, selectionState: null, valueNow: null, children: [],
    }]),
  };
}

function createDriver() {
  let mode: "stable" | "transient" | "divergent" = "stable";
  let firstFrame = false;
  const reset = vi.fn(async () => { firstFrame = true; });
  const press = vi.fn(async () => {
    throw new Error("Startup root recovery must not send a remote input");
  });
  const read = vi.fn(async (): Promise<StateSnapshot> => {
    if (mode === "divergent") return snapshot("other-page");
    if (mode === "transient" && firstFrame) {
      firstFrame = false;
      return snapshot("loading");
    }
    return snapshot("home");
  });
  const driver = {
    capabilities: async () => new Set(["remote-input", "ui-tree"]),
    reset, snapshot: read, press,
  } as unknown as TVDoctorDriver;
  return { driver, reset, press, read, setMode: (value: typeof mode) => { mode = value; } };
}

const stability = {
  maxSnapshots: 4,
  requiredStableSnapshots: 2,
  pollIntervalMs: 0,
  timeoutMs: 1_000,
} as const;

describe("prepared-state restoration after a late browser relaunch", () => {
  it("reobserves a transient first frame and recovers the verified root without a second reset", async () => {
    const fixture = createDriver();
    const prepared = await prepareStartup(fixture.driver, {
      stability, resetStrategy: "relaunch", wait: async () => undefined,
    });
    expect(prepared.status).toBe("ready");
    const beforeResets = fixture.reset.mock.calls.length;
    const beforeSnapshots = fixture.read.mock.calls.length;
    fixture.setMode("transient");

    await expect(prepared.restoreToPreparedState?.()).resolves.toEqual(snapshot("home"));
    expect(fixture.reset).toHaveBeenCalledTimes(beforeResets + 1);
    expect(fixture.read.mock.calls.length - beforeSnapshots).toBe(3);
    expect(fixture.press).not.toHaveBeenCalled();
  });

  it("still fails closed after the bounded retries when the root truly changes", async () => {
    const fixture = createDriver();
    const prepared = await prepareStartup(fixture.driver, {
      stability, resetStrategy: "relaunch", wait: async () => undefined,
    });
    expect(prepared.status).toBe("ready");
    const beforeResets = fixture.reset.mock.calls.length;
    fixture.setMode("divergent");

    await expect(prepared.restoreToPreparedState?.()).rejects.toBeInstanceOf(
      PreparedStateDivergenceError,
    );
    expect(fixture.reset).toHaveBeenCalledTimes(beforeResets + 3);
    expect(fixture.press).not.toHaveBeenCalled();
  });
});
