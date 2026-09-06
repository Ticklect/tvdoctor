import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, constants, readFile, stat, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import {
  EXPLORATION_BUDGET_PROFILES,
  compileIssueReplay,
  diagnoseNavigation,
  explore,
  type ExplorationBudgets,
  type ExplorationProgress,
  type ExplorationResult,
} from "@tvdoctor/core";
import {
  AndroidTvDriver,
  resolveAdbExecutable,
} from "@tvdoctor/driver-android";
import type {
  AndroidDeviceMetadata,
  AndroidStateSnapshot,
  AndroidUiNodeSnapshot,
} from "@tvdoctor/driver-android";
import type { ArtifactDescriptor, CoverageBudget } from "@tvdoctor/protocol";
import {
  buildTVDoctorReportV1,
  sanitiseEvidenceJson,
  stableJson,
  type JsonValue,
} from "@tvdoctor/reporters";
import { CLI_VERSION } from "./version.js";
import { reserveAuditOutput } from "./node-audit.js";
import { writeReportBundle } from "@tvdoctor/reporters";

const execFileAsync = promisify(execFile);

export const ANDROID_EXPLORATION_BUDGETS: Readonly<Record<
  AndroidScanOptions["mode"],
  ExplorationBudgets
>> = {
  quick: {
    ...EXPLORATION_BUDGET_PROFILES.quick,
    maxDurationMs: 720_000,
  },
  deep: EXPLORATION_BUDGET_PROFILES.deep,
};

export const ANDROID_ACTION_SETTLING = {
  strategy: "stable-snapshot",
  maxSnapshots: 6,
  requiredStableSnapshots: 3,
  pollIntervalMs: 250,
  keyOverrides: {
    SELECT: { maxSnapshots: 14, requiredStableSnapshots: 7 },
    BACK: { maxSnapshots: 14, requiredStableSnapshots: 7 },
  },
} as const;

async function fileArtifact(
  outputRoot: string,
  path: string,
  id: string,
  kind: "report",
  mediaType: string,
): Promise<ArtifactDescriptor> {
  const data = await readFile(path);
  const metadata = await stat(path);
  return {
    id,
    kind,
    status: "available",
    path: relative(outputRoot, path).split(sep).join("/"),
    mediaType,
    byteLength: metadata.size,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}
export interface AndroidPreflightDevice {
  readonly serial: string;
  readonly state: string;
  readonly online: boolean;
  readonly model: string | null;
  readonly manufacturer: string | null;
  readonly apiLevel: number | null;
  readonly supportedAbis: readonly string[];
  readonly isTelevision: boolean | null;
  readonly detail: string | null;
}

export interface AndroidPreflightResult {
  readonly available: boolean;
  readonly adbPath: string | null;
  readonly message: string;
  readonly devices: readonly AndroidPreflightDevice[];
}

export interface ApkMetadata {
  readonly path: string;
  readonly packageName: string | null;
  readonly versionName: string | null;
  readonly launchableActivities: readonly string[];
  readonly leanbackActivity: string | null;
  readonly supportedAbis: readonly string[];
  readonly minSdk: number | null;
  readonly targetSdk: number | null;
  readonly label: string | null;
}

export interface ApkCompatibility {
  readonly compatible: boolean;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
}

export interface ApkInspectionDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly runTool?: (
    command: string,
    arguments_: readonly string[],
  ) => Promise<{ readonly stdout: string; readonly stderr: string }>;
  readonly toolCommands?: readonly string[];
  readonly exists?: (path: string) => Promise<boolean>;
}

