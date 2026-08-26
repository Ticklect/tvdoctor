import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  ANDROID_TV_DRIVER_CAPABILITIES,
  AndroidTvDriver,
  type AdbCommandExecutor,
  type AdbCommandOptions,
  type AdbCommandResult,
} from "../src/index.js";

function bytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? Buffer.from(value, "utf8") : value;
}

function result(value: string | Uint8Array = ""): AdbCommandResult {
  return { stdout: bytes(value), stderr: "", exitCode: 0 };
}

function png(width: number, height: number): Uint8Array {
  const value = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(value, 0);
  value.write("IHDR", 12, "ascii");
  value.writeUInt32BE(width, 16);
  value.writeUInt32BE(height, 20);
  return value;
}

class FakeAdbExecutor implements AdbCommandExecutor {
  readonly calls: string[][] = [];
  focus: "first" | "third" = "first";
  /** Screen bytes returned for `exec-out screencap -p`. */
  screen: Uint8Array = png(1920, 1080);
  devices = "List of devices attached\nemulator-5554\tdevice product:sdk_tv model:sdk_tv device:generic transport_id:1\n";

  hierarchy(): string {
    const firstFocused = String(this.focus === "first");
    const thirdFocused = String(this.focus === "third");
    return `<hierarchy rotation="0"><node resource-id="org.tvdoctor.fixture:id/root" class="android.widget.LinearLayout" package="org.tvdoctor.fixture" text="" content-desc="" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" selected="false" bounds="[0,0][1920,1080]"><node resource-id="org.tvdoctor.fixture:id/first" class="android.widget.Button" package="org.tvdoctor.fixture" text="First" content-desc="First card" clickable="true" enabled="true" focusable="true" focused="${firstFocused}" scrollable="false" selected="false" bounds="[100,200][350,340]" /><node resource-id="org.tvdoctor.fixture:id/unreachable" class="android.widget.Button" package="org.tvdoctor.fixture" text="Diagnostics" content-desc="Diagnostics" clickable="true" enabled="true" focusable="false" focused="false" scrollable="false" selected="false" bounds="[380,200][630,340]" /><node resource-id="org.tvdoctor.fixture:id/third" class="android.widget.Button" package="org.tvdoctor.fixture" text="Third" content-desc="Third card" clickable="true" enabled="true" focusable="true" focused="${thirdFocused}" scrollable="false" selected="false" bounds="[660,200][910,340]" /></node></hierarchy>`;
  }

