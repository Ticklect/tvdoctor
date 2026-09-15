import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AndroidTvDriver,
  type AdbCommandExecutor,
  type AdbCommandResult,
  type AndroidObserverConnection,
  type ObserverRequestPayload,
  type ObserverResponse,
} from "../src/index.js";

const TOKEN = "a".repeat(64);
const OBSERVER_APK = Buffer.from("packaged-tvdoctor-observer");
const OBSERVER_SHA256 = createHash("sha256").update(OBSERVER_APK).digest("hex");
const NODE = {
  stableId: "org.example.tv:id/play",
  role: "button",
  name: "Play",
  text: "Play",
  bounds: { x: 10, y: 20, width: 200, height: 80 },
  visible: true,
  enabled: true,
  focusable: true,
  focused: true,
  modal: null,
  selectionState: null,
  valueNow: null,
  className: "android.widget.Button",
  packageName: "org.example.tv",
  clickable: true,
  scrollable: false,
  selected: false,
  children: [],
} as const;

function targetState(full: boolean, sequence = 1) {
  return {
    sequence,
    timestampMs: Date.now(),
    packageName: "org.example.tv",
    windowClassName: "org.example.tv.MainActivity",
    windowId: 1,
    focused: { stableId: NODE.stableId, role: NODE.role, name: NODE.name, bounds: NODE.bounds },
    structureFingerprint: "a".repeat(64),
    stateFingerprint: "b".repeat(64),
    treeChanged: full,
    ...(full ? { nodes: [NODE] } : {}),
    nodeCount: 1,
    maxDepth: 0,
  };
}

function externalState(leak = false, sequence = 2) {
  return {
    sequence,
    timestampMs: Date.now(),
    packageName: "com.google.android.tvlauncher",
    windowClassName: "com.google.android.tvlauncher.MainActivity",
    windowId: 8,
    focused: leak ? { stableId: NODE.stableId, role: NODE.role, name: NODE.name, bounds: NODE.bounds } : null,
    structureFingerprint: "0".repeat(64),
    stateFingerprint: "c".repeat(64),
    treeChanged: true,
    ...(leak ? { nodes: [NODE] } : { nodes: [] }),
    nodeCount: leak ? 1 : 0,
    maxDepth: 0,
  };
}

function png1x1(): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0);
  Buffer.from("IHDR", "ascii").copy(buffer, 12);
  buffer.writeUInt32BE(1, 16);
  buffer.writeUInt32BE(1, 20);
  return buffer;
}

class FakeExecutor implements AdbCommandExecutor {
  readonly calls: string[][] = [];
  focusedPackage = "org.example.tv/org.example.tv.MainActivity";
  switchFocusAfterKeyevent: string | null = null;
  switchFocusAfterScreencap: string | null = null;

  async execute(arguments_: readonly string[]): Promise<AdbCommandResult> {
    const call = [...arguments_];
    this.calls.push(call);
    const joined = call.join(" ");
    let stdout: string | Uint8Array = "";
    if (joined.includes("install -r D:/packaged/tvdoctor-observer.apk")) stdout = "Success";
    else if (joined.includes("shell pm path org.tvdoctor.observer")) stdout = "package:/data/app/org.tvdoctor.observer/base.apk";
    else if (joined.includes("exec-out cat /data/app/org.tvdoctor.observer/base.apk")) stdout = OBSERVER_APK;
    else if (joined.includes("content call") && joined.includes("org.tvdoctor.observer.provisioning")) stdout = "Bundle[{result=provisioned}]";
    else if (joined.includes("settings get secure accessibility_enabled")) stdout = "1";
    else if (joined.includes("settings get secure enabled_accessibility_services")) stdout = "org.tvdoctor.observer/.ObserverAccessibilityService";
    else if (joined.includes("forward tcp:0")) stdout = "45678";
    else if (joined.includes("shell date +%s.%3N")) stdout = "1788537600.000";
    else if (joined.includes("ro.product.manufacturer")) stdout = "Google";
    else if (joined.includes("ro.product.model")) stdout = "sdk_google_atv64_x86_64";
    else if (joined.includes("ro.build.version.sdk")) stdout = "36";
    else if (joined.includes("ro.build.version.release")) stdout = "16";
    else if (joined.includes("ro.build.fingerprint")) stdout = "google/tv/atv";
    else if (joined.includes("ro.build.characteristics")) stdout = "tv";
    else if (joined.includes("ro.product.cpu.abilist")) stdout = "x86_64";
    else if (joined.includes("wm size")) stdout = "Physical size: 1920x1080";
    else if (joined.includes("dumpsys window")) stdout = `mCurrentFocus=Window{123 u0 ${this.focusedPackage}}`;
    else if (joined.includes("pidof -s org.example.tv")) stdout = "321";
    else if (joined.includes("dumpsys package org.example.tv")) stdout = "versionName=1.2.3 versionCode=7";
    else if (joined.includes("input keyevent")) {
      if (this.switchFocusAfterKeyevent !== null) this.focusedPackage = this.switchFocusAfterKeyevent;
    } else if (joined.includes("exec-out screencap -p")) {
      stdout = png1x1();
      if (this.switchFocusAfterScreencap !== null) this.focusedPackage = this.switchFocusAfterScreencap;
    }
    return { stdout: typeof stdout === "string" ? Buffer.from(stdout) : stdout, stderr: "", exitCode: 0 };
  }
}

