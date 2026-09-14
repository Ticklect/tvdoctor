import { describe, expect, it } from "vitest";

import { runZeroConfigTarget, type CliContext, type RuntimeEnvironment } from "../src/index.js";
import type { StartTerminal } from "../src/interactive.js";

const environment: RuntimeEnvironment = {
  nodeVersion: "v24.18.0",
  platform: "win32",
  architecture: "x64",
};

const apk = {
  path: "D:/apps/example.apk",
  packageName: "org.example.tv",
  versionName: "1.0.0",
  launchableActivities: [".MainActivity"],
  leanbackActivity: ".MainActivity",
  supportedAbis: ["x86_64"],
  minSdk: 24,
  targetSdk: 36,
  label: "Example TV",
} as const;

const tv = {
  serial: "emulator-5554",
  state: "device",
  online: true,
  model: "Android TV",
  manufacturer: "Google",
  apiLevel: 36,
  supportedAbis: ["x86_64"],
  isTelevision: true,
  detail: null,
} as const;

function terminal(select: StartTerminal["select"] = async () => 0): StartTerminal {
  return { isInteractive: true, prompt: async () => null, select };
}

function context(
  events: string[],
  startTerminal = terminal(),
  overrides: Partial<NonNullable<CliContext["operations"]>> = {},
): CliContext {
  return {
    environment,
    startTerminal,
    io: { writeStdout: () => undefined, writeStderr: () => undefined },
    operations: {
      replayIssue: async () => ({ status: "fixed", details: [] }),
      inspectApk: async () => { events.push("inspect-apk"); return apk; },
      androidPreflight: async () => {
        events.push("preflight");
        return { available: true, adbPath: "adb", message: "ready", devices: [tv] };
      },
      scanAndroidApk: async () => {
        events.push("scan");
        return {
          status: "completed",
          issueCount: 0,
          highestSeverity: null,
          reportPath: null,
          details: ["All reachable navigation work was exhausted."],
        };
      },
      ...overrides,
    },
  };
}

describe("zero-config Android flow", () => {
  it("inspects the APK before device discovery and auto-selects one compatible TV", async () => {
    const events: string[] = [];
    let selections = 0;
    const ctx = context(events, terminal(async () => { selections += 1; return 0; }));
    const code = await runZeroConfigTarget({ kind: "android-apk", apkPath: apk.path }, ctx, {
      androidPackageInstalled: async () => false,
    });
    expect(code).toBe(0);
    expect(events).toEqual(["inspect-apk", "preflight", "scan"]);
    expect(selections).toBe(0);
  });

  it("asks once when several compatible TVs exist", async () => {
    const events: string[] = [];
    let selections = 0;
    const ctx = context(events, terminal(async () => { selections += 1; return 1; }), {
      androidPreflight: async () => ({
        available: true,
        adbPath: "adb",
        message: "ready",
        devices: [tv, { ...tv, serial: "tv-2", model: "Second TV" }],
      }),
    });
    await runZeroConfigTarget({ kind: "android-apk", apkPath: apk.path }, ctx, {
      androidPackageInstalled: async () => false,
    });
    expect(selections).toBe(1);
  });

  it("does not silently replace an existing app on an external target", async () => {
    const events: string[] = [];
    let scanCalled = false;
    const ctx = context(events, terminal(async () => 1), {
      scanAndroidApk: async () => {
        scanCalled = true;
        throw new Error("must not scan");
      },
    });
    const code = await runZeroConfigTarget({ kind: "android-apk", apkPath: apk.path }, ctx, {
      androidPackageInstalled: async () => true,
    });
    expect(code).toBe(2);
    expect(scanCalled).toBe(false);
  });

  it("opens Observer setup, waits for explicit enablement, and retries in the same command", async () => {
    const events: string[] = [];
    let scans = 0;
    let enabledChecks = 0;
    const ctx = context(events, terminal(), {
      scanAndroidApk: async () => {
        scans += 1;
        if (scans === 1) {
          return {
            status: "failed",
            issueCount: 0,
            highestSeverity: null,
            reportPath: null,
            details: ["Enable TVDoctor Observer accessibility access on the Android device and retry."],
          };
        }
        return {
          status: "completed",
          issueCount: 0,
          highestSeverity: null,
          reportPath: null,
          details: ["All reachable navigation work was exhausted."],
        };
      },
    });

    const code = await runZeroConfigTarget({ kind: "android-apk", apkPath: apk.path }, ctx, {
      androidPackageInstalled: async () => false,
      openObserverSetup: async () => { events.push("open-observer-setup"); },
      observerAccessibilityEnabled: async () => {
        enabledChecks += 1;
        return enabledChecks >= 2;
      },
      sleep: async () => undefined,
      now: (() => {
        let value = 0;
        return () => { value += 500; return value; };
      })(),
    });

    expect(code).toBe(0);
    expect(scans).toBe(2);
    expect(events).toContain("open-observer-setup");
    expect(enabledChecks).toBe(2);
  });

  it("lets the user complete app setup and automatically rechecks in the same command", async () => {
    const events: string[] = [];
    let scans = 0;
    const ctx = context(events, terminal(async () => 0), {
      scanAndroidApk: async (request) => {
        scans += 1;
        if (scans === 1) {
          const decision = await request.onSetupScreen?.({
            kind: "login",
            heading: "Sign in",
            controls: [],
          });
          expect(decision).toBe("leave-unchanged");
          return {
            status: "setup-blocker",
            issueCount: 0,
            highestSeverity: null,
            reportPath: null,
            details: ["The scan was not started because TVDoctor found a login screen."],
          };
        }
        return {
          status: "completed",
          issueCount: 0,
          highestSeverity: null,
          reportPath: null,
          details: ["All reachable navigation work was exhausted."],
        };
      },
    });

    const code = await runZeroConfigTarget({ kind: "android-apk", apkPath: apk.path }, ctx, {
      androidPackageInstalled: async () => false,
    });
    expect(code).toBe(0);
    expect(scans).toBe(2);
  });
});
