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
    if (joined.startsWith("shell uiautomator dump --compressed ")) return result("UI hierarchy dumped\n");
    if (command[0] === "exec-out" && command[1] === "cat") return result(this.hierarchy());
    if (joined.startsWith("shell rm -f ")) return result();
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
});
