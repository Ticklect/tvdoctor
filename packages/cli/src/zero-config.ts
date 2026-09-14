import { basename } from "node:path";

import type { CliContext } from "./cli.js";
import type { AndroidScanResult } from "./android-product.js";
import { evaluateZeroConfigAndroidDevice } from "./android-selection.js";
import {
  androidPackageInstalled as queryAndroidPackageInstalled,
  observerAccessibilityEnabled as readObserverAccessibilityEnabled,
  openObserverSetup as launchObserverSetup,
} from "./android-zero-config-support.js";
import { locateAndroidSdkTools } from "./android-sdk.js";
import { ProgressRenderer, type StartTerminal } from "./interactive.js";
import { defaultOutputDirectory } from "./product-output.js";
import type { ZeroConfigTarget } from "./zero-config-target.js";
import { finishInteractiveScan } from "./zero-config-output.js";

const EXIT_SUCCESS = 0;
const EXIT_ENVIRONMENT = 1;
const EXIT_USAGE = 2;
const EXIT_PARTIAL = 3;
const EXIT_EXECUTION = 4;
const INTERACTIVE_SETUP_TIMEOUT_MS = 300_000;

const nonInteractiveTerminal: StartTerminal = {
  isInteractive: false,
  prompt: async () => null,
  select: async () => null,
};

export interface ZeroConfigDependencies {
  readonly androidPackageInstalled?: typeof queryAndroidPackageInstalled;
  readonly openObserverSetup?: typeof launchObserverSetup;
  readonly observerAccessibilityEnabled?: typeof readObserverAccessibilityEnabled;
  readonly sleep?: (durationMs: number, signal?: AbortSignal) => Promise<void>;
  readonly now?: () => number;
}

function write(context: CliContext, text: string): void {
  context.io.writeStdout(`${text}\n`);
}

function writeError(context: CliContext, text: string): void {
  context.io.writeStderr(`${text}\n`);
}

async function delay(durationMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) throw signal.reason ?? new Error("Operation was cancelled.");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, durationMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Operation was cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function ensureWebRuntime(context: CliContext): Promise<void> {
  if (context.runtimeProbe === undefined) return;
  try {
    await context.runtimeProbe();
    return;
  } catch (firstError) {
    if (context.runtimeSetup === undefined) throw firstError;
    write(context, "Installing TVDoctor's browser…");
    await context.runtimeSetup(context.signal);
    await context.runtimeProbe();
  }
}

function exitCodeForStatus(status: "completed" | "partial" | "failed" | "setup-blocker"): number {
  if (status === "completed") return EXIT_SUCCESS;
  if (status === "partial" || status === "setup-blocker") return EXIT_PARTIAL;
  return EXIT_EXECUTION;
}

