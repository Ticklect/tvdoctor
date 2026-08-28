import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporaryPrefix = path.join(tmpdir(), "tvdoctor-package-smoke-");
const packageDefinitions = [
  ["@tvdoctor/baseline", "baseline"],
  ["tvdoctor", "cli"],
  ["@tvdoctor/core", "core"],
  ["@tvdoctor/driver-android", "driver-android"],
  ["@tvdoctor/driver-web", "driver-web"],
  ["@tvdoctor/pack-streaming", "pack-streaming"],
  ["@tvdoctor/pack-web", "pack-web"],
  ["@tvdoctor/protocol", "protocol"],
  ["@tvdoctor/reporters", "reporters"],
];

const npmCliPath = process.env.npm_execpath;
if (npmCliPath === undefined || !path.isAbsolute(npmCliPath)) {
  throw new Error("Run the package smoke through npm so its cross-platform CLI entry point is available.");
}
const npxCliPath = path.join(path.dirname(npmCliPath), "npx-cli.js");

function runNpm(arguments_, options) {
  return run(process.execPath, [npmCliPath, ...arguments_], options);
}

function runNpx(arguments_, options) {
  return run(process.execPath, [npxCliPath, ...arguments_], options);
}

function runNpxWithStatuses(arguments_, statuses, options) {
  return runWithStatuses(process.execPath, [npxCliPath, ...arguments_], statuses, options);
}

function run(command, arguments_, options = {}) {
  return runWithStatuses(command, arguments_, [0], options);
}

