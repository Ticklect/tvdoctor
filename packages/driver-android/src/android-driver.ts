import { mkdir, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import {
  availableObservation,
  unavailableObservation,
  type ActionResult,
  type AppReference,
  type Capability,
  type FocusTarget,
  type LogEntry,
  type RemoteKey,
  type ResetStrategy,
  type ScreenshotArtifact,
  type TVDoctorDriver,
} from "@tvdoctor/protocol";
import { parseUiAutomatorHierarchy, type ParsedAndroidHierarchy } from "./hierarchy.js";
import { NodeAdbCommandExecutor } from "./subprocess.js";
import type {
  AdbCommandExecutor,
  AdbCommandOptions,
  AndroidAppMetadata,
  AndroidAppReference,
  AndroidDeviceListEntry,
  AndroidDeviceMetadata,
  AndroidLogEntry,
  AndroidStateSnapshot,
  AndroidTvDriverOptions,
} from "./types.js";

const PACKAGE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u;
const COMPONENT_CLASS_PATTERN = /^\.?[A-Za-z][A-Za-z0-9_.$]*$/u;
const SERIAL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_TIMER_MS = 2_147_483_647;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const WEDGE_FAILURE_MS = 250;
const WEDGE_FAILURE_LIMIT = 4;
const SCREEN_PROBE_FALLBACK_LIMIT = 1;
const MAX_PROFILE_CAPTURES = 16;
let hierarchyCaptureSequence = 0;

const KEY_CODES: Readonly<Record<RemoteKey, string>> = {
  UP: "KEYCODE_DPAD_UP",
  DOWN: "KEYCODE_DPAD_DOWN",
  LEFT: "KEYCODE_DPAD_LEFT",
  RIGHT: "KEYCODE_DPAD_RIGHT",
  SELECT: "KEYCODE_DPAD_CENTER",
  BACK: "KEYCODE_BACK",
};

export const ANDROID_TV_DRIVER_CAPABILITIES: ReadonlySet<Capability> = new Set([
  "remote-input",
  "ui-tree",
  "accessibility-tree",
  "screenshot",
  "logs",
  "install",
  "launch",
]);

interface NormalisedOptions {
  readonly commandTimeoutMs: number;
  readonly executor: AdbCommandExecutor;
  readonly hierarchyTimeoutMs: number;
  readonly maxCommandOutputBytes: number;
  readonly maxHierarchyBytes: number;
  readonly maxHierarchyDepth: number;
  readonly maxHierarchyNodes: number;
  readonly maxLogEntries: number;
  readonly maxScreenshotBytes: number;
  readonly noResponseGraceMs: number;
  readonly baselineReuseMs: number;
  readonly stabilityProbeMs: number;
  readonly serial: string | undefined;
  readonly settlePollIntervalMs: number;
  readonly settleStableSamples: number;
  readonly settleTimeoutMs: number;
}

interface CurrentApp {
  readonly packageName: string;
  readonly component: string | null;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result <= 0) throw new TypeError(`${name} must be a positive integer.`);
  return result;
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 0) throw new TypeError(`${name} must be a non-negative integer.`);
  return result;
}

function defaultAdbPath(): string {
  const sdkRoot = process.env["ANDROID_SDK_ROOT"] ?? process.env["ANDROID_HOME"];
  if (sdkRoot === undefined || sdkRoot.trim().length === 0) return "adb";
  return join(sdkRoot, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
}

function validateSerial(value: string): string {
  if (!SERIAL_PATTERN.test(value)) throw new TypeError("Android device serial is invalid.");
  return value;
}

function validatePackageName(value: string): string {
  if (!PACKAGE_PATTERN.test(value)) throw new TypeError("Android package name is invalid.");
  return value;
}

function componentFor(packageName: string, value: string): string {
  if (value.includes("\0") || /[\s?#]/u.test(value)) {
    throw new TypeError("Android launch component is invalid.");
  }
  const separator = value.indexOf("/");
  if (separator >= 0) {
    const componentPackage = value.slice(0, separator);
    const activity = value.slice(separator + 1);
    if (componentPackage !== packageName || !COMPONENT_CLASS_PATTERN.test(activity)) {
      throw new TypeError("Android launch component must belong to the selected package.");
    }
    return `${packageName}/${activity}`;
  }
  if (!COMPONENT_CLASS_PATTERN.test(value)) throw new TypeError("Android activity class is invalid.");
  return `${packageName}/${value}`;
}

function utf8(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}

function cleanText(value: string, maximumLength = 2_000): string {
  let printable = "";
  for (const character of value.normalize("NFKC")) {
    const codePoint = character.codePointAt(0) ?? 0;
    printable += codePoint < 32 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13
      || (codePoint >= 127 && codePoint <= 159)
      ? " "
      : character;
  }
  return printable
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximumLength);
}

function optionalCleanText(value: string | undefined): string | null {
  if (value === undefined) return null;
  const result = cleanText(value, 1_024);
  return result.length === 0 ? null : result;
}

function parsePositiveInteger(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/u.test(value)) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function sha256Prefix(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pngDimensions(bytes: Uint8Array): { readonly width: number; readonly height: number } {
  const buffer = Buffer.from(bytes);
  if (buffer.byteLength < 24 || !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new TypeError("ADB screenshot output is not a PNG image.");
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width <= 0 || height <= 0) throw new TypeError("ADB screenshot has invalid dimensions.");
  return { width, height };
}

function parseDevices(output: string): readonly AndroidDeviceListEntry[] {
  const entries: AndroidDeviceListEntry[] = [];
  for (const rawLine of output.split(/\r?\n/u).slice(1)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("* daemon")) continue;
    const columns = line.split(/\s+/u);
    const serial = columns[0];
    const state = columns[1];
    if (serial === undefined || state === undefined || !SERIAL_PATTERN.test(serial)) continue;
    const properties = new Map<string, string>();
    for (const column of columns.slice(2)) {
      const separator = column.indexOf(":");
      if (separator <= 0) continue;
      properties.set(column.slice(0, separator), column.slice(separator + 1));
    }
    entries.push({
      serial,
      state,
      product: optionalCleanText(properties.get("product")),
      model: optionalCleanText(properties.get("model")),
      device: optionalCleanText(properties.get("device")),
      transportId: optionalCleanText(properties.get("transport_id")),
    });
  }
  return entries;
}

function parseProperties(output: string): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\[([^\]]+)\]:\s*\[(.*)\]$/u.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      result.set(match[1], cleanText(match[2], 2_048));
    }
  }
  return result;
}

