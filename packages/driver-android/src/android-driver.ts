import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import {
  availableObservation,
  unavailableObservation,
  type ActionResult,
  type ActionTiming,
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
    noResponseGraceMs: nonNegativeInteger(options.noResponseGraceMs, 250, "noResponseGraceMs"),
    serial: options.serial === undefined ? undefined : validateSerial(options.serial),
    settlePollIntervalMs: positiveInteger(options.settlePollIntervalMs, 100, "settlePollIntervalMs"),
    settleStableSamples: positiveInteger(options.settleStableSamples, 2, "settleStableSamples"),
    settleTimeoutMs: positiveInteger(options.settleTimeoutMs, 3_000, "settleTimeoutMs"),
  };
}

export class AndroidTvDriver implements TVDoctorDriver {
  readonly #options: NormalisedOptions;
  #closed = false;
  #currentApp: CurrentApp | null = null;
  #deviceMetadata: AndroidDeviceMetadata | null = null;
  #hierarchySequence = 0;
  #launchPid: number | null = null;
  #launchStartedAtMs = 0;
  #resolvedSerial: string | null = null;

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
    await this.#waitForStableHierarchy(this.#options.settleTimeoutMs).catch(() => undefined);
  }

  async forceStop(packageName = this.#currentApp?.packageName): Promise<void> {
    this.#ensureOpen();
    if (packageName === undefined) throw new Error("No Android package is selected.");
    await this.#deviceText(["shell", "am", "force-stop", validatePackageName(packageName)]);
  }

  async reset(strategy: ResetStrategy): Promise<void> {
    this.#ensureOpen();
    const current = this.#currentApp;
    if (current === null) throw new Error("No Android app has been launched.");
    if (strategy === "clear-data") {
      const output = await this.#deviceText(["shell", "pm", "clear", current.packageName]);
      if (!/(?:^|\s)Success(?:\s|$)/u.test(output)) {
        throw new Error(`ADB did not confirm app-data clearing: ${cleanText(output)}`);
      }
    }
    await this.launch({
      id: current.packageName,
      ...(current.component === null ? {} : { launchUri: current.component }),
    });
  }

  async press(key: RemoteKey): Promise<ActionResult> {
    this.#ensureOpen();
    const inputSentAtMs = Date.now();
    let baseline: ParsedAndroidHierarchy | null = null;
    try {
      baseline = await this.#captureHierarchy();
    } catch {
      // Input delivery can still be truthful even when pre-action observation is unavailable.
    }
    try {
      await this.#deviceText(["shell", "input", "keyevent", KEY_CODES[key]]);
    } catch (error) {
      return {
        key,
        outcome: "failed",
        timing: { inputSentAtMs },
        message: cleanText(error instanceof Error ? error.message : String(error)),
      };
    }

    if (baseline === null) {
      return {
        key,
        outcome: "applied",
        timing: { inputSentAtMs },
        message: "Input was delivered, but pre-action hierarchy observation was unavailable.",
      };
    }

    const baselineSignature = baseline.settleSignature;
    const baselineFocus = focusedIdentity(baseline);
    const deadline = performance.now() + this.#options.settleTimeoutMs;
    let previousSignature: string | null = null;
    let stableSamples = 0;
    let firstResponseAtMs: number | undefined;
    let focusChanged = false;
    let lastError: unknown;
    while (performance.now() < deadline) {
      try {
        const hierarchy = await this.#captureHierarchy(
          Math.max(1, Math.min(this.#options.hierarchyTimeoutMs, deadline - performance.now())),
        );
        const nowEpochMs = Date.now();
        const changed = hierarchy.settleSignature !== baselineSignature;
        if (changed && firstResponseAtMs === undefined) firstResponseAtMs = nowEpochMs;
        focusChanged ||= focusedIdentity(hierarchy) !== baselineFocus;
        stableSamples = hierarchy.settleSignature === previousSignature ? stableSamples + 1 : 1;
        previousSignature = hierarchy.settleSignature;
        const graceElapsed = nowEpochMs - inputSentAtMs >= this.#options.noResponseGraceMs;
        if (stableSamples >= this.#options.settleStableSamples && (changed || graceElapsed)) {
          const timing: ActionTiming = {
            inputSentAtMs,
            ...(firstResponseAtMs === undefined ? {} : { firstResponseAtMs }),
            ...(focusChanged ? { focusSettledAtMs: nowEpochMs } : {}),
            screenSettledAtMs: nowEpochMs,
          };
          return { key, outcome: "applied", timing };
        }
      } catch (error) {
        lastError = error;
      }
      await delay(Math.min(
        this.#options.settlePollIntervalMs,
        Math.max(1, deadline - performance.now()),
      ));
    }
    return {
      key,
      outcome: "applied",
      timing: {
        inputSentAtMs,
        ...(firstResponseAtMs === undefined ? {} : { firstResponseAtMs }),
        ...(focusChanged ? { focusSettledAtMs: Date.now() } : {}),
        screenSettledAtMs: Date.now(),
      },
      message: lastError === undefined
        ? "Input was delivered, but the Android UI did not reach the configured stability threshold."
        : `Input was delivered, but settling observation failed: ${cleanText(lastError instanceof Error ? lastError.message : String(lastError))}`,
    };
  }

  async snapshot(): Promise<AndroidStateSnapshot> {
    this.#ensureOpen();
    const capturedAt = new Date().toISOString();
    let hierarchy: ParsedAndroidHierarchy | null = null;
    let hierarchyFailure: string | null = null;
    try {
      hierarchy = await this.#captureHierarchy();
    } catch (error) {
      hierarchyFailure = `UIAutomator observation failed: ${cleanText(error instanceof Error ? error.message : String(error))}`;
    }

    let location: string | null = null;
    let locationFailure: string | null = null;
    try {
      location = currentActivity(await this.#deviceText(["shell", "dumpsys", "activity", "activities"]));
      if (location === null) locationFailure = "Android resumed activity was not observable.";
    } catch (error) {
      locationFailure = `Android activity observation failed: ${cleanText(error instanceof Error ? error.message : String(error))}`;
    }

    let device: AndroidDeviceMetadata | null = null;
    let deviceFailure: string | null = null;
    try {
      device = await this.getDeviceMetadata();
    } catch (error) {
      deviceFailure = `Android device metadata unavailable: ${cleanText(error instanceof Error ? error.message : String(error))}`;
    }

    let app: AndroidAppMetadata | null = null;
    let appFailure: string | null = null;
    try {
      app = await this.getAppMetadata();
    } catch (error) {
      appFailure = `Android app metadata unavailable: ${cleanText(error instanceof Error ? error.message : String(error))}`;
    }

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
    const result = await this.#deviceCommand(
      ["exec-out", "screencap", "-p"],
      {
        timeoutMs: this.#options.commandTimeoutMs,
        maxOutputBytes: this.#options.maxScreenshotBytes,
      },
    );
    const dimensions = pngDimensions(result.stdout);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, result.stdout);
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
      displayWidth: size?.[0] ?? null,
      displayHeight: size?.[1] ?? null,
      displayDensityDpi: density?.[0] ?? null,
      isTelevision: characteristics.length === 0 ? null : characteristics.includes("tv"),
    };
    return this.#deviceMetadata;
  }

  async getAppMetadata(): Promise<AndroidAppMetadata> {
    this.#ensureOpen();
    const current = this.#currentApp;
    if (current === null) throw new Error("No Android app has been launched.");
    const [pidOutput, packageOutput] = await Promise.all([
      this.#deviceText(["shell", "pidof", "-s", current.packageName]).catch(() => ""),
      this.#deviceText(["shell", "dumpsys", "package", current.packageName]),
    ]);
    const pid = parsePositiveInteger(cleanText(pidOutput));
    const versionName = /\bversionName=([^\s]+)/u.exec(packageOutput)?.[1];
    const versionCode = /\bversionCode=(\d+)/u.exec(packageOutput)?.[1];
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
    this.#hierarchySequence += 1;
    const remotePath = `/data/local/tmp/tvdoctor-hierarchy-${String(process.pid)}-${String(this.#hierarchySequence)}.xml`;
    const timeout = Math.max(1, Math.floor(timeoutMs));
    try {
      await this.#deviceText(
        ["shell", "uiautomator", "dump", "--compressed", remotePath],
        { timeoutMs: timeout, maxOutputBytes: 64 * 1024 },
      );
      const result = await this.#deviceCommand(
        ["exec-out", "cat", remotePath],
        { timeoutMs: timeout, maxOutputBytes: this.#options.maxHierarchyBytes },
      );
      return parseUiAutomatorHierarchy(result.stdout, {
        maxBytes: this.#options.maxHierarchyBytes,
        maxNodes: this.#options.maxHierarchyNodes,
        maxDepth: this.#options.maxHierarchyDepth,
      });
    } finally {
      await this.#deviceText(
        ["shell", "rm", "-f", remotePath],
        { timeoutMs: Math.min(timeout, 5_000), maxOutputBytes: 64 * 1024 },
      ).catch(() => undefined);
    }
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
    if (latest !== null) return latest;
    throw new Error("Android hierarchy did not become observable before the settle deadline.");
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
