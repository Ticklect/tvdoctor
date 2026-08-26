#!/usr/bin/env node
// Benchmarks the real AndroidTvDriver press() path against VLC so before/after
// campaigns compare like for like. Usage: node scripts/bench-android-driver.mjs [serial] [presses]

import { performance } from "node:perf_hooks";
import { AndroidTvDriver } from "../packages/driver-android/dist/index.js";

const serial = process.argv[2] ?? "emulator-5554";
const presses = Number(process.argv[3] ?? "6");
const keys = ["RIGHT", "LEFT", "DOWN", "UP"];

const adbPath = `${process.env["LOCALAPPDATA"]}\\Android\\Sdk\\platform-tools\\adb.exe`;
const driver = new AndroidTvDriver({ serial, adbPath });

await driver.waitForDeviceReady(120_000);
console.log(`device ready: ${serial}`);

await driver.launch({
  id: "org.videolan.vlc",
  launchUri: "org.videolan.vlc/.StartActivity",
});

// Wrap the internal executor indirectly by counting via public behavior:
// we instead time each press() and report result messages/timing.
const samples = [];
for (let i = 0; i < presses; i += 1) {
  const key = keys[i % keys.length];
  const started = performance.now();
  const result = await driver.press(key);
  const elapsed = performance.now() - started;
  samples.push({ key, elapsed, outcome: result.outcome, message: result.message ?? "", timing: result.timing });
  console.log(`${String(i + 1).padStart(2)} ${key.padEnd(5)} ${elapsed.toFixed(0).padStart(6)}ms outcome=${result.outcome}${result.message ? ` msg=${result.message}` : ""}`);
}

samples.sort((a, b) => a.elapsed - b.elapsed);
const median = samples[Math.floor(samples.length / 2)]?.elapsed ?? Number.NaN;
const p90 = samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.9) - 1)]?.elapsed ?? Number.NaN;
console.log(`\nmedian=${median.toFixed(0)}ms p90=${p90.toFixed(0)}ms worst=${samples.at(-1)?.elapsed.toFixed(0)}ms`);
await driver.close();
