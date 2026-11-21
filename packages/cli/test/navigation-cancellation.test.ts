import { describe, expect, it, vi } from "vitest";
import type { PlaywrightWebDriver } from "@tvdoctor/driver-web";
import { availableObservation, type StateSnapshot } from "@tvdoctor/protocol";
import {
  createSafeExplorationDriver,
  resolveStartupDecisionThroughFocus,
} from "../src/node-audit-navigation.js";

function focusedControl(name: string): StateSnapshot {
  return {
    capturedAt: "2026-10-08T00:00:00.000Z",
    location: availableObservation("https://example.test/"),
    focusedElement: availableObservation({ stableId: "control", role: "button", name }),
    uiTree: availableObservation([{
      stableId: "control",
      role: "button",
      name,
      text: name,
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

describe("safe web exploration cancellation", () => {
  it("forwards the exact signal to capabilities, snapshot, reset and both press paths", async () => {
    const controller = new AbortController();
    const operation = { signal: controller.signal };
    const capabilities = vi.fn(async () => new Set(["remote-input"]));
    const snapshot = vi.fn(async () => focusedControl("Browse"));
    const reset = vi.fn(async () => undefined);
    const press = vi.fn(async (key: string) => ({
      key,
      outcome: "applied" as const,
      timing: { inputSentAtMs: 1 },
    }));
    const safe = createSafeExplorationDriver({
      capabilities, snapshot, reset, press,
    } as unknown as PlaywrightWebDriver);

    await safe.capabilities(operation);
    await safe.snapshot(operation);
    await safe.reset?.("reload", operation);
    await safe.press("DOWN", operation);
    await safe.press("SELECT", operation);

    expect(capabilities).toHaveBeenCalledWith(operation);
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(snapshot).toHaveBeenNthCalledWith(1, operation);
    expect(snapshot).toHaveBeenNthCalledWith(2, operation);
    expect(reset).toHaveBeenCalledWith("reload", operation);
    expect(press).toHaveBeenNthCalledWith(1, "DOWN", operation);
    expect(press).toHaveBeenNthCalledWith(2, "SELECT", operation);
  });

  it("does not activate SELECT if cancellation occurs during its safety observation", async () => {
    const controller = new AbortController();
    const reason = new Error("audit cancelled");
    const snapshot = vi.fn(async () => {
      controller.abort(reason);
      return focusedControl("Browse");
    });
    const press = vi.fn();
    const safe = createSafeExplorationDriver({ snapshot, press } as unknown as PlaywrightWebDriver);

    await expect(safe.press("SELECT", { signal: controller.signal })).rejects.toBe(reason);
    expect(snapshot).toHaveBeenCalledWith({ signal: controller.signal });
    expect(press).not.toHaveBeenCalled();
  });

  it("continues to withhold unsafe activation while forwarding the safety snapshot signal", async () => {
    const controller = new AbortController();
    const snapshot = vi.fn(async () => focusedControl("Delete account"));
    const press = vi.fn();
    const safe = createSafeExplorationDriver({ snapshot, press } as unknown as PlaywrightWebDriver);

    await expect(safe.press("SELECT", { signal: controller.signal }))
      .resolves.toMatchObject({ outcome: "unsupported" });
    expect(snapshot).toHaveBeenCalledWith({ signal: controller.signal });
    expect(press).not.toHaveBeenCalled();
  });

  it("stops consent focus discovery on cancellation without another key or snapshot", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled during consent traversal");
    const press = vi.fn(async () => {
      controller.abort(reason);
      return {
        key: "TAB" as const,
        outcome: "applied" as const,
        timing: { inputSentAtMs: 1 },
        postActionSnapshot: focusedControl("Reject"),
      };
    });
    const snapshot = vi.fn(async () => focusedControl("Reject"));
    const driver = { press, snapshot } as unknown as PlaywrightWebDriver;
    await expect(resolveStartupDecisionThroughFocus(
      driver, "reject", "consent-wall", focusedControl("Browse"),
      { signal: controller.signal },
    )).rejects.toBe(reason);
    expect(press).toHaveBeenCalledTimes(1);
    expect(press).toHaveBeenCalledWith("TAB", { signal: controller.signal });
    expect(snapshot).not.toHaveBeenCalled();
  });
});