interface BuildToolsCandidate {
  readonly directory: string;
  readonly name: string;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function firstMatch(value: string, pattern: RegExp): string | null {
  return pattern.exec(value)?.[1] ?? null;
}

function optionalNumber(value: string | null): number | null {
  if (value === null || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normaliseComponents(values: readonly string[], packageName: string): readonly string[] {
  return [...new Set(values)].map((value) => {
    if (value.startsWith(`${packageName}/`)) return value.slice(packageName.length + 1);
    if (value.startsWith(`${packageName}.`)) return `.${value.slice(packageName.length + 1)}`;
    return value.startsWith(".") ? value : `.${value}`;
  });
}

function parseBadging(output: string, apkPath: string): ApkMetadata {
  const packageLine = firstMatch(output, /^package: name='([^']+)'/mu);
  const version = firstMatch(output, /versionName='([^']*)'/u);
  const launchables = [...output.matchAll(/^launchable-activity: name='([^']+)'/gimu)]
    .map((match) => match[1] ?? "")
    .filter((value) => value.length > 0);
  const leanbacks = [...output.matchAll(/^leanback-launchable-activity:\s*name='([^']+)'/gimu)]
    .map((match) => match[1] ?? "")
    .filter((value) => value.length > 0);
  const abis = [...output.matchAll(/^native-code:\s*(.+)$/gimu)]
    .flatMap((match) => (match[1] ?? "").split(/\s+/u))
    .map((value) => value.replaceAll("'", ""))
    .filter((value) => value.length > 0);
  return {
    path: apkPath,
    packageName: packageLine,
    versionName: version,
    launchableActivities: normaliseComponents(launchables, packageLine ?? ""),
    leanbackActivity: leanbacks.length === 0
      ? null
      : normaliseComponents(leanbacks, packageLine ?? "")[0] ?? null,
    supportedAbis: [...new Set(abis)],
    minSdk: optionalNumber(
      firstMatch(output, /\bsdkVersion:'(\d+)'/u)
      ?? firstMatch(output, /\bminSdkVersion:'(\d+)'/u),
    ),
    targetSdk: optionalNumber(firstMatch(output, /\btargetSdkVersion:'(\d+)'/u)),
    label: firstMatch(output, /^application-label:'([^']*)'/mu),
  };
}

