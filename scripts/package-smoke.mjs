import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import { removeTemporaryTree } from "./package-smoke-cleanup.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporaryPrefix = path.join(tmpdir(), "tvdoctor-package-smoke-");
const packageDefinitions = [
  ["@tvdoctor/baseline", "baseline"],
  ["tvdoctor", "cli"],
  ["@tvdoctor/core", "core"],
  ["@tvdoctor/driver-android", "driver-android"],
  ["@tvdoctor/driver-roku", "driver-roku"],
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

function runInstalledShim(shimPath, arguments_, options) {
  return runInstalledShimWithStatuses(shimPath, arguments_, [0], options);
}

function runInstalledShimWithStatuses(shimPath, arguments_, statuses, options) {
  if (process.platform !== "win32") return runWithStatuses(shimPath, arguments_, statuses, options);
  return runWithStatuses(
    process.env.ComSpec ?? "cmd.exe",
    ["/d", "/s", "/c", shimPath, ...arguments_],
    statuses,
    options,
  );
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
      ...options.env,
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
  if (packageName === "tvdoctor") {
    required.add("dist/demo-fixture/index.html");
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

async function verifyPublicationClosure() {
  const manifests = new Map();
  const directoryByName = new Map();
  for (const [name, directory] of packageDefinitions) {
    const manifest = JSON.parse(await readFile(path.join(repositoryRoot, "packages", directory, "package.json"), "utf8"));
    if (manifest.name !== name || manifest.private === true) {
      throw new Error(`${name} is missing or is no longer a publishable workspace.`);
    }
    if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(manifest.version)) {
      throw new Error(`${name} has no valid publishable version.`);
    }
    manifests.set(name, manifest);
    directoryByName.set(name, directory);
  }

  // New public workspaces must be part of the release proof.
  for (const entry of await readdir(path.join(repositoryRoot, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let manifest;
    try {
      manifest = JSON.parse(await readFile(path.join(repositoryRoot, "packages", entry.name, "package.json"), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (manifest.private !== true && !directoryByName.has(manifest.name)) {
      throw new Error(`Public workspace ${manifest.name} is missing from package smoke coverage.`);
    }
  }

  const lock = JSON.parse(await readFile(path.join(repositoryRoot, "package-lock.json"), "utf8"));
  for (const [name, manifest] of manifests) {
    const directory = directoryByName.get(name);
    const locked = lock.packages?.[`packages/${directory}`];
    if (locked?.version !== manifest.version) {
      throw new Error(`${name} manifest version ${manifest.version} does not match the lockfile.`);
    }
    for (const [dependency, version] of Object.entries(manifest.dependencies ?? {})) {
      if (dependency.startsWith("@tvdoctor/") && !manifests.has(dependency)) {
        throw new Error(`${name} depends on unaccounted public workspace ${dependency}.`);
      }
      if (manifests.has(dependency) && version !== manifests.get(dependency).version) {
        throw new Error(`${name} depends on ${dependency}@${version}, expected ${manifests.get(dependency).version}.`);
      }
      if (locked.dependencies?.[dependency] !== version) {
        throw new Error(`${name} dependency ${dependency}@${version} is out of sync with the lockfile.`);
      }
    }

    // Check emitted runtime JS and public declarations for undeclared imports.
    const distRoot = path.join(repositoryRoot, "packages", directory, "dist");
    const pending = [distRoot];
    while (pending.length > 0) {
      const folder = pending.pop();
      for (const file of await readdir(folder, { withFileTypes: true })) {
        const fullPath = path.join(folder, file.name);
        if (file.isDirectory()) {
          pending.push(fullPath);
        } else if (/\.(?:js|d\.ts)$/u.test(file.name)) {
          const contents = await readFile(fullPath, "utf8");
          const regex = /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\(|\bimport\s*)["'](@tvdoctor\/[a-z0-9-]+|playwright(?:-core)?)(?:\/[^"']*)?["']/gu;
          for (const match of contents.matchAll(regex)) {
            const dependency = match[1];
            if (dependency !== name && !Object.hasOwn(manifest.dependencies ?? {}, dependency)) {
              throw new Error(`${name} publishes ${path.relative(distRoot, fullPath)} importing undeclared dependency ${dependency}.`);
            }
          }
        }
      }
    }
  }
  return manifests;
}

async function runPublishPreflight(manifests) {
  for (const definition of packageDefinitions) {
    const [name] = definition;
    const publication = runNpm(["publish", "--dry-run", "--ignore-scripts", "--json", "--workspace", name], {
      timeout: 5 * 60 * 1000,
    });
    const json = JSON.parse(publication.stdout);
    const packResult = json[name];
    if (packResult === undefined) throw new Error(`${name} did not return a package from npm publish --dry-run.`);
    verifyPackResult(definition, manifests.get(name), packResult);
    process.stdout.write(`publish --dry-run ${name}@${packResult.version}: PASS (${packResult.entryCount} files)\n`);
  }
  process.stdout.write("release package preflight: GO (packaging only; registry and hosted CI remain separate gates)\n");
}

async function main() {
  if (!process.argv.includes("--preflight")) {
    // A clean checkout may have no dist files yet. The normal smoke builds
    // them before checking the artifacts that consumers will actually import.
    runNpm(["run", "build:packages"], { timeout: 10 * 60 * 1000 });
  }
  const manifests = await verifyPublicationClosure();
  if (process.argv.includes("--preflight")) {
    await runPublishPreflight(manifests);
    return;
  }
  const temporaryRoot = await mkdtemp(temporaryPrefix);
  const resolvedTemporaryRoot = path.resolve(temporaryRoot);
  if (path.dirname(resolvedTemporaryRoot) !== path.resolve(tmpdir())
    || !path.basename(resolvedTemporaryRoot).startsWith("tvdoctor-package-smoke-")) {
    throw new Error(`Refusing to use unsafe temporary path: ${resolvedTemporaryRoot}`);
  }

  try {
    const tarballDirectory = path.join(resolvedTemporaryRoot, "tarballs");
    const consumerDirectory = path.join(resolvedTemporaryRoot, "consumer");
    const globalPrefixDirectory = path.join(resolvedTemporaryRoot, "global-prefix");
    await mkdir(tarballDirectory);
    await mkdir(consumerDirectory);
    await mkdir(globalPrefixDirectory);

    const tarballs = [];
    const exportSpecifiers = [];
    let cliVersion;
    for (const definition of packageDefinitions) {
      const [packageName, packageDirectory] = definition;
      const manifestPath = path.join(repositoryRoot, "packages", packageDirectory, "package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (packageName === "tvdoctor") cliVersion = manifest.version;
      runNpm(["run", "prepack", "--workspace", packageName], {
        timeout: 10 * 60 * 1000,
      });
      const packed = runNpm([
        "pack",
        "--ignore-scripts",
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
    if (typeof cliVersion !== "string" || cliVersion.length === 0) {
      throw new Error("The tvdoctor package manifest does not declare a version.");
    }

    await writeFile(path.join(consumerDirectory, "package.json"), `${JSON.stringify({
      name: "tvdoctor-package-consumer-smoke",
      version: "1.0.0",
      private: true,
      type: "module",
    }, null, 2)}\n`);
    runNpm(["install", "--install-strategy=nested", "--no-audit", "--no-fund", ...tarballs], {
      cwd: consumerDirectory,
      timeout: 10 * 60 * 1000,
    });
    const consumerCliPath = process.platform === "win32"
      ? path.join(consumerDirectory, "node_modules", ".bin", "tvdoctor.cmd")
      : path.join(consumerDirectory, "node_modules", ".bin", "tvdoctor");
    const consumerCli = await stat(consumerCliPath);
    if (!consumerCli.isFile() || consumerCli.size === 0) {
      throw new Error(`Consumer install did not create a usable CLI shim at ${consumerCliPath}.`);
    }

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
      if (asset.protocolVersion !== 2
        || !/^[0-9a-f]{64}$/u.test(asset.sha256)
        || !/^[0-9a-f]{64}$/u.test(asset.certificateSha256)) {
        throw new Error("Installed observer asset verification failed");
      }
      process.stdout.write("installed observer asset checksum: PASS\\n");
    `], { cwd: consumerDirectory });
    process.stdout.write(observerVerification.stdout);

    const help = runInstalledShim(consumerCliPath, ["--help"], {
      cwd: consumerDirectory,
    });
    if (!help.stdout.includes("TVDoctor") || !help.stdout.includes("Commands:")) {
      throw new Error("The installed CLI help output is incomplete.");
    }

    const version = runInstalledShim(consumerCliPath, ["--version"], {
      cwd: consumerDirectory,
    });
    if (version.stdout.trim() !== `tvdoctor ${cliVersion}`) {
      throw new Error(`Unexpected installed CLI version output: ${version.stdout.trim()}`);
    }

    const npxOptions = {
      cwd: consumerDirectory,
      env: { npm_config_offline: "true" },
    };
    const npxVersion = runNpx(["--no-install", "-c", "tvdoctor --version"], npxOptions);
    if (npxVersion.stdout.trim() !== `tvdoctor ${cliVersion}`) {
      throw new Error(`Unexpected offline npx CLI version output: ${npxVersion.stdout.trim()}`);
    }
    const npxHelp = runNpx(["--no-install", "-c", "tvdoctor --help"], npxOptions);
    if (!npxHelp.stdout.includes("TVDoctor") || !npxHelp.stdout.includes("Commands:")) {
      throw new Error("Offline npx did not execute the installed TVDoctor help surface.");
    }
    process.stdout.write("clean-consumer offline npx --version/--help: PASS\n");

    const demoOutput = path.join(resolvedTemporaryRoot, "installed-demo-report");
    const demo = runInstalledShim(consumerCliPath, ["demo", "--output", demoOutput], {
      cwd: consumerDirectory,
      timeout: 5 * 60 * 1000,
    });
    if (!demo.stdout.includes("Demo VERIFIED") || !demo.stdout.includes("Replay: REPRODUCED")) {
      throw new Error(`Installed demo did not verify its seeded finding and replay:\n${demo.stdout}`);
    }
    const demoReportPath = path.join(demoOutput, "report.json");
    await statReport(demoReportPath, "installed deterministic demo");
    const demoReport = JSON.parse(await readFile(demoReportPath, "utf8"));
    const demoIssues = Array.isArray(demoReport.issues) ? demoReport.issues : [];
    const demoReplays = Array.isArray(demoReport.replays) ? demoReport.replays : [];
    const seededIssue = demoIssues.find((issue) => issue?.rule === "remote.reachability"
      && issue?.transition?.fromElement === "hero-watch"
      && issue?.transition?.action === "RIGHT"
      && issue?.transition?.expectedElement === "hero-more-info"
      && issue?.transition?.observedElement === "hero-watch");
    if (seededIssue === undefined || !demoReplays.some((replay) => replay?.issueId === seededIssue.id)) {
      throw new Error("Installed demo report is missing its seeded Home More info issue or correlated replay.");
    }
    process.stdout.write("installed deterministic demo and replay: PASS\n");

    const persistedDemoReplay = runInstalledShimWithStatuses(
      consumerCliPath,
      ["replay", seededIssue.id, "--report", demoReportPath],
      [1],
      { cwd: consumerDirectory, timeout: 5 * 60 * 1000 },
    );
    if (!persistedDemoReplay.stdout.includes("Replay classification REPRODUCED")) {
      throw new Error(`Saved demo replay was not portable after the demo server stopped:\n${persistedDemoReplay.stdout}`);
    }
    process.stdout.write("installed saved demo replay after server shutdown: PASS\n");

    const demoInventoryPath = path.join(demoOutput, "inventory.json");
    await statReport(demoInventoryPath, "installed deterministic demo inventory");
    const baselinePath = path.join(resolvedTemporaryRoot, "installed-demo-baseline.json");
    const baselineCreate = runInstalledShim(consumerCliPath, [
      "baseline", "create",
      "--report", demoReportPath,
      "--inventory", demoInventoryPath,
      "--output", baselinePath,
    ], { cwd: consumerDirectory });
    if (!baselineCreate.stdout.includes("Baseline created from")) {
      throw new Error(`Installed baseline create did not confirm output:\n${baselineCreate.stdout}`);
    }
    await statReport(baselinePath, "installed baseline create");
    const baselineComparisonPath = path.join(resolvedTemporaryRoot, "installed-demo-comparison.json");
    const baselineCompare = runInstalledShim(consumerCliPath, [
      "baseline", "compare",
      "--baseline", baselinePath,
      "--report", demoReportPath,
      "--inventory", demoInventoryPath,
      "--output", baselineComparisonPath,
    ], { cwd: consumerDirectory });
    if (!baselineCompare.stdout.includes("Baseline result: IDENTICAL")) {
      throw new Error(`Installed baseline compare did not report an identical controlled fixture:\n${baselineCompare.stdout}`);
    }
    await statReport(baselineComparisonPath, "installed baseline comparison");
    await statReport(baselineComparisonPath.replace(/\.json$/u, ".md"), "installed baseline comparison Markdown");
    process.stdout.write("installed baseline create and compare on controlled demo: PASS\n");

    runNpm(["install", "--global", "--install-strategy=nested", "--no-audit", "--no-fund", "--prefix", globalPrefixDirectory, ...tarballs], {
      timeout: 10 * 60 * 1000,
    });
    const globalCliPath = process.platform === "win32"
      ? path.join(globalPrefixDirectory, "tvdoctor.cmd")
      : path.join(globalPrefixDirectory, "bin", "tvdoctor");
    const globalCli = await stat(globalCliPath);
    if (!globalCli.isFile() || globalCli.size === 0) {
      throw new Error(`Global install did not create a usable CLI shim at ${globalCliPath}.`);
    }
    const globalVersion = runInstalledShim(globalCliPath, ["--version"]);
    if (globalVersion.stdout.trim() !== `tvdoctor ${cliVersion}`) {
      throw new Error(`Unexpected global CLI version output: ${globalVersion.stdout.trim()}`);
    }
    process.stdout.write("global npm install and tvdoctor shim: PASS\n");

    const doctor = runInstalledShim(consumerCliPath, ["doctor"], {
      cwd: consumerDirectory,
      timeout: 2 * 60 * 1000,
    });
    if (!doctor.stdout.includes("TVDoctor environment diagnosis")) {
      throw new Error("The installed CLI doctor output is incomplete.");
    }

    const setupHelp = runInstalledShim(consumerCliPath, ["setup", "--help"], {
      cwd: consumerDirectory,
    });
    if (!setupHelp.stdout.includes("matched to this TVDoctor version")) {
      throw new Error("The installed CLI setup help is incomplete.");
    }

    const ciHelp = runInstalledShim(consumerCliPath, ["ci", "--help"], {
      cwd: consumerDirectory,
    });
    if (!ciHelp.stdout.includes("--fail-on LEVEL") || !ciHelp.stdout.includes("junit.xml")) {
      throw new Error("The installed CLI CI help is incomplete.");
    }

    const baselineHelp = runInstalledShim(consumerCliPath, ["baseline", "--help"], {
      cwd: consumerDirectory,
    });
    if (!baselineHelp.stdout.includes("baseline create") || !baselineHelp.stdout.includes("baseline compare")) {
      throw new Error("The installed CLI baseline help is incomplete.");
    }

    const accessibilityHelp = runInstalledShim(consumerCliPath, ["accessibility", "--help"], {
      cwd: consumerDirectory,
    });
    if (!accessibilityHelp.stdout.includes("streaming and")
      || !accessibilityHelp.stdout.includes("does not prove TalkBack")) {
      throw new Error("The installed CLI accessibility help is incomplete.");
    }

    const testHelp = runInstalledShim(consumerCliPath, ["test", "--help"], { cwd: consumerDirectory });
    if (!testHelp.stdout.includes("--apk PATH") || !testHelp.stdout.includes("--device SERIAL")) {
      throw new Error("The installed CLI Android test help is incomplete.");
    }
    const replayHelp = runInstalledShim(consumerCliPath, ["replay", "--help"], { cwd: consumerDirectory });
    if (!replayHelp.stdout.includes("--apk PATH") || !replayHelp.stdout.includes("--device SERIAL")) {
      throw new Error("The installed CLI Android replay help is incomplete.");
    }
    const guidedStart = runInstalledShimWithStatuses(consumerCliPath, ["start"], [2], { cwd: consumerDirectory });
    if (!guidedStart.stderr.includes("requires an interactive terminal")) {
      throw new Error("The installed guided start surface did not fail safely without a TTY.");
    }

    const webUrl = process.env["TVDOCTOR_PACKAGE_SMOKE_WEB_URL"];
    if (webUrl !== undefined) {
      const webOutput = path.join(resolvedTemporaryRoot, "installed-web-report");
      const web = runInstalledShimWithStatuses(consumerCliPath, [
        "test", webUrl,
        "--pack", "navigation", "--mode", "quick", "--max-duration-ms", "30000",
        "--output", webOutput,
      ], [0, 1, 3], { cwd: consumerDirectory, timeout: 3 * 60 * 1000 });
      await statReport(path.join(webOutput, "report.json"), "installed website audit");
      process.stdout.write(`installed website path: PASS (${web.stdout.match(/Result:\s+([^\r\n]+)/u)?.[1] ?? "report written"})\n`);
    } else {
      process.stdout.write("installed external website path: SKIPPED (TVDOCTOR_PACKAGE_SMOKE_WEB_URL not set)\n");
    }

    const androidApk = process.env["TVDOCTOR_PACKAGE_SMOKE_ANDROID_APK"];
    const androidSerial = process.env["TVDOCTOR_PACKAGE_SMOKE_ANDROID_SERIAL"];
    if ((androidApk === undefined) !== (androidSerial === undefined)) {
      throw new Error("Set both TVDOCTOR_PACKAGE_SMOKE_ANDROID_APK and TVDOCTOR_PACKAGE_SMOKE_ANDROID_SERIAL.");
    }
    if (androidApk !== undefined && androidSerial !== undefined) {
      const androidOutput = path.join(resolvedTemporaryRoot, "installed-android-report");
      const android = runInstalledShimWithStatuses(consumerCliPath, [
        "test", "--apk", path.resolve(repositoryRoot, androidApk),
        "--device", androidSerial, "--mode", "quick", "--output", androidOutput,
      ], [0, 1], { cwd: consumerDirectory, timeout: 5 * 60 * 1000 });
      const reportPath = path.join(androidOutput, "report.json");
      await statReport(reportPath, "installed Android audit");
      const report = JSON.parse(await readFile(reportPath, "utf8"));
      const issueId = report.issues?.[0]?.id;
      if (typeof issueId !== "string") throw new Error("Installed Android audit did not produce its expected fixture issue.");
      const replay = runInstalledShimWithStatuses(consumerCliPath, [
        "replay", issueId, "--report", reportPath,
        "--apk", path.resolve(repositoryRoot, androidApk), "--device", androidSerial,
      ], [1], { cwd: consumerDirectory, timeout: 3 * 60 * 1000 });
      if (!replay.stdout.includes("Replay classification REPRODUCED")) {
        throw new Error("Installed Android replay did not reproduce its finding.");
      }
      process.stdout.write(`installed Android path and replay: PASS (${android.stdout.match(/Result:\s+([^\r\n]+)/u)?.[1] ?? "report written"})\n`);
    } else {
      process.stdout.write("installed external Android path: SKIPPED (TVDOCTOR_PACKAGE_SMOKE_ANDROID_APK/TVDOCTOR_PACKAGE_SMOKE_ANDROID_SERIAL not set)\n");
    }

    process.stdout.write("installed CLI local contracts: --help, --version, doctor, setup/ci/baseline/accessibility/test/replay help, and start non-TTY behavior: PASS\n");
  } finally {
    await cleanupSmokeDirectory(resolvedTemporaryRoot);
  }
  process.stdout.write("package smoke: PASS\n");
}

async function cleanupSmokeDirectory(directory) {
  try {
    await removeTemporaryTree(directory);
  } catch (error) {
    if (process.platform !== "win32" || !["EBUSY", "ENOTEMPTY", "EPERM"].includes(error.code)) {
      throw error;
    }
    // Use Windows' native long-path deletion if the bounded Node retries
    // were exhausted. Pass the owned temp path as data, never shell text.
    const script = [
      "$target = [IO.Path]::GetFullPath($env:TVDOCTOR_SMOKE_OWNED_TEMP)",
      "$parent = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\\', '/')",
      "$prefix = $parent + [IO.Path]::DirectorySeparatorChar",
      "if (-not $target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or -not [IO.Path]::GetFileName($target).StartsWith('tvdoctor-package-smoke-', [StringComparison]::Ordinal)) { throw 'Unsafe smoke cleanup target' }",
      "for ($i = 0; $i -lt 8; $i++) {",
      "  if (-not [IO.Directory]::Exists($target)) { exit 0 }",
      "  try { [IO.Directory]::Delete('\\\\?\\' + $target, $true); exit 0 }",
      "  catch { if ($i -eq 7) { throw }; Start-Sleep -Milliseconds 500 }",
      "}",
    ].join("; ");
    const fallback = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, TVDOCTOR_SMOKE_OWNED_TEMP: directory },
      timeout: 15_000,
    });
    if (fallback.status !== 0 || fallback.error !== undefined) {
      throw new AggregateError([error, fallback.error ?? new Error(fallback.stderr)],
        `Windows smoke cleanup failed for owned temp directory ${directory}`, { cause: error });
    }
    process.stdout.write("package smoke Windows native cleanup fallback: PASS\n");
  }
}

async function statReport(reportPath, label) {
  const metadata = await stat(reportPath);
  if (!metadata.isFile() || metadata.size <= 0) throw new Error(`${label} did not write a report.`);
}

await main();
