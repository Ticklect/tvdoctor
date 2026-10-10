import { describe, expect, it, vi } from "vitest";
import {
  availableObservation,
  type DriverOperationOptions,
  type ResetStrategy,
  type StateSnapshot,
  type TVDoctorDriver,
} from "@tvdoctor/protocol";
import { prepareStartup } from "../src/startup.js";

function stableHome(): StateSnapshot {
  return {
    capturedAt: "2026-10-08T00:00:00.000Z",
    location: availableObservation("https://example.test/"),
    focusedElement: availableObservation({ stableId: "home", role: "button", name: "Home" }),
    uiTree: availableObservation([{
      stableId: "home", role: "button", name: "Home", text: "Home",
      bounds: { x: 0, y: 0, width: 120, height: 48 },
      visible: true, enabled: true, focusable: true, focused: true, modal: false,
      selectionState: null, valueNow: null, children: [],
    }]),
  };
}

const stability = { maxSnapshots: 2, requiredStableSnapshots: 2, pollIntervalMs: 0, timeoutMs: 1_000 };

function stableDriver() {
  const reset = vi.fn(async (strategy: ResetStrategy, options?: DriverOperationOptions) => {
    void strategy;
    void options;
  });
  const snapshot = vi.fn(async (options?: DriverOperationOptions) => {
    void options;
    return stableHome();
  });
  const driver = {
    reset,
    snapshot,
    capabilities: async () => new Set(["remote-input"]),
    press: async (key: string) => ({ key, outcome: "applied", timing: { inputSentAtMs: 1 } }),
  } as unknown as TVDoctorDriver;
  return { driver, reset, snapshot };
}

describe("startup restoration cancellation", () => {
  it("forwards the signal through preparation resets, polling snapshots and later restoration", async () => {
    const { driver, reset, snapshot } = stableDriver();
    const preparationController = new AbortController();
    const result = await prepareStartup(driver, {
      stability,
      signal: preparationController.signal,
      wait: async () => undefined,
    });
    expect(result.status).toBe("ready");
    expect(reset).toHaveBeenCalledTimes(3);
    for (const call of reset.mock.calls) {
      expect(call[1]).toEqual({ signal: preparationController.signal });
    }
    for (const call of snapshot.mock.calls) {
      expect(call[0]).toEqual({ signal: preparationController.signal });
    }

    const restorationController = new AbortController();
    await expect(result.restoreToPreparedState?.({ signal: restorationController.signal }))
      .resolves.toEqual(stableHome());
    expect(reset).toHaveBeenLastCalledWith("reload", { signal: restorationController.signal });
    expect(snapshot).toHaveBeenLastCalledWith({ signal: restorationController.signal });
  });

  it("rejects immediately on a pre-aborted restoration without resetting", async () => {
    const { driver, reset } = stableDriver();
    const prepared = await prepareStartup(driver, { stability, wait: async () => undefined });
    expect(prepared.status).toBe("ready");
    const before = reset.mock.calls.length;
    const controller = new AbortController();
    const reason = new Error("cancelled before reset");
    controller.abort(reason);

    await expect(prepared.restoreToPreparedState?.({ signal: controller.signal })).rejects.toBe(reason);
    expect(reset).toHaveBeenCalledTimes(before);
  });

  it("does not swallow cancellation during a failed reset or start another retry", async () => {
    const { driver, reset, snapshot } = stableDriver();
    const prepared = await prepareStartup(driver, { stability, wait: async () => undefined });
    expect(prepared.status).toBe("ready");
    const before = reset.mock.calls.length;
    const controller = new AbortController();
    const reason = new Error("cancelled during reset");
    reset.mockImplementation(async () => {
      controller.abort(reason);
      throw new Error("transport failed");
    });

    const previousSnapshots = snapshot.mock.calls.length;
    await expect(prepared.restoreToPreparedState?.({ signal: controller.signal })).rejects.toBe(reason);
    expect(reset).toHaveBeenCalledTimes(before + 1);
    expect(snapshot).toHaveBeenCalledTimes(previousSnapshots);
  });

  it("interrupts retry backoff rather than executing a second reset", async () => {
    const { driver, reset } = stableDriver();
    const prepared = await prepareStartup(driver, { stability, wait: async () => undefined });
    expect(prepared.status).toBe("ready");
    const before = reset.mock.calls.length;
    reset.mockRejectedValue(new Error("temporary reset failure"));
    const controller = new AbortController();
    const reason = new Error("cancelled while backing off");
    const timer = setTimeout(() => controller.abort(reason), 5);
    try {
      await expect(prepared.restoreToPreparedState?.({ signal: controller.signal })).rejects.toBe(reason);
    } finally {
      clearTimeout(timer);
    }
    expect(reset).toHaveBeenCalledTimes(before + 1);
  });

  it("propagates abort during preparation rather than misclassifying it as setup failure", async () => {
    const controller = new AbortController();
    const reason = new Error("audit interrupted");
    const { driver, reset, snapshot } = stableDriver();
    reset.mockImplementation(async () => { controller.abort(reason); });

    await expect(prepareStartup(driver, {
      stability,
      signal: controller.signal,
      wait: async () => undefined,
    })).rejects.toBe(reason);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(snapshot).not.toHaveBeenCalled();
  });
});