class BoundaryObserver implements AndroidObserverConnection {
  readonly requests: ObserverRequestPayload[] = [];
  mode: "target" | "external" | "leaky" = "target";
  crossOnSettle = false;
  sequence = 1;

  async request(request: ObserverRequestPayload): Promise<ObserverResponse> {
    this.requests.push(request);
    if (request.type === "begin_action") {
      return { version: 2, id: 1, ok: true, type: "begin_action", actionId: 91, baselineSequence: this.sequence };
    }
    if (request.type === "settle_action") {
      this.sequence += 1;
      const cross = this.crossOnSettle || this.mode !== "target";
      return {
        version: 2,
        id: 2,
        ok: true,
        type: "settle_action",
        state: cross ? externalState(this.mode === "leaky", this.sequence) : targetState(false, this.sequence),
        timing: { eventLatencyMs: 10, snapshotGenerationMs: 2, settlingMs: 20, eventsObserved: 1, noOpConfirmed: false },
      };
    }
    if (this.mode === "external") return { version: 2, id: 3, ok: true, type: request.type, state: externalState(false, this.sequence) };
    if (this.mode === "leaky") return { version: 2, id: 3, ok: true, type: request.type, state: externalState(true, this.sequence) };
    const forceFull = request.type === "current_state" && request.forceFull === true;
    return { version: 2, id: 3, ok: true, type: request.type, state: targetState(request.type === "resync" || forceFull, this.sequence) };
  }

  close(): void {}
}

function createDriver(executor: FakeExecutor, observer: BoundaryObserver): AndroidTvDriver {
  return new AndroidTvDriver({
    serial: "emulator-5554",
    executor,
    tokenFactory: () => TOKEN,
    observerAsset: {
      apkPath: "D:/packaged/tvdoctor-observer.apk",
      packageName: "org.tvdoctor.observer",
      versionName: "0.1.0",
      protocolVersion: 2,
      sha256: OBSERVER_SHA256,
      certificateSha256: "d".repeat(64),
    },
    createObserverClient: async () => observer,
    settleTimeoutMs: 50,
    quietWindowMs: 5,
    noResponseGraceMs: 10,
    resetStableWindowMs: 10,
    resetSettleTimeoutMs: 50,
  });
}

async function launchedDriver() {
  const executor = new FakeExecutor();
  const observer = new BoundaryObserver();
  const driver = createDriver(executor, observer);
  await driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" });
  return { driver, executor, observer };
}

