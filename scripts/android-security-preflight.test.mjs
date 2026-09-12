import assert from "node:assert/strict";
import test from "node:test";
import { preflightAndroidSecurityTarget } from "./lib/android-security-preflight.mjs";

const adb = "C:/Android/platform-tools/adb.exe";
const serial = "emulator-5554";

test("explains when ADB cannot be executed", () => {
  const missing = Object.assign(new Error("spawn failed"), { code: "ENOENT" });
  assert.throws(
    () => preflightAndroidSecurityTarget({ adb, serial, execute: () => { throw missing; } }),
    /Install Android SDK platform-tools or set ADB/u,
  );
});

test("explains when the requested serial is absent", () => {
  assert.throws(
    () => preflightAndroidSecurityTarget({
      adb,
      serial,
      execute: () => "List of devices attached\nemulator-5556 device product:sdk_google_atv\n",
    }),
    /emulator-5554.*not listed.*ANDROID_SERIAL/u,
  );
});

for (const [state, guidance] of [
  ["unauthorized", /authorize this computer/u],
  ["offline", /restart or reconnect/iu],
]) {
  test(`explains the ${state} device state`, () => {
    assert.throws(
      () => preflightAndroidSecurityTarget({
        adb,
        serial,
        execute: () => `List of devices attached\n${serial}\t${state}\n`,
      }),
      guidance,
    );
  });
}

test("accepts the requested online device", () => {
  assert.doesNotThrow(() => preflightAndroidSecurityTarget({
    adb,
    serial,
    execute: () => `List of devices attached\n${serial} device product:sdk_google_atv model:TV\n`,
  }));
});

test("bounds and sanitises device text in diagnostics", () => {
  const hostileSerial = `other\u001b[31m-${"x".repeat(300)}`;
  assert.throws(
    () => preflightAndroidSecurityTarget({
      adb,
      serial,
      execute: () => `List of devices attached\n${hostileSerial} offline\n`,
    }),
    (error) => {
      assert.equal(error.message.includes("\u001b"), false);
      assert.ok(error.message.length < 700);
      return true;
    },
  );
});