async function runZeroConfigWeb(target: string, context: CliContext): Promise<number> {
  if (context.operations?.testTarget === undefined) {
    writeError(context, "Web auditing is unavailable in this TVDoctor installation.");
    return EXIT_EXECUTION;
  }

  const terminal = context.startTerminal ?? nonInteractiveTerminal;
  write(context, "TVDoctor");
  write(context, `Target: ${target}`);
  write(context, "Checking browser…");
  try {
    await ensureWebRuntime(context);
  } catch (error) {
    const message = error instanceof Error ? error.message.split(/\r?\n/u, 1)[0] : String(error);
    writeError(context, `Browser setup failed: ${message}`);
    return EXIT_ENVIRONMENT;
  }

  const outputPath = defaultOutputDirectory({ target, mode: "deep" });
  const startedAtMs = Date.now();
  const progress = new ProgressRenderer(terminal.isInteractive, (line) => write(context, line));
  const intervalMs = terminal.isInteractive ? 1_000 : 30_000;
  const timer = setInterval(() => {
    progress.update({ elapsedSeconds: Math.floor((Date.now() - startedAtMs) / 1_000) });
  }, intervalMs);

  write(context, "Scanning… Press Ctrl+C to stop safely.");
  try {
    const result = await context.operations.testTarget({
      target,
      packs: ["all"],
      mode: "deep",
      outputPath,
      searchQuery: "N",
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    clearInterval(timer);
    progress.finish();
    await finishInteractiveScan(context, terminal, result, startedAtMs);
    return exitCodeForStatus(result.status);
  } catch (error) {
    clearInterval(timer);
    progress.finish();
    const message = error instanceof Error ? error.message.split(/\r?\n/u, 1)[0] : String(error);
    writeError(context, `Scan failed: ${message}`);
    return EXIT_EXECUTION;
  } finally {
    clearInterval(timer);
    progress.finish();
  }
}

function observerSetupRequired(details: readonly string[]): boolean {
  return details.some((detail) => /TVDoctor Observer.*accessibility|Enable TVDoctor Observer accessibility/iu.test(detail));
}

async function waitForObserverAccessibility(
  request: { readonly adbPath: string; readonly serial: string; readonly signal?: AbortSignal },
  dependencies: ZeroConfigDependencies,
): Promise<boolean> {
  const enabled = dependencies.observerAccessibilityEnabled ?? readObserverAccessibilityEnabled;
  const sleep = dependencies.sleep ?? delay;
  const now = dependencies.now ?? Date.now;
  const started = now();
  while (now() - started < INTERACTIVE_SETUP_TIMEOUT_MS) {
    request.signal?.throwIfAborted();
    if (await enabled(request)) return true;
    await sleep(500, request.signal);
  }
  return false;
}

async function runAndroidScanAttempt(
  context: CliContext,
  terminal: StartTerminal,
  request: {
    readonly adbPath: string;
    readonly serial: string;
    readonly apkPath: string;
    readonly outputPath: string;
  },
): Promise<AndroidScanResult> {
  const scan = context.operations?.scanAndroidApk;
  if (scan === undefined) throw new Error("Android TV scanning is unavailable in this TVDoctor installation.");
  const progress = new ProgressRenderer(terminal.isInteractive, (line) => write(context, line));
  try {
    return await scan({
      adbPath: request.adbPath,
      serial: request.serial,
      apkPath: request.apkPath,
      mode: "deep",
      outputPath: request.outputPath,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
      onProgress: (state) => progress.update(state),
      onSetupScreen: async (detection) => {
        const focused = detection.controls.find((control) => control.focused);
        const choice = await terminal.select(
          `TVDoctor found a ${detection.kind} screen. How should it continue?`,
          [
            { label: "Leave unchanged and stop", detail: "Safest when the choice is unclear" },
            {
              label: "Select the highlighted control",
              ...(focused === undefined ? {} : { detail: focused.label }),
            },
            { label: "Press Back" },
          ],
        );
        if (choice === 1) return "select-highlighted";
        if (choice === 2) return "press-back";
        return "leave-unchanged";
      },
    });
  } finally {
    progress.finish();
  }
}

async function runZeroConfigAndroid(
  apkPath: string,
  context: CliContext,
  dependencies: ZeroConfigDependencies,
): Promise<number> {
  const operations = context.operations;
  if (operations?.inspectApk === undefined
    || operations.androidPreflight === undefined
    || operations.scanAndroidApk === undefined) {
    writeError(context, "Android TV testing is unavailable in this TVDoctor installation.");
    return EXIT_EXECUTION;
  }
  const terminal = context.startTerminal ?? nonInteractiveTerminal;
  write(context, "TVDoctor");
  write(context, `APK: ${basename(apkPath)}`);

  let apk;
  try {
    write(context, "Inspecting APK…");
    apk = await operations.inspectApk(apkPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeError(context, `APK inspection failed: ${message}`);
    return EXIT_ENVIRONMENT;
  }
  if (apk.packageName === null) {
    writeError(context, "TVDoctor could not determine the APK package name.");
    return EXIT_ENVIRONMENT;
  }

  write(context, "Finding a compatible Android TV…");
  const preflight = await operations.androidPreflight();
  if (!preflight.available) {
    writeError(context, preflight.message);
    return EXIT_ENVIRONMENT;
  }
  const evaluations = preflight.devices.map((device) => evaluateZeroConfigAndroidDevice(apk, device));
  const compatible = evaluations.filter((evaluation) => evaluation.compatible);
  if (compatible.length === 0) {
    writeError(context, "No compatible, boot-ready Android TV target was found.");
    for (const evaluation of evaluations) {
      write(context, `${evaluation.device.serial}: ${evaluation.reasons.join(" ") || "Not eligible for zero-config selection."}`);
    }
    return EXIT_ENVIRONMENT;
  }

  let selected = compatible[0];
  if (compatible.length > 1) {
    const choice = await terminal.select(
      "Choose the Android TV you want to test:",
      compatible.map((evaluation) => ({
        label: `${evaluation.device.manufacturer ?? "Android"} ${evaluation.device.model ?? "TV"}`.trim(),
        detail: `${evaluation.device.serial}; API ${evaluation.device.apiLevel?.toString() ?? "unknown"}`,
      })),
    );
    if (choice === null) return EXIT_USAGE;
    selected = compatible[choice];
  }
  if (selected === undefined) return EXIT_USAGE;

  const tools = await locateAndroidSdkTools({
    ...(preflight.adbPath === null ? {} : { explicitAdbPath: preflight.adbPath }),
  });
  const adbPath = preflight.adbPath ?? tools.adbPath;
  write(context, `Using: ${selected.device.manufacturer ?? "Android"} ${selected.device.model ?? "TV"} · API ${selected.device.apiLevel?.toString() ?? "unknown"}`);

  const packageInstalled = dependencies.androidPackageInstalled ?? queryAndroidPackageInstalled;
  if (await packageInstalled({
    adbPath,
    serial: selected.device.serial,
    packageName: apk.packageName,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  })) {
    const replace = await terminal.select(
      `${apk.label ?? apk.packageName} is already installed on this external target.`,
      [
        { label: "Replace existing app and test" },
        { label: "Cancel" },
      ],
    );
    if (replace !== 0) return EXIT_USAGE;
  }

  const outputPath = defaultOutputDirectory({
    target: apk.label ?? apk.packageName,
    platform: "android-tv",
    mode: "deep",
  });
  const startedAtMs = Date.now();
  write(context, "Scanning… Press Ctrl+C to stop safely.");
  let result = await runAndroidScanAttempt(context, terminal, {
    adbPath,
    serial: selected.device.serial,
    apkPath,
    outputPath,
  });

  if (result.status === "failed" && observerSetupRequired(result.details)) {
    const openObserverSetup = dependencies.openObserverSetup ?? launchObserverSetup;
    await openObserverSetup({
      adbPath,
      serial: selected.device.serial,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    write(context, "Enable TVDoctor Observer accessibility access on the Android TV. TVDoctor will continue automatically.");
    const enabled = await waitForObserverAccessibility({
      adbPath,
      serial: selected.device.serial,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    }, dependencies);
    if (!enabled) {
      result = {
        status: "setup-blocker",
        issueCount: 0,
        highestSeverity: null,
        reportPath: null,
        details: ["TVDoctor Observer was not enabled within five minutes."],
      };
    } else {
      write(context, "Observer enabled. Resuming scan…");
      result = await runAndroidScanAttempt(context, terminal, {
        adbPath,
        serial: selected.device.serial,
        apkPath,
        outputPath,
      });
    }
  }

  await finishInteractiveScan(context, terminal, result, startedAtMs);
  return exitCodeForStatus(result.status);
}

export async function runZeroConfigTarget(
  target: ZeroConfigTarget,
  context: CliContext,
  dependencies: ZeroConfigDependencies = {},
): Promise<number> {
  if (target.kind === "web") return await runZeroConfigWeb(target.target, context);
  return await runZeroConfigAndroid(target.apkPath, context, dependencies);
}
