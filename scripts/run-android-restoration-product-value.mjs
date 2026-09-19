import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeSourceFiles = [
  "packages/core/src/explorer-contracts.ts",
  "packages/core/src/explorer-local-restoration.ts",
  "packages/core/src/explorer-options.ts",
  "packages/core/src/explorer-runtime.ts",
  "packages/cli/src/android-product.ts",
  "packages/cli/src/android-restoration-benchmark.ts",
  "scripts/run-android-restoration-product-value.mjs",
];
const runtimeBuildFiles = [
  "packages/core/dist/explorer-local-restoration.js",
  "packages/core/dist/explorer-options.js",
  "packages/core/dist/explorer-runtime.js",
  "packages/cli/dist/android-product.js",
  "packages/cli/dist/android-restoration-benchmark.js",
];
const apps = {
  vlc: {
    label: "VLC 3.7.1",
    apk: "Tests/real-apps-2026-09-19/android/rerun-apks/vlc-3.7.1.apk",
    component: "org.videolan.vlc/org.videolan.vlc.StartActivity",
  },
  moonlight: {
    label: "Moonlight 12.2",
    apk: "Tests/real-apps-2026-09-19/android/rerun-apks/moonlight-12.2.apk",
    component: "com.limelight/com.limelight.PcView",
  },
  flauncher: {
    label: "FLauncher 2025.07.001",
    apk: "Tests/real-apps-2026-09-19/android/rerun-apks/flauncher-2025.07.001.apk",
    component: "me.efesser.flauncher/me.efesser.flauncher.MainActivity",
  },
  nova: {
    label: "Nova 6.4.64",
    apk: "Tests/real-apps-2026-09-19/android/rerun-apks/nova-6.4.64.apk",
    component: "org.courville.nova/com.archos.mediacenter.video.leanback.MainActivityLeanback",
  },
};

function argumentsMap(values) {
  const result = new Map();
  for (let index = 2; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("Expected --name value arguments.");
    result.set(key.slice(2), value);
  }
  return result;
}

function command(command, args) {
  try {
    return execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function combinedFileHash(paths) {
  const digest = createHash("sha256");
  for (const path of paths) {
    digest.update(path);
    digest.update("\0");
    digest.update(await readFile(resolve(root, path)));
    digest.update("\0");
  }
  return digest.digest("hex");
}

function buildRuntime() {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  execFileSync(npm, ["run", "build", "--workspace", "tvdoctor", "--", "--force"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const parsed = argumentsMap(process.argv);
const appKey = parsed.get("app");
const requestedVariant = parsed.get("variant");
const variant = requestedVariant === "enabled" ? "restoration" : requestedVariant;
const device = parsed.get("device");
const output = parsed.get("output");
const adb = parsed.get("adb") ?? "adb";
if (!(appKey in apps) || !["baseline", "restoration"].includes(variant) || device === undefined || output === undefined) {
  throw new Error("Usage: node scripts/run-android-restoration-product-value.mjs --app vlc|moonlight|flauncher|nova --variant baseline|enabled --device SERIAL --output PATH [--adb PATH]");
}

const app = apps[appKey];
const outputPath = resolve(root, output);
const apkPath = [resolve(root, app.apk), resolve(root, "..", "..", app.apk)].find((candidate) => existsSync(candidate));
if (apkPath === undefined) throw new Error(`APK not found for ${app.label}: ${app.apk}`);
buildRuntime();
const { scanAndroidApkForRestorationBenchmark } = await import("../packages/cli/dist/android-product.js");
const restorationMode = variant === "baseline" ? "verified-live-only" : "verified-local";
const [apkSha256, runtimeSourceSha256, runtimeBuildSha256] = await Promise.all([
  sha256File(apkPath),
  combinedFileHash(runtimeSourceFiles),
  combinedFileHash(runtimeBuildFiles),
]);
const startedAt = new Date().toISOString();
let scanResult;
let thrown = null;
try {
  scanResult = await scanAndroidApkForRestorationBenchmark({
    adbPath: adb,
    serial: device,
    apkPath,
    mode: "deep",
    outputPath,
    restorationMode,
    launchComponent: app.component,
  });
} catch (error) {
  thrown = error instanceof Error ? error.message : String(error);
}

const metadata = {
  schema: "tvdoctor.android-restoration-product-value-run/v1",
  app: appKey,
  label: app.label,
  variant,
  device,
  apk: app.apk,
  launchComponent: app.component,
  apkSha256,
  sourceProvenance: {
    gitHead: command("git", ["rev-parse", "HEAD"]),
    gitStatus: command("git", ["status", "--short", "--", ...runtimeSourceFiles]),
    runtimeSourceSha256,
    runtimeBuildSha256,
  },
  startedAt,
  completedAt: new Date().toISOString(),
  environment: {
    sdk: command(adb, ["-s", device, "shell", "getprop", "ro.build.version.sdk"]),
    buildFingerprint: command(adb, ["-s", device, "shell", "getprop", "ro.build.fingerprint"]),
    displaySize: command(adb, ["-s", device, "shell", "wm", "size"]),
    displayDensity: command(adb, ["-s", device, "shell", "wm", "density"]),
  },
  traversal: {
    mode: "deep",
    policy: "adaptive",
    restorationMode,
    definition: restorationMode === "verified-live-only"
      ? "exact verified live-state continuation only; verified local-path reconstruction and root replay disabled"
      : "verified live-state continuation plus verified local-path reconstruction and bounded root replay fallback",
  },
  result: scanResult ?? null,
  error: thrown,
};
if (!existsSync(outputPath)) await mkdir(outputPath, { recursive: false });
await writeFile(resolve(outputPath, "benchmark-run-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
if (thrown !== null) throw new Error(thrown);
process.stdout.write(`${app.label} ${variant}: ${scanResult.status}; ${scanResult.issueCount} issue(s); ${scanResult.reportPath ?? "no report"}\n`);
if (scanResult.status === "failed" || scanResult.status === "setup-blocker") process.exitCode = 2;