describe("Android foreground integrity regressions", () => {
  it("corrects a masked observer target identity when another package owns the focused window", async () => {
    const { driver, executor } = await launchedDriver();
    executor.focusedPackage = "com.google.android.tvlauncher/com.google.android.tvlauncher.MainActivity";
    const snapshot = await driver.snapshot();
    expect(snapshot.location).toMatchObject({ status: "available", value: expect.stringContaining("com.google.android.tvlauncher") });
    expect(snapshot.uiTree).toEqual({ status: "available", value: [] });
    expect(snapshot.focusedElement).toEqual({ status: "available", value: null });
    await driver.close();
  });

  it("records a redacted external boundary without exposing foreign content", async () => {
    const { driver, executor, observer } = await launchedDriver();
    executor.focusedPackage = "com.google.android.tvlauncher/com.google.android.tvlauncher.MainActivity";
    observer.mode = "external";
    const snapshot = await driver.snapshot();
    expect(snapshot.location).toMatchObject({ status: "available", value: expect.stringContaining("com.google.android.tvlauncher") });
    expect(snapshot.uiTree).toEqual({ status: "available", value: [] });
    expect(snapshot.focusedElement).toEqual({ status: "available", value: null });
    await driver.close();
  });

  it("rejects a foreign boundary that leaks accessibility content", async () => {
    const { driver, executor, observer } = await launchedDriver();
    executor.focusedPackage = "com.google.android.tvlauncher/com.google.android.tvlauncher.MainActivity";
    observer.mode = "leaky";
    await expect(driver.snapshot()).rejects.toThrow(/foreign UI content|outside.*target/u);
    await driver.close();
  });

  it("blocks a normal key before dispatch when the target no longer owns focus", async () => {
    const { driver, executor } = await launchedDriver();
    executor.focusedPackage = "com.google.android.tvlauncher/com.google.android.tvlauncher.MainActivity";
    const before = executor.calls.filter((call) => call.join(" ").includes("input keyevent")).length;
    const result = await driver.press("RIGHT");
    const after = executor.calls.filter((call) => call.join(" ").includes("input keyevent")).length;
    expect(result.outcome).toBe("failed");
    expect(after).toBe(before);
    expect(result.message).toMatch(/focused window|foreground|target/u);
    await driver.close();
  });

  it("records an action that crosses into an external boundary after input", async () => {
    const { driver, executor, observer } = await launchedDriver();
    observer.crossOnSettle = true;
    executor.switchFocusAfterKeyevent = "com.google.android.tvlauncher/com.google.android.tvlauncher.MainActivity";
    const result = await driver.press("RIGHT");
    expect(result.outcome).toBe("applied");
    expect(result.postActionSnapshot?.location).toMatchObject({ status: "available", value: expect.stringContaining("com.google.android.tvlauncher") });
    expect(result.postActionSnapshot?.uiTree).toEqual({ status: "available", value: [] });
    await driver.close();
  });

  it("requires a fresh full tree after target to foreign to target cache invalidation", async () => {
    const { driver, executor, observer } = await launchedDriver();
    await driver.snapshot();
    executor.focusedPackage = "com.google.android.tvlauncher/com.google.android.tvlauncher.MainActivity";
    observer.mode = "external";
    await driver.snapshot();
    executor.focusedPackage = "org.example.tv/org.example.tv.MainActivity";
    observer.mode = "target";
    const requestCount = observer.requests.length;
    await driver.snapshot();
    const returnRequest = observer.requests.slice(requestCount).find((request) => request.type === "current_state");
    expect(returnRequest).toMatchObject({ type: "current_state", forceFull: true });
    await driver.close();
  });

  it("permits setup input only for the exact system setup allowlist", async () => {
    const { driver, executor } = await launchedDriver();
    const setupDriver = driver as AndroidTvDriver & {
      pressSystemSetup(key: "SELECT" | "BACK"): Promise<{ outcome: string }>;
    };
    executor.focusedPackage = "com.google.android.permissioncontroller/com.android.permissioncontroller.permission.ui.GrantPermissionsActivity";
    await expect(setupDriver.pressSystemSetup("SELECT")).resolves.toMatchObject({ outcome: "applied" });
    executor.focusedPackage = "com.evil.permissioncontroller.fake/com.evil.permissioncontroller.fake.MainActivity";
    const before = executor.calls.filter((call) => call.join(" ").includes("input keyevent")).length;
    await expect(setupDriver.pressSystemSetup("SELECT")).resolves.toMatchObject({ outcome: "failed" });
    const after = executor.calls.filter((call) => call.join(" ").includes("input keyevent")).length;
    expect(after).toBe(before);
    await driver.close();
  });

  it("does not write a screenshot if focus leaves the target during screencap", async () => {
    const { driver, executor } = await launchedDriver();
    const directory = await mkdtemp(join(tmpdir(), "tvdoctor-foreground-"));
    const artifactPath = join(directory, "frame.png");
    try {
      executor.switchFocusAfterScreencap = "com.google.android.tvlauncher/com.google.android.tvlauncher.MainActivity";
      await expect(driver.captureScreenshot(artifactPath)).rejects.toThrow(/focused window|foreground|target/u);
      await expect(access(artifactPath)).rejects.toThrow();
    } finally {
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});