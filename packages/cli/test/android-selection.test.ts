import { describe, expect, it } from "vitest";

import { evaluateZeroConfigAndroidDevice } from "../src/android-selection.js";
import type { AndroidPreflightDevice, ApkMetadata } from "../src/android-product.js";

const apk: ApkMetadata = {
  path: "D:/apps/example.apk",
  packageName: "org.example.tv",
  versionName: "1.0.0",
  launchableActivities: [".MainActivity"],
  leanbackActivity: ".MainActivity",
  supportedAbis: ["x86_64"],
  minSdk: 24,
  targetSdk: 36,
  label: "Example TV",
};

const device: AndroidPreflightDevice = {
  serial: "emulator-5554",
  state: "device",
  online: true,
  model: "Android TV",
  manufacturer: "Google",
  apiLevel: 36,
  supportedAbis: ["x86_64"],
  isTelevision: true,
  detail: null,
};

describe("zero-config Android device selection", () => {
  it("accepts a compatible proven TV", () => {
    expect(evaluateZeroConfigAndroidDevice(apk, device)).toMatchObject({ compatible: true, reasons: [] });
  });

  it("rejects offline and non-TV devices", () => {
    expect(evaluateZeroConfigAndroidDevice(apk, { ...device, online: false }).compatible).toBe(false);
    expect(evaluateZeroConfigAndroidDevice(apk, { ...device, isTelevision: false }).compatible).toBe(false);
    expect(evaluateZeroConfigAndroidDevice(apk, { ...device, isTelevision: null }).compatible).toBe(false);
  });

  it("rejects devices below the observer or APK minimum SDK", () => {
    expect(evaluateZeroConfigAndroidDevice(apk, { ...device, apiLevel: 22 }).compatible).toBe(false);
    expect(evaluateZeroConfigAndroidDevice({ ...apk, minSdk: 37 }, device).compatible).toBe(false);
  });

  it("rejects ABI mismatch but permits unknown ABI with a warning", () => {
    expect(evaluateZeroConfigAndroidDevice(apk, { ...device, supportedAbis: ["arm64-v8a"] }).compatible).toBe(false);
    const unknown = evaluateZeroConfigAndroidDevice(apk, { ...device, supportedAbis: [] });
    expect(unknown.compatible).toBe(true);
    expect(unknown.reasons.join(" ")).toMatch(/architecture.*could not be fully verified/iu);
  });
});
