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

function state(full: boolean, sequence = 1) {
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

class FakeExecutor implements AdbCommandExecutor {
  readonly calls: string[][] = [];
  enabled = true;
  focusAfterLaunchAttempt = 1;
  launchAttempts = 0;

  async execute(arguments_: readonly string[]): Promise<AdbCommandResult> {
    const call = [...arguments_];
    this.calls.push(call);
    const joined = call.join(" ");
    if (joined.includes("am start -W") && joined.includes("org.example.tv/.MainActivity")) {
      this.launchAttempts += 1;
    }
    let stdout = "";
    if (joined.includes("dumpsys package org.tvdoctor.observer")) stdout = "versionName=0.1.0";
    else if (joined.includes("settings get secure accessibility_enabled")) stdout = this.enabled ? "1" : "0";
    else if (joined.includes("settings get secure enabled_accessibility_services")) {
      stdout = this.enabled ? "org.tvdoctor.observer/.ObserverAccessibilityService" : "null";
    } else if (joined.includes("forward tcp:0")) stdout = "45678";
    else if (joined.includes("ro.product.manufacturer")) stdout = "Google";
    else if (joined.includes("ro.product.model")) stdout = "sdk_google_atv64_x86_64";
    else if (joined.includes("ro.build.version.sdk")) stdout = "36";
    else if (joined.includes("ro.build.version.release")) stdout = "16";
    else if (joined.includes("ro.build.fingerprint")) stdout = "google/tv/atv";
    else if (joined.includes("ro.build.characteristics")) stdout = "tv";
    else if (joined.includes("ro.product.cpu.abilist")) stdout = "x86_64";
    else if (joined.includes("wm size")) stdout = "Physical size: 1920x1080";
    else if (joined.includes("dumpsys window")) {
      const focusedPackage = this.launchAttempts >= this.focusAfterLaunchAttempt
        ? "org.example.tv/org.example.tv.MainActivity"
        : "com.google.android.tvlauncher/com.google.android.tvlauncher.MainActivity";
      stdout = `mCurrentFocus=Window{1234567 u0 ${focusedPackage}}`;
    }
    else if (joined.includes("pidof -s org.example.tv")) stdout = "321";
    else if (joined.includes("dumpsys package org.example.tv")) stdout = "versionName=1.2.3 versionCode=7";
    return { stdout: Buffer.from(stdout), stderr: "", exitCode: 0 };
  }
}

class FakeObserver implements AndroidObserverConnection {
  readonly requests: ObserverRequestPayload[] = [];
  closed = false;
  currentSequence = 1;

  async request(request: ObserverRequestPayload): Promise<ObserverResponse> {
    this.requests.push(request);
    if (request.type === "begin_action") {
      return { version: 2, id: 1, ok: true, type: "begin_action", actionId: 91, baselineSequence: this.currentSequence };
    }
    if (request.type === "settle_action") {
      this.currentSequence += 1;
      return {
        version: 2,
        id: 2,
        ok: true,
        type: "settle_action",
        state: state(false, this.currentSequence),
        timing: { eventLatencyMs: 18, snapshotGenerationMs: 4, settlingMs: 105, eventsObserved: 2, noOpConfirmed: false },
      };
    }
    return { version: 2, id: 3, ok: true, type: request.type, state: state(true, this.currentSequence) };
  }

  close(): void { this.closed = true; }
}

class ChangingLaunchObserver extends FakeObserver {
  resyncCalls = 0;

  override async request(request: ObserverRequestPayload): Promise<ObserverResponse> {
    if (request.type !== "resync") return await super.request(request);
    this.requests.push(request);
    this.resyncCalls += 1;
    const fingerprint = this.resyncCalls === 1 ? "c".repeat(64) : "d".repeat(64);
    return {
      version: 2,
      id: 3,
      ok: true,
      type: "resync",
      state: { ...state(true, this.currentSequence), stateFingerprint: fingerprint },
    };
  }
}

class DepthBoundObserver extends FakeObserver {
  override async request(request: ObserverRequestPayload): Promise<ObserverResponse> {
    const response = await super.request(request);
    return response.state === undefined
      ? response
      : { ...response, state: { ...response.state, maxDepth: 64 } };
  }
}

function createDriver(executor: FakeExecutor, observer: FakeObserver): AndroidTvDriver {
  return new AndroidTvDriver({
    serial: "emulator-5554",
    executor,
    tokenFactory: () => TOKEN,
    observerAsset: {
      apkPath: "D:/packaged/tvdoctor-observer.apk",
      packageName: "org.tvdoctor.observer",
      versionName: "0.1.0",
      protocolVersion: 2,
      sha256: "c".repeat(64),
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

describe("Android V2 observer-backed driver", () => {
  it("uses persistent observations and never invokes UIAutomator in the normal action loop", async () => {
    const executor = new FakeExecutor();
    const observer = new FakeObserver();
    const driver = createDriver(executor, observer);
    await driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" });
    expect((await driver.getDeviceMetadata()).isTelevision).toBe(true);
    const action = await driver.press("RIGHT");
    expect(action.outcome).toBe("applied");
    expect(action.postActionSnapshot?.focusedElement.status).toBe("available");
    expect(action.timing.profile).toMatchObject({
      captureCount: 1,
      inputDispatchMs: expect.any(Number),
      observerEventLatencyMs: 18,
      snapshotGenerationMs: 4,
      settlingMs: 105,
      totalMs: expect.any(Number),
    });
    expect(executor.calls.filter((call) => call.join(" ").includes("input keyevent"))).toHaveLength(1);
    expect(executor.calls.some((call) => /uiautomator|hierarchy/iu.test(call.join(" ")))).toBe(false);
    expect(observer.requests.map((request) => request.type)).toContain("settle_action");
    await driver.close();
    expect(observer.closed).toBe(true);
    expect(executor.calls.some((call) => call.join(" ").includes("forward --remove tcp:45678"))).toBe(true);
  });

  it("maps explicit HOME and media controls to bounded Android key events", async () => {
    const executor = new FakeExecutor();
    const driver = createDriver(executor, new FakeObserver());
    await driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" });
    await driver.press("HOME");
    await driver.press("PLAY_PAUSE");
    await driver.press("FAST_FORWARD");
    const commands = executor.calls.map((call) => call.join(" "));
    expect(commands).toContain("-s emulator-5554 shell input keyevent --async KEYCODE_HOME");
    expect(commands).toContain("-s emulator-5554 shell input keyevent --async KEYCODE_MEDIA_PLAY_PAUSE");
    expect(commands).toContain("-s emulator-5554 shell input keyevent --async KEYCODE_MEDIA_FAST_FORWARD");
    await driver.close();
  });

  it("fails safely with actionable permission diagnostics", async () => {
    const executor = new FakeExecutor();
    executor.enabled = false;
    const driver = createDriver(executor, new FakeObserver());
    await expect(driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" })).rejects.toThrow(
      /Observer service: not enabled[\s\S]*Enable TVDoctor Observer accessibility access/u,
    );
    expect(executor.calls.some((call) => call.join(" ").includes("forward tcp:0"))).toBe(false);
    await driver.close();
  });

  it("resynchronizes the observer across reset boundaries", async () => {
    const executor = new FakeExecutor();
    const observer = new FakeObserver();
    const driver = createDriver(executor, observer);
    await driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" });
    await driver.reset("relaunch");
    expect(observer.requests.map((request) => request.type)).toContain("resync");
    expect(executor.calls.some((call) => call.join(" ").includes("am force-stop org.example.tv"))).toBe(true);
    expect(executor.calls.filter((call) => call.join(" ").includes(
      "am start -W -f 0x10008000 -n org.example.tv/.MainActivity",
    ))).toHaveLength(2);
    await driver.close();
  });

  it("waits through a changing launch tree until the canonical state remains stable", async () => {
    const executor = new FakeExecutor();
    const observer = new ChangingLaunchObserver();
    const driver = createDriver(executor, observer);
    await driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" });
    expect(observer.resyncCalls).toBeGreaterThanOrEqual(3);
    await driver.close();
  });

  it("relaunches when observer state is ready but Android has not focused the target window", async () => {
    const executor = new FakeExecutor();
    executor.focusAfterLaunchAttempt = 2;
    const driver = createDriver(executor, new FakeObserver());
    await driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" });
    expect(executor.calls.filter((call) => call.join(" ").includes(
      "am start -W -f 0x10008000 -n org.example.tv/.MainActivity",
    ))).toHaveLength(2);
    expect(executor.calls.some((call) => call.join(" ").includes("dumpsys window"))).toBe(true);
    await driver.close();
  });

  it("marks canonical hierarchy evidence truncated when an observer bound is reached", async () => {
    const driver = createDriver(new FakeExecutor(), new DepthBoundObserver());
    await driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" });
    const snapshot = await driver.snapshot();
    expect(snapshot.hierarchyMetadata).toMatchObject({
      status: "available",
      value: { maxDepth: 64, truncated: true },
    });
    await driver.close();
  });
});
