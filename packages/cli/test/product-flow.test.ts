import { describe, expect, it } from "vitest";

import {
  EXIT_CODES,
  HELP_TEXT,
  runCli,
  safeTarget,
  type CliContext,
  type RuntimeEnvironment,
} from "../src/index.js";
import { defaultOutputDirectory } from "../src/product-output.js";
import {
  ANDROID_EXPLORATION_BUDGETS,
  androidPreflight,
  checkApkCompatibility,
  classifyAndroidStartup,
  inspectApk,
} from "../src/android-product.js";
import type { StartTerminal } from "../src/interactive.js";

const environment: RuntimeEnvironment = {
  nodeVersion: "v24.18.0",
  platform: "linux",
  architecture: "x64",
};

function contextWithTerminal(terminal: StartTerminal): CliContext {
  return {
    environment,
    io: {
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    },
    startTerminal: terminal,
  };
}

describe("guided product output", () => {
  it("creates readable collision-safe Tests names", () => {
    expect(defaultOutputDirectory({
      target: "https://www.Example.com/watch?v=NOVA",
      mode: "deep",
      now: () => new Date(2026, 7, 26, 0, 30, 4, 123),
    })).toContain("example-com-deep-2026-08-26-00-30-04-123");
  });

  it("gives the real Android driver enough time for a useful Quick traversal", () => {
    expect(ANDROID_EXPLORATION_BUDGETS.quick).toMatchObject({
      maxDurationMs: 120_000,
      maxDepth: 8,
    });
    expect(ANDROID_EXPLORATION_BUDGETS.deep.maxDurationMs).toBe(1_800_000);
  });
});


describe("APK inspection", () => {
  it("parses package, launcher, architecture, and SDK metadata", async () => {
    const apk = await inspectApk("D:/apps/VLC.apk", {
      environment: { ANDROID_SDK_ROOT: "D:/Android/Sdk" },
      toolCommands: [process.platform === "win32" ? "D:/tools/aapt2.exe" : "/tools/aapt2"],
      exists: async (path) => path.endsWith(process.platform === "win32" ? "aapt2.exe" : "aapt2"),
      runTool: async () => ({
        stdout: [
          "package: name='org.videolan.vlc' versionCode='30502' versionName='3.6.2'",
          "application-label:'VLC'",
          "launchable-activity: name='org.videolan.vlc.StartActivity'",
          "leanback-launchable-activity: name='org.videolan.vlc.TvStartActivity'",
          "native-code: 'arm64-v8a' 'armeabi-v7a'",
          "sdkVersion:'21'",
          "targetSdkVersion:'35'",
        ].join("\n"),
        stderr: "",
      }),
    });
    expect(apk.packageName).toBe("org.videolan.vlc");
    expect(apk.leanbackActivity).toBe(".TvStartActivity");
    expect(apk.supportedAbis).toEqual(["arm64-v8a", "armeabi-v7a"]);
    expect(apk.minSdk).toBe(21);
  });

  it("blocks architecture mismatch before installation", () => {
    const result = checkApkCompatibility(
      { minSdk: 24, supportedAbis: ["arm64-v8a"] },
      { apiLevel: 36, supportedAbis: ["x86_64"] },
    );
    expect(result.compatible).toBe(false);
    expect(result.blockers.join(" ")).toContain("do not overlap");
  });

  it("gives a clear failure for an unreadable APK", async () => {
    await expect(inspectApk("D:/not-an-apk.apk", {
      toolCommands: ["aapt2"],
      exists: async () => true,
      runTool: async () => {
        throw new Error("failed opening zip");
      },
    })).rejects.toThrow("Verify that the file is a valid Android application package.");
  });
});

