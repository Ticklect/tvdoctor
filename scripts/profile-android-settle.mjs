#!/usr/bin/env node
// Measures uiautomator dump latency immediately after DPAD input versus while
// static, capturing dump status output so silent failures cannot skew results.

import { spawn } from "node:child_process";

const adb = process.env["ANDROID_ADB"] ??
  `${process.env["LOCALAPPDATA"] ?? ""}\\Android\\Sdk\\platform-tools\\adb.exe`;
const serial = process.argv[2] ?? "emulator-5554";
const remotePath = "/data/local/tmp/tvdoctor-settle-probe.xml";

function run(args) {
  return new Promise((resolveRun, rejectRun) => {
    const started = performance.now();
    const child = spawn(adb, ["-s", serial, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", rejectRun);
    child.on("close", (code) => resolveRun({ ms: performance.now() - started, code, stdout: stdout.trim() }));
  });
}

async function timedDump(label) {
  const { ms, stdout } = await run([
    "shell", `uiautomator dump --compressed ${remotePath} >/dev/null 2>&1; cat ${remotePath}; rm -f ${remotePath}`,
  ]);
  const bytes = stdout.length;
  console.log(`${label.padEnd(34)} ${ms.toFixed(0).padStart(5)}ms bytes=${String(bytes).padStart(7)}`);
  return { ms, bytes };
}

console.log(`device=${serial}`);
await run(["shell", "am", "start", "-n", "org.videolan.vlc/.StartActivity"]);
await new Promise((r) => setTimeout(r, 1500));

console.log("--- after DPAD input (sleep 400ms then dump) ---");
for (let i = 1; i <= 6; i += 1) {
  await run(["shell", "input", "keyevent", "KEYCODE_DPAD_RIGHT"]);
  await new Promise((r) => setTimeout(r, 400));
  await timedDump(`post-input #${i}`);
}

console.log("--- static consecutive dumps ---");
for (let i = 1; i <= 6; i += 1) {
  await timedDump(`static #${i}`);
}
