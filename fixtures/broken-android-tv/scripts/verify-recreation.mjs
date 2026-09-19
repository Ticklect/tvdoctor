import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";

const PACKAGE = "org.tvdoctor.fixture";
const COMPONENT = `${PACKAGE}/.MainActivity`;
const APK = fileURLToPath(new URL(
  "../build/outputs/apk/debug/tvdoctor-broken-android-tv-debug.apk",
  import.meta.url,
));

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const device = option("--device", "emulator-5554");
if (device === undefined || device.length === 0) {
  throw new Error("--device requires a non-empty adb serial.");
}
if (!existsSync(APK)) {
  throw new Error(`Fixture APK not found at ${APK}. Run the fixture build first.`);
}

function adb(args, { allowFailure = false } = {}) {
  const result = spawnSync("adb", ["-s", device, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`adb ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return (result.stdout ?? "").trim();
}

function requireMatch(text, pattern, message) {
  if (!pattern.test(text)) throw new Error(message);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

adb(["get-state"]);
adb(["install", "-r", APK]);
adb(["shell", "am", "force-stop", PACKAGE]);
adb(["shell", "am", "start", "-W", "-f", "0x10008000", "-n", COMPONENT]);

const pidBefore = adb(["shell", "pidof", PACKAGE]).split(/\s+/u)[0];
if (!/^\d+$/u.test(pidBefore)) {
  throw new Error(`Could not establish fixture PID before recreation: ${pidBefore}`);
}

adb(["shell", "input", "keyevent", "KEYCODE_DPAD_RIGHT"]);
adb(["shell", "input", "keyevent", "KEYCODE_DPAD_RIGHT"]);
adb(["shell", "input", "keyevent", "KEYCODE_DPAD_CENTER"]);

let hierarchy = "";
for (let attempt = 0; attempt < 20; attempt += 1) {
  adb(["shell", "uiautomator", "dump", "/sdcard/tvdoctor-fixture-recreation.xml"], { allowFailure: true });
  hierarchy = adb(["shell", "cat", "/sdcard/tvdoctor-fixture-recreation.xml"], { allowFailure: true });
  if (hierarchy.includes("Activity recreation completed. Focus Probe has initial focus.")) break;
  sleep(100);
}
adb(["shell", "rm", "-f", "/sdcard/tvdoctor-fixture-recreation.xml"], { allowFailure: true });

const pidAfter = adb(["shell", "pidof", PACKAGE]).split(/\s+/u)[0];
if (pidBefore !== pidAfter) {
  throw new Error(`Activity recreation changed process PID: before=${pidBefore}, after=${pidAfter}`);
}

requireMatch(
  hierarchy,
  /text="Activity recreation completed\. Focus Probe has initial focus\."/u,
  "Recreated Activity completion marker was not visible.",
);
requireMatch(
  hierarchy,
  /resource-id="org\.tvdoctor\.fixture:id\/focus_probe"[^>]*focused="true"/u,
  "Focus Probe did not regain focus after Activity recreation.",
);

adb(["shell", "input", "keyevent", "KEYCODE_DPAD_RIGHT"]);
sleep(100);
adb(["shell", "uiautomator", "dump", "/sdcard/tvdoctor-fixture-recreation.xml"], { allowFailure: true });
const replayRightHierarchy = adb(["shell", "cat", "/sdcard/tvdoctor-fixture-recreation.xml"], { allowFailure: true });
requireMatch(
  replayRightHierarchy,
  /resource-id="org\.tvdoctor\.fixture:id\/safe_control"[^>]*focused="true"/u,
  "Post-recreation RIGHT replay did not move focus to Safe Control.",
);

adb(["shell", "input", "keyevent", "KEYCODE_DPAD_LEFT"]);
sleep(100);
adb(["shell", "uiautomator", "dump", "/sdcard/tvdoctor-fixture-recreation.xml"], { allowFailure: true });
const replayLeftHierarchy = adb(["shell", "cat", "/sdcard/tvdoctor-fixture-recreation.xml"], { allowFailure: true });
adb(["shell", "rm", "-f", "/sdcard/tvdoctor-fixture-recreation.xml"], { allowFailure: true });
requireMatch(
  replayLeftHierarchy,
  /resource-id="org\.tvdoctor\.fixture:id\/focus_probe"[^>]*focused="true"/u,
  "Post-recreation LEFT replay did not restore focus to Focus Probe.",
);

const lifecycle = adb([
  "logcat",
  "-d",
  `--pid=${pidAfter}`,
  "-s",
  "TVDoctorFixture:I",
  "*:S",
]);
const sameProcess = `pid=${pidAfter}; package=${PACKAGE}`;
requireMatch(
  lifecycle,
  new RegExp(`Activity instance created; sequence=1; ${sameProcess}; restored=false`, "u"),
  "Initial MainActivity instance creation was not observed in the fixture process.",
);
requireMatch(
  lifecycle,
  new RegExp(`Activity instance destroyed; sequence=1; ${sameProcess}`, "u"),
  "Original MainActivity instance destruction was not observed.",
);
requireMatch(
  lifecycle,
  new RegExp(`Activity instance created; sequence=2; ${sameProcess}; restored=true`, "u"),
  "A second restored MainActivity instance was not observed in the same fixture process.",
);

process.stdout.write(
  `Activity recreation verification passed on ${device}: ${PACKAGE} stayed on pid ${pidAfter}, instance 1 was destroyed, instance 2 was created, focus was restored, and RIGHT/LEFT replay succeeded after recreation.\n`,
);