  async execute(arguments_: readonly string[], options?: AdbCommandOptions): Promise<AdbCommandResult> {
    void options;
    const call = [...arguments_];
    this.calls.push(call);
    if (call[0] === "devices") return result(this.devices);
    const command = call.slice(2);
    const joined = command.join(" ");
    if (joined === "get-state") return result("device\n");
    if (joined === "shell getprop sys.boot_completed") return result("1\n");
    if (joined === "shell getprop") {
      return result([
        "[ro.product.manufacturer]: [Google]",
        "[ro.product.model]: [Android TV Emulator]",
        "[ro.build.version.sdk]: [36]",
        "[ro.build.version.release]: [16]",
        "[ro.build.fingerprint]: [google/tv/test:userdebug/test-keys]",
        "[ro.build.characteristics]: [tv,emulator]",
      ].join("\n"));
    }
    if (joined === "shell wm size") return result("Physical size: 1920x1080\n");
    if (joined === "shell wm density") return result("Physical density: 320\n");
    if (joined.includes("uiautomator dump --compressed ")) {
      const remotePath = joined.match(/uiautomator dump --compressed (\/data\/local\/tmp\/[^ ;]+)/u)?.[1] ?? "";
      const catMarker = `cat ${remotePath}`;
      if (!joined.includes(catMarker)) {
        throw new Error(`Legacy multi-invocation hierarchy capture rejected: ${joined}`);
      }
      return result(this.hierarchy());
    }
    if (joined.startsWith("shell rm -f /data/local/tmp/tvdoctor-hierarchy-")) return result();
    if (joined === "shell dumpsys activity activities") {
      return result("mResumedActivity: ActivityRecord{123 u0 org.tvdoctor.fixture/.MainActivity t5}\n");
    }
    if (joined === "shell pidof -s org.tvdoctor.fixture") return result("4242\n");
    if (joined === "shell dumpsys package org.tvdoctor.fixture") {
      return result("versionCode=7 minSdk=23 targetSdk=36\nversionName=0.1-test\n");
    }
    if (joined === "shell input keyevent KEYCODE_DPAD_RIGHT") {
      this.focus = "third";
      return result();
    }
    if (joined.startsWith("shell input keyevent ")) return result();
    if (joined.startsWith("shell am force-stop ")) return result();
    if (joined.startsWith("shell am start -W -n ")) {
      this.focus = "first";
      return result("Status: ok\nComplete\n");
    }
    if (joined.startsWith("shell monkey -p ")) return result("Events injected: 1\n");
    if (joined === "shell pm clear org.tvdoctor.fixture") return result("Success\n");
    if (command[0] === "install") return result("Success\n");
    if (command[0] === "logcat") {
      expect(command).toContain("--pid=4242");
      return result([
        "1787392800.125 4242 4243 I TVDoctorFixture: Activity started",
        "1787392800.250 4242 4243 W TVDoctorFixture: Seeded warning",
      ].join("\n"));
    }
    if (joined === "exec-out screencap -p") return result(png(1920, 1080));
    throw new Error(`Unexpected fake ADB command: ${joined}`);
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("AndroidTvDriver", () => {
  it("advertises only implemented Android capabilities", async () => {
    const driver = new AndroidTvDriver({ executor: new FakeAdbExecutor(), serial: "emulator-5554" });
    const capabilities = await driver.capabilities();
    expect([...capabilities].sort()).toEqual([...ANDROID_TV_DRIVER_CAPABILITIES].sort());
    expect(capabilities.has("performance")).toBe(false);
    expect(capabilities.has("network")).toBe(false);
    expect(capabilities.has("player-state")).toBe(false);
    expect(capabilities.has("video-capture")).toBe(false);
  });

  it("covers install, launch, metadata, DPAD settling, screenshot, logcat, and resets", async () => {
    const fake = new FakeAdbExecutor();
    const driver = new AndroidTvDriver({
      executor: fake,
      serial: "emulator-5554",
      noResponseGraceMs: 0,
      settlePollIntervalMs: 1,
      settleStableSamples: 2,
      settleTimeoutMs: 1_000,
    });
    const directory = await mkdtemp(join(tmpdir(), "tvdoctor-android-driver-"));
    temporaryDirectories.push(directory);
    const apkPath = join(directory, "fixture.apk");
    await writeFile(apkPath, "fake apk bytes");

    const ready = await driver.waitForDeviceReady(2_000);
    expect(ready).toMatchObject({
      serial: "emulator-5554",
      manufacturer: "Google",
      model: "Android TV Emulator",
      sdkLevel: 36,
      displayWidth: 1920,
      displayHeight: 1080,
      displayDensityDpi: 320,
      isTelevision: true,
    });
    await driver.install(apkPath);
    await driver.launch({
      id: "org.tvdoctor.fixture",
      launchUri: "org.tvdoctor.fixture/.MainActivity",
    });

    const before = await driver.snapshot();
    expect(before.location).toEqual({
      status: "available",
      value: "org.tvdoctor.fixture/.MainActivity",
    });
    expect(before.focusedElement).toEqual({
      status: "available",
      value: {
        stableId: "org.tvdoctor.fixture:id/first",
        role: "button",
        name: "First card",
        bounds: { x: 100, y: 200, width: 250, height: 140 },
      },
    });
    expect(before.hierarchyMetadata).toMatchObject({
      status: "available",
      value: { capturedNodeCount: 4, truncated: false },
    });
    expect(before.device).toMatchObject({ status: "available", value: { isTelevision: true } });
    expect(before.app).toEqual({
      status: "available",
      value: {
        packageName: "org.tvdoctor.fixture",
        component: "org.tvdoctor.fixture/.MainActivity",
        pid: 4242,
        versionName: "0.1-test",
        versionCode: 7,
      },
    });

    const action = await driver.press("RIGHT");
    expect(action).toMatchObject({ key: "RIGHT", outcome: "applied" });
    expect(action.timing.firstResponseAtMs).toBeTypeOf("number");
    const after = await driver.snapshot();
    expect(after.focusedElement).toMatchObject({
      status: "available",
      value: { stableId: "org.tvdoctor.fixture:id/third" },
    });

    const screenshotPath = join(directory, "evidence", "screen.png");
    const screenshot = await driver.captureScreenshot(screenshotPath);
    expect(screenshot).toMatchObject({
      path: screenshotPath,
      mediaType: "image/png",
      width: 1920,
      height: 1080,
    });
    expect((await readFile(screenshotPath)).subarray(0, 8))
      .toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

    expect(await driver.getLogs()).toEqual([
      {
        timestamp: "2026-08-22T10:00:00.125Z",
        level: "info",
        message: "Activity started",
        pid: 4242,
        threadId: 4243,
        tag: "TVDoctorFixture",
      },
      {
        timestamp: "2026-08-22T10:00:00.250Z",
        level: "warning",
        message: "Seeded warning",
        pid: 4242,
        threadId: 4243,
        tag: "TVDoctorFixture",
      },
    ]);

    await driver.reset("relaunch");
    await driver.reset("reload");
    await driver.reset("clear-data");
    expect(fake.calls.some((call) => call.slice(2).join(" ") === "shell pm clear org.tvdoctor.fixture"))
      .toBe(true);
    expect(fake.calls.some((call) => call.slice(2).join(" ") === "shell input keyevent KEYCODE_DPAD_RIGHT"))
      .toBe(true);
    expect(fake.calls.some((call) => call[2] === "install" && call.at(-1) === apkPath)).toBe(true);

    await driver.close();
    await expect(driver.snapshot()).rejects.toThrow("closed");
  });

  it("fails closed for ambiguous devices and unsafe identifiers", async () => {
    const fake = new FakeAdbExecutor();
    fake.devices = "List of devices attached\nemulator-5554\tdevice\nemulator-5556\tdevice\n";
    const ambiguous = new AndroidTvDriver({ executor: fake });
    await expect(ambiguous.getDeviceMetadata()).rejects.toThrow("Exactly one online Android device");

    expect(() => new AndroidTvDriver({ executor: fake, serial: "bad serial; rm" }))
      .toThrow("serial is invalid");
    const explicit = new AndroidTvDriver({ executor: fake, serial: "emulator-5554" });
    await expect(explicit.launch({ id: "bad;package", launchUri: ".MainActivity" }))
      .rejects.toThrow("package name is invalid");
    await expect(explicit.launch({
      id: "org.tvdoctor.fixture",
      launchUri: "other.package/.MainActivity",
    })).rejects.toThrow("must belong to the selected package");
  });

  it("keeps hierarchy and duplicate-focus failures explicitly unavailable", async () => {
    const fake = new FakeAdbExecutor();
    const original = fake.hierarchy.bind(fake);
    fake.hierarchy = () => original().replace('focused="false" scrollable="false" selected="false" bounds="[660,200][910,340]"', 'focused="true" scrollable="false" selected="false" bounds="[660,200][910,340]"');
    const driver = new AndroidTvDriver({ executor: fake, serial: "emulator-5554" });
    await driver.launch({ id: "org.tvdoctor.fixture", launchUri: ".MainActivity" });
    const snapshot = await driver.snapshot();
    expect(snapshot.focusedElement).toEqual({
      status: "unavailable",
      reason: "UIAutomator hierarchy reported multiple focused nodes.",
    });
  });

  it("reuses the settled baseline and refreshes it during reset", async () => {
    const fake = new FakeAdbExecutor();
    const driver = new AndroidTvDriver({
      executor: fake,
      serial: "emulator-5554",
      noResponseGraceMs: 0,
      settlePollIntervalMs: 1,
      settleTimeoutMs: 1_000,
    });
    await driver.launch({ id: "org.tvdoctor.fixture", launchUri: ".MainActivity" });

    const first = await driver.press("RIGHT");
    expect(first.outcome).toBe("applied");
    const dumpCallsAfterFirst = fake.calls.filter((call) =>
      call.slice(2).join(" ").includes("uiautomator dump --compressed"),
    ).length;
    expect(first.timing.profile).toMatchObject({ baselineSource: "cached" });
    expect(first.postActionSnapshot).toBeDefined();

    const second = await driver.press("LEFT");
    expect(second.outcome).toBe("applied");
    expect(second.timing.profile).toMatchObject({ baselineSource: "cached" });
    const dumpCallsAfterSecond = fake.calls.filter((call) =>
      call.slice(2).join(" ").includes("uiautomator dump --compressed"),
    ).length;
    // LEFT is a canonical no-op in the fixture, so two post-input samples
    // must agree before the driver can rule out a delayed response.
    expect(dumpCallsAfterSecond - dumpCallsAfterFirst).toBe(2);
    expect(second.postActionSnapshot).toBeDefined();

    await driver.reset("relaunch");
    const third = await driver.press("RIGHT");
    expect(third.timing.profile).toMatchObject({ baselineSource: "cached" });
  });

  it("uses unique hierarchy files, preserves dump status, and cleans each capture", async () => {
    const fake = new FakeAdbExecutor();
    const driver = new AndroidTvDriver({
      executor: fake,
      serial: "emulator-5554",
      settlePollIntervalMs: 1,
      settleTimeoutMs: 1_000,
    });

    await driver.launch({ id: "org.tvdoctor.fixture", launchUri: ".MainActivity" });
    await driver.snapshot();

    const dumpCalls = fake.calls
      .map((call) => call.slice(2).join(" "))
      .filter((call) => call.includes("uiautomator dump --compressed"));
    const paths = dumpCalls.map((call) => (
      call.match(/uiautomator dump --compressed (\/data\/local\/tmp\/[^ ;]+)/u)?.[1]
    ));
    expect(paths.every((path) => path !== undefined)).toBe(true);
    expect(new Set(paths).size).toBe(paths.length);
    expect(dumpCalls.every((call) => call.includes("dump_rc=$?"))).toBe(true);
    for (const path of paths) {
      expect(fake.calls.some((call) => call.slice(2).join(" ") === `shell rm -f ${path}`)).toBe(true);
    }
  });

  it("does not certify a delayed response as a no-op", async () => {
    const fake = new FakeAdbExecutor();
    const originalExecute = fake.execute.bind(fake);
    let inputSent = false;
    let postInputCaptures = 0;
    fake.execute = async (arguments_, options) => {
      const joined = [...arguments_].slice(2).join(" ");
      if (joined === "shell input keyevent KEYCODE_DPAD_DOWN") inputSent = true;
      if (inputSent && joined.includes("uiautomator dump --compressed")) {
        postInputCaptures += 1;
        if (postInputCaptures >= 2) fake.focus = "third";
      }
      return await originalExecute(arguments_, options);
    };
    const driver = new AndroidTvDriver({
      executor: fake,
      serial: "emulator-5554",
      noResponseGraceMs: 0,
      settlePollIntervalMs: 1,
      stabilityProbeMs: 1,
      settleTimeoutMs: 1_000,
    });
    await driver.launch({ id: "org.tvdoctor.fixture", launchUri: ".MainActivity" });

    const action = await driver.press("DOWN");

    expect(action.outcome).toBe("applied");
    expect(postInputCaptures).toBeGreaterThanOrEqual(3);
    expect(action.postActionSnapshot?.focusedElement).toMatchObject({
      status: "available",
      value: { stableId: "org.tvdoctor.fixture:id/third" },
    });
  });

  it("returns inconclusive and stops polling when captures wedge instantly", async () => {
    const fake = new FakeAdbExecutor();
    let captureFailures = 0;
    const originalExecute = fake.execute.bind(fake);
    fake.execute = async (arguments_, options) => {
      const joined = [...arguments_].slice(2).join(" ");
      if (joined.includes("uiautomator dump --compressed") && captureFailures >= 2) {
        captureFailures += 1;
        throw new Error("uiautomator wedged");
      }
      if (joined.includes("uiautomator dump --compressed")) captureFailures += 0;
      return await originalExecute(arguments_, options);
    };
    const driver = new AndroidTvDriver({
      executor: fake,
      serial: "emulator-5554",
      noResponseGraceMs: 0,
      settlePollIntervalMs: 1,
      settleTimeoutMs: 1_000,
    });
    await driver.launch({ id: "org.tvdoctor.fixture", launchUri: ".MainActivity" });
    const warmup = await driver.press("RIGHT"); // succeeds; settles and caches baseline (focus now third)
    expect(warmup.outcome).toBe("applied");
    const callsBefore = fake.calls.length;
    fake.execute = async (arguments_, options) => {
      const joined = [...arguments_].slice(2).join(" ");
      if (joined.includes("uiautomator dump --compressed")) {
        captureFailures += 1;
        throw new Error("uiautomator wedged");
      }
      return await originalExecute(arguments_, options);
    };
    // The next press reuses the cached baseline, sends LEFT, then every dump fails.
    const action = await driver.press("LEFT");
    expect(action.outcome).toBe("inconclusive");
    expect(action.message).toContain("wedged");
    expect(action.timing.profile?.wedgeSuspected).toBe(true);
    expect(fake.calls.length - callsBefore).toBeLessThan(12);
    expect(captureFailures).toBeGreaterThanOrEqual(2);
  });

  it("fails closed before sending input when pre-action observation is unavailable", async () => {
    const fake = new FakeAdbExecutor();
    const originalExecute = fake.execute.bind(fake);
    fake.execute = async (arguments_, options) => {
      const joined = [...arguments_].slice(2).join(" ");
      if (joined.includes("uiautomator dump --compressed")) throw new Error("dump unavailable");
      return await originalExecute(arguments_, options);
    };
    const driver = new AndroidTvDriver({
      executor: fake,
      serial: "emulator-5554",
      settleTimeoutMs: 500,
    });
    await driver.launch({ id: "org.tvdoctor.fixture", launchUri: ".MainActivity" });
    const inputBefore = fake.calls.filter((call) => call.slice(2).join(" ").startsWith("shell input")).length;
    const action = await driver.press("DOWN");
    expect(action.outcome).toBe("failed");
    expect(action.message).toContain("input was not sent");
    const inputAfter = fake.calls.filter((call) => call.slice(2).join(" ").startsWith("shell input")).length;
    expect(inputAfter).toBe(inputBefore);
  });

  it("keeps polling through a transient hierarchy difference before settling on change", async () => {
    const fake = new FakeAdbExecutor();
    const driver = new AndroidTvDriver({
      executor: fake,
      serial: "emulator-5554",
      noResponseGraceMs: 0,
      settlePollIntervalMs: 1,
      stabilityProbeMs: 1,
      settleTimeoutMs: 2_000,
    });
    await driver.launch({ id: "org.tvdoctor.fixture", launchUri: ".MainActivity" });
    const dumpsBefore = fake.calls.filter((call) => (
      call.slice(2).join(" ").includes("uiautomator dump --compressed")
    )).length;
    const action = await driver.press("RIGHT");
    const dumpsAfter = fake.calls.filter((call) => (
      call.slice(2).join(" ").includes("uiautomator dump --compressed")
    )).length;
    expect(action.outcome).toBe("applied");
    expect(dumpsAfter - dumpsBefore).toBe(2);
    expect(action.timing.focusSettledAtMs).toBeTypeOf("number");
    expect(action.postActionSnapshot?.focusedElement).toMatchObject({
      status: "available",
      value: { stableId: "org.tvdoctor.fixture:id/third" },
    });
    expect(action.timing.profile?.captureCount).toBeGreaterThan(0);
  });

  it("bounds screen probes by the remaining settle deadline", async () => {
    const fake = new FakeAdbExecutor();
    const originalExecute = fake.execute.bind(fake);
    const screenshotTimeouts: number[] = [];
    fake.execute = async (arguments_, options) => {
      const joined = [...arguments_].slice(2).join(" ");
      if (joined === "exec-out screencap -p" && options?.timeoutMs !== undefined) {
        screenshotTimeouts.push(options.timeoutMs);
      }
      return await originalExecute(arguments_, options);
    };
    const driver = new AndroidTvDriver({
      executor: fake,
      serial: "emulator-5554",
      noResponseGraceMs: 0,
      settlePollIntervalMs: 1,
      stabilityProbeMs: 1,
      settleTimeoutMs: 100,
      commandTimeoutMs: 15_000,
    });
    await driver.launch({ id: "org.tvdoctor.fixture", launchUri: ".MainActivity" });

    const action = await driver.press("RIGHT");

    expect(action.outcome).toBe("applied");
    expect(screenshotTimeouts).toHaveLength(2);
    expect(screenshotTimeouts.every((timeout) => timeout > 0 && timeout <= 100)).toBe(true);
  });

  it("falls back to stable semantic hierarchy after one changing screen probe", async () => {
    const fake = new FakeAdbExecutor();
    const originalExecute = fake.execute.bind(fake);
    let screenCaptures = 0;
    fake.execute = async (arguments_, options) => {
      const joined = [...arguments_].slice(2).join(" ");
      if (joined === "exec-out screencap -p") {
        screenCaptures += 1;
        return result(png(1_920, 1_080 + screenCaptures));
      }
      return await originalExecute(arguments_, options);
    };
    const driver = new AndroidTvDriver({
      executor: fake,
      serial: "emulator-5554",
      noResponseGraceMs: 0,
      settlePollIntervalMs: 1,
      stabilityProbeMs: 1,
      settleTimeoutMs: 1_000,
    });
    await driver.launch({ id: "org.tvdoctor.fixture", launchUri: ".MainActivity" });

    const action = await driver.press("RIGHT");

    expect(action.outcome).toBe("applied");
    expect(screenCaptures).toBe(2);
    expect(action.timing.profile?.captureCount).toBe(4);
    expect(action.postActionSnapshot?.focusedElement).toMatchObject({
      status: "available",
      value: { stableId: "org.tvdoctor.fixture:id/third" },
    });
  });
});
