import { resolve } from "node:path";
import { AndroidTvDriver } from "@tvdoctor/driver-android";
import { fingerprintSnapshot } from "@tvdoctor/core";

const [serial = "emulator-5554", apkPath, packageName, activity = ".MainActivity", iterationsText = "20"] = process.argv.slice(2);
if (apkPath === undefined || packageName === undefined) {
  throw new Error("Usage: node scripts/bench-android-v2.mjs SERIAL APK PACKAGE [ACTIVITY] [ITERATIONS]");
}
const iterations = Number(iterationsText);
if (!Number.isSafeInteger(iterations) || iterations <= 0 || iterations > 1_000) {
  throw new Error("ITERATIONS must be between 1 and 1000.");
}

function summary(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
  return {
    count: sorted.length,
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p50: percentile(0.5),
    p90: percentile(0.9),
    p95: percentile(0.95),
    p99: percentile(0.99),
    worst: sorted.at(-1),
  };
}

const driver = new AndroidTvDriver({ serial });
const resetFingerprints = [];
const actionDurations = [];
try {
  await driver.install(resolve(apkPath));
  await driver.launch({ id: packageName, launchUri: activity });
  for (let index = 0; index < 5; index += 1) {
    await driver.reset("relaunch");
    const snapshot = await driver.snapshot();
    const computed = fingerprintSnapshot(snapshot);
    resetFingerprints.push({
      index,
      location: snapshot.location,
      focus: snapshot.focusedElement,
      screenIdentity: computed.screen.value,
      focusIdentity: computed.focus.value,
      stateIdentity: computed.stateValue,
    });
  }
  const keys = ["RIGHT", "LEFT", "UP", "DOWN", "SELECT", "BACK"];
  for (let index = 0; index < iterations; index += 1) {
    const key = keys[index % keys.length];
    const result = await driver.press(key);
    if (result.outcome !== "applied") throw new Error(`${key} failed: ${result.message ?? result.outcome}`);
    actionDurations.push(result.timing.profile?.totalMs ?? 0);
    if (key === "SELECT" || key === "BACK") await driver.reset("relaunch");
  }
  process.stdout.write(`${JSON.stringify({
    architecture: "android-observer-v2",
    serial,
    packageName,
    resetFingerprints,
    resetsDeterministic: new Set(resetFingerprints.map((item) => item.stateIdentity)).size === 1,
    actionLatencyMs: summary(actionDurations),
  }, null, 2)}\n`);
} finally {
  await driver.forceStop(packageName).catch(() => undefined);
  await driver.close();
}
