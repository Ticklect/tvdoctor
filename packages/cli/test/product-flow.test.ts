import { describe, expect, it } from "vitest";
import { normaliseActionSettlingOptions } from "@tvdoctor/core";
import { sanitiseEvidenceJson } from "@tvdoctor/reporters";

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
  ANDROID_ACTION_SETTLING,
  ANDROID_LAUNCH_SETTLING,
  ANDROID_LAUNCH_WARMUP_MS,
  ANDROID_TRAVERSAL_VERIFIED_LIVE_ONLY,
  ANDROID_TRAVERSAL_RESTORATION,
  ANDROID_EXPLORATION_BUDGETS,
  androidPreflight,
  buildAndroidExplorationEvidence,
  buildAndroidTraversalLedger,
  checkApkCompatibility,
  classifyAndroidStartup,
  createAndroidTraversalRootRestorer,
  createAndroidTraversalPolicyRecorder,
  inspectApk,
  restoreAndroidTargetForFinalEvidence,
} from "../src/android-product.js";
import { hasIncompleteSafeCoverage } from "../src/android-coverage-ledger.js";
import type { StartTerminal } from "../src/interactive.js";
import type { StateSnapshot } from "@tvdoctor/protocol";

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

function playerSnapshot(
  activity: string,
  focusedStableId: string,
  changingDecoration: string,
): StateSnapshot {
  return {
    capturedAt: "2026-09-09T18:00:00.000Z",
    location: { status: "available", value: `android://io.github.ticklect.goatedtv/${activity}` },
    focusedElement: {
      status: "available",
      value: {
        stableId: focusedStableId,
        role: "button",
        name: "Play",
      },
    },
    uiTree: {
      status: "available",
      value: [{
        stableId: "player-root",
        role: null,
        name: null,
        text: changingDecoration,
        enabled: true,
        focusable: false,
        focused: false,
        visible: true,
        modal: false,
        selectionState: null,
        valueNow: null,
        bounds: null,
        children: [{
          stableId: changingDecoration,
          role: "image",
          name: null,
          text: null,
          enabled: true,
          focusable: false,
          focused: false,
          visible: true,
          modal: false,
          selectionState: null,
          valueNow: null,
          bounds: null,
          children: [],
        }],
      }],
    },
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

  it("gives stable Android observations enough time for a useful Quick traversal", () => {
    expect(ANDROID_EXPLORATION_BUDGETS.quick).toMatchObject({
      maxDurationMs: 720_000,
      maxDepth: 8,
    });
    expect(ANDROID_EXPLORATION_BUDGETS.deep.maxDurationMs).toBe(1_800_000);
    expect(ANDROID_ACTION_SETTLING).toMatchObject({
      strategy: "stable-snapshot",
      maxSnapshots: 6,
      requiredStableSnapshots: 3,
      pollIntervalMs: 250,
      keyOverrides: {
        SELECT: { maxSnapshots: 14, requiredStableSnapshots: 7 },
        BACK: { maxSnapshots: 14, requiredStableSnapshots: 7 },
      },
    });
    expect(ANDROID_LAUNCH_SETTLING).toEqual({
      resetStableWindowMs: 2_000,
      resetSettleTimeoutMs: 20_000,
    });
    expect(ANDROID_LAUNCH_WARMUP_MS).toBe(8_000);
    expect(ANDROID_TRAVERSAL_RESTORATION).toEqual({
      restorationMode: "verified-local",
      allowRootRestorationFallback: true,
      refreshVisibleSelfLoops: false,
      replayActions: ["UP", "DOWN", "LEFT", "RIGHT", "SELECT"],
      replaySettling: ANDROID_ACTION_SETTLING,
    });
    expect(ANDROID_TRAVERSAL_VERIFIED_LIVE_ONLY).toEqual({
      restorationMode: "verified-live-only",
      allowRootRestorationFallback: false,
      refreshVisibleSelfLoops: false,
      replayActions: ["UP", "DOWN", "LEFT", "RIGHT", "SELECT"],
      replaySettling: ANDROID_ACTION_SETTLING,
    });
  });

  it("keeps polling when the canonical Android tree changes under the same activity and focus", () => {
    const equivalent = normaliseActionSettlingOptions(ANDROID_ACTION_SETTLING).equivalent;
    const first = playerSnapshot(".MainActivity", "player-play", "frame 101");
    const unchanged = playerSnapshot(".MainActivity", "player-play", "frame 101");
    const nextFrame = playerSnapshot(".MainActivity", "player-play", "frame 102");
    const movedFocus = playerSnapshot(".MainActivity", "player-settings", "frame 103");
    const changedActivity = playerSnapshot(".DetailsActivity", "player-play", "frame 104");

    expect(equivalent(first, unchanged)).toBe(true);
    expect(equivalent(first, nextFrame)).toBe(false);
    expect(equivalent(first, movedFocus)).toBe(false);
    expect(equivalent(first, changedActivity)).toBe(false);
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

  it("recognises a redacted permission-controller boundary from its window owner", () => {
    const detection = classifyAndroidStartup({
      capturedAt: "2026-09-15T19:00:00.000Z",
      location: {
        status: "available",
        value: "android://com.google.android.permissioncontroller/com.android.permissioncontroller.permission.ui.GrantPermissionsActivity",
      },
      focusedElement: { status: "available", value: null },
      uiTree: { status: "available", value: [] },
      device: { status: "unavailable", reason: "unused" },
      app: { status: "unavailable", reason: "unused" },
      hierarchyMetadata: { status: "unavailable", reason: "unused" },
    } as never);

    expect(detection).toEqual({
      kind: "system permission",
      heading: "System permission",
      controls: [],
    });
  });
});

describe("Android traversal safety policy", () => {
  const targetPackage = "org.example.tv";
  const targetSnapshot = (name: string) => ({
    capturedAt: "2026-09-18T17:00:00.000Z",
    location: { status: "available", value: `android://${targetPackage}/org.example.tv.MainActivity` },
    focusedElement: {
      status: "available",
      value: { stableId: "root/action", role: "button", name },
    },
    uiTree: {
      status: "available",
      value: [{
        stableId: "root/action",
        role: "button",
        name,
        text: null,
        enabled: true,
        focusable: true,
        focused: true,
        visible: true,
        modal: false,
        selectionState: null,
        valueNow: null,
        bounds: null,
        className: "android.widget.Button",
        packageName: targetPackage,
        clickable: true,
        scrollable: false,
        selected: false,
        children: [],
      }],
    },
    device: { status: "unavailable", reason: "unused" },
    app: { status: "unavailable", reason: "unused" },
    hierarchyMetadata: {
      status: "available",
      value: {
        targetWindowActive: true,
        capturedNodeCount: 1,
        maxNodeCount: 2_048,
        maxDepth: 64,
        truncated: false,
      },
    },
  } as const);

  it("gates risky SELECT instead of sending it automatically", async () => {
    const recorder = createAndroidTraversalPolicyRecorder({
      driver: {
        getActiveMediaSession: async () => ({ status: "unavailable", reason: "none" }),
        captureScreenshotFingerprint: async () => {
          throw new Error("rich semantics should not need screenshot evidence");
        },
      } as never,
      targetPackage,
    });

    const actions = await recorder.actionsForState({
      screenStateId: "screen-risky",
      focusStateId: "focus-risky",
      snapshot: targetSnapshot("Sign in"),
      defaultActions: [],
    } as never);

    expect(actions).not.toContain("SELECT");
    expect(recorder.records[0]?.decisions.find((decision) => decision.key === "SELECT"))
      .toMatchObject({ disposition: "operator-gated", reasonCode: "risky-activation" });
  });

  it("fails closed when sparse semantics are paired with a blank screenshot", async () => {
    const recorder = createAndroidTraversalPolicyRecorder({
      driver: {
        getActiveMediaSession: async () => ({ status: "unavailable", reason: "none" }),
        captureScreenshotFingerprint: async () => ({
          status: "available",
          value: {
            sha256: "0".repeat(64),
            width: 1280,
            height: 720,
            luminanceGrid: [0],
            meanLuminance: 0,
            luminanceVariance: 0,
            visuallyBlank: true,
          },
        }),
      } as never,
      targetPackage,
    });
    const sparseSnapshot = {
      ...targetSnapshot("Open"),
      focusedElement: { status: "unavailable", reason: "observer sparse" },
      uiTree: { status: "unavailable", reason: "observer sparse" },
    } as const;

    const actions = await recorder.actionsForState({
      screenStateId: "screen-sparse",
      focusStateId: "focus-sparse",
      snapshot: sparseSnapshot,
      defaultActions: [],
    } as never);
    expect(actions).toEqual([]);
    expect(recorder.records[0]?.decisions.every((decision) => (
      decision.disposition === "inaccessible"
      && decision.reasonCode === "semantic-and-visual-evidence-unavailable"
    ))).toBe(true);

    const ledger = buildAndroidTraversalLedger({
      targetPackage,
      records: recorder.records,
      result: {
        graph: { actions: [] },
        budgets: ANDROID_EXPLORATION_BUDGETS.quick,
        termination: { reason: "queue-exhausted", complete: true },
        statistics: { deferredStates: 0 },
      } as never,
      finalTargetValidated: true,
    });
    expect(ledger.counts.inaccessible).toBeGreaterThan(0);
    expect(hasIncompleteSafeCoverage(ledger)).toBe(true);
  });

  it("never offers HOME to automatic Android exploration", async () => {
    const recorder = createAndroidTraversalPolicyRecorder({
      driver: {
        getActiveMediaSession: async () => ({ status: "unavailable", reason: "none" }),
        captureScreenshotFingerprint: async () => {
          throw new Error("rich semantics should not need screenshot evidence");
        },
      } as never,
      targetPackage,
    });

    const first = await recorder.actionsForState({
      screenStateId: "screen-main",
      focusStateId: "focus-main",
      snapshot: targetSnapshot("Open"),
      defaultActions: [],
    } as never);
    expect(first).not.toContain("HOME");
    expect(recorder.records[0]?.decisions.some((decision) => decision.key === "HOME")).toBe(false);
  });

  it("gates BACK on the prepared root screen so traversal does not exit to the launcher", async () => {
    const recorder = createAndroidTraversalPolicyRecorder({
      driver: {
        getActiveMediaSession: async () => ({ status: "unavailable", reason: "none" }),
        captureScreenshotFingerprint: async () => {
          throw new Error("rich semantics should not need screenshot evidence");
        },
      } as never,
      targetPackage,
    });

    const actions = await recorder.actionsForState({
      screenStateId: "screen-root",
      focusStateId: "focus-root",
      snapshot: targetSnapshot("Open"),
      defaultActions: [],
    } as never);

    expect(actions).not.toContain("BACK");
    expect(recorder.records[0]?.decisions.find((decision) => decision.key === "BACK"))
      .toMatchObject({ disposition: "operator-gated", reasonCode: "root-back-boundary" });
  });
});

describe("Android final target validation", () => {
  const snapshotAt = (location: string) => ({
    location: { status: "available", value: location },
  }) as never;

  it("restores the target before final evidence when exploration ends on an external boundary", async () => {
    let restored = false;
    let resetCalls = 0;
    const driver = {
      snapshot: async () => snapshotAt(restored
        ? "android://org.example.tv/org.example.tv.MainActivity"
        : "android://com.google.android.tvlauncher/com.google.android.tvlauncher.MainActivity"),
      reset: async () => {
        resetCalls += 1;
        restored = true;
      },
    };

    await expect(restoreAndroidTargetForFinalEvidence(
      driver as never,
      "org.example.tv",
      async () => undefined,
    )).resolves.toMatchObject({
      location: { status: "available", value: "android://org.example.tv/org.example.tv.MainActivity" },
    });
    expect(resetCalls).toBe(1);
  });

  it("fails final validation when relaunch cannot prove target ownership", async () => {
    const external = snapshotAt("android://com.google.android.tvlauncher/com.google.android.tvlauncher.MainActivity");
    const driver = {
      snapshot: async () => external,
      reset: async () => undefined,
    };

    await expect(restoreAndroidTargetForFinalEvidence(
      driver as never,
      "org.example.tv",
      async () => undefined,
    )).rejects.toThrow(/ended outside org\.example\.tv/u);
  });
});

describe("Android traversal root restoration", () => {
  const snapshotAt = (location: string) => ({
    location: { status: "available", value: location },
  }) as never;

  it("uses the prepared state once, then relaunches before reconstructing queued branches", async () => {
    const prepared = snapshotAt("android://org.example.tv/org.example.tv.MainActivity");
    const relaunched = snapshotAt("android://org.example.tv/org.example.tv.MainActivity");
    let resetCalls = 0;
    let snapshotCalls = 0;
    const driver = {
      reset: async (strategy: string) => {
        expect(strategy).toBe("relaunch");
        resetCalls += 1;
      },
      snapshot: async () => {
        snapshotCalls += 1;
        return relaunched;
      },
    };
    const restore = createAndroidTraversalRootRestorer(driver as never, "org.example.tv", prepared);

    await expect(restore()).resolves.toBe(prepared);
    await expect(restore()).resolves.toBe(relaunched);
    expect(resetCalls).toBe(1);
    expect(snapshotCalls).toBe(1);
  });

  it("fails closed when relaunch cannot prove target ownership", async () => {
    const prepared = snapshotAt("android://org.example.tv/org.example.tv.MainActivity");
    const external = snapshotAt("android://com.android.tv.settings/com.android.settings.Settings");
    const driver = {
      reset: async () => undefined,
      snapshot: async () => external,
    };
    const restore = createAndroidTraversalRootRestorer(driver as never, "org.example.tv", prepared);

    await expect(restore()).resolves.toBe(prepared);
    await expect(restore()).rejects.toThrow(/root restoration ended outside org\.example\.tv/u);
  });

  it("uses the post-setup prepared snapshot as the initial exploration root", async () => {
    const prepared = snapshotAt("android://org.example.tv/org.example.tv.MainActivity");
    const staleSetup = snapshotAt("android://com.android.permissioncontroller/GrantPermissionsActivity");
    const driver = {
      reset: async () => undefined,
      snapshot: async () => staleSetup,
    };
    const restore = createAndroidTraversalRootRestorer(driver as never, "org.example.tv", prepared);

    await expect(restore()).resolves.toBe(prepared);
  });
});

describe("Android restoration evidence", () => {
  it("records package/activity, replay history, restart status, and exact rejection metadata", () => {
    const expectedSnapshot = snapshotAtForRestorationEvidence(
      "android://org.example.tv/org.example.tv.MainActivity",
    );
    const externalLocation = "android://com.android.tv.settings/com.android.settings.Settings";
    const result = {
      termination: {
        reason: "restoration-unavailable",
        complete: false,
        restorationSubtype: "strategy-exhausted",
        restorationRejectionReason: "unsafe-root-replay",
      },
      budgets: { maxActions: 10, maxStates: 10, maxDepth: 4, maxDurationMs: 60_000 },
      actionOrder: ["UP"],
      graph: {
        screens: { states: [], transitions: [] },
        focus: {
          states: [{
            id: "focus-0001",
            screenStateId: "screen-0001",
            fingerprint: { value: "focus-expected" },
            stateFingerprint: "state-expected",
            confidence: "high",
            firstSeenDepth: 0,
            discoveredBy: [],
            representativeSnapshot: expectedSnapshot,
          }],
          transitions: [],
        },
        actions: [],
      },
      statistics: {
        physicalActions: 1,
        focusStates: 1,
        screenStates: 1,
        elapsedMs: 123,
        restorationAttempts: 1,
        restorationSuccesses: 0,
        restorationFailures: 1,
        repeatedStates: 0,
        compressedStates: 0,
        deferredStates: 0,
      },
      restorationDiagnostics: [{
        attemptNumber: 1,
        retryNumber: 0,
        restorationCycleNumber: 1,
        successfulRestorationsBeforeAttempt: 0,
        traversalDepth: 2,
        destinationStateId: "focus-0001",
        strategy: "root-replay",
        status: "failed",
        elapsedMs: 25,
        actionHistory: ["SELECT"],
        before: {
          capturedAt: "2026-09-19T10:00:00.000Z",
          stateFingerprint: "state-external",
          screenFingerprint: "screen-external",
          focusFingerprint: "focus-external",
          focusIdentity: "focus-external",
          location: externalLocation,
        },
        after: {
          capturedAt: "2026-09-19T10:00:01.000Z",
          stateFingerprint: "state-external",
          screenFingerprint: "screen-external",
          focusFingerprint: "focus-external",
          focusIdentity: "focus-external",
          location: externalLocation,
        },
        expected: {
          capturedAt: "2026-09-19T10:00:00.000Z",
          stateFingerprint: "state-expected",
          screenFingerprint: "screen-expected",
          focusFingerprint: "focus-expected",
          focusIdentity: "focus-expected",
          location: "android://org.example.tv/org.example.tv.MainActivity",
          applicationId: "org.example.tv",
        },
        history: [],
        subtype: "strategy-exhausted",
        rejectionReason: "unsafe-root-replay",
      }],
    } as never;

    expect(buildAndroidExplorationEvidence(result, "org.example.tv", null, null, "android-test-scan")).toMatchObject({
      scanId: "android-test-scan",
      applicationPackage: "org.example.tv",
      completionEvidence: {
        restorationAttempts: 1,
        restorationSuccesses: 0,
        restorationFailures: 1,
        appCrashCount: null,
        appCrashCountStatus: "not-collected",
      },
      restorationDiagnostics: [{
        applicationPackage: "org.example.tv",
        scanId: "android-test-scan",
        restorationCycleNumber: 1,
        successfulRestorationsBeforeAttempt: 0,
        traversalDepth: 2,
        sourceStateId: null,
        intendedDestinationStateId: "focus-0001",
        strategy: "root-replay",
        actionHistory: ["SELECT"],
        processRestarted: false,
        currentPackage: "com.android.tv.settings",
        currentActivity: "com.android.settings.Settings",
        expectedPackage: "org.example.tv",
        expectedActivity: "org.example.tv.MainActivity",
        failureClass: "restoration-external-surface",
        taxonomyCategory: "application-or-system-surface",
        rejectionReason: "unsafe-root-replay",
      }],
      restorationResilience: {
        restorationCycles: { attempts: 1, successes: 0, failures: 1, successRate: 0 },
        byRestorationOrdinal: {
          first: { attempts: 1, successes: 0, failures: 1, successRate: 0 },
        },
        deepestSuccessfullyRestoredCheckpoint: null,
        successfulRestorationCyclesInTraversal: 0,
        multipleSuccessfulRestorations: false,
        failureCountByTaxonomy: { "application-or-system-surface": 1 },
      },
    });
  });

  it("classifies timeout and strategy-exhaustion failures from the core subtype before rejection text", () => {
    const base = {
      termination: { reason: "settling-exhausted", complete: false },
      budgets: { maxActions: 10, maxStates: 10, maxDepth: 4, maxDurationMs: 60_000 },
      actionOrder: ["RIGHT"],
      graph: { screens: { states: [], transitions: [] }, focus: { states: [], transitions: [] }, actions: [] },
      statistics: {
        physicalActions: 1,
        focusStates: 1,
        screenStates: 1,
        elapsedMs: 50,
        restorationAttempts: 2,
        restorationSuccesses: 0,
        restorationFailures: 2,
      },
      restorationDiagnostics: [{
        attemptNumber: 1,
        retryNumber: 0,
        restorationCycleNumber: 1,
        successfulRestorationsBeforeAttempt: 0,
        traversalDepth: 1,
        destinationStateId: "focus-0001",
        strategy: "verified-local-path",
        status: "failed",
        elapsedMs: 20,
        actionHistory: ["RIGHT"],
        history: [],
        subtype: "timeout",
        rejectionReason: "settling-exhausted",
      }, {
        attemptNumber: 2,
        retryNumber: 0,
        restorationCycleNumber: 2,
        successfulRestorationsBeforeAttempt: 0,
        traversalDepth: 2,
        destinationStateId: "focus-0002",
        strategy: "root-replay",
        status: "failed",
        elapsedMs: 21,
        actionHistory: ["RIGHT"],
        history: [],
        subtype: "strategy-exhausted",
        rejectionReason: "action-budget-exhausted",
      }],
    } as never;

    const evidence = buildAndroidExplorationEvidence(base, "org.example.tv", null, null, "taxonomy-test") as never as {
      restorationDiagnostics: readonly { failureClass: string; taxonomyCategory: string }[];
    };
    expect(evidence.restorationDiagnostics).toEqual([
      expect.objectContaining({
        failureClass: "restoration-timeout",
        taxonomyCategory: "asynchronous-ui-timing-or-timeout",
      }),
      expect.objectContaining({
        failureClass: "restoration-strategy-exhausted",
        taxonomyCategory: "strategy-exhausted",
      }),
    ]);
  });

  it("reports observed structural impact, lifecycle recovery, and incomplete retained-diagnostic aggregates conservatively", () => {
    const shared = {
      capturedAt: "2026-09-19T10:00:00.000Z",
      stateFingerprint: "state-a",
      screenFingerprint: "screen-a",
      focusFingerprint: "focus-a",
      focusIdentity: "focus-a",
      focusedStableId: "play",
      location: "android://org.example.tv/org.example.tv.MainActivity",
      applicationId: "org.example.tv",
      processId: 100,
      processGeneration: 1,
      activity: "org.example.tv.MainActivity",
      rootIdentity: "window-1",
      windowId: 1,
      windowGeneration: 1,
      actionableNodeFingerprint: "actionable-a",
      navigationStructureFingerprint: "navigation-a",
      visibleStructureFingerprint: "visible-a",
    } as const;
    const result = {
      termination: { reason: "replay-diverged", complete: false },
      budgets: { maxActions: 100, maxStates: 100, maxDepth: 8, maxDurationMs: 60_000 },
      actionOrder: ["RIGHT"],
      graph: { screens: { states: [], transitions: [] }, focus: { states: [], transitions: [] }, actions: [] },
      statistics: {
        physicalActions: 4,
        focusStates: 2,
        screenStates: 2,
        elapsedMs: 100,
        restorationAttempts: 65,
        restorationSuccesses: 1,
        restorationFailures: 64,
      },
      restorationDiagnostics: [{
        attemptNumber: 1,
        retryNumber: 0,
        restorationCycleNumber: 1,
        successfulRestorationsBeforeAttempt: 0,
        traversalDepth: 2,
        destinationStateId: "focus-0001",
        strategy: "root-replay",
        status: "failed",
        elapsedMs: 30,
        actionHistory: ["RIGHT"],
        expected: shared,
        after: {
          ...shared,
          capturedAt: "2026-09-19T10:00:01.000Z",
          stateFingerprint: "state-b",
          screenFingerprint: "screen-b",
          actionableNodeFingerprint: "actionable-b",
          navigationStructureFingerprint: "navigation-b",
        },
        history: [],
        subtype: "navigation-diverged",
        rejectionReason: "replay-checkpoint-diverged",
      }, {
        attemptNumber: 2,
        retryNumber: 0,
        restorationCycleNumber: 2,
        successfulRestorationsBeforeAttempt: 0,
        traversalDepth: 3,
        destinationStateId: "focus-0002",
        strategy: "root-replay",
        status: "success",
        elapsedMs: 31,
        actionHistory: ["RIGHT"],
        expected: shared,
        after: {
          ...shared,
          capturedAt: "2026-09-19T10:00:02.000Z",
          processId: 101,
          processGeneration: 2,
          rootIdentity: "window-2",
          windowId: 2,
          windowGeneration: 2,
        },
        history: [],
      }],
    };

    const evidence = buildAndroidExplorationEvidence(result as never, "org.example.tv", null, null, "contract-test") as never as {
      restorationDiagnostics: readonly Record<string, unknown>[];
      restorationResilience: Record<string, unknown> & {
        recoveryAfterProcessReplacement: { successes: number };
        recoveryAfterRootOrWindowReplacement: { successes: number };
        byStrategyAttemptOrdinal: Record<string, { attempts: number; successes: number; failures: number }>;
        byRetryOrdinal: Record<string, { attempts: number; successes: number; failures: number }>;
        byStrategy: Record<string, { attempts: number; successes: number; failures: number }>;
      };
    };
    expect(evidence.restorationDiagnostics[0]).toMatchObject({
      structuralDiagnosticDifferences: expect.arrayContaining([
        "actionableNodeFingerprint",
        "navigationStructureFingerprint",
      ]),
      observedNavigationSurfaceEquivalent: false,
      behaviorallyEquivalent: false,
      traversalWouldMateriallyDiffer: true,
      reachabilityFingerprint: null,
      reachabilityEvidenceStatus: "not-observable-from-a-single-restored-snapshot",
      taxonomyCategory: "structurally-meaningful-divergence",
    });
    expect(evidence.restorationDiagnostics[1]).toMatchObject({
      processRestarted: true,
      behaviorallyEquivalent: true,
      traversalWouldMateriallyDiffer: null,
    });
    expect(evidence.restorationResilience).toMatchObject({
      retainedDiagnosticAttempts: 2,
      diagnosticsComplete: false,
      metricsDerivedFromRetainedDiagnosticsAreComplete: false,
      recoveryAfterProcessReplacement: { successes: 1 },
      recoveryAfterRootOrWindowReplacement: { successes: 1 },
      byStrategyAttemptOrdinal: {
        first: { attempts: 2, successes: 1, failures: 1 },
        second: { attempts: 0, successes: 0, failures: 0 },
        thirdAndLater: { attempts: 0, successes: 0, failures: 0 },
      },
      byRetryOrdinal: {
        first: { attempts: 2, successes: 1, failures: 1 },
        second: { attempts: 0, successes: 0, failures: 0 },
        thirdAndLater: { attempts: 0, successes: 0, failures: 0 },
      },
      byStrategy: {
        "root-replay": { attempts: 2, successes: 1, failures: 1 },
      },
    });

    const largeState = {
      ...shared,
      focusedPath: Array.from({ length: 16 }, (_, index) => `ancestor-${String(index)}`),
      stableIdentifiers: Array.from({ length: 32 }, (_, index) => `stable-${String(index)}`),
    };
    const largeResult = {
      ...result,
      statistics: {
        ...result.statistics,
        restorationAttempts: 64,
        restorationSuccesses: 48,
        restorationFailures: 16,
      },
      restorationDiagnostics: Array.from({ length: 64 }, (_, index) => ({
        attemptNumber: index + 1,
        retryNumber: index % 3,
        restorationCycleNumber: index + 1,
        successfulRestorationsBeforeAttempt: Math.max(0, index - Math.floor(index / 4)),
        traversalDepth: index % 8,
        destinationStateId: `focus-${String(index)}`,
        strategy: index % 2 === 0 ? "root-replay" : "verified-local-path",
        status: index % 4 === 0 ? "failed" : "success",
        elapsedMs: 30 + index,
        actionHistory: ["DOWN", "SELECT"],
        before: largeState,
        expected: largeState,
        after: { ...largeState, processGeneration: index + 2, windowGeneration: index + 2 },
        history: Array.from({ length: 16 }, () => largeState),
        ...(index % 4 === 0 ? {
          subtype: "navigation-diverged",
          rejectionReason: "replay-checkpoint-diverged",
        } : {}),
      })),
    } as never;
    expect(() => sanitiseEvidenceJson(buildAndroidExplorationEvidence(
      largeResult,
      "org.example.tv",
      null,
      null,
      "large-diagnostics-contract",
    ))).not.toThrow();
  });

  it("does not claim verified-local process continuity from cached launch metadata", () => {
    const cachedProcessState = {
      capturedAt: "2026-09-19T10:00:00.000Z",
      stateFingerprint: "state-a",
      screenFingerprint: "screen-a",
      focusFingerprint: "focus-a",
      focusIdentity: "focus-a",
      location: "android://org.example.tv/org.example.tv.MainActivity",
      applicationId: "org.example.tv",
      processId: 100,
      processGeneration: 1,
      processIdentitySource: "last-launch-or-reset-metadata",
    } as const;
    const result = {
      termination: { reason: "frontier-exhausted", complete: true },
      budgets: { maxActions: 10, maxStates: 10, maxDepth: 4, maxDurationMs: 60_000 },
      actionOrder: ["RIGHT"],
      graph: { screens: { states: [], transitions: [] }, focus: { states: [], transitions: [] }, actions: [] },
      statistics: {
        physicalActions: 1,
        focusStates: 1,
        screenStates: 1,
        elapsedMs: 20,
        restorationAttempts: 1,
        restorationSuccesses: 1,
        restorationFailures: 0,
      },
      restorationDiagnostics: [{
        attemptNumber: 1,
        retryNumber: 0,
        restorationCycleNumber: 1,
        successfulRestorationsBeforeAttempt: 0,
        traversalDepth: 1,
        destinationStateId: "focus-0001",
        strategy: "verified-local-path",
        status: "success",
        elapsedMs: 10,
        actionHistory: ["RIGHT"],
        before: cachedProcessState,
        after: { ...cachedProcessState, capturedAt: "2026-09-19T10:00:01.000Z" },
        expected: cachedProcessState,
        history: [],
      }],
    } as never;

    const evidence = buildAndroidExplorationEvidence(result, "org.example.tv", null, null, "cached-process-test") as never as {
      restorationDiagnostics: readonly { processRestarted: boolean | null }[];
      restorationResilience: { recoveryAfterProcessReplacement: { successes: number; status: string } };
    };
    expect(evidence.restorationDiagnostics[0]?.processRestarted).toBeNull();
    expect(evidence.restorationResilience.recoveryAfterProcessReplacement).toEqual({
      successes: 0,
      status: "partial-cached-process-identity",
    });
  });
});

function snapshotAtForRestorationEvidence(location: string): StateSnapshot {
  return {
    capturedAt: "2026-09-19T10:00:00.000Z",
    location: { status: "available", value: location },
    focusedElement: { status: "available", value: null },
    uiTree: { status: "available", value: [] },
  } as StateSnapshot;
}

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
