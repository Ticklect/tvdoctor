import { describe, expect, it } from "vitest";

import {
  androidPackageInstalled,
  observerAccessibilityEnabled,
  openObserverSetup,
} from "../src/android-zero-config-support.js";

function bytes(value: string): Uint8Array {
  return Buffer.from(value, "utf8");
}

describe("zero-config Android support", () => {
  it("checks package presence without mutating device state", async () => {
    const commands: readonly string[][] = [];
    const mutable = commands as string[][];
    const installed = await androidPackageInstalled({
      adbPath: "adb",
      serial: "emulator-5554",
      packageName: "org.example.tv",
    }, {
      execute: async (arguments_) => {
        mutable.push([...arguments_]);
        return { stdout: bytes("package:/data/app/org.example.tv/base.apk\n"), stderr: "", exitCode: 0 };
      },
    });
    expect(installed).toBe(true);
    expect(commands).toEqual([["-s", "emulator-5554", "shell", "pm", "path", "org.example.tv"]]);
  });

  it("opens the packaged Observer setup activity", async () => {
    const commands: string[][] = [];
    await openObserverSetup({ adbPath: "adb", serial: "emulator-5554" }, {
      execute: async (arguments_) => {
        commands.push([...arguments_]);
        return { stdout: bytes("Starting: Intent"), stderr: "", exitCode: 0 };
      },
    });
    expect(commands).toEqual([[
      "-s", "emulator-5554", "shell", "am", "start", "-n",
      "org.tvdoctor.observer/.SetupActivity",
    ]]);
  });

  it("reads accessibility state without writing secure settings", async () => {
    const commands: string[][] = [];
    const enabled = await observerAccessibilityEnabled({ adbPath: "adb", serial: "emulator-5554" }, {
      execute: async (arguments_) => {
        commands.push([...arguments_]);
        return {
          stdout: bytes("org.tvdoctor.observer/org.tvdoctor.observer.ObserverAccessibilityService\n"),
          stderr: "",
          exitCode: 0,
        };
      },
    });
    expect(enabled).toBe(true);
    expect(commands.flat().join(" ")).toContain("settings get secure enabled_accessibility_services");
    expect(commands.flat().join(" ")).not.toContain("settings put");
  });
});
