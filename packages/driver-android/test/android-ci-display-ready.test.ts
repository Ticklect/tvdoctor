import { describe, expect, it } from "vitest";
import {
  androidDisplayReady,
  ensureAndroidDisplayReady,
} from "../../../scripts/ensure-android-display-ready.mjs";

describe("hosted Android display readiness", () => {
  it("requires both awake wakefulness and an on display", () => {
    expect(androidDisplayReady("mWakefulness=Awake\nDisplay Power: state=ON")).toBe(true);
    expect(androidDisplayReady("mWakefulness=Asleep\nDisplay Power: state=OFF")).toBe(false);
    expect(androidDisplayReady("mWakefulness=Awake\nDisplay Power: state=OFF")).toBe(false);
  });

  it("wakes, unlocks, and polls until the display is truly ready", async () => {
    const calls: string[] = [];
    let powerSamples = 0;
    const result = await ensureAndroidDisplayReady({
      executeAdb: async (arguments_: readonly string[]) => {
        const command = arguments_.join(" ");
        calls.push(command);
        if (command === "shell dumpsys power") {
          powerSamples += 1;
          return powerSamples === 1
            ? "mWakefulness=Asleep\nDisplay Power: state=OFF"
            : "mWakefulness=Awake\nDisplay Power: state=ON";
        }
        return "";
      },
      wait: async () => undefined,
      maxAttempts: 3,
      pollIntervalMs: 1,
    });

    expect(result).toEqual({ attempts: 2, powerState: "mWakefulness=Awake\nDisplay Power: state=ON" });
    expect(calls).toEqual([
      "shell svc power stayon true",
      "shell input keyevent KEYCODE_WAKEUP",
      "shell wm dismiss-keyguard",
      "shell dumpsys power",
      "shell input keyevent KEYCODE_WAKEUP",
      "shell wm dismiss-keyguard",
      "shell dumpsys power",
    ]);
  });

  it("fails closed with the last observed power state", async () => {
    await expect(ensureAndroidDisplayReady({
      executeAdb: async (arguments_: readonly string[]) => arguments_.join(" ") === "shell dumpsys power"
        ? "mWakefulness=Asleep\nDisplay Power: state=OFF"
        : "",
      wait: async () => undefined,
      maxAttempts: 2,
      pollIntervalMs: 1,
    })).rejects.toThrow(/display did not become ready after 2 attempts[\s\S]*mWakefulness=Asleep/u);
  });
});
