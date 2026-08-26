#!/usr/bin/env node
// Measures raw Android observation/input primitive costs so settling design is
// grounded in device data. Run: node scripts/profile-android-primitives.mjs [serial]

import { spawn } from "node:child_process";

const adb = process.env["ANDROID_ADB"] ??
  `${process.env["LOCALAPPDATA"] ?? ""}\\Android\\Sdk\\platform-tools\\adb.exe`;
const serial = process.argv[2] ?? "emulator-5554";
const iterations = Number(process.env["PROBE_ITERATIONS"] ?? "5");

function runAdb(args, { input } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const started = performance.now();
    const child = spawn(adb, ["-s", serial, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", rejectRun);
    child.on("close", () => resolveRun({ ms: performance.now() - started, stdout }));
    if (input !== undefined) child.stdin.end(input);
  });
}

async function sample(label, fn) {
  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    const { ms } = await fn(i);
    samples.push(ms);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  const p90 = samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.9) - 1)];
  console.log(`${label.padEnd(46)} median=${median.toFixed(0)}ms p90=${p90.toFixed(0)}ms max=${samples.at(-1).toFixed(0)}ms`);
  return median;
}

const remotePath = "/data/local/tmp/tvdoctor-probe.xml";

console.log(`device=${serial} adb="${adb}" iterations=${iterations}`);

await sample("shell true (spawn+shell startup)", () => runAdb(["shell", "true"]));

await sample("uiautomator dump only", () =>
  runAdb(["shell", "uiautomator", "dump", "--compressed", remotePath]));

await sample("dump + cat + rm (3 invocations)", () =>
  runAdb(["shell", "uiautomator", "dump", "--compressed", remotePath])
    .then(() => runAdb(["exec-out", "cat", remotePath]))
    .then(() => runAdb(["shell", "rm", "-f", remotePath])));

await sample("dump >/dev/null; cat; rm (1 invocation)", () =>
  runAdb(["shell", `uiautomator dump --compressed ${remotePath} >/dev/null 2>&1; cat ${remotePath}; rm -f ${remotePath}`]));

await sample("input keyevent DPAD_DOWN", () =>
  runAdb(["shell", "input", "keyevent", "KEYCODE_DPAD_DOWN"]));

await sample("dumpsys activity activities", () =>
  runAdb(["shell", "dumpsys", "activity", "activities"]));

await sample("exec-out screencap -p (hash stability)", async () => {
  const { stdout } = await runAdb(["exec-out", "screencap", "-p"]);
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(stdout).digest("hex").slice(0, 16);
  console.log(`  screencap sha256[:16]=${hash}`);
  return { ms: 0 };
});

await sample("getprop sys.boot_completed", () =>
  runAdb(["shell", "getprop", "sys.boot_completed"]));

await sample("two dumps in one invocation", () =>
  runAdb(["shell", `uiautomator dump --compressed ${remotePath} >/dev/null 2>&1; uiautomator dump --compressed ${remotePath} >/dev/null 2>&1`]));

// Persistent interactive shell roundtrip cost.
{
  const child = spawn(adb, ["-s", serial, "shell"], { stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  child.stdout.on("data", (chunk) => { buffer += chunk; });
  const roundtrip = async () => new Promise((resolveRound) => {
    buffer = "";
    child.stdin.write("true; echo __DONE__\n");
    const started = performance.now();
    const poll = setInterval(() => {
      if (buffer.includes("__DONE__")) {
        clearInterval(poll);
        resolveRound(performance.now() - started);
      }
    }, 5);
  });
  await new Promise((resolveWarm) => setTimeout(resolveWarm, 300));
  await roundtrip(); // warm-up
  await sample("persistent shell roundtrip (true)", () => roundtrip());
  child.kill();
}

console.log("done");
