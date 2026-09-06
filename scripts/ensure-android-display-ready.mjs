import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function androidDisplayReady(powerState, displayState, inputState) {
  return /(?:^|\s)mWakefulness=Awake(?:\s|$)/u.test(powerState)
    && /(?:Display State=ON|\bstate ON\b|mState=ON)/u.test(displayState)
    && /FocusedWindows:\s*(?!<none>)[\s\S]*?displayId=\d+,\s*name=/u.test(inputState);
}

export async function ensureAndroidDisplayReady({
  executeAdb,
  wait = delay,
  maxAttempts = 30,
  pollIntervalMs = 1_000,
}) {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
    throw new TypeError("maxAttempts must be a positive integer.");
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0) {
    throw new TypeError("pollIntervalMs must be a non-negative integer.");
  }

  await executeAdb(["shell", "svc", "power", "stayon", "true"]);
  let powerState = "No power state was returned.";
  let displayState = "No display state was returned.";
  let inputState = "No input state was returned.";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await executeAdb(["shell", "input", "keyevent", "KEYCODE_WAKEUP"]);
    await executeAdb(["shell", "wm", "dismiss-keyguard"]);
    powerState = await executeAdb(["shell", "dumpsys", "power"]);
    displayState = await executeAdb(["shell", "dumpsys", "display"]);
    inputState = await executeAdb(["shell", "dumpsys", "input"]);
    if (androidDisplayReady(powerState, displayState, inputState)) {
      return { attempts: attempt, powerState, displayState, inputState };
    }
    if (attempt < maxAttempts) await wait(pollIntervalMs);
  }
  throw new Error(
    [
      `Android display did not become ready after ${String(maxAttempts)} attempts.`,
      `Last power state:\n${powerState}`,
      `Last display state:\n${displayState}`,
      `Last input state:\n${inputState}`,
    ].join("\n"),
  );
}

async function executeAdb(arguments_) {
  const executable = process.env["ANDROID_ADB"]?.trim() || "adb";
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, { shell: false, windowsHide: true });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.byteLength;
      if (outputBytes <= MAX_OUTPUT_BYTES) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      outputBytes += chunk.byteLength;
      if (outputBytes <= MAX_OUTPUT_BYTES) stderr.push(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      const output = Buffer.concat(stdout).toString("utf8");
      const errorOutput = Buffer.concat(stderr).toString("utf8").trim();
      if (code === 0) resolve(output);
      else reject(new Error(`adb ${arguments_.join(" ")} failed with exit ${String(code)}: ${errorOutput}`));
    });
  });
}

async function main() {
  const result = await ensureAndroidDisplayReady({ executeAdb });
  process.stdout.write(`Android display ready after ${String(result.attempts)} attempt(s).\n`);
}

const entryPath = process.argv[1];
if (entryPath !== undefined && pathToFileURL(entryPath).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
