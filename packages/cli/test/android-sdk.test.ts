import { describe, expect, it } from "vitest";

import { locateAndroidSdkTools } from "../src/android-sdk.js";

const windowsNames = {
  adb: "adb.exe",
  aapt2: "aapt2.exe",
  emulator: "emulator.exe",
  sdkmanager: "sdkmanager.bat",
  avdmanager: "avdmanager.bat",
};

describe("Android SDK discovery", () => {
  it("prefers an explicit adb path while using the selected SDK root for sibling tools", async () => {
    const existing = new Set([
      "C:/explicit/adb.exe",
      "D:/Sdk/build-tools/36.0.0/aapt2.exe",
      "D:/Sdk/emulator/emulator.exe",
      "D:/Sdk/cmdline-tools/latest/bin/sdkmanager.bat",
      "D:/Sdk/cmdline-tools/latest/bin/avdmanager.bat",
    ]);
    const tools = await locateAndroidSdkTools({
      platform: "win32",
      explicitAdbPath: "C:/explicit/adb.exe",
      environment: { ANDROID_SDK_ROOT: "D:/Sdk" },
      exists: async (path) => existing.has(path.replaceAll("\\", "/")),
      listDirectories: async (path) => path.replaceAll("\\", "/").endsWith("/build-tools") ? ["35.0.0", "36.0.0"] : [],
      resolveFromPath: async () => null,
    });
    expect(tools.adbPath.replaceAll("\\", "/")).toBe("C:/explicit/adb.exe");
    expect(tools.aaptPath?.replaceAll("\\", "/")).toBe("D:/Sdk/build-tools/36.0.0/aapt2.exe");
  });

  it("uses ANDROID_SDK_ROOT before ANDROID_HOME", async () => {
    const tools = await locateAndroidSdkTools({
      platform: "win32",
      environment: { ANDROID_SDK_ROOT: "D:/Root", ANDROID_HOME: "E:/Home" },
      exists: async (path) => path.replaceAll("\\", "/") === `D:/Root/platform-tools/${windowsNames.adb}`,
      listDirectories: async () => [],
      resolveFromPath: async () => null,
    });
    expect(tools.sdkRoot?.replaceAll("\\", "/")).toBe("D:/Root");
    expect(tools.adbPath.replaceAll("\\", "/")).toBe(`D:/Root/platform-tools/${windowsNames.adb}`);
  });

  it("falls back to ANDROID_HOME", async () => {
    const tools = await locateAndroidSdkTools({
      platform: "win32",
      environment: { ANDROID_HOME: "E:/Home" },
      exists: async (path) => path.replaceAll("\\", "/") === `E:/Home/platform-tools/${windowsNames.adb}`,
      listDirectories: async () => [],
      resolveFromPath: async () => null,
    });
    expect(tools.sdkRoot?.replaceAll("\\", "/")).toBe("E:/Home");
  });

  it("finds the normal Windows Android Studio SDK under LOCALAPPDATA", async () => {
    const root = "C:/Users/leon/AppData/Local/Android/Sdk";
    const existing = new Set([
      `${root}/platform-tools/${windowsNames.adb}`,
      `${root}/build-tools/36.0.0/${windowsNames.aapt2}`,
      `${root}/emulator/${windowsNames.emulator}`,
      `${root}/cmdline-tools/latest/bin/${windowsNames.sdkmanager}`,
      `${root}/cmdline-tools/latest/bin/${windowsNames.avdmanager}`,
    ]);
    const tools = await locateAndroidSdkTools({
      platform: "win32",
      environment: { LOCALAPPDATA: "C:/Users/leon/AppData/Local" },
      exists: async (path) => existing.has(path.replaceAll("\\", "/")),
      listDirectories: async (path) => path.replaceAll("\\", "/").endsWith("/build-tools") ? ["36.0.0"] : [],
      resolveFromPath: async () => null,
    });
    expect(tools.sdkRoot?.replaceAll("\\", "/")).toBe(root);
    expect(tools.aaptPath?.replaceAll("\\", "/")).toBe(`${root}/build-tools/36.0.0/${windowsNames.aapt2}`);
    expect(tools.emulatorPath?.replaceAll("\\", "/")).toBe(`${root}/emulator/${windowsNames.emulator}`);
    expect(tools.sdkManagerPath?.replaceAll("\\", "/")).toBe(`${root}/cmdline-tools/latest/bin/${windowsNames.sdkmanager}`);
    expect(tools.avdManagerPath?.replaceAll("\\", "/")).toBe(`${root}/cmdline-tools/latest/bin/${windowsNames.avdmanager}`);
  });

  it("falls back to PATH for adb when no SDK root is usable", async () => {
    const tools = await locateAndroidSdkTools({
      platform: "linux",
      environment: {},
      exists: async () => false,
      listDirectories: async () => [],
      resolveFromPath: async (name) => name === "adb" ? "/usr/bin/adb" : null,
    });
    expect(tools.sdkRoot).toBeNull();
    expect(tools.adbPath).toBe("/usr/bin/adb");
  });
});
