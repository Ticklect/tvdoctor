import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  AndroidTvDriver,
  MAX_MEDIA_SESSION_DUMP_BYTES,
  MAX_SCREENSHOT_PNG_BYTES,
  type AdbCommandOptions,
  type AdbCommandExecutor,
  type AdbCommandResult,
  type AndroidObserverAsset,
  type AndroidObserverConnection,
  type ObserverRequestPayload,
  type ObserverResponse,
} from "../src/index.js";

const TOKEN = "a".repeat(64);
const OBSERVER_APK = Buffer.from("packaged-tvdoctor-observer");
const OBSERVER_SHA256 = createHash("sha256").update(OBSERVER_APK).digest("hex");

function screenshotPng(red: number, green: number, blue: number): Buffer {
  const uint32 = (value: number): Buffer => {
    const result = Buffer.alloc(4);
    result.writeUInt32BE(value);
    return result;
  };
  const chunk = (type: string, body: Uint8Array): Buffer => Buffer.concat([
    uint32(body.byteLength), Buffer.from(type, "ascii"), Buffer.from(body), Buffer.alloc(4),
  ]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, red, green, blue]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
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
    targetWindowActive: true,
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
  readonly options: (AdbCommandOptions | undefined)[] = [];
  enabled = true;
  focusAfterLaunchAttempt = 1;
  focusedPackageOverride: string | null = null;
  launchAttempts = 0;
  deviceState = "device";
  bootCompleted = "1";
  installedApk = OBSERVER_APK;
  appPid = "321";
  mediaSessionResult: AdbCommandResult | null = null;
  screenshotResult: AdbCommandResult | null = null;
  focusedPackageAfterScreenshot: string | null = null;
  logcat = [
    "1788537600.100 321 7 I Target: target message",
    "1788537600.200 999 8 W Other: unrelated message",
  ].join("\n");

  async execute(arguments_: readonly string[], options?: AdbCommandOptions): Promise<AdbCommandResult> {
    const call = [...arguments_];
    this.calls.push(call);
    this.options.push(options);
    const joined = call.join(" ");
    if (joined.includes("am start -W") && joined.includes("org.example.tv/.MainActivity")) {
      this.launchAttempts += 1;
    }
    if (joined.includes("dumpsys media_session") && this.mediaSessionResult !== null) {
      return this.mediaSessionResult;
    }
    if (joined.includes("exec-out screencap -p") && this.screenshotResult !== null) {
      const result = this.screenshotResult;
      if (this.focusedPackageAfterScreenshot !== null) {
        this.focusedPackageOverride = this.focusedPackageAfterScreenshot;
      }
      return result;
    }
    let stdout: string | Uint8Array = "";
    if (joined.includes("install -r D:/packaged/tvdoctor-observer.apk")) stdout = "Success";
    else if (joined.includes("shell pm path org.tvdoctor.observer")) {
      stdout = "package:/data/app/org.tvdoctor.observer/base.apk";
    } else if (joined.includes("exec-out cat /data/app/org.tvdoctor.observer/base.apk")) {
      stdout = this.installedApk;
    } else if (joined.includes("content call") && joined.includes("org.tvdoctor.observer.provisioning")) {
      stdout = "Bundle[{result=provisioned}]";
    } else if (joined.endsWith(" get-state")) stdout = this.deviceState;
    else if (joined.includes("shell date +%s.%3N")) stdout = "1788537600.000";
    else if (joined.includes("getprop sys.boot_completed")) stdout = this.bootCompleted;
    else if (joined.includes("dumpsys package org.tvdoctor.observer")) stdout = "versionName=0.1.0";
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
      const packageName = this.focusedPackageOverride
        ?? (this.launchAttempts >= this.focusAfterLaunchAttempt
          ? "org.example.tv"
          : "com.google.android.tvlauncher");
      stdout = `mCurrentFocus=Window{1234567 u0 ${packageName}/${packageName}.MainActivity}`;
    }
    else if (joined.includes("pidof -s org.example.tv")) stdout = this.appPid;
    else if (joined.includes("dumpsys package org.example.tv")) stdout = "versionName=1.2.3 versionCode=7";
    else if (joined.includes(" logcat ")) stdout = this.logcat;
    return { stdout: typeof stdout === "string" ? Buffer.from(stdout) : stdout, stderr: "", exitCode: 0 };
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

class MutableWindowObserver extends FakeObserver {
  windowId = 1;

  override async request(request: ObserverRequestPayload): Promise<ObserverResponse> {
    const response = await super.request(request);
    return response.state === undefined
      ? response
      : { ...response, state: { ...response.state, windowId: this.windowId } };
  }
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

class AlternatingLaunchObserver extends FakeObserver {
  resyncCalls = 0;

  override async request(request: ObserverRequestPayload): Promise<ObserverResponse> {
    if (request.type !== "resync") return await super.request(request);
    this.requests.push(request);
    this.resyncCalls += 1;
    return {
      version: 2,
      id: 3,
      ok: true,
      type: "resync",
      state: {
        ...state(true, this.currentSequence),
        stateFingerprint: (this.resyncCalls % 2 === 0 ? "e" : "f").repeat(64),
      },
    };
  }
}

class GatedObserver extends FakeObserver {
  gateType: "begin_action" | "current_state" | null = null;
  gateStarted: (() => void) | null = null;
  releaseGate: (() => void) | null = null;

  override async request(request: ObserverRequestPayload): Promise<ObserverResponse> {
    if (request.type === this.gateType) {
      this.gateType = null;
      this.gateStarted?.();
      await new Promise<void>((resolve) => { this.releaseGate = resolve; });
    }
    return await super.request(request);
  }
}

class AbortAwareObserver extends FakeObserver {
  beginStarted: (() => void) | null = null;
  beginSignal: AbortSignal | undefined;

  override async request(
    request: ObserverRequestPayload,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ObserverResponse> {
    if (request.type !== "begin_action") return await super.request(request);
    this.beginSignal = options?.signal;
    this.beginStarted?.();
    if (options?.signal === undefined) return await super.request(request);
    await new Promise<void>((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
    });
    return await super.request(request);
  }
}

class CrossPackageObserver extends FakeObserver {
  escape = false;
  override async request(request: ObserverRequestPayload): Promise<ObserverResponse> {
    const result = await super.request(request);
    return this.escape && result.state !== undefined
      ? {
          ...result,
          state: {
            ...result.state,
            packageName: "org.other.private",
            windowClassName: "org.other.private.ExternalActivity",
            windowId: 8,
            focused: null,
            nodes: [],
            nodeCount: 0,
            maxDepth: 0,
            structureFingerprint: "c".repeat(64),
            stateFingerprint: "d".repeat(64),
          },
        }
      : result;
  }
}

class LeakyCrossPackageObserver extends CrossPackageObserver {
  override async request(request: ObserverRequestPayload): Promise<ObserverResponse> {
    const result = await super.request(request);
    return this.escape && result.state !== undefined
      ? { ...result, state: { ...result.state, nodes: [NODE], nodeCount: 1 } }
      : result;
  }
}

class PermissionBoundaryObserver extends FakeObserver {
  readonly #executor: FakeExecutor;
  escaped = false;

  constructor(executor: FakeExecutor) {
    super();
    this.#executor = executor;
  }

  override async request(request: ObserverRequestPayload): Promise<ObserverResponse> {
    const result = await super.request(request);
    if (request.type === "resync") {
      this.escaped = true;
      this.#executor.focusedPackageOverride = "com.google.android.permissioncontroller";
    }
    if (!this.escaped || result.state === undefined) return result;
    return {
      ...result,
      state: {
        ...result.state,
        packageName: "com.google.android.permissioncontroller",
        windowClassName: "com.android.permissioncontroller.permission.ui.GrantPermissionsActivity",
        windowId: 9,
        focused: null,
        nodes: [],
        nodeCount: 0,
        maxDepth: 0,
        structureFingerprint: "e".repeat(64),
        stateFingerprint: "f".repeat(64),
      },
    };
  }
}

class ForceStopTimeoutExecutor extends FakeExecutor {
  stoppedAfterTimeout = true;

  override async execute(arguments_: readonly string[]): Promise<AdbCommandResult> {
    const joined = arguments_.join(" ");
    if (joined.includes("shell am force-stop org.example.tv")) {
      this.calls.push([...arguments_]);
      if (this.stoppedAfterTimeout) this.appPid = "";
      throw new Error("ADB command timed out after 15000 ms");
    }
    return await super.execute(arguments_);
  }
}

class ObserverSignatureMismatchExecutor extends FakeExecutor {
  installAttempts = 0;

  override async execute(arguments_: readonly string[]): Promise<AdbCommandResult> {
    const joined = arguments_.join(" ");
    if (joined.includes("install -r D:/packaged/tvdoctor-observer.apk")) {
      this.installAttempts += 1;
      if (this.installAttempts === 1) {
        this.calls.push([...arguments_]);
        throw new Error(
          "ADB command failed (1): -s emulator-5554 install -r D:/packaged/tvdoctor-observer.apk — adb: failed to install D:/packaged/tvdoctor-observer.apk: Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package org.tvdoctor.observer signatures do not match newer version; ignoring!]",
        );
      }
    }
    return await super.execute(arguments_);
  }
}

class ObserverInstallFailureExecutor extends FakeExecutor {
  readonly apkPath: string;
  readonly failure: string;

  constructor(apkPath: string, failure: string) {
    super();
    this.apkPath = apkPath;
    this.failure = failure;
  }

  override async execute(arguments_: readonly string[]): Promise<AdbCommandResult> {
    const joined = arguments_.join(" ");
    if (joined.includes(`install -r ${this.apkPath}`)) {
      this.calls.push([...arguments_]);
      throw new Error(this.failure);
    }
    return await super.execute(arguments_);
  }
}

function createDriver(
  executor: FakeExecutor,
  observer: FakeObserver,
  observerAsset: AndroidObserverAsset = {
    apkPath: "D:/packaged/tvdoctor-observer.apk",
    packageName: "org.tvdoctor.observer",
    versionName: "0.1.0",
    protocolVersion: 2,
    sha256: OBSERVER_SHA256,
    certificateSha256: "d".repeat(64),
  },
): AndroidTvDriver {
  return new AndroidTvDriver({
    serial: "emulator-5554",
    executor,
    tokenFactory: () => TOKEN,
    observerAsset,
    createObserverClient: async () => observer,
    settleTimeoutMs: 50,
    quietWindowMs: 5,
    noResponseGraceMs: 10,
    resetStableWindowMs: 10,
    resetSettleTimeoutMs: 250,
  });
}

describe("Android V2 observer-backed driver", () => {
  it("records a redacted cross-package boundary without exposing foreign UI content", async () => {
    const observer = new CrossPackageObserver();
    const driver = createDriver(new FakeExecutor(), observer);
    await driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" });
    observer.escape = true;
    await expect(driver.snapshot()).resolves.toMatchObject({
      location: { status: "available", value: "android://org.other.private/org.other.private.ExternalActivity" },
      focusedElement: { status: "available", value: null },
      uiTree: { status: "available", value: [] },
    });
    await driver.close();
  });

  it("rejects a cross-package observer state that leaks foreign UI content", async () => {
    const observer = new LeakyCrossPackageObserver();
    const driver = createDriver(new FakeExecutor(), observer);
    await driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" });
    observer.escape = true;
    await expect(driver.snapshot()).rejects.toThrow(/outside.*target.*content|foreign.*content/iu);
    await driver.close();
  });

  it("refuses to send a remote key when the target is no longer the focused window", async () => {
    const executor = new FakeExecutor();
    const driver = createDriver(executor, new FakeObserver());
    await driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" });
    executor.focusedPackageOverride = "com.google.android.tvlauncher";

    await expect(driver.press("RIGHT")).resolves.toMatchObject({ outcome: "failed" });
    expect(executor.calls.some((call) => call.join(" ").includes("input keyevent KEYCODE_DPAD_RIGHT"))).toBe(false);
    await driver.close();
  });

  it("records an action that crosses the target boundary after input", async () => {
    const executor = new FakeExecutor();
    const observer = new CrossPackageObserver();
    const driver = createDriver(executor, observer);
    await driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" });
    observer.escape = true;

    await expect(driver.press("RIGHT")).resolves.toMatchObject({
      outcome: "applied",
      postActionSnapshot: {
        location: { status: "available", value: "android://org.other.private/org.other.private.ExternalActivity" },
        uiTree: { status: "available", value: [] },
      },
    });
    await driver.close();
  });

  it("refuses to capture report evidence while another package owns the focused window", async () => {
    const executor = new FakeExecutor();
    const driver = createDriver(executor, new FakeObserver());
    await driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" });
    executor.focusedPackageOverride = "com.google.android.tvlauncher";

    await expect(driver.captureScreenshot("artifacts/external-window.png")).rejects.toThrow(/foreground|focused window/iu);
    expect(executor.calls.some((call) => call.join(" ").includes("exec-out screencap -p"))).toBe(false);
    await driver.close();
  });

  it("surfaces a redacted system-permission boundary during launch for startup policy", async () => {
    const executor = new FakeExecutor();
    const observer = new PermissionBoundaryObserver(executor);
    const driver = createDriver(executor, observer);

    await expect(driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" })).resolves.toBeUndefined();
    await expect(driver.snapshot()).resolves.toMatchObject({
      location: {
        status: "available",
        value: "android://com.google.android.permissioncontroller/com.android.permissioncontroller.permission.ui.GrantPermissionsActivity",
      },
      uiTree: { status: "available", value: [] },
    });
    await driver.close();
  });

  it("allows only the explicit setup-input path to operate on a permission-controller window", async () => {
    const executor = new FakeExecutor();
    const observer = new PermissionBoundaryObserver(executor);
    const driver = createDriver(executor, observer);
    await driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" });

    await expect(driver.pressSystemSetup("SELECT")).resolves.toMatchObject({ outcome: "applied" });
    expect(executor.calls.some((call) => call.join(" ").includes("input keyevent KEYCODE_DPAD_CENTER"))).toBe(true);
    await driver.close();
  });

  it("refuses the setup-input path when the foreground window is not a recognised setup package", async () => {
    const executor = new FakeExecutor();
    const driver = createDriver(executor, new FakeObserver());
    await driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" });
    executor.focusedPackageOverride = "com.evil.permissioncontroller.fake";

    await expect(driver.pressSystemSetup("BACK")).resolves.toMatchObject({ outcome: "failed" });
    expect(executor.calls.some((call) => call.join(" ").includes("input keyevent KEYCODE_BACK"))).toBe(false);
    await driver.close();
  });
  it("reinstalls and byte-verifies the exact packaged observer before provisioning", async () => {
    const executor = new FakeExecutor();
    const driver = createDriver(executor, new FakeObserver());

    await driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" });

    const commands = executor.calls.map((call) => call.join(" "));
    expect(commands).toContain("-s emulator-5554 install -r D:/packaged/tvdoctor-observer.apk");
    expect(commands).toContain("-s emulator-5554 shell pm path org.tvdoctor.observer");
    expect(commands).toContain("-s emulator-5554 exec-out cat /data/app/org.tvdoctor.observer/base.apk");
    await driver.close();
  });

  it("recovers a signature-incompatible update only for the packaged TVDoctor observer", async () => {
    const executor = new ObserverSignatureMismatchExecutor();
    const driver = createDriver(executor, new FakeObserver());

    await driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" });

    const commands = executor.calls.map((call) => call.join(" "));
    const replaceInstall = "-s emulator-5554 install -r D:/packaged/tvdoctor-observer.apk";
    const cleanInstall = "-s emulator-5554 install D:/packaged/tvdoctor-observer.apk";
    const uninstall = "-s emulator-5554 uninstall org.tvdoctor.observer";
    const installedPath = "-s emulator-5554 shell pm path org.tvdoctor.observer";
    const installedBytes = "-s emulator-5554 exec-out cat /data/app/org.tvdoctor.observer/base.apk";
    const provision = `-s emulator-5554 shell content call --uri content://org.tvdoctor.observer.provisioning --method provision --extra token:s:${TOKEN} --extra target_package:s:org.example.tv`;
    expect(commands.filter((command) => command === replaceInstall)).toHaveLength(1);
    expect(commands.filter((command) => command === cleanInstall)).toHaveLength(1);
    expect(commands.filter((command) => command === uninstall)).toHaveLength(1);
    expect(commands.indexOf(replaceInstall)).toBeLessThan(commands.indexOf(uninstall));
    expect(commands.indexOf(cleanInstall)).toBeGreaterThan(commands.indexOf(uninstall));
    expect(commands.indexOf(installedPath)).toBeGreaterThan(commands.indexOf(cleanInstall));
    expect(commands.indexOf(installedBytes)).toBeGreaterThan(commands.indexOf(installedPath));
    expect(commands.indexOf(provision)).toBeGreaterThan(commands.indexOf(installedBytes));
    expect(commands.some((command) => command.includes("uninstall org.example.tv"))).toBe(false);
    await driver.close();
  });

  it("does not uninstall packages for unrelated observer install failures", async () => {
    const apkPath = "D:/packaged/other-observer.apk";
    const executor = new ObserverInstallFailureExecutor(
      apkPath,
      "ADB command failed (1): INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package org.example.other signatures do not match newer version",
    );
    const driver = createDriver(executor, new FakeObserver(), {
      apkPath,
      packageName: "org.example.other",
      versionName: "0.1.0",
      protocolVersion: 2,
      sha256: OBSERVER_SHA256,
      certificateSha256: "d".repeat(64),
    });

    await expect(driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" }))
      .rejects.toThrow(/INSTALL_FAILED_UPDATE_INCOMPATIBLE/u);
    expect(executor.calls.some((call) => call.includes("uninstall"))).toBe(false);
    await driver.close();
  });

  it("does not uninstall the TVDoctor observer for arbitrary install failures", async () => {
    const apkPath = "D:/packaged/tvdoctor-observer.apk";
    const executor = new ObserverInstallFailureExecutor(
      apkPath,
      "ADB command failed (1): INSTALL_FAILED_INVALID_APK: Package is invalid",
    );
    const driver = createDriver(executor, new FakeObserver());

    await expect(driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" }))
      .rejects.toThrow(/INSTALL_FAILED_INVALID_APK/u);
    expect(executor.calls.some((call) => call.includes("uninstall"))).toBe(false);
    await driver.close();
  });

  it("provisions the session and target through the shell-only content provider", async () => {
    const executor = new FakeExecutor();
    const driver = createDriver(executor, new FakeObserver());

    await driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" });

    const commands = executor.calls.map((call) => call.join(" "));
    expect(commands).toContain(
      `-s emulator-5554 shell content call --uri content://org.tvdoctor.observer.provisioning --method provision --extra token:s:${TOKEN} --extra target_package:s:org.example.tv`,
    );
    expect(commands.some((command) => command.includes("SetupActivity") && command.includes(TOKEN))).toBe(false);
    await driver.close();
  });

  it("rejects an installed APK whose bytes differ before disclosing a provisioning token", async () => {
    const executor = new FakeExecutor();
    executor.installedApk = Buffer.from("another APK with the same version name");
    const driver = createDriver(executor, new FakeObserver());
    await expect(driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" }))
      .rejects.toThrow(/identity/u);
    expect(executor.calls.some((call) => call.some((part) => part.includes(TOKEN)))).toBe(false);
    await driver.close();
  });

  it("continues the operation queue after a rejected launch and can close", async () => {
    const driver = createDriver(new FakeExecutor(), new FakeObserver());
    await expect(driver.launch({ id: "invalid" })).rejects.toThrow(/package/u);
    await expect(driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" })).resolves.toBeUndefined();
    await expect(driver.reset("relaunch")).resolves.toBeUndefined();
    await expect(driver.close()).resolves.toBeUndefined();
  });

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
    expect(commands).toContain("-s emulator-5554 shell input keyevent KEYCODE_HOME");
    expect(commands).toContain("-s emulator-5554 shell input keyevent KEYCODE_MEDIA_PLAY_PAUSE");
    expect(commands).toContain("-s emulator-5554 shell input keyevent KEYCODE_MEDIA_FAST_FORWARD");
    await driver.close();
  });

  it("captures a bounded screenshot fingerprint only while the target remains foreground", async () => {
    const executor = new FakeExecutor();
    executor.screenshotResult = {
      stdout: screenshotPng(255, 0, 0),
      stderr: "",
      exitCode: 0,
    };
    const driver = createDriver(executor, new FakeObserver());
    await driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" });

    await expect(driver.captureScreenshotFingerprint()).resolves.toEqual({
      status: "available",
      value: expect.objectContaining({
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        width: 1,
        height: 1,
        luminanceGrid: expect.any(Array),
        visuallyBlank: false,
      }),
    });
    const callIndex = executor.calls.findIndex((call) => call.join(" ").includes("exec-out screencap -p"));
    expect(executor.calls[callIndex]).toEqual(["-s", "emulator-5554", "exec-out", "screencap", "-p"]);
    expect(executor.options[callIndex]).toMatchObject({
      timeoutMs: 15_000,
      maxOutputBytes: MAX_SCREENSHOT_PNG_BYTES,
    });
    await driver.close();
  });

  it("returns unavailable without fingerprinting when a foreign window owns or takes foreground", async () => {
    const executor = new FakeExecutor();
    executor.screenshotResult = {
      stdout: screenshotPng(255, 0, 0),
      stderr: "private screenshot detail",
      exitCode: 0,
    };
    const driver = createDriver(executor, new FakeObserver());
    await driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" });

    executor.focusedPackageOverride = "org.other.private";
    const foreignBeforeCapture = await driver.captureScreenshotFingerprint();
    expect(foreignBeforeCapture).toEqual({
      status: "unavailable",
      reason: "Android screenshot fingerprint capture failed for the target foreground window.",
    });
    expect(executor.calls.some((call) => call.join(" ").includes("exec-out screencap -p"))).toBe(false);

    executor.focusedPackageOverride = "org.example.tv";
    executor.focusedPackageAfterScreenshot = "org.other.private";
    const foreignAfterCapture = await driver.captureScreenshotFingerprint();
    expect(foreignAfterCapture).toEqual({
      status: "unavailable",
      reason: "Android screenshot fingerprint capture failed for the target foreground window.",
    });
    expect(executor.calls.filter((call) => call.join(" ").includes("exec-out screencap -p"))).toHaveLength(1);
    expect(JSON.stringify(foreignAfterCapture)).not.toContain("private screenshot detail");
    await driver.close();
  });

  it("observes only the exact launched target media session through a bounded ADB call", async () => {
    const executor = new FakeExecutor();
    executor.mediaSessionResult = {
      stdout: Buffer.from(`
  MediaSessionRecord (pid=111, package=org.example.tv.beta, tag=Other)
    active=true
    state=PlaybackState {state=3}
  MediaSessionRecord (pid=222, package=org.example.tv, tag=Player)
    active=true
    state=PlaybackState {state=3, position=42}
`),
      stderr: "",
      exitCode: 0,
    };
    const driver = createDriver(executor, new FakeObserver());
    await driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" });

    await expect(driver.getActiveMediaSession("org.example.tv")).resolves.toEqual({
      status: "available",
      value: { packageName: "org.example.tv", active: true, playbackState: "playing" },
    });
    const callIndex = executor.calls.findIndex((call) => call.join(" ").includes("dumpsys media_session"));
    expect(executor.calls[callIndex]).toEqual(["-s", "emulator-5554", "shell", "dumpsys", "media_session"]);
    expect(executor.options[callIndex]).toMatchObject({
      timeoutMs: 15_000,
      maxOutputBytes: MAX_MEDIA_SESSION_DUMP_BYTES,
    });
    await driver.close();
  });

  it("refuses media-session reads for any package other than the exact launched target", async () => {
    const executor = new FakeExecutor();
    const driver = createDriver(executor, new FakeObserver());
    await driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" });

    await expect(driver.getActiveMediaSession("org.example.tv.beta")).resolves.toEqual({
      status: "unavailable",
      reason: "Android media-session target must exactly match org.example.tv.",
    });
    expect(executor.calls.some((call) => call.join(" ").includes("dumpsys media_session"))).toBe(false);
    await driver.close();
  });

  it("propagates per-operation cancellation before screenshot or media-session ADB reads", async () => {
    const executor = new FakeExecutor();
    const driver = createDriver(executor, new FakeObserver());
    await driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" });
    const controller = new AbortController();
    controller.abort(Object.assign(new Error("cancelled"), { name: "AbortError" }));

    await expect(driver.captureScreenshotFingerprint({ signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(driver.getActiveMediaSession("org.example.tv", { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(executor.calls.some((call) => call.join(" ").includes("exec-out screencap -p"))).toBe(false);
    expect(executor.calls.some((call) => call.join(" ").includes("dumpsys media_session"))).toBe(false);
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

  it("fails closed when the target fingerprint never remains stable", async () => {
    const driver = createDriver(new FakeExecutor(), new AlternatingLaunchObserver());
    await expect(driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" })).rejects.toThrow(
      /stable focused launch[\s\S]*did not remain stable/u,
    );
    await driver.close();
  });

  it("serializes a press through settling before a concurrent reset starts", async () => {
    const executor = new FakeExecutor();
    const observer = new GatedObserver();
    const driver = createDriver(executor, observer);
    await driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" });
    observer.gateType = "begin_action";
    const gateStarted = new Promise<void>((resolve) => { observer.gateStarted = resolve; });

    const press = driver.press("RIGHT");
    await gateStarted;
    const reset = driver.reset("relaunch");
    await Promise.resolve();
    expect(executor.calls.some((call) => call.join(" ").includes("am force-stop org.example.tv"))).toBe(false);

    observer.gateType = null;
    observer.releaseGate?.();
    await expect(press).resolves.toMatchObject({ outcome: "applied" });
    await expect(reset).resolves.toBeUndefined();
    const commands = executor.calls.map((call) => call.join(" "));
    expect(commands.indexOf("-s emulator-5554 shell input keyevent KEYCODE_DPAD_RIGHT"))
      .toBeLessThan(commands.indexOf("-s emulator-5554 shell am force-stop org.example.tv"));
    await driver.close();
  });

  it("serializes a snapshot before a concurrent reset invalidates observer state", async () => {
    const executor = new FakeExecutor();
    const observer = new GatedObserver();
    const driver = createDriver(executor, observer);
    await driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" });
    observer.gateType = "current_state";
    const gateStarted = new Promise<void>((resolve) => { observer.gateStarted = resolve; });

    const snapshot = driver.snapshot();
    await gateStarted;
    const reset = driver.reset("relaunch");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const crossedBoundary = executor.calls.some((call) => call.join(" ").includes("am force-stop org.example.tv"));

    observer.gateType = null;
    observer.releaseGate?.();
    await expect(snapshot).resolves.toMatchObject({ location: { status: "available" } });
    await expect(reset).resolves.toBeUndefined();
    await driver.close();
    expect(crossedBoundary).toBe(false);
  });

  it("honors a per-operation signal during an active observer request", async () => {
    const observer = new AbortAwareObserver();
    const driver = createDriver(new FakeExecutor(), observer);
    await driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" });
    const beginStarted = new Promise<void>((resolve) => { observer.beginStarted = resolve; });
    const controller = new AbortController();

    const press = driver.press("RIGHT", { signal: controller.signal });
    await beginStarted;
    controller.abort();

    await expect(press).rejects.toMatchObject({ name: "AbortError" });
    expect(observer.beginSignal?.aborted).toBe(true);
    await driver.close();
  });

  it("serializes force-stop after an active press settles", async () => {
    const executor = new FakeExecutor();
    const observer = new GatedObserver();
    const driver = createDriver(executor, observer);
    await driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" });
    observer.gateType = "begin_action";
    const gateStarted = new Promise<void>((resolve) => { observer.gateStarted = resolve; });

    const press = driver.press("RIGHT");
    await gateStarted;
    const forceStop = driver.forceStop();
    await Promise.resolve();
    expect(executor.calls.some((call) => call.join(" ").includes("am force-stop org.example.tv"))).toBe(false);

    observer.releaseGate?.();
    await expect(press).resolves.toMatchObject({ outcome: "applied" });
    await expect(forceStop).resolves.toBeUndefined();
    const commands = executor.calls.map((call) => call.join(" "));
    expect(commands.indexOf("-s emulator-5554 shell input keyevent KEYCODE_DPAD_RIGHT"))
      .toBeLessThan(commands.indexOf("-s emulator-5554 shell am force-stop org.example.tv"));
    await driver.close();
  });

  it("serializes screenshots after an active snapshot completes", async () => {
    const executor = new FakeExecutor();
    const observer = new GatedObserver();
    const driver = createDriver(executor, observer);
    await driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" });
    observer.gateType = "current_state";
    const gateStarted = new Promise<void>((resolve) => { observer.gateStarted = resolve; });

    const snapshot = driver.snapshot();
    await gateStarted;
    const screenshot = driver.captureScreenshot("artifacts/queued-screenshot.png");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(executor.calls.some((call) => call.join(" ").includes("exec-out screencap -p"))).toBe(false);

    observer.releaseGate?.();
    await expect(snapshot).resolves.toMatchObject({ location: { status: "available" } });
    await expect(screenshot).rejects.toThrow(/valid PNG/u);
    await driver.close();
  });

  it("carries process, window, observer sequence, and structure generations for restoration diagnostics", async () => {
    const executor = new FakeExecutor();
    const observer = new MutableWindowObserver();
    const driver = createDriver(executor, observer);
    await driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" });

    const initial = await driver.snapshot();
    expect(initial.restorationContext).toMatchObject({
      platform: "android-tv",
      applicationId: "org.example.tv",
      processId: 321,
      processGeneration: 1,
      processIdentitySource: "last-launch-or-reset-metadata",
      activity: "org.example.tv.MainActivity",
      activityGeneration: null,
      activityGenerationObservable: false,
      rootIdentity: "window-1",
      rootIdentitySource: "accessibility-window-id",
      windowId: 1,
      observationSequence: 1,
      observerStructureFingerprint: "a".repeat(64),
      observerStateFingerprint: "b".repeat(64),
    });
    expect(initial.restorationContext.windowGeneration).toBeGreaterThanOrEqual(1);

    const initialWindowGeneration = initial.restorationContext.windowGeneration;
    executor.appPid = "654";
    observer.windowId = 8;
    await driver.reset("relaunch");
    const relaunched = await driver.snapshot();
    expect(relaunched.restorationContext).toMatchObject({
      applicationId: "org.example.tv",
      processId: 654,
      processGeneration: 2,
      rootIdentity: "window-8",
      windowId: 8,
    });
    expect(relaunched.restorationContext.windowGeneration).toBeGreaterThan(initialWindowGeneration);
    await driver.close();
  });

  it("serializes screenshot fingerprints and media-session reads behind active driver operations", async () => {
    const executor = new FakeExecutor();
    executor.screenshotResult = { stdout: screenshotPng(10, 20, 30), stderr: "", exitCode: 0 };
    executor.mediaSessionResult = {
      stdout: Buffer.from("MediaSessionRecord (package=org.example.tv)\n  active=true\n  state=PlaybackState {state=3}"),
      stderr: "",
      exitCode: 0,
    };
    const observer = new GatedObserver();
    const driver = createDriver(executor, observer);
    await driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" });
    observer.gateType = "current_state";
    const gateStarted = new Promise<void>((resolve) => { observer.gateStarted = resolve; });

    const snapshot = driver.snapshot();
    await gateStarted;
    const fingerprint = driver.captureScreenshotFingerprint();
    const mediaSession = driver.getActiveMediaSession("org.example.tv");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(executor.calls.some((call) => call.join(" ").includes("exec-out screencap -p"))).toBe(false);
    expect(executor.calls.some((call) => call.join(" ").includes("dumpsys media_session"))).toBe(false);

    observer.releaseGate?.();
    await expect(snapshot).resolves.toMatchObject({ location: { status: "available" } });
    await expect(fingerprint).resolves.toMatchObject({ status: "available" });
    await expect(mediaSession).resolves.toEqual({
      status: "available",
      value: { packageName: "org.example.tv", active: true, playbackState: "playing" },
    });
    await driver.close();
  });

  it("serializes metadata collection after an active snapshot completes", async () => {
    const executor = new FakeExecutor();
    const observer = new GatedObserver();
    const driver = createDriver(executor, observer);
    await driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" });
    const metadataCallsBefore = executor.calls.filter((call) => call.join(" ").includes("ro.product.manufacturer")).length;
    observer.gateType = "current_state";
    const gateStarted = new Promise<void>((resolve) => { observer.gateStarted = resolve; });

    const snapshot = driver.snapshot();
    await gateStarted;
    const metadata = driver.getDeviceMetadata(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(executor.calls.filter((call) => call.join(" ").includes("ro.product.manufacturer"))).toHaveLength(metadataCallsBefore);

    observer.releaseGate?.();
    await expect(snapshot).resolves.toMatchObject({ location: { status: "available" } });
    await expect(metadata).resolves.toMatchObject({ manufacturer: "Google" });
    await driver.close();
  });

  it("serializes installs after an active snapshot completes", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "tvdoctor-android-driver-"));
    const apkPath = join(temporaryDirectory, "fixture.apk");
    await writeFile(apkPath, "fixture");
    const executor = new FakeExecutor();
    const observer = new GatedObserver();
    const driver = createDriver(executor, observer);
    try {
      await driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" });
      observer.gateType = "current_state";
      const gateStarted = new Promise<void>((resolve) => { observer.gateStarted = resolve; });

      const snapshot = driver.snapshot();
      await gateStarted;
      const install = driver.install(apkPath);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(executor.calls.some((call) => call.includes(apkPath))).toBe(false);

      observer.releaseGate?.();
      await expect(snapshot).resolves.toMatchObject({ location: { status: "available" } });
      await expect(install).resolves.toBeUndefined();
      expect(executor.calls.some((call) => call.includes(apkPath))).toBe(true);
    } finally {
      await driver.close();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("captures only target-PID logs from the current launch-time boundary", async () => {
    const executor = new FakeExecutor();
    executor.logcat = "1788537599.999 321 7 I Target: previous launch\n" + executor.logcat;
    const driver = createDriver(executor, new FakeObserver());
    await driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" });

    await expect(driver.getLogs()).resolves.toMatchObject([
      { pid: 321, message: "target message" },
    ]);
    const command = executor.calls.find((call) => call.includes("logcat"));
    expect(command).toEqual(expect.arrayContaining(["-T", "--pid=321"]));
    expect(command).not.toContain("shell");
    expect(command).toContain("1788537600.000");
    await driver.close();
  });

  it("returns no logs when a target PID cannot be proven", async () => {
    const executor = new FakeExecutor();
    executor.appPid = "";
    const driver = createDriver(executor, new FakeObserver());
    await driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" });

    await expect(driver.getLogs()).resolves.toEqual([]);
    expect(executor.calls.some((call) => call.includes("logcat"))).toBe(false);
    await driver.close();
  });

  it("requires exact device and completed-boot readiness signals", async () => {
    const wrongState = new FakeExecutor();
    wrongState.deviceState = "devices";
    const stateDriver = createDriver(wrongState, new FakeObserver());
    await expect(stateDriver.waitForDeviceReady(20)).rejects.toThrow(/did not become ready/u);
    await stateDriver.close();

    const incompleteBoot = new FakeExecutor();
    incompleteBoot.bootCompleted = "0";
    const bootDriver = createDriver(incompleteBoot, new FakeObserver());
    await expect(bootDriver.waitForDeviceReady(20)).rejects.toThrow(/did not become ready/u);
    expect(incompleteBoot.calls.some((call) => call.join(" ").includes("getprop sys.boot_completed"))).toBe(true);
    await bootDriver.close();
  });

  it("validates readiness lifecycle and timeout before touching ADB", async () => {
    const executor = new FakeExecutor();
    const driver = createDriver(executor, new FakeObserver());
    await expect(driver.waitForDeviceReady(0)).rejects.toThrow(/timeoutMs/u);
    expect(executor.calls).toEqual([]);
    await driver.close();
    await expect(driver.waitForDeviceReady(10)).rejects.toThrow(/closed/u);
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

  it("reconciles a force-stop timeout when the target process is already gone", async () => {
    const executor = new ForceStopTimeoutExecutor();
    const driver = createDriver(executor, new FakeObserver());
    await driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" });

    await expect(driver.reset("relaunch")).resolves.toBeUndefined();

    const commands = executor.calls.map((call) => call.join(" "));
    expect(commands.filter((command) => command.includes("shell am force-stop org.example.tv"))).toHaveLength(1);
    expect(commands.filter((command) => command.includes(
      "am start -W -f 0x10008000 -n org.example.tv/.MainActivity",
    ))).toHaveLength(2);
    await driver.close();
  });

  it("labels the reset stage when a force-stop timeout leaves the target process running", async () => {
    const executor = new ForceStopTimeoutExecutor();
    executor.stoppedAfterTimeout = false;
    const driver = createDriver(executor, new FakeObserver());
    await driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" });

    await expect(driver.reset("relaunch")).rejects.toThrow(/reset stage force-stop[\s\S]*timed out/iu);
    expect(executor.calls.filter((call) => call.join(" ").includes(
      "am start -W -f 0x10008000 -n org.example.tv/.MainActivity",
    ))).toHaveLength(1);
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
