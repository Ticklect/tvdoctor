import { describe, expect, it } from "vitest";
import {
  androidDisplayReady,
  ensureAndroidDisplayReady,
} from "../../../scripts/ensure-android-display-ready.mjs";

describe("hosted Android display readiness", () => {
  const AWAKE = "mWakefulness=Awake";
  const ASLEEP = "mWakefulness=Asleep";
  const DISPLAY_ON = "Display States: size=1\n  Display State=ON";
  const DISPLAY_OFF = "Display States: size=1\n  Display State=OFF";
  const INPUT_FOCUSED = "FocusedWindows:\n  displayId=0, name='Launcher'";
  const INPUT_UNFOCUSED = "FocusedWindows: <none>";

  it("requires awake power, an on display, and a real InputDispatcher focused window", () => {
    expect(androidDisplayReady(AWAKE, DISPLAY_ON, INPUT_FOCUSED)).toBe(true);
    expect(androidDisplayReady(ASLEEP, DISPLAY_ON, INPUT_FOCUSED)).toBe(false);
    expect(androidDisplayReady(AWAKE, DISPLAY_OFF, INPUT_FOCUSED)).toBe(false);
    expect(androidDisplayReady(AWAKE, DISPLAY_ON, INPUT_UNFOCUSED)).toBe(false);
  });

  it("wakes, unlocks, and polls until the display is truly ready", async () => {
    const calls: string[] = [];
    let inputSamples = 0;
    const result = await ensureAndroidDisplayReady({
      executeAdb: async (arguments_: readonly string[]) => {
        const command = arguments_.join(" ");
        calls.push(command);
        if (command === "shell dumpsys power") return AWAKE;
        if (command === "shell dumpsys display") return DISPLAY_ON;
        if (command === "shell dumpsys input") {
          inputSamples += 1;
          return inputSamples === 1 ? INPUT_UNFOCUSED : INPUT_FOCUSED;
        }
        return "";
      },
      wait: async () => undefined,
      maxAttempts: 3,
      pollIntervalMs: 1,
    });

    expect(result).toEqual({
      attempts: 2,
      powerState: AWAKE,
      displayState: DISPLAY_ON,
      inputState: INPUT_FOCUSED,
    });
    expect(calls).toEqual([
      "shell svc power stayon true",
      "shell input keyevent KEYCODE_WAKEUP",
      "shell wm dismiss-keyguard",
      "shell dumpsys power",
      "shell dumpsys display",
      "shell dumpsys input",
      "shell input keyevent KEYCODE_WAKEUP",
      "shell wm dismiss-keyguard",
      "shell dumpsys power",
      "shell dumpsys display",
      "shell dumpsys input",
    ]);
  });

  it("fails closed with the last observed power state", async () => {
    await expect(ensureAndroidDisplayReady({
      executeAdb: async (arguments_: readonly string[]) => {
        const command = arguments_.join(" ");
        if (command === "shell dumpsys power") return AWAKE;
        if (command === "shell dumpsys display") return DISPLAY_ON;
        if (command === "shell dumpsys input") return INPUT_UNFOCUSED;
        return "";
      },
      wait: async () => undefined,
      maxAttempts: 2,
      pollIntervalMs: 1,
    })).rejects.toThrow(/display did not become ready after 2 attempts[\s\S]*FocusedWindows: <none>/u);
  });
});
