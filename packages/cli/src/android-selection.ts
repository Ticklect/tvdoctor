import { ANDROID_OBSERVER_MIN_SDK } from "@tvdoctor/driver-android";

import {
  checkApkCompatibility,
  type AndroidPreflightDevice,
  type ApkMetadata,
} from "./android-product.js";

export interface AndroidDeviceEvaluation {
  readonly device: AndroidPreflightDevice;
  readonly compatible: boolean;
  readonly reasons: readonly string[];
}

export function evaluateZeroConfigAndroidDevice(
  apk: ApkMetadata,
  device: AndroidPreflightDevice,
): AndroidDeviceEvaluation {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!device.online || device.state !== "device") {
    blockers.push(device.detail ?? "Device is not online.");
  }
  if (device.isTelevision !== true) {
    blockers.push(device.isTelevision === false
      ? "This Android device is not an Android TV target."
      : "Android TV identity could not be proven for this device.");
  }
  if (device.apiLevel === null) {
    blockers.push("Android API level could not be verified.");
  } else if (device.apiLevel < ANDROID_OBSERVER_MIN_SDK) {
    blockers.push(
      `TVDoctor Observer requires Android API ${String(ANDROID_OBSERVER_MIN_SDK)} or newer, but this device provides API ${String(device.apiLevel)}.`,
    );
  }

  const compatibility = checkApkCompatibility(apk, device);
  blockers.push(...compatibility.blockers);
  warnings.push(...compatibility.warnings);

  return {
    device,
    compatible: blockers.length === 0,
    reasons: [...blockers, ...warnings],
  };
}
