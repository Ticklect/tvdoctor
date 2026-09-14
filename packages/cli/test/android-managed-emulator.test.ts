import { describe, expect, it } from "vitest";

import {
  MANAGED_ANDROID_AVD_NAME,
  MANAGED_ANDROID_SYSTEM_IMAGE,
  ensureManagedAndroidTvEmulator,
} from "../src/android-managed-emulator.js";
import type { AndroidSdkTools } from "../src/android-sdk.js";

const tools: AndroidSdkTools = {
  sdkRoot: "C:/Android/Sdk",
  adbPath: "C:/Android/Sdk/platform-tools/adb.exe",
  aaptPath: "C:/Android/Sdk/build-tools/36.0.0/aapt2.exe",
  emulatorPath: "C:/Android/Sdk/emulator/emulator.exe",
  sdkManagerPath: "C:/Android/Sdk/cmdline-tools/latest/bin/sdkmanager.bat",
  avdManagerPath: "C:/Android/Sdk/cmdline-tools/latest/bin/avdmanager.bat",
};

function readyDependencies(options: {
  installed?: string;
  avds?: string;
  beforeDevices?: string;
  afterDevices?: string;
} = {}) {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const interactive: Array<{ command: string; args: readonly string[] }> = [];
  const starts: Array<{ command: string; args: readonly string[] }> = [];
  let adbDeviceReads = 0;
  return {
    calls,
    interactive,
    starts,
    dependencies: {
      runTool: async (command: string, args: readonly string[]) => {
        calls.push({ command, args: [...args] });
        if (args.includes("--list_installed")) {
          return {
            stdout: options.installed ?? `emulator\nplatform-tools\n${MANAGED_ANDROID_SYSTEM_IMAGE}\n`,
            stderr: "",
            exitCode: 0,
          };
        }
        if (args.includes("-list-avds")) {
          return { stdout: options.avds ?? `${MANAGED_ANDROID_AVD_NAME}\n`, stderr: "", exitCode: 0 };
        }
        if (args.length === 1 && args[0] === "devices") {
          adbDeviceReads += 1;
          return {
            stdout: adbDeviceReads === 1
              ? options.beforeDevices ?? "List of devices attached\n"
              : options.afterDevices ?? "List of devices attached\nemulator-5554\tdevice\n",
            stderr: "",
            exitCode: 0,
          };
        }
        if (args.at(-2) === "emu" && args.at(-1) === "kill") {
          return { stdout: "OK", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      runInteractiveTool: async (command: string, args: readonly string[]) => {
        interactive.push({ command, args: [...args] });
        return 0;
      },
      startEmulator: async (command: string, args: readonly string[]) => {
        starts.push({ command, args: [...args] });
        return { pid: 1234, stop: async () => undefined };
      },
      waitForReady: async () => undefined,
      sleep: async () => undefined,
    },
  };
}

describe("TVDoctor managed Android TV emulator", () => {
  it("rejects unsupported hosts without guessing another image", async () => {
    const fixture = readyDependencies();
    await expect(ensureManagedAndroidTvEmulator({
      tools,
      platform: "linux",
      architecture: "x64",
      confirmDownload: async () => true,
      dependencies: fixture.dependencies,
    })).rejects.toThrow(/Windows.*x64/iu);
    expect(fixture.starts).toHaveLength(0);
  });

  it("reuses the owned AVD without a download or recreation", async () => {
    const fixture = readyDependencies();
    let confirmations = 0;
    const handle = await ensureManagedAndroidTvEmulator({
      tools,
      platform: "win32",
      architecture: "x64",
      confirmDownload: async () => { confirmations += 1; return true; },
      dependencies: fixture.dependencies,
    });
    expect(handle.serial).toBe("emulator-5554");
    expect(confirmations).toBe(0);
    expect(fixture.interactive).toHaveLength(0);
    expect(fixture.starts[0]?.args).toContain(MANAGED_ANDROID_AVD_NAME);
    expect(fixture.starts[0]?.args).toContain("-no-window");
    await handle.stop();
    expect(fixture.calls.some((call) => call.args.join(" ").includes("emu kill"))).toBe(true);
    expect(fixture.calls.some((call) => call.args.includes("delete"))).toBe(false);
  });

  it("asks once before installing missing emulator/image packages", async () => {
    const fixture = readyDependencies({
      installed: "platform-tools\n",
      avds: "",
    });
    let requested: readonly string[] = [];
    await ensureManagedAndroidTvEmulator({
      tools: { ...tools, emulatorPath: null },
      platform: "win32",
      architecture: "x64",
      confirmDownload: async (packages) => { requested = packages; return true; },
      dependencies: fixture.dependencies,
    });
    expect(requested).toEqual(["emulator", MANAGED_ANDROID_SYSTEM_IMAGE]);
    expect(fixture.interactive[0]?.args).toEqual(["emulator", MANAGED_ANDROID_SYSTEM_IMAGE]);
    expect(fixture.interactive[1]?.args).toContain("create");
    expect(fixture.interactive[1]?.args).toContain(MANAGED_ANDROID_AVD_NAME);
  });

  it("does not run sdkmanager when the user declines the download", async () => {
    const fixture = readyDependencies({ installed: "platform-tools\n", avds: "" });
    await expect(ensureManagedAndroidTvEmulator({
      tools: { ...tools, emulatorPath: null },
      platform: "win32",
      architecture: "x64",
      confirmDownload: async () => false,
      dependencies: fixture.dependencies,
    })).rejects.toThrow(/declined/iu);
    expect(fixture.interactive).toHaveLength(0);
    expect(fixture.starts).toHaveLength(0);
  });
});