function runWithStatuses(command, arguments_, statuses, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
    },
    maxBuffer: 20 * 1024 * 1024,
    timeout: options.timeout ?? 5 * 60 * 1000,
  });

  if (result.error !== undefined) {
    throw result.error;
  }
  if (!statuses.includes(result.status)) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${arguments_.join(" ")} exited ${result.status}${detail === "" ? "" : `:\n${detail}`}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function normalisePackagePath(value) {
  return value.replace(/^\.\//u, "").replaceAll("\\", "/");
}

function declaredExportSpecifiers(packageName, exportsField) {
  if (exportsField === undefined) return [packageName];
  if (typeof exportsField === "string" || Array.isArray(exportsField)) return [packageName];
  if (exportsField === null || typeof exportsField !== "object") {
    throw new TypeError(`${packageName} has an invalid exports field.`);
  }

  const keys = Object.keys(exportsField);
  if (keys.length === 0 || keys.every((key) => !key.startsWith("."))) {
    return [packageName];
  }
  return keys
    .filter((key) => !key.includes("*"))
    .map((key) => key === "." ? packageName : `${packageName}${key.slice(1)}`);
}

function verifyPackResult(definition, manifest, packResult) {
  const [packageName] = definition;
  if (packResult.name !== packageName || packResult.version !== manifest.version) {
    throw new Error(`${packageName} tarball identity does not match its manifest.`);
  }

  const entries = new Map(packResult.files.map((entry) => [normalisePackagePath(entry.path), entry]));
  const required = new Set([
    "package.json",
    "README.md",
    "LICENSE",
    normalisePackagePath(manifest.main),
    normalisePackagePath(manifest.types),
  ]);
  if (manifest.bin !== undefined) {
    for (const binPath of Object.values(manifest.bin)) required.add(normalisePackagePath(binPath));
  }
  if (packageName === "@tvdoctor/driver-android") {
    required.add("observer/tvdoctor-observer.apk");
    required.add("observer/observer-manifest.json");
  }

  const missing = [...required].filter((entry) => !entries.has(entry));
  if (missing.length > 0) {
    throw new Error(`${packageName} tarball is missing: ${missing.join(", ")}`);
  }

  for (const [entryPath, entry] of entries) {
    const allowed = entryPath === "package.json"
      || entryPath === "README.md"
      || entryPath === "LICENSE"
      || entryPath.startsWith("dist/")
      || (packageName === "@tvdoctor/driver-android"
        && (entryPath === "observer/tvdoctor-observer.apk"
          || entryPath === "observer/observer-manifest.json"));
    if (!allowed) {
      throw new Error(`${packageName} unexpectedly packs ${entryPath}.`);
    }
    if (/(^|\/)(?:\.env(?:\.|$)|\.npmrc$|id_rsa$|id_ed25519$|credentials?|secrets?)(?:\/|$)/iu.test(entryPath)) {
      throw new Error(`${packageName} packs a secret-like path: ${entryPath}.`);
    }
    if (/\.(?:ts|tsx)$/u.test(entryPath) && !/\.d\.ts$/u.test(entryPath)) {
      throw new Error(`${packageName} packs TypeScript source: ${entryPath}.`);
    }
    if (required.has(entryPath) && entry.size === 0) {
      throw new Error(`${packageName} packs an empty required file: ${entryPath}.`);
    }
  }

  if (![...entries.keys()].some((entry) => /^dist\/.*\.js$/u.test(entry))) {
    throw new Error(`${packageName} tarball contains no runtime JavaScript.`);
  }
  if (![...entries.keys()].some((entry) => /^dist\/.*\.d\.ts$/u.test(entry))) {
    throw new Error(`${packageName} tarball contains no TypeScript declarations.`);
  }
}

async function main() {
  const temporaryRoot = await mkdtemp(temporaryPrefix);
  const resolvedTemporaryRoot = path.resolve(temporaryRoot);
  if (path.dirname(resolvedTemporaryRoot) !== path.resolve(tmpdir())
    || !path.basename(resolvedTemporaryRoot).startsWith("tvdoctor-package-smoke-")) {
    throw new Error(`Refusing to use unsafe temporary path: ${resolvedTemporaryRoot}`);
  }

  try {
    const tarballDirectory = path.join(resolvedTemporaryRoot, "tarballs");
    const consumerDirectory = path.join(resolvedTemporaryRoot, "consumer");
    await mkdir(tarballDirectory);
    await mkdir(consumerDirectory);

    const tarballs = [];
    const exportSpecifiers = [];
    for (const definition of packageDefinitions) {
      const [packageName, packageDirectory] = definition;
      const manifestPath = path.join(repositoryRoot, "packages", packageDirectory, "package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const packed = runNpm([
        "pack",
        "--json",
        "--silent",
        "--pack-destination",
        tarballDirectory,
        "--workspace",
        packageName,
      ], { timeout: 10 * 60 * 1000 });
      const packResults = JSON.parse(packed.stdout);
      if (!Array.isArray(packResults) || packResults.length !== 1) {
        throw new Error(`${packageName} returned an unexpected npm pack result.`);
      }
      verifyPackResult(definition, manifest, packResults[0]);

      const tarballPath = path.resolve(tarballDirectory, packResults[0].filename);
      if (path.dirname(tarballPath) !== path.resolve(tarballDirectory)) {
        throw new Error(`${packageName} returned an unsafe tarball path.`);
      }
      tarballs.push(tarballPath);
      exportSpecifiers.push(...declaredExportSpecifiers(packageName, manifest.exports));
      process.stdout.write(`packed ${packageName}: ${packResults[0].entryCount} files, ${packResults[0].unpackedSize} unpacked bytes\n`);
    }

    await writeFile(path.join(consumerDirectory, "package.json"), `${JSON.stringify({
      name: "tvdoctor-package-consumer-smoke",
      version: "1.0.0",
      private: true,
      type: "module",
    }, null, 2)}\n`);
    runNpm(["install", "--no-audit", "--no-fund", ...tarballs], {
      cwd: consumerDirectory,
      timeout: 10 * 60 * 1000,
    });

    const importProgram = `
      const specifiers = ${JSON.stringify(exportSpecifiers)};
      for (const specifier of specifiers) {
        const namespace = await import(specifier);
        if (Object.keys(namespace).length === 0) {
          throw new Error(specifier + " exported an empty module namespace");
        }
        process.stdout.write("imported " + specifier + "\\n");
      }
    `;
    const imports = run(process.execPath, ["--input-type=module", "--eval", importProgram], {
      cwd: consumerDirectory,
    });
    process.stdout.write(imports.stdout);

    const observerVerification = run(process.execPath, ["--input-type=module", "--eval", `
      const { resolveAndroidObserverAsset } = await import("@tvdoctor/driver-android");
      const asset = await resolveAndroidObserverAsset();
      if (asset.protocolVersion !== 2 || !/^[0-9a-f]{64}$/u.test(asset.sha256)) {
        throw new Error("Installed observer asset verification failed");
      }
      process.stdout.write("installed observer asset checksum: PASS\\n");
    `], { cwd: consumerDirectory });
    process.stdout.write(observerVerification.stdout);

    const help = runNpx(["--no-install", "tvdoctor", "--help"], {
      cwd: consumerDirectory,
    });
    if (!help.stdout.includes("TVDoctor") || !help.stdout.includes("Commands:")) {
      throw new Error("The installed CLI help output is incomplete.");
    }

    const version = runNpx(["--no-install", "tvdoctor", "--version"], {
      cwd: consumerDirectory,
    });
    if (!/^tvdoctor 0\.1\.0\s*$/u.test(version.stdout)) {
      throw new Error(`Unexpected installed CLI version output: ${version.stdout.trim()}`);
    }

    const doctor = runNpx(["--no-install", "tvdoctor", "doctor"], {
      cwd: consumerDirectory,
      timeout: 2 * 60 * 1000,
    });
    if (!doctor.stdout.includes("TVDoctor environment diagnosis")) {
      throw new Error("The installed CLI doctor output is incomplete.");
    }

    const testHelp = runNpx(["--no-install", "tvdoctor", "test", "--help"], { cwd: consumerDirectory });
    if (!testHelp.stdout.includes("--apk PATH") || !testHelp.stdout.includes("--device SERIAL")) {
      throw new Error("The installed CLI Android test help is incomplete.");
    }
    const replayHelp = runNpx(["--no-install", "tvdoctor", "replay", "--help"], { cwd: consumerDirectory });
    if (!replayHelp.stdout.includes("--apk PATH") || !replayHelp.stdout.includes("--device SERIAL")) {
      throw new Error("The installed CLI Android replay help is incomplete.");
    }
    const guidedStart = runNpxWithStatuses(["--no-install", "tvdoctor", "start"], [2], { cwd: consumerDirectory });
    if (!guidedStart.stderr.includes("requires an interactive terminal")) {
      throw new Error("The installed guided start surface did not fail safely without a TTY.");
    }

    const webUrl = process.env["TVDOCTOR_PACKAGE_SMOKE_WEB_URL"];
    if (webUrl !== undefined) {
      const webOutput = path.join(resolvedTemporaryRoot, "installed-web-report");
      const web = runNpxWithStatuses([
        "--no-install", "tvdoctor", "test", webUrl,
        "--pack", "navigation", "--mode", "quick", "--max-duration-ms", "30000",
        "--output", webOutput,
      ], [0, 1, 3], { cwd: consumerDirectory, timeout: 3 * 60 * 1000 });
      await statReport(path.join(webOutput, "report.json"), "installed website audit");
      process.stdout.write(`installed website path: PASS (${web.stdout.match(/Result:\s+([^\r\n]+)/u)?.[1] ?? "report written"})\n`);
    }

    const androidApk = process.env["TVDOCTOR_PACKAGE_SMOKE_ANDROID_APK"];
    const androidSerial = process.env["TVDOCTOR_PACKAGE_SMOKE_ANDROID_SERIAL"];
    if ((androidApk === undefined) !== (androidSerial === undefined)) {
      throw new Error("Set both TVDOCTOR_PACKAGE_SMOKE_ANDROID_APK and TVDOCTOR_PACKAGE_SMOKE_ANDROID_SERIAL.");
    }
    if (androidApk !== undefined && androidSerial !== undefined) {
      const androidOutput = path.join(resolvedTemporaryRoot, "installed-android-report");
      const android = runNpxWithStatuses([
        "--no-install", "tvdoctor", "test", "--apk", path.resolve(repositoryRoot, androidApk),
        "--device", androidSerial, "--mode", "quick", "--output", androidOutput,
      ], [0, 1], { cwd: consumerDirectory, timeout: 5 * 60 * 1000 });
      const reportPath = path.join(androidOutput, "report.json");
      await statReport(reportPath, "installed Android audit");
      const report = JSON.parse(await readFile(reportPath, "utf8"));
      const issueId = report.issues?.[0]?.id;
      if (typeof issueId !== "string") throw new Error("Installed Android audit did not produce its expected fixture issue.");
      const replay = runNpxWithStatuses([
        "--no-install", "tvdoctor", "replay", issueId, "--report", reportPath,
        "--apk", path.resolve(repositoryRoot, androidApk), "--device", androidSerial,
      ], [1], { cwd: consumerDirectory, timeout: 3 * 60 * 1000 });
      if (!replay.stdout.includes("Replay classification REPRODUCED")) {
        throw new Error("Installed Android replay did not reproduce its finding.");
      }
      process.stdout.write(`installed Android path and replay: PASS (${android.stdout.match(/Result:\s+([^\r\n]+)/u)?.[1] ?? "report written"})\n`);
    }

    process.stdout.write("installed CLI start, test, replay, --help, --version, and doctor: PASS\n");
    process.stdout.write("package smoke: PASS\n");
  } finally {
    await rm(resolvedTemporaryRoot, { recursive: true, force: true });
  }
}

async function statReport(reportPath, label) {
  const metadata = await stat(reportPath);
  if (!metadata.isFile() || metadata.size <= 0) throw new Error(`${label} did not write a report.`);
}

await main();