describe("tvdoctor start", () => {
  it("refuses to hang when stdin is not interactive", async () => {
    const terminal: StartTerminal = {
      isInteractive: false,
      prompt: async () => "never",
      select: async () => 0,
    };
    let stderr = "";
    const code = await runCli(["start"], {
      ...contextWithTerminal(terminal),
      io: {
        writeStdout: () => undefined,
        writeStderr: (value) => { stderr += value; },
      },
    });
    expect(code).toBe(EXIT_CODES.usageError);
    expect(stderr).toContain("requires an interactive terminal");
  });

  it("advertises the guided entry point", () => {
    expect(HELP_TEXT).toContain("tvdoctor start");
    expect(safeTarget("HTTPS://Example.COM")).toBe("https://example.com/");
  });

  it("does not offer cookie actions for a non-consent setup blocker", async () => {
    let selections = 0;
    let auditStarted = false;
    const terminal: StartTerminal = {
      isInteractive: true,
      prompt: async () => "https://example.test/login",
      select: async () => {
        selections += 1;
        return 0;
      },
    };
    const code = await runCli(["start"], {
      ...contextWithTerminal(terminal),
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        detectWebsiteStartup: async () => ({
          status: "blocked",
          blockerKind: "login",
          detail: "Sign-in is required.",
        }),
        testTarget: async () => {
          auditStarted = true;
          return { status: "completed", issueCount: 0, highestSeverity: null, reportPath: null, details: [] };
        },
      },
    });

    expect(code).toBe(EXIT_CODES.replayInconclusive);
    expect(selections).toBe(2);
    expect(auditStarted).toBe(false);
  });

  it("confirms a successful report action after a website scan", async () => {
    let stdout = "";
    let openedPath: string | null = null;
    const selections = [0, 0, 0];
    const terminal: StartTerminal = {
      isInteractive: true,
      prompt: async () => "https://example.test",
      select: async () => selections.shift() ?? null,
    };
    const code = await runCli(["start"], {
      ...contextWithTerminal(terminal),
      io: {
        writeStdout: (value) => { stdout += value; },
        writeStderr: () => undefined,
      },
      reportActions: {
        openReport: async (path) => {
          openedPath = path;
          return true;
        },
        showFolder: async () => false,
        copyPath: async () => false,
      },
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        detectWebsiteStartup: async () => ({ status: "ready", detail: "Ready." }),
        testTarget: async () => ({
          status: "completed",
          issueCount: 0,
          highestSeverity: null,
          reportPath: "D:/reports/report.json",
          details: ["All reachable work was exhausted."],
        }),
      },
    });

    expect(code).toBe(EXIT_CODES.success);
    expect(openedPath).toMatch(/[\\/]reports[\\/]report\.html$/u);
    expect(stdout).toContain("sent the report to your default viewer");
  });

  it("offers the same report actions after an Android scan", async () => {
    let copiedPath: string | null = null;
    const selections = [1, 0, 0, 2];
    const terminal: StartTerminal = {
      isInteractive: true,
      prompt: async () => "D:/apps/example.apk",
      select: async () => selections.shift() ?? null,
    };
    const code = await runCli(["start"], {
      ...contextWithTerminal(terminal),
      reportActions: {
        openReport: async () => false,
        showFolder: async () => false,
        copyPath: async (path) => {
          copiedPath = path;
          return true;
        },
      },
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        androidPreflight: async () => ({
          available: true,
          adbPath: "adb",
          message: "Found 1 online Android device.",
          devices: [{
            serial: "emulator-5554",
            state: "device",
            online: true,
            model: "Android TV",
            manufacturer: "Google",
            apiLevel: 36,
            supportedAbis: ["x86_64"],
            isTelevision: true,
            detail: null,
          }],
        }),
        inspectApk: async (path) => ({
          path,
          packageName: "org.example.tv",
          versionName: "1.0.0",
          launchableActivities: [".MainActivity"],
          leanbackActivity: ".MainActivity",
          supportedAbis: ["x86_64"],
          minSdk: 24,
          targetSdk: 36,
          label: "Example TV",
        }),
        scanAndroidApk: async () => ({
          status: "completed",
          issueCount: 0,
          highestSeverity: null,
          reportPath: "D:/reports/report.json",
          details: ["All reachable work was exhausted."],
        }),
      },
    });

    expect(code).toBe(EXIT_CODES.success);
    expect(copiedPath).toMatch(/[\\/]reports[\\/]report\.html$/u);
  });
});