function buildToolsCandidates(sdkRoot: string): readonly BuildToolsCandidate[] {
  const executableNames = process.platform === "win32"
    ? ["aapt2.exe", "aapt.exe"]
    : ["aapt2", "aapt"];
  try {
    const versions = readdirSync(join(sdkRoot, "build-tools"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
    return versions.flatMap((version) => executableNames.map((name) => ({
      directory: join(sdkRoot, "build-tools", version),
      name,
    })));
  } catch {
    return [];
  }
}

async function inspectWithAapt(
  apkPath: string,
  dependencies: ApkInspectionDependencies,
): Promise<ApkMetadata> {
  const runTool = dependencies.runTool ?? (async (command, arguments_) => {
    const result = await execFileAsync(command, [...arguments_].map((argument) => argument.replaceAll("\\", "/")), {
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  });
  const injectedCommands = dependencies.toolCommands;
  const candidates = injectedCommands === undefined ? (() => {
    const environment = dependencies.environment ?? process.env;
    let sdkRoot = environment["ANDROID_SDK_ROOT"] ?? environment["ANDROID_HOME"];
    if (sdkRoot === undefined && process.platform === "win32" && environment["LOCALAPPDATA"] !== undefined) {
      sdkRoot = join(environment["LOCALAPPDATA"], "Android", "Sdk");
    }
    if (sdkRoot === undefined || sdkRoot.trim().length === 0) {
      throw new Error("APK inspection requires ANDROID_SDK_ROOT or ANDROID_HOME.");
    }
    return buildToolsCandidates(sdkRoot);
  })() : injectedCommands.map((path) => ({
    directory: dirname(path),
    name: basename(path),
  }));
  for (const candidate of candidates) {
    const command = join(candidate.directory, candidate.name);
    if (!(await (dependencies.exists ?? pathExists)(command))) continue;
    try {
      const output = await runTool(command, ["dump", "badging", apkPath]);
      return parseBadging(`${output.stdout}\n${output.stderr}`, apkPath);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      if (!/ENOENT|EACCES/iu.test(raw)) {
        throw new Error("TVDoctor could not read this APK. Verify that the file is a valid Android application package.", { cause: error });
      }
    }
  }
  throw new Error("No usable aapt/aapt2 installation was found in Android SDK build-tools.");
}

export async function inspectApk(
  apkPath: string,
  dependencies: ApkInspectionDependencies = {},
): Promise<ApkMetadata> {
  if (!/\.apk$/iu.test(apkPath)) throw new Error("Select a file with an .apk extension.");
  return await inspectWithAapt(apkPath, dependencies);
}

export function checkApkCompatibility(
  apk: Pick<ApkMetadata, "minSdk" | "supportedAbis">,
  device: Pick<AndroidPreflightDevice, "apiLevel" | "supportedAbis">,
): ApkCompatibility {
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (apk.minSdk !== null && device.apiLevel !== null && apk.minSdk > device.apiLevel) {
    blockers.push(
      `The APK requires Android API ${String(apk.minSdk)}, but this device provides API ${String(device.apiLevel)}.`,
    );
  }
  if (apk.supportedAbis.length > 0 && device.supportedAbis.length > 0) {
    const overlap = apk.supportedAbis.filter((abi) => device.supportedAbis.includes(abi));
    if (overlap.length === 0) {
      blockers.push(
        `APK architectures (${apk.supportedAbis.join(", ")}) do not overlap the device architectures (${device.supportedAbis.join(", ")}).`,
      );
    }
  } else {
    warnings.push("Architecture compatibility could not be fully verified; installation will still be checked by ADB.");
  }
  return { compatible: blockers.length === 0, blockers, warnings };
}

function friendlyDeviceError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/command not found|enoent|not recognized|cannot run program|createprocess/iu.test(raw)) {
    return "Android platform-tools (ADB) was not found.";
  }
  if (/unauthorized|offline|device not found|no devices|did not become ready/iu.test(raw)) {
    return "This Android device did not authorize or come online in time.";
  }
  return raw.split(/\r?\n/u, 1)[0] ?? "Android device information was unavailable.";
}

export interface AndroidPreflightDriver {
  listDevices(): Promise<readonly { readonly serial: string; readonly state: string; readonly model: string | null }[]>;
  getDeviceMetadata(refresh: boolean): Promise<AndroidDeviceMetadata>;
  close(): Promise<void> | void;
}

export interface AndroidPreflightDependencies {
  readonly createDriver?: (options: { readonly adbPath: string; readonly serial?: string }) => AndroidPreflightDriver;
}

export async function androidPreflight(
  explicitAdbPath?: string,
  dependencies: AndroidPreflightDependencies = {},
): Promise<AndroidPreflightResult> {
  let adbPath: string;
  try {
    const environment = process.env;
    const sdkRoot = environment["ANDROID_SDK_ROOT"] ?? environment["ANDROID_HOME"];
    const executable = process.platform === "win32" ? "adb.exe" : "adb";
    const windowsSdk = environment["LOCALAPPDATA"] === undefined
      ? null
      : join(environment["LOCALAPPDATA"], "Android", "Sdk", "platform-tools", executable);
    if (explicitAdbPath !== undefined && await pathExists(explicitAdbPath)) {
      adbPath = explicitAdbPath;
    } else if (sdkRoot !== undefined && await pathExists(join(sdkRoot, "platform-tools", executable))) {
      adbPath = join(sdkRoot, "platform-tools", executable);
    } else if (process.platform === "win32" && windowsSdk !== null && await pathExists(windowsSdk)) {
      adbPath = windowsSdk;
    } else {
      adbPath = await resolveAdbExecutable(undefined);
    }
  } catch {
    adbPath = explicitAdbPath ?? "adb";
  }
  const createDriver = dependencies.createDriver
    ?? ((options: { readonly adbPath: string; readonly serial?: string }) => new AndroidTvDriver(options));
  const driver = createDriver({ adbPath });
  try {
    const entries = await driver.listDevices();
    const onlineEntries = entries.filter((entry) => entry.state === "device");
    const devices: AndroidPreflightDevice[] = [];
    for (const entry of entries) {
      if (entry.state !== "device") {
        devices.push({
          serial: entry.serial,
          state: entry.state,
          online: false,
          model: entry.model,
          manufacturer: null,
          apiLevel: null,
          supportedAbis: [],
          isTelevision: null,
          detail: entry.state === "offline"
            ? "Offline. Wake or reconnect the device."
            : entry.state === "unauthorized"
              ? "Unauthorized. Accept the USB debugging prompt on the device."
              : "Not ready for testing.",
        });
        continue;
      }
      const metadataDriver = createDriver({ adbPath, serial: entry.serial });
      try {
        const metadata: AndroidDeviceMetadata = await metadataDriver.getDeviceMetadata(true);
        devices.push({
          serial: metadata.serial,
          state: entry.state,
          online: true,
          model: metadata.model,
          manufacturer: metadata.manufacturer,
          apiLevel: metadata.sdkLevel,
          supportedAbis: metadata.supportedAbis,
          isTelevision: metadata.isTelevision,
          detail: null,
        });
      } catch (error) {
        devices.push({
          serial: entry.serial,
          state: entry.state,
          online: false,
          model: entry.model,
          manufacturer: null,
          apiLevel: null,
          supportedAbis: [],
          isTelevision: null,
          detail: friendlyDeviceError(error),
        });
      } finally {
        await metadataDriver.close();
      }
    }
    return {
      available: true,
      adbPath,
      message: onlineEntries.length === 0
        ? "ADB is available, but no online Android devices were found."
        : `Found ${String(onlineEntries.length)} online Android device${onlineEntries.length === 1 ? "" : "s"}.`,
      devices,
    };
  } catch (error) {
    return {
      available: false,
      adbPath: null,
      message: friendlyDeviceError(error),
      devices: [],
    };
  } finally {
    await driver.close();
  }
}

export interface AndroidScanOptions {
  readonly adbPath?: string;
  readonly serial: string;
  readonly apkPath: string;
  readonly mode: "quick" | "deep";
  readonly outputPath: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: AndroidScanProgress) => void;
  readonly onSetupScreen?: (
    detection: AndroidSetupDetection,
  ) => Promise<"select-highlighted" | "press-back" | "leave-unchanged">;
}

export interface AndroidScanProgress {
  readonly elapsedSeconds: number;
  readonly screens: number;
  readonly states: number;
  readonly actions: number;
  readonly findings: number;
  readonly currentActivityLabel: string | null;
}

export interface AndroidScanResult {
  readonly status: "completed" | "partial" | "failed" | "setup-blocker";
  readonly issueCount: number;
  readonly highestSeverity: "critical" | "high" | "medium" | "low" | "info" | null;
  readonly reportPath: string | null;
  readonly details: readonly string[];
}

export interface AndroidSetupControl {
  readonly label: string;
  readonly focused: boolean;
}

export interface AndroidSetupDetection {
  readonly kind: string;
  readonly heading: string;
  readonly controls: readonly AndroidSetupControl[];
}

function flattenAndroidNodes(
  nodes: readonly AndroidUiNodeSnapshot[],
): readonly AndroidUiNodeSnapshot[] {
  const result: AndroidUiNodeSnapshot[] = [];
  const pending = [...nodes];
  while (pending.length > 0 && result.length < 2_048) {
    const node = pending.shift();
    if (node === undefined) break;
    result.push(node);
    pending.push(...node.children);
  }
  return result;
}

export function classifyAndroidStartup(
  snapshot: AndroidStateSnapshot,
): AndroidSetupDetection | null {
  if (snapshot.uiTree.status !== "available") return null;
  const nodes = flattenAndroidNodes(snapshot.uiTree.value);
  const text = nodes.flatMap((node) => [node.name, node.text])
    .filter((value): value is string => value !== null)
    .join(" ")
    .replace(/\s+/gu, " ")
    .toLowerCase();
  const packages = [...new Set(nodes.map((node) => node.packageName).filter((value): value is string => value !== null))];
  const isPermissionUi = packages.some((value) => /(?:permissioncontroller|packageinstaller)/iu.test(value))
    || /\b(?:allow .* to (?:access|take pictures|record audio)|runtime permission|system permission)\b/u.test(text);
  let kind: string | null = null;
  if (isPermissionUi) kind = "system permission";
  else if (/\b(?:sign in|log in|login|account linking|choose account)\b/u.test(text)) kind = "login";
  else if (/\b(?:welcome|onboarding|get started|set up|setup)\b/u.test(text)) kind = "onboarding";
  else if (/\b(?:region|country|language)\s+(?:selection|choice)\b/u.test(text)) kind = "region selection";
  if (kind === null) return null;
  const controls = nodes
    .filter((node) => node.visible !== false && node.enabled !== false
      && (node.clickable === true || node.focused === true))
    .map((node) => ({
      label: (node.name ?? node.text ?? "Unnamed control").replace(/\s+/gu, " ").trim(),
      focused: node.focused === true,
    }))
    .filter((control, index, all) => control.label.length > 0
      && all.findIndex((candidate) => candidate.label === control.label) === index)
    .slice(0, 5);
  const headingNode = nodes.find((node) => node.visible !== false
    && (node.name ?? node.text ?? "").trim().length > 0);
  return {
    kind,
    heading: (headingNode?.name ?? headingNode?.text ?? kind).replace(/\s+/gu, " ").trim(),
    controls,
  };
}

export async function scanAndroidApk(options: AndroidScanOptions): Promise<AndroidScanResult> {
  const startedAtMs = performance.now();
  const startedAt = new Date();
  let latestFindings = 0;
  let latestProgress: ExplorationProgress | null = null;
  let exploration: ExplorationResult | null = null;
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  let selectedPackage: string | null = null;
  const driver = new AndroidTvDriver({
    ...(options.adbPath === undefined ? {} : { adbPath: options.adbPath }),
    serial: options.serial,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  try {
    const apk = await inspectApk(options.apkPath);
    if (apk.packageName === null) throw new Error("TVDoctor could not determine the APK package name.");
    selectedPackage = apk.packageName;
    const component = apk.leanbackActivity ?? apk.launchableActivities.at(0) ?? null;
    await driver.getDeviceMetadata(true);
    await driver.install(options.apkPath);
    await driver.launch({
      id: apk.packageName,
      ...(component === null ? {} : { launchUri: component }),
    });
    const initial = await driver.snapshot();
    if (initial.uiTree.status !== "available") throw new Error("Android observer UI state was unavailable after launch.");
    let setup = classifyAndroidStartup(initial);
    if (setup !== null && options.onSetupScreen !== undefined) {
      const decision = await options.onSetupScreen(setup);
      if (decision === "leave-unchanged") {
        return {
          status: "setup-blocker",
          issueCount: 0,
          highestSeverity: null,
          reportPath: null,
          details: [
            `The scan was not started because TVDoctor found a ${setup.kind} screen.`,
            "No application state or permissions were changed.",
          ],
        };
      }
      await driver.press(decision === "select-highlighted" ? "SELECT" : "BACK");
      const observed = await driver.snapshot();
      setup = classifyAndroidStartup(observed);
      if (setup !== null) throw new Error(`TVDoctor could not safely clear the ${setup.kind} screen.`);
    } else if (setup !== null) {
      return {
        status: "setup-blocker",
        issueCount: 0,
        highestSeverity: null,
        reportPath: null,
        details: [
          `The scan was not started because TVDoctor found a ${setup.kind} screen.`,
          "Automation policy was observation-only.",
        ],
      };
    }

    const outputRoot = resolve(options.outputPath);
    const store = await reserveAuditOutput(options.outputPath);
    const beforeScreenshotPath = join(outputRoot, "before-screenshot.png");
    await driver.captureScreenshot(beforeScreenshotPath);
    const runArtifacts: ArtifactDescriptor[] = [];
    try {
      runArtifacts.push(await fileArtifact(
        outputRoot,
        beforeScreenshotPath,
        "run:before-screenshot",
        "report",
        "image/png",
      ));
    } catch {
      // A screenshot is supplementary evidence and must not invalidate navigation results.
    }

    const explorationPromise = explore(driver, {
      profile: options.mode,
      budgets: ANDROID_EXPLORATION_BUDGETS[options.mode],
      settling: ANDROID_ACTION_SETTLING,
      restoreInitialState: async () => {
        await driver.reset("relaunch");
      },
      shouldExpand: (snapshot) => snapshot.location.status === "available"
        && snapshot.location.value.startsWith(`android://${apk.packageName}/`),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onProgress: (progress) => {
        latestProgress = progress;
      },
    }).then((result) => {
      exploration = result;
      return result;
    });
    if (options.onProgress !== undefined) {
      progressTimer = setInterval(() => {
        options.onProgress?.({
          elapsedSeconds: Math.floor((performance.now() - startedAtMs) / 1_000),
          screens: latestProgress?.screenStates ?? 0,
          states: latestProgress?.focusStates ?? 0,
          actions: latestProgress?.physicalActions ?? 0,
          findings: latestFindings,
          currentActivityLabel: exploration?.graph.screens.states.at(-1)?.fingerprint.value ?? null,
        });
      }, 500);
    }
    const result = await explorationPromise;
    const findings = diagnoseNavigation(result).findings;
    latestFindings = findings.length;
    const issues = findings.map((finding) => finding.issue);
    const completedAt = new Date();
    const complete = result.termination.complete;
    const exhausted: CoverageBudget[] = [];
    if (!complete) {
      if (result.termination.reason === "max-actions") exhausted.push("actions");
      if (result.termination.reason === "max-states") exhausted.push("states");
      if (result.termination.reason === "max-depth") exhausted.push("depth");
      if (result.termination.reason === "max-duration") exhausted.push("duration");
    }
    try {
      const afterScreenshotPath = join(outputRoot, "after-screenshot.png");
      await driver.captureScreenshot(afterScreenshotPath);
      runArtifacts.push(await fileArtifact(
        outputRoot,
        afterScreenshotPath,
        "run:after-screenshot",
        "report",
        "image/png",
      ));
    } catch {
      // Preserve navigation coverage even if the final visual capture fails.
    }
    try {
      const logs = sanitiseEvidenceJson(
        JSON.parse(JSON.stringify(await driver.getLogs())) as JsonValue,
      );
      const logText = `${stableJson(logs)}\n`;
      const logPath = join(outputRoot, "logcat.json");
      await writeFile(logPath, logText);
      runArtifacts.push(await fileArtifact(
        outputRoot,
        logPath,
        "run:logcat",
        "report",
        "application/json",
      ));
    } catch {
      // Log capture is supplementary; the scan result remains authoritative.
    }
    try {
      const explorationEvidence = sanitiseEvidenceJson(JSON.parse(JSON.stringify({
        termination: result.termination,
        budgets: result.budgets,
        actionOrder: result.actionOrder,
        statistics: result.statistics,
      })) as JsonValue);
      const explorationPath = join(outputRoot, "android-exploration.json");
      await writeFile(explorationPath, `${stableJson(explorationEvidence)}\n`);
      runArtifacts.push(await fileArtifact(
        outputRoot,
        explorationPath,
        "run:android-exploration",
        "report",
        "application/json",
      ));
    } catch {
      // The canonical report verdict remains authoritative if supplementary diagnostics fail.
    }
    try {
      const actionProfiles = result.graph.actions.map((action) => ({
        id: action.id,
        key: action.key,
        outcome: action.actionResult.outcome,
        timing: action.actionResult.timing,
      }));
      const totals = actionProfiles.flatMap((action) => {
        const total = action.timing.profile?.totalMs;
        return total === undefined ? [] : [total];
      }).sort((left, right) => left - right);
      const percentile = (fraction: number): number | null => {
        if (totals.length === 0) return null;
        return totals[Math.min(totals.length - 1, Math.max(0, Math.ceil(totals.length * fraction) - 1))] ?? null;
      };
      const performanceEvidence = sanitiseEvidenceJson(JSON.parse(JSON.stringify({
        architecture: "android-observer-v2",
        count: totals.length,
        meanMs: totals.length === 0 ? null : totals.reduce((sum, value) => sum + value, 0) / totals.length,
        p50Ms: percentile(0.5),
        p90Ms: percentile(0.9),
        p95Ms: percentile(0.95),
        p99Ms: percentile(0.99),
        worstMs: totals.at(-1) ?? null,
        actions: actionProfiles,
        observer: driver.getObserverMetrics(),
      })) as JsonValue);
      const performancePath = join(outputRoot, "android-action-performance.json");
      await writeFile(performancePath, `${stableJson(performanceEvidence)}\n`);
      runArtifacts.push(await fileArtifact(
        outputRoot,
        performancePath,
        "run:android-action-performance",
        "report",
        "application/json",
      ));
    } catch {
      // Profiling evidence is supplementary and must never rewrite the run verdict.
    }
    const replays = issues.flatMap((issue) => {
      const compiled = compileIssueReplay(issue);
      return compiled.status === "compiled" ? [compiled.plan.replay] : [];
    });
    const report = buildTVDoctorReportV1({
      run: {
        id: `android-${startedAt.getTime().toString(36)}`,
        tvdoctorVersion: CLI_VERSION,
        mode: options.mode,
        status: complete ? "completed" : "partial",
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
      },
      target: {
        name: apk.label ?? apk.packageName,
        platform: "android-tv",
        location: options.serial,
        environment: {
          package: apk.packageName,
          version: apk.versionName ?? "unknown",
          architecture: apk.supportedAbis.join(", ") || "unknown",
          explorer: "experimental Android TV navigation audit",
          driver: "persistent TVDoctor observer v2",
        },
      },
      coverage: {
        screenStatesDiscovered: result.statistics.screenStates,
        focusStatesDiscovered: result.statistics.focusStates,
        transitionsTested: result.graph.actions.length,
        actionsSent: result.statistics.physicalActions,
        capabilitiesObserved: [...await driver.capabilities()],
        packs: [{ pack: "navigation", status: complete ? "completed" : "partial" }],
        budget: {
          maxActions: result.budgets.maxActions,
          maxStates: result.budgets.maxStates,
          maxDepth: result.budgets.maxDepth,
          maxDurationMs: result.budgets.maxDurationMs,
          maxRepetitiveItems: options.mode === "quick" ? 1 : 4,
          exhausted,
        },
      },
      issues,
      artifacts: runArtifacts,
      replays,
    });
    const bundle = await writeReportBundle(store, report);
    const severityOrder = ["critical", "high", "medium", "low", "info"] as const;
    return {
      status: report.run.status,
      issueCount: issues.length,
      highestSeverity: severityOrder.find((severity) => issues.some((issue) => issue.severity === severity)) ?? null,
      reportPath: bundle.reportJson.absolutePath,
      details: complete
        ? ["All reachable navigation work was exhausted."]
        : result.termination.reason === "interrupted"
          ? ["The scan was interrupted; completed coverage was retained in this partial report."]
        : [
          `Safety ceiling reached: ${result.termination.reason}. Unexplored work remained.`,
          ...(result.termination.detail === undefined ? [] : [result.termination.detail]),
        ],
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      issueCount: 0,
      highestSeverity: null,
      reportPath: null,
      details: [reason],
    };
  } finally {
    if (progressTimer !== undefined) clearInterval(progressTimer);
    const appPackage = selectedPackage ?? undefined;
    await driver.forceStop(appPackage ?? undefined).catch(() => undefined);
    await driver.close();
  }
}