function lastDisplayPair(output: string, label: "density" | "size"): readonly number[] | null {
  const matches = label === "size"
    ? [...output.matchAll(/(?:Physical|Override) size:\s*(\d+)x(\d+)/giu)]
    : [...output.matchAll(/(?:Physical|Override) density:\s*(\d+)/giu)];
  const match = matches.at(-1);
  if (match === undefined) return null;
  const values = match.slice(1).map(Number);
  return values.every((value) => Number.isFinite(value) && value > 0) ? values : null;
}

function currentActivity(output: string): string | null {
  const patterns = [
    /(?:topResumedActivity|mResumedActivity)[^\n]*?\s([A-Za-z][A-Za-z0-9_.]*\/[A-Za-z0-9_.$]+)/u,
    /mFocusedApp[^\n]*?\s([A-Za-z][A-Za-z0-9_.]*\/[A-Za-z0-9_.$]+)/u,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(output);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

function logLevel(value: string): LogEntry["level"] {
  if (value === "E" || value === "F" || value === "A") return "error";
  if (value === "W") return "warning";
  if (value === "D" || value === "V") return "debug";
  return "info";
}

function parseLogcat(output: string, maximumEntries: number): readonly AndroidLogEntry[] {
  const result: AndroidLogEntry[] = [];
  const pattern = /^(\d+(?:\.\d+)?)\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+([^:]{1,128}):\s?(.*)$/u;
  for (const line of output.split(/\r?\n/u)) {
    const match = pattern.exec(line);
    if (match === null) continue;
    const seconds = Number(match[1]);
    const timestamp = Number.isFinite(seconds)
      ? new Date(seconds * 1_000).toISOString()
      : new Date(0).toISOString();
    result.push({
      timestamp,
      level: logLevel(match[4] ?? "I"),
      message: cleanText(match[6] ?? "", 2_000),
      pid: parsePositiveInteger(match[2]),
      threadId: parsePositiveInteger(match[3]),
      tag: optionalCleanText(match[5]),
    });
  }
  return result.slice(-maximumEntries);
}

function focusedIdentity(hierarchy: ParsedAndroidHierarchy): string {
  const focus = hierarchy.focusedTarget;
  if (hierarchy.focusedNodeCount !== 1 || focus === null) return `count:${String(hierarchy.focusedNodeCount)}`;
  return [focus.stableId ?? "", focus.role ?? "", focus.name ?? ""].join("\u001f");
}

function normaliseOptions(options: AndroidTvDriverOptions): NormalisedOptions {
  const commandTimeoutMs = positiveInteger(options.commandTimeoutMs, 15_000, "commandTimeoutMs");
  const maxCommandOutputBytes = positiveInteger(
    options.maxCommandOutputBytes,
    2 * 1024 * 1024,
    "maxCommandOutputBytes",
  );
  if (commandTimeoutMs > MAX_TIMER_MS) throw new TypeError("commandTimeoutMs exceeds the timer limit.");
  const executor = options.executor ?? new NodeAdbCommandExecutor(options.adbPath ?? defaultAdbPath(), {
    maxOutputBytes: maxCommandOutputBytes,
    timeoutMs: commandTimeoutMs,
  });
  return {
    commandTimeoutMs,
    executor,
    hierarchyTimeoutMs: positiveInteger(options.hierarchyTimeoutMs, 12_000, "hierarchyTimeoutMs"),
    maxCommandOutputBytes,
    maxHierarchyBytes: positiveInteger(options.maxHierarchyBytes, 2 * 1024 * 1024, "maxHierarchyBytes"),
    maxHierarchyDepth: positiveInteger(options.maxHierarchyDepth, 128, "maxHierarchyDepth"),
    maxHierarchyNodes: positiveInteger(options.maxHierarchyNodes, 4_096, "maxHierarchyNodes"),
    maxLogEntries: positiveInteger(options.maxLogEntries, 500, "maxLogEntries"),
    maxScreenshotBytes: positiveInteger(options.maxScreenshotBytes, 32 * 1024 * 1024, "maxScreenshotBytes"),
    noResponseGraceMs: nonNegativeInteger(options.noResponseGraceMs, 100, "noResponseGraceMs"),
    baselineReuseMs: nonNegativeInteger(options.baselineReuseMs, 30_000, "baselineReuseMs"),
    stabilityProbeMs: positiveInteger(options.stabilityProbeMs, 150, "stabilityProbeMs"),
    serial: options.serial === undefined ? undefined : validateSerial(options.serial),
    settlePollIntervalMs: positiveInteger(options.settlePollIntervalMs, 100, "settlePollIntervalMs"),
    settleStableSamples: positiveInteger(options.settleStableSamples, 2, "settleStableSamples"),
    settleTimeoutMs: positiveInteger(options.settleTimeoutMs, 10_000, "settleTimeoutMs"),
  };
}

export class AndroidTvDriver implements TVDoctorDriver {
  readonly #options: NormalisedOptions;
  #closed = false;
  #currentApp: CurrentApp | null = null;
  #deviceMetadata: AndroidDeviceMetadata | null = null;
  #launchPid: number | null = null;
  #launchStartedAtMs = 0;
  #resolvedSerial: string | null = null;
  #operationQueue: Promise<unknown> = Promise.resolve();
  #settledBaseline: {
    readonly hierarchy: ParsedAndroidHierarchy;
    readonly capturedAtMs: number;
  } | null = null;
  #cachedVersionInfo: {
    readonly packageName: string;
    readonly versionName: string | null;
    readonly versionCode: number | null;
  } | null = null;

  constructor(options: AndroidTvDriverOptions = {}) {
    this.#options = normaliseOptions(options);
    this.#resolvedSerial = options.serial ?? null;
  }

  async capabilities(): Promise<ReadonlySet<Capability>> {
    return new Set(ANDROID_TV_DRIVER_CAPABILITIES);
  }

  async listDevices(): Promise<readonly AndroidDeviceListEntry[]> {
    this.#ensureOpen();
    return parseDevices(await this.#text(["devices", "-l"]));
  }

  async waitForDeviceReady(timeoutMs = 180_000): Promise<AndroidDeviceMetadata> {
    this.#ensureOpen();
    const timeout = positiveInteger(timeoutMs, 180_000, "timeoutMs");
    if (timeout > MAX_TIMER_MS) throw new TypeError("timeoutMs exceeds the timer limit.");
    const deadline = performance.now() + timeout;
    await this.#serial();
    while (performance.now() < deadline) {
      try {
        const state = cleanText(await this.#deviceText(["get-state"], { timeoutMs: 5_000 }));
        const booted = cleanText(await this.#deviceText(
          ["shell", "getprop", "sys.boot_completed"],
          { timeoutMs: 5_000 },
        ));
        if (state === "device" && booted === "1") return await this.getDeviceMetadata(true);
      } catch {
        // Device startup is expected to transition through unavailable states.
      }
      await delay(Math.min(500, Math.max(1, deadline - performance.now())));
    }
    throw new Error(`Android device did not become ready within ${String(timeout)} ms.`);
  }

  async install(artifactPath: string): Promise<void> {
    this.#ensureOpen();
    if (artifactPath.includes("\0") || extname(artifactPath).toLowerCase() !== ".apk") {
      throw new TypeError("Android install requires an APK path.");
    }
    const absolutePath = resolve(artifactPath);
    if (!isAbsolute(absolutePath)) throw new TypeError("Android APK path could not be resolved.");
    const metadata = await stat(absolutePath);
    if (!metadata.isFile()) throw new TypeError("Android APK path is not a regular file.");
    const output = await this.#deviceText(
      ["install", "-r", "-t", absolutePath],
      { timeoutMs: Math.max(this.#options.commandTimeoutMs, 120_000) },
    );
    if (!/(?:^|\s)Success(?:\s|$)/u.test(output)) {
      throw new Error(`ADB did not confirm APK installation: ${cleanText(output)}`);
    }
  }

  async launch(app: AppReference): Promise<void> {
    this.#ensureOpen();
    return await this.#enqueue(async () => {
      await this.#launch(app);
    });
  }

  async #launch(app: AppReference): Promise<void> {
    const reference = app as AndroidAppReference;
    const packageName = validatePackageName(reference.id);
    const component = reference.launchUri === undefined
      ? null
      : componentFor(packageName, reference.launchUri);
    await this.forceStop(packageName);
    this.#launchStartedAtMs = Date.now();
    if (component === null) {
      const output = await this.#deviceText([
        "shell", "monkey", "-p", packageName,
        "-c", "android.intent.category.LEANBACK_LAUNCHER", "1",
      ]);
      if (/No activities found|monkey aborted/iu.test(output)) {
        throw new Error(`Android package has no launchable Leanback activity: ${cleanText(output)}`);
      }
    } else {
      const output = await this.#deviceText(["shell", "am", "start", "-W", "-n", component]);
      if (/Error:|Exception|does not exist/iu.test(output)) {
        throw new Error(`Android activity launch failed: ${cleanText(output)}`);
      }
    }
    this.#currentApp = { packageName, component };
    this.#launchPid = await this.#waitForPid(packageName, 8_000);
    this.#settledBaseline = null;
    const hierarchy = await this.#waitForStableHierarchy(this.#options.settleTimeoutMs)
      .catch(() => null);
    if (hierarchy !== null) {
      this.#settledBaseline = { hierarchy, capturedAtMs: performance.now() };
    }
  }

  /**
   * Serialises device-touching operations so captures from concurrent calls
   * cannot observe interleaved states.
   */
  async #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#operationQueue.then(operation, operation);
    this.#operationQueue = run.catch(() => undefined);
    return run;
  }

  async forceStop(packageName = this.#currentApp?.packageName): Promise<void> {
    this.#ensureOpen();
    if (packageName === undefined) throw new Error("No Android package is selected.");
    await this.#deviceText(["shell", "am", "force-stop", validatePackageName(packageName)]);
  }

  async reset(strategy: ResetStrategy): Promise<void> {
    this.#ensureOpen();
    return await this.#enqueue(async () => {
      const current = this.#currentApp;
      if (current === null) throw new Error("No Android app has been launched.");
      if (strategy === "clear-data") {
        const output = await this.#deviceText(["shell", "pm", "clear", current.packageName]);
        if (!/(?:^|\s)Success(?:\s|$)/u.test(output)) {
          throw new Error(`ADB did not confirm app-data clearing: ${cleanText(output)}`);
        }
      }
      this.#settledBaseline = null;
      await this.#launch({
        id: current.packageName,
        ...(current.component === null ? {} : { launchUri: current.component }),
      });
    });
  }

  async press(key: RemoteKey): Promise<ActionResult> {
    this.#ensureOpen();
    return await this.#enqueue(() => this.#press(key));
  }

  async #press(key: RemoteKey): Promise<ActionResult> {
    const profileCaptureDurations: number[] = [];
    let pollCount = 0;
    let wedgeSuspected = false;
    let instantFailures = 0;

    // 1. Establish the compared pre-input state. Fail closed before sending
    // input when neither the settled cache nor a fresh capture is available.
    let baselineSource: "fresh" | "cached" | "unavailable" = "unavailable";
    let baseline!: ParsedAndroidHierarchy;
    const cached = this.#settledBaseline;
    if (
      cached !== null
      && performance.now() - cached.capturedAtMs <= this.#options.baselineReuseMs
    ) {
      baselineSource = "cached";
      baseline = cached.hierarchy;
    } else {
      let captureError: unknown = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const started = performance.now();
          baseline = await this.#captureHierarchy(this.#options.hierarchyTimeoutMs);
          profileCaptureDurations.push(performance.now() - started);
          baselineSource = "fresh";
          captureError = null;
          break;
        } catch (error) {
          captureError = error;
          await delay(250 * (attempt + 1));
        }
      }
      if (captureError !== null) {
        return {
          key,
          outcome: "failed",
          timing: {
            inputSentAtMs: Date.now(),
            profile: {
              baselineSource,
              captureCount: profileCaptureDurations.length,
            },
          },
          message:
            "Android UI observation remained unavailable before input; input was not sent.",
        };
      }
    }

    // 2. Deliver the key event.
    const inputSentAtMs = Date.now();
    const inputStarted = performance.now();
    try {
      await this.#deviceText(["shell", "input", "keyevent", KEY_CODES[key]]);
    } catch (error) {
      this.#settledBaseline = null;
      return {
        key,
        outcome: "failed",
        timing: {
          inputSentAtMs,
          profile: {
            baselineSource,
            captureCount: profileCaptureDurations.length,
            captureDurationsMs: [...profileCaptureDurations],
            inputDispatchMs: performance.now() - inputStarted,
          },
        },
        message: cleanText(error instanceof Error ? error.message : String(error)),
      };
    }
    const inputDispatchMs = performance.now() - inputStarted;

    const baselineSignature = baseline.settleSignature;
    const baselineFocus = focusedIdentity(baseline);
    const deadline = performance.now() + this.#options.settleTimeoutMs;
    let firstResponseAtMs: number | undefined;
    let focusChanged = false;
    let screenSettledAtMs: number | undefined;
    let settledHierarchy: ParsedAndroidHierarchy | null = null;
    let unchangedAfterInputSamples = 0;
    let probeFailures = 0;
    let failureMessage: string | null = null;

    while (performance.now() < deadline && failureMessage === null) {
      pollCount += 1;
      const remainingMs = deadline - performance.now();
      const graceRemainingMs = Math.max(
        0,
        this.#options.noResponseGraceMs - (Date.now() - inputSentAtMs),
      );
      await delay(Math.min(
        Math.max(graceRemainingMs, this.#options.settlePollIntervalMs),
        Math.max(1, remainingMs),
      ));

      let hierarchy: ParsedAndroidHierarchy;
      const captureStarted = performance.now();
      try {
        hierarchy = await this.#captureHierarchy(
          Math.max(1, Math.min(this.#options.hierarchyTimeoutMs, deadline - performance.now())),
        );
        profileCaptureDurations.push(performance.now() - captureStarted);
        instantFailures = 0;
      } catch (error) {
        const durationMs = performance.now() - captureStarted;
        if (durationMs < WEDGE_FAILURE_MS) {
          instantFailures += 1;
          if (instantFailures >= WEDGE_FAILURE_LIMIT) wedgeSuspected = true;
        }
        if (wedgeSuspected || performance.now() >= deadline) {
          failureMessage = wedgeSuspected
            ? "UIAutomator observations began failing instantly; device observation looks wedged."
            : `Settling observation failed: ${cleanText(error instanceof Error ? error.message : String(error))}`;
          break;
        }
        await delay(250);
        continue;
      }

      const changed = hierarchy.settleSignature !== baselineSignature;
      if (changed && firstResponseAtMs === undefined) firstResponseAtMs = Date.now();
      focusChanged ||= focusedIdentity(hierarchy) !== baselineFocus;

      if (!changed) {
        unchangedAfterInputSamples += 1;
        if (unchangedAfterInputSamples >= this.#options.settleStableSamples) {
          // Canonical no-op: multiple post-input observations match the
          // pre-input state, so a delayed response is not still arriving.
          screenSettledAtMs = Date.now();
          settledHierarchy = hierarchy;
          break;
        }
        continue;
      }
      unchangedAfterInputSamples = 0;

      // The UI responded. Confirm quiescence with two screen samples
      // separated by a measured quiet window instead of paying for another
      // full hierarchy capture while animations finish.
      let stable: boolean;
      try {
        await delay(Math.min(
          this.#options.stabilityProbeMs,
          Math.max(1, deadline - performance.now()),
        ));
        const firstStarted = performance.now();
        const firstProbe = sha256Prefix((await this.#screenCapture(
          Math.max(1, Math.min(this.#options.commandTimeoutMs, deadline - performance.now())),
        )).png);
        profileCaptureDurations.push(performance.now() - firstStarted);
        await delay(Math.min(
          this.#options.stabilityProbeMs,
          Math.max(1, deadline - performance.now()),
        ));
        const secondStarted = performance.now();
        const secondProbe = sha256Prefix((await this.#screenCapture(
          Math.max(1, Math.min(this.#options.commandTimeoutMs, deadline - performance.now())),
        )).png);
        profileCaptureDurations.push(performance.now() - secondStarted);
        stable = firstProbe === secondProbe;
      } catch {
        stable = false;
      }

      if (stable) {
        try {
          const started = performance.now();
          settledHierarchy = await this.#captureHierarchy(
            Math.max(1, Math.min(this.#options.hierarchyTimeoutMs, deadline - performance.now())),
          );
          profileCaptureDurations.push(performance.now() - started);
          screenSettledAtMs = Date.now();
          break;
        } catch {
          settledHierarchy = null;
        }
      }
      probeFailures += 1;
      if (probeFailures >= SCREEN_PROBE_FALLBACK_LIMIT
        && performance.now() < deadline) {
        // The screen keeps changing (e.g. a shimmer animation). Fall back to a
        // second hierarchy capture: two consecutive equal trees prove the
        // semantic state is stable even when pixels keep animating.
        try {
          const started = performance.now();
          const confirmation = await this.#captureHierarchy(
            Math.max(1, Math.min(this.#options.hierarchyTimeoutMs, deadline - performance.now())),
          );
          profileCaptureDurations.push(performance.now() - started);
          instantFailures = 0;
          if (confirmation.settleSignature === hierarchy.settleSignature) {
            screenSettledAtMs = Date.now();
            settledHierarchy = confirmation;
            break;
          }
        } catch {
          // Continue polling; the outer timeout handles exhaustion.
        }
      }
      if (performance.now() >= deadline) break;
    }

    if (failureMessage !== null || settledHierarchy === null || screenSettledAtMs === undefined) {
      this.#settledBaseline = null;
      return {
        key,
        outcome: "inconclusive",
        timing: {
          inputSentAtMs,
          ...(firstResponseAtMs === undefined ? {} : { firstResponseAtMs }),
          profile: {
            baselineSource,
            captureCount: profileCaptureDurations.length,
            captureDurationsMs: [...profileCaptureDurations].slice(0, MAX_PROFILE_CAPTURES),
            inputDispatchMs,
            pollCount,
            wedgeSuspected,
          },
        },
        message: failureMessage
          ?? "Input was delivered, but the Android UI never reached a confirmed settle within the configured budget.",
      };
    }

    this.#settledBaseline = {
      hierarchy: settledHierarchy,
      capturedAtMs: performance.now(),
    };

    const snapshot = await this.#buildStateSnapshot(settledHierarchy);
    return {
      key,
      outcome: "applied",
      timing: {
        inputSentAtMs,
        ...(firstResponseAtMs === undefined ? {} : { firstResponseAtMs }),
        ...(focusChanged ? { focusSettledAtMs: screenSettledAtMs } : {}),
        screenSettledAtMs,
        profile: {
          baselineSource,
          captureCount: profileCaptureDurations.length,
          captureDurationsMs: [...profileCaptureDurations].slice(0, MAX_PROFILE_CAPTURES),
          inputDispatchMs,
          pollCount,
          wedgeSuspected,
        },
      },
      postActionSnapshot: snapshot,
    };
  }

  async snapshot(): Promise<AndroidStateSnapshot> {
    this.#ensureOpen();
    return await this.#enqueue(async () => {
      let hierarchy: ParsedAndroidHierarchy | null;
      try {
        hierarchy = await this.#captureHierarchy();
      } catch {
        hierarchy = null;
      }
      const snapshot = await this.#buildStateSnapshot(hierarchy);
      if (hierarchy !== null) {
        this.#settledBaseline = { hierarchy, capturedAtMs: performance.now() };
      }
      return snapshot;
    });
  }

  async #buildStateSnapshot(
    hierarchy: ParsedAndroidHierarchy | null,
  ): Promise<AndroidStateSnapshot> {
    const capturedAt = new Date().toISOString();
    const hierarchyFailure = hierarchy === null
      ? "UIAutomator observation failed."
      : null;
    const [locationResult, deviceResult, appResult] = await Promise.all([
      this.#deviceText(["shell", "dumpsys", "activity", "activities"])
        .then((output) => ({ value: currentActivity(output), failure: null as string | null }))
        .catch((error: unknown) => ({
          value: null,
          failure: `Android activity observation failed: ${cleanText(error instanceof Error ? error.message : String(error))}`,
        })),
      this.getDeviceMetadata()
        .then((metadata) => ({ value: metadata, failure: null as string | null }))
        .catch((error: unknown) => ({
          value: null,
          failure: `Android device metadata unavailable: ${cleanText(error instanceof Error ? error.message : String(error))}`,
        })),
      this.getAppMetadata()
        .then((metadata) => ({ value: metadata, failure: null as string | null }))
        .catch((error: unknown) => ({
          value: null,
          failure: `Android app metadata unavailable: ${cleanText(error instanceof Error ? error.message : String(error))}`,
        })),
    ]);
    const location = locationResult.value;
    const locationFailure = locationResult.failure ?? (location === null
      ? "Android resumed activity was not observable."
      : null);
    const device = deviceResult.value;
    const deviceFailure = deviceResult.failure;
    const app = appResult.value;
    const appFailure = appResult.failure;

    const focusObservation = hierarchy === null
      ? unavailableObservation(hierarchyFailure ?? "UIAutomator hierarchy unavailable.")
      : hierarchy.focusedNodeCount <= 1
        ? availableObservation<FocusTarget | null>(hierarchy.focusedTarget)
        : unavailableObservation("UIAutomator hierarchy reported multiple focused nodes.");
    return {
      capturedAt,
      location: location === null
        ? unavailableObservation(locationFailure ?? "Android activity unavailable.")
        : availableObservation(location),
      focusedElement: focusObservation,
      uiTree: hierarchy === null
        ? unavailableObservation(hierarchyFailure ?? "UIAutomator hierarchy unavailable.")
        : availableObservation(hierarchy.roots),
      hierarchyMetadata: hierarchy === null
        ? unavailableObservation(hierarchyFailure ?? "UIAutomator hierarchy unavailable.")
        : availableObservation(hierarchy.metadata),
      device: device === null
        ? unavailableObservation(deviceFailure ?? "Android device metadata unavailable.")
        : availableObservation(device),
      app: app === null
        ? unavailableObservation(appFailure ?? "Android app metadata unavailable.")
        : availableObservation(app),
    };
  }

  async captureScreenshot(artifactPath: string): Promise<ScreenshotArtifact> {
    this.#ensureOpen();
    if (artifactPath.includes("\0") || extname(artifactPath).toLowerCase() !== ".png") {
      throw new TypeError("Android screenshots require a .png artifact path.");
    }
    const absolutePath = resolve(artifactPath);
    const result = await this.#screenCapture();
    const dimensions = pngDimensions(result.png);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, result.png);
    return {
      path: absolutePath,
      mediaType: "image/png",
      width: dimensions.width,
      height: dimensions.height,
      capturedAt: new Date().toISOString(),
    };
  }

  async getLogs(): Promise<readonly AndroidLogEntry[]> {
    this.#ensureOpen();
    if (this.#launchPid === null) return [];
    const sinceSeconds = Math.max(0, this.#launchStartedAtMs / 1_000 - 1).toFixed(3);
    const output = await this.#deviceText(
      ["logcat", "-d", "-v", "epoch", "-T", sinceSeconds, `--pid=${String(this.#launchPid)}`],
      { maxOutputBytes: this.#options.maxCommandOutputBytes },
    );
    return parseLogcat(output, this.#options.maxLogEntries);
  }

  async getDeviceMetadata(refresh = false): Promise<AndroidDeviceMetadata> {
    this.#ensureOpen();
    if (!refresh && this.#deviceMetadata !== null) return this.#deviceMetadata;
    const [propertiesOutput, sizeOutput, densityOutput] = await Promise.all([
      this.#deviceText(["shell", "getprop"]),
      this.#deviceText(["shell", "wm", "size"]),
      this.#deviceText(["shell", "wm", "density"]),
    ]);
    const properties = parseProperties(propertiesOutput);
    const size = lastDisplayPair(sizeOutput, "size");
    const density = lastDisplayPair(densityOutput, "density");
    const supportedAbis = (properties.get("ro.product.cpu.abilist") ?? "")
      .split(",")
      .map((value) => cleanText(value, 64))
      .filter((value) => value.length > 0);
    const characteristics = (properties.get("ro.build.characteristics") ?? "")
      .split(",")
      .map((value) => cleanText(value, 128))
      .filter((value) => value.length > 0)
      .sort();
    const sdkLevel = parsePositiveInteger(properties.get("ro.build.version.sdk"));
    this.#deviceMetadata = {
      serial: await this.#serial(),
      manufacturer: optionalCleanText(properties.get("ro.product.manufacturer")),
      model: optionalCleanText(properties.get("ro.product.model")),
      sdkLevel,
      release: optionalCleanText(properties.get("ro.build.version.release")),
      buildFingerprint: optionalCleanText(properties.get("ro.build.fingerprint")),
      characteristics,
      supportedAbis,
      displayWidth: size?.[0] ?? null,
      displayHeight: size?.[1] ?? null,
      displayDensityDpi: density?.[0] ?? null,
      isTelevision: characteristics.length === 0 ? null : characteristics.includes("tv"),
    };
    const semanticFingerprint = [
      properties.get("ro.product.model"),
      properties.get("ro.product.name"),
      properties.get("ro.build.fingerprint"),
    ].filter((value): value is string => value !== undefined).join(" ").toLowerCase();
    const inferredTelevision = /\b(?:atv|android[_ ]?tv|leanback)\b/u.test(semanticFingerprint);
    this.#deviceMetadata = {
      ...this.#deviceMetadata,
      isTelevision: characteristics.includes("tv") || inferredTelevision,
    };
    return this.#deviceMetadata;
  }

  async getAppMetadata(): Promise<AndroidAppMetadata> {
    this.#ensureOpen();
    const current = this.#currentApp;
    if (current === null) throw new Error("No Android app has been launched.");
    const cached = this.#cachedVersionInfo;
    if (cached !== null && cached.packageName === current.packageName) {
      const pid = parsePositiveInteger(cleanText(
        await this.#deviceText(["shell", "pidof", "-s", current.packageName]).catch(() => ""),
      ));
      return {
        packageName: current.packageName,
        component: current.component,
        pid,
        versionName: cached.versionName,
        versionCode: cached.versionCode,
      };
    }
    const [pidOutput, packageOutput] = await Promise.all([
      this.#deviceText(["shell", "pidof", "-s", current.packageName]).catch(() => ""),
      this.#deviceText(["shell", "dumpsys", "package", current.packageName]),
    ]);
    const pid = parsePositiveInteger(cleanText(pidOutput));
    const versionName = /\bversionName=([^\s]+)/u.exec(packageOutput)?.[1];
    const versionCode = /\bversionCode=(\d+)/u.exec(packageOutput)?.[1];
    this.#cachedVersionInfo = {
      packageName: current.packageName,
      versionName: optionalCleanText(versionName),
      versionCode: parsePositiveInteger(versionCode),
    };
    return {
      packageName: current.packageName,
      component: current.component,
      pid,
      versionName: optionalCleanText(versionName),
      versionCode: parsePositiveInteger(versionCode),
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#currentApp = null;
    this.#launchPid = null;
    this.#settledBaseline = null;
    this.#cachedVersionInfo = null;
  }

  async #serial(): Promise<string> {
    if (this.#resolvedSerial !== null) return this.#resolvedSerial;
    const devices = await this.listDevices();
    const online = devices.filter((device) => device.state === "device");
    if (online.length !== 1 || online[0] === undefined) {
      const states = devices.map((device) => `${device.serial}:${device.state}`).join(", ");
      throw new Error(
        `Exactly one online Android device is required when serial is omitted; found ${String(online.length)}${states.length === 0 ? "" : ` (${cleanText(states)})`}.`,
      );
    }
    this.#resolvedSerial = validateSerial(online[0].serial);
    return this.#resolvedSerial;
  }

  async #deviceCommand(
    arguments_: readonly string[],
    options: AdbCommandOptions = {},
  ) {
    const serial = await this.#serial();
    return await this.#options.executor.execute(["-s", serial, ...arguments_], options);
  }

  async #deviceText(
    arguments_: readonly string[],
    options: AdbCommandOptions = {},
  ): Promise<string> {
    return utf8((await this.#deviceCommand(arguments_, options)).stdout);
  }

  async #text(arguments_: readonly string[], options: AdbCommandOptions = {}): Promise<string> {
    return utf8((await this.#options.executor.execute(arguments_, options)).stdout);
  }

  async #captureHierarchy(timeoutMs = this.#options.hierarchyTimeoutMs): Promise<ParsedAndroidHierarchy> {
    hierarchyCaptureSequence += 1;
    const remotePath = `/data/local/tmp/tvdoctor-hierarchy-${String(process.pid)}-${String(hierarchyCaptureSequence)}.xml`;
    const timeout = Math.max(1, Math.floor(timeoutMs));
    const script = `rm -f ${remotePath}; uiautomator dump --compressed ${remotePath} >/dev/null 2>&1; dump_rc=$?; if [ $dump_rc -ne 0 ]; then exit $dump_rc; fi; cat ${remotePath}`;
    try {
      const result = await this.#deviceCommand(
        ["shell", script],
        { timeoutMs: timeout, maxOutputBytes: this.#options.maxHierarchyBytes },
      );
      return parseUiAutomatorHierarchy(result.stdout, {
        maxBytes: this.#options.maxHierarchyBytes,
        maxNodes: this.#options.maxHierarchyNodes,
        maxDepth: this.#options.maxHierarchyDepth,
      });
    } finally {
      await this.#deviceCommand(
        ["shell", "rm", "-f", remotePath],
        { timeoutMs: Math.min(1_000, this.#options.commandTimeoutMs), maxOutputBytes: 1_024 },
      ).catch(() => undefined);
    }
  }

  async #screenCapture(timeoutMs = this.#options.commandTimeoutMs): Promise<{ readonly png: Uint8Array }> {
    const result = await this.#deviceCommand(
      ["exec-out", "screencap", "-p"],
      {
        timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        maxOutputBytes: this.#options.maxScreenshotBytes,
      },
    );
    pngDimensions(result.stdout);
    return { png: result.stdout };
  }

  async #waitForStableHierarchy(timeoutMs: number): Promise<ParsedAndroidHierarchy> {
    const deadline = performance.now() + timeoutMs;
    let previous: string | null = null;
    let stableSamples = 0;
    let latest: ParsedAndroidHierarchy | null = null;
    while (performance.now() < deadline) {
      latest = await this.#captureHierarchy(Math.max(1, deadline - performance.now()));
      stableSamples = latest.settleSignature === previous ? stableSamples + 1 : 1;
      previous = latest.settleSignature;
      if (stableSamples >= this.#options.settleStableSamples) return latest;
      await delay(Math.min(this.#options.settlePollIntervalMs, Math.max(1, deadline - performance.now())));
    }
    if (latest === null) {
      throw new Error("Android hierarchy did not become observable before the settle deadline.");
    }
    throw new Error("Android hierarchy did not become stable before the settle deadline.");
  }

  async #waitForPid(packageName: string, timeoutMs: number): Promise<number | null> {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      const output = await this.#deviceText(["shell", "pidof", "-s", packageName]).catch(() => "");
      const pid = parsePositiveInteger(cleanText(output));
      if (pid !== null) return pid;
      await delay(Math.min(100, Math.max(1, deadline - performance.now())));
    }
    return null;
  }

  #ensureOpen(): void {
    if (this.#closed) throw new Error("Android TV driver is closed.");
  }
}