describe("Android startup policy", () => {
  it("classifies a system permission screen as setup rather than an application defect", () => {
    const node = {
      stableId: "permission-button",
      role: "button",
      name: "While using the app",
      text: null,
      visible: true,
      enabled: true,
      focusable: true,
      clickable: true,
      focused: false,
      packageName: "com.google.android.permissioncontroller",
      className: null,
      scrollable: false,
      selected: false,
      children: [],
    };
    const detection = classifyAndroidStartup({
      capturedAt: "2026-08-26T00:00:00.000Z",
      location: { status: "available", value: "com.android.permissioncontroller" },
      focusedElement: { status: "available", value: { stableId: "permission-button" } },
      uiTree: { status: "available", value: [node] },
      device: { status: "unavailable", reason: "unused" },
      app: { status: "unavailable", reason: "unused" },
      hierarchyMetadata: { status: "unavailable", reason: "unused" },
    } as never);

    expect(detection?.kind).toBe("system permission");
    expect(detection?.controls).toContainEqual({ label: "While using the app", focused: false });
  });
});

describe("Android device preflight", () => {
  it("gives actionable copy when ADB is missing", async () => {
    const result = await androidPreflight("missing-adb", {
      createDriver: () => ({
        listDevices: async () => {
          throw new Error("spawn adb ENOENT");
        },
        getDeviceMetadata: async () => {
          throw new Error("unused");
        },
        close: () => undefined,
      }),
    });
    expect(result.available).toBe(false);
    expect(result.message).toBe("Android platform-tools (ADB) was not found.");
  });

  it("summarises online, offline, and multiple devices without requiring serial expertise", async () => {
    const metadataSerials = new Set(["emulator-5554", "tv-1", "tv-2"]);
    let created = 0;
    const result = await androidPreflight("adb", {
      createDriver: (options) => {
        created += 1;
        if (options.serial === undefined) {
          return {
            listDevices: async () => [
              { serial: "emulator-5554", state: "device", model: "ATV" },
              { serial: "tv-2", state: "device", model: "Panel" },
              { serial: "offline-1", state: "offline", model: null },
            ],
            getDeviceMetadata: async () => {
              throw new Error("root driver has no single device");
            },
            close: () => undefined,
          };
        }
        if (!metadataSerials.has(options.serial)) {
          return {
            listDevices: async () => [],
            getDeviceMetadata: async () => {
              throw new Error("device offline");
            },
            close: () => undefined,
          };
        }
        if (options.serial === undefined) throw new Error("metadata driver requires a serial");
        const serial = options.serial;
        return {
          listDevices: async () => [],
          getDeviceMetadata: async () => ({
            serial,
            manufacturer: "Google",
            model: "Android TV",
            sdkLevel: 36,
            release: "16",
            buildFingerprint: "atv",
            characteristics: ["tv"],
            supportedAbis: ["x86_64"],
            displayWidth: 1280,
            displayHeight: 720,
            displayDensityDpi: 213,
            isTelevision: true,
          }),
          close: () => undefined,
        };
      },
    });

    expect(result.message).toBe("Found 2 online Android devices.");
    expect(result.devices).toHaveLength(3);
    expect(result.devices[0]).toMatchObject({ online: true, isTelevision: true, apiLevel: 36 });
    expect(result.devices[1]).toMatchObject({ online: true, model: "Android TV" });
    expect(result.devices[2]?.detail).toContain("Offline");
    expect(created).toBe(3);
  });

  it("rejects invalid guided URLs without starting an audit", async () => {
    let stdout = "";
    let auditStarted = false;
    let promptCount = 0;
    const terminal = {
      isInteractive: true,
      prompt: async () => {
        promptCount += 1;
        return promptCount === 1 ? "not-a-url" : null;
      },
      select: async () => 0,
    };
    const code = await runCli(["start"], {
      environment,
      io: {
        writeStdout: (value) => { stdout += value; },
        writeStderr: () => undefined,
      },
      startTerminal: terminal,
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        testTarget: async () => {
          auditStarted = true;
          return { status: "completed", issueCount: 0, highestSeverity: null, reportPath: null, details: [] };
        },
      },
    });

    expect(code).toBe(EXIT_CODES.usageError);
    expect(stdout).toContain("Please enter an absolute HTTP or HTTPS web address");
    expect(auditStarted).toBe(false);
  });
});
