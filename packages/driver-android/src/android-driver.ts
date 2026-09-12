import { createHash, randomBytes } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import {
  availableObservation,
  unavailableObservation,
  type ActionResult,
  type Capability,
  type DriverOperationOptions,
  type RemoteKey,
  type ResetStrategy,
  type ScreenshotArtifact,
  type TVDoctorDriver,
} from "@tvdoctor/protocol";
import { resolveAndroidObserverAsset } from "./observer-asset.js";
import { AndroidObserverClient, type AndroidObserverConnection } from "./observer-client.js";
import {
  ANDROID_OBSERVER_DEVICE_PORT,
  parseObserverState,
  type ObserverSettleTiming,
  type ObserverState,
} from "./observer-protocol.js";
import { NodeAdbCommandExecutor } from "./subprocess.js";
import type {
  AdbCommandOptions,
  AndroidAppMetadata,
  AndroidAppReference,
  AndroidDeviceListEntry,
  AndroidDeviceMetadata,
  AndroidLogEntry,
  AndroidObserverMetrics,
  AndroidStateSnapshot,
  AndroidTvDriverOptions,
  AndroidUiNodeSnapshot,
} from "./types.js";

const CAPABILITIES: ReadonlySet<Capability> = new Set([
  "remote-input", "ui-tree", "accessibility-tree", "screenshot", "logs", "install", "launch",
]);
const PACKAGE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u;
const SERIAL_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;
const COMPONENT_CLASS_PATTERN = /^(?:\.[A-Za-z0-9_$]+(?:\.[A-Za-z0-9_$]+)*|[A-Za-z][A-Za-z0-9_$]*(?:\.[A-Za-z0-9_$]+)+)$/u;
const KEY_CODES: Readonly<Record<RemoteKey, string>> = {
  UP: "KEYCODE_DPAD_UP", DOWN: "KEYCODE_DPAD_DOWN", LEFT: "KEYCODE_DPAD_LEFT",
  RIGHT: "KEYCODE_DPAD_RIGHT", SELECT: "KEYCODE_DPAD_CENTER", BACK: "KEYCODE_BACK",
  HOME: "KEYCODE_HOME", PLAY_PAUSE: "KEYCODE_MEDIA_PLAY_PAUSE", PLAY: "KEYCODE_MEDIA_PLAY",
  PAUSE: "KEYCODE_MEDIA_PAUSE", STOP: "KEYCODE_MEDIA_STOP", NEXT: "KEYCODE_MEDIA_NEXT",
  PREVIOUS: "KEYCODE_MEDIA_PREVIOUS", REWIND: "KEYCODE_MEDIA_REWIND",
  FAST_FORWARD: "KEYCODE_MEDIA_FAST_FORWARD",
};

interface NormalisedOptions {
  readonly executor: NonNullable<AndroidTvDriverOptions["executor"]>;
  readonly serial: string | undefined;
  readonly commandTimeoutMs: number;
  readonly maxCommandOutputBytes: number;
  readonly maxLogEntries: number;
  readonly maxScreenshotBytes: number;
  readonly settleTimeoutMs: number;
  readonly quietWindowMs: number;
  readonly noResponseGraceMs: number;
  readonly resetStableWindowMs: number;
  readonly resetSettleTimeoutMs: number;
  readonly observerConnectTimeoutMs: number;
  readonly observerRequestTimeoutMs: number;
  readonly signal: AbortSignal | undefined;
  readonly observerAsset: AndroidTvDriverOptions["observerAsset"];
  readonly createObserverClient: NonNullable<AndroidTvDriverOptions["createObserverClient"]>;
  readonly tokenFactory: () => string;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate <= 0 || candidate > 60_000) {
    throw new TypeError(`${name} must be a positive integer no greater than 60000.`);
  }
  return candidate;
}

function cleanText(value: string): string {
  // eslint-disable-next-line no-control-regex -- ADB output may contain terminal control bytes that must not reach reports.
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ").trim().slice(0, 2_000);
}
function utf8(value: Uint8Array): string { return Buffer.from(value).toString("utf8"); }
function defaultAdbPath(): string {
  const sdkRoot = process.env["ANDROID_SDK_ROOT"] ?? process.env["ANDROID_HOME"]
    ?? (process.platform === "win32" && process.env["LOCALAPPDATA"] !== undefined
      ? join(process.env["LOCALAPPDATA"], "Android", "Sdk") : undefined);
  return sdkRoot === undefined || sdkRoot.trim().length === 0
    ? "adb" : join(sdkRoot, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
}
function validateSerial(value: string): string {
  if (!SERIAL_PATTERN.test(value)) throw new TypeError("Android device serial is invalid.");
  return value;
}
function validatePackage(value: string): string {
  if (!PACKAGE_PATTERN.test(value)) throw new TypeError("Android package name is invalid.");
  return value;
}
function componentName(packageName: string, requested: string): string {
  const value = requested.includes("/") ? requested.split("/", 2)[1] ?? "" : requested;
  if (!COMPONENT_CLASS_PATTERN.test(value)) throw new TypeError("Android activity class is invalid.");
  return `${packageName}/${value}`;
}

function normaliseOptions(options: AndroidTvDriverOptions): NormalisedOptions {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new TypeError("Android driver options must be an object.");
  }
  const commandTimeoutMs = positiveInteger(options.commandTimeoutMs, 15_000, "commandTimeoutMs");
  const quietWindowMs = positiveInteger(options.quietWindowMs, 100, "quietWindowMs");
  const noResponseGraceMs = positiveInteger(options.noResponseGraceMs, 220, "noResponseGraceMs");
  const settleTimeoutMs = positiveInteger(options.settleTimeoutMs, 2_500, "settleTimeoutMs");
  const resetStableWindowMs = positiveInteger(options.resetStableWindowMs, 600, "resetStableWindowMs");
  const resetSettleTimeoutMs = positiveInteger(options.resetSettleTimeoutMs, 8_000, "resetSettleTimeoutMs");
  if (quietWindowMs >= settleTimeoutMs || noResponseGraceMs >= settleTimeoutMs) {
    throw new TypeError("Android observer quiet and no-response windows must be shorter than settleTimeoutMs.");
  }
  if (resetStableWindowMs >= resetSettleTimeoutMs) {
    throw new TypeError("Android reset stability window must be shorter than resetSettleTimeoutMs.");
  }
  return {
    executor: options.executor ?? new NodeAdbCommandExecutor(options.adbPath ?? defaultAdbPath(), {
      timeoutMs: commandTimeoutMs, maxOutputBytes: options.maxCommandOutputBytes ?? 2 * 1024 * 1024,
    }),
    serial: options.serial === undefined ? undefined : validateSerial(options.serial),
    commandTimeoutMs,
    maxCommandOutputBytes: options.maxCommandOutputBytes ?? 2 * 1024 * 1024,
    maxLogEntries: options.maxLogEntries ?? 500,
    maxScreenshotBytes: options.maxScreenshotBytes ?? 25 * 1024 * 1024,
    settleTimeoutMs, quietWindowMs, noResponseGraceMs, resetStableWindowMs, resetSettleTimeoutMs,
    observerConnectTimeoutMs: positiveInteger(options.observerConnectTimeoutMs, 5_000, "observerConnectTimeoutMs"),
    observerRequestTimeoutMs: positiveInteger(options.observerRequestTimeoutMs, 7_500, "observerRequestTimeoutMs"),
    signal: options.signal,
    observerAsset: options.observerAsset,
    createObserverClient: options.createObserverClient ?? AndroidObserverClient.connect,
    tokenFactory: options.tokenFactory ?? (() => randomBytes(32).toString("hex")),
  };
}

function parseDevices(output: string): readonly AndroidDeviceListEntry[] {
  const result: AndroidDeviceListEntry[] = [];
  for (const line of output.split(/\r?\n/u).slice(1)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("*")) continue;
    const [serial, state, ...attributes] = trimmed.split(/\s+/u);
    if (serial === undefined || state === undefined || !SERIAL_PATTERN.test(serial)) continue;
    const values = new Map<string, string>();
    for (const attribute of attributes) {
      const separator = attribute.indexOf(":");
      if (separator > 0) values.set(attribute.slice(0, separator), attribute.slice(separator + 1));
    }
    result.push({
      serial, state, product: values.get("product") ?? null,
      model: values.get("model")?.replaceAll("_", " ") ?? null,
      device: values.get("device") ?? null, transportId: values.get("transport_id") ?? null,
    });
  }
  return result;
}
function optionalText(value: string | undefined): string | null {
  const cleaned = value === undefined ? "" : cleanText(value);
  return cleaned.length === 0 ? null : cleaned;
}
function optionalInteger(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
function focusedWindowPackage(output: string): string | null {
  const currentFocus = output.split(/\r?\n/u).find((line) => line.includes("mCurrentFocus="));
  if (currentFocus === undefined || /mCurrentFocus=(?:null|Window\{[^}]*\snull(?:\s|\}))/u.test(currentFocus)) return null;
  const match = /\s([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)\//u.exec(currentFocus);
  return match?.[1] ?? null;
}
function pngDimensions(png: Uint8Array): { readonly width: number; readonly height: number } {
  const buffer = Buffer.from(png);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.byteLength < 24 || !buffer.subarray(0, 8).equals(signature)
    || buffer.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new Error("Android screenshot did not contain a valid PNG header.");
  }
  const width = buffer.readUInt32BE(16); const height = buffer.readUInt32BE(20);
  if (width <= 0 || height <= 0) throw new Error("Android screenshot dimensions are invalid.");
  return { width, height };
}
function withFocus(nodes: readonly AndroidUiNodeSnapshot[], focusedStableId: string | null): readonly AndroidUiNodeSnapshot[] {
  return nodes.map((node) => ({
    ...node,
    focused: focusedStableId === null ? false : node.stableId === focusedStableId,
    children: withFocus(node.children, focusedStableId),
  }));
}
function parseSettleTiming(value: unknown): ObserverSettleTiming {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Android observer settle timing is missing.");
  const timing = value as Record<string, unknown>;
  const finite = (name: string, nullable = false): number | null => {
    const candidate = timing[name];
    if (nullable && candidate === null) return null;
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0) {
      throw new TypeError(`Android observer timing ${name} is invalid.`);
    }
    return candidate;
  };
  if (typeof timing["noOpConfirmed"] !== "boolean") throw new TypeError("Android observer no-op timing is invalid.");
  return {
    eventLatencyMs: finite("eventLatencyMs", true),
    snapshotGenerationMs: finite("snapshotGenerationMs") as number,
    settlingMs: finite("settlingMs") as number,
    eventsObserved: finite("eventsObserved") as number,
    noOpConfirmed: timing["noOpConfirmed"],
  };
}
function parseLogcat(output: string, maximumEntries: number, pid: number, since: number): readonly AndroidLogEntry[] {
  const result: AndroidLogEntry[] = [];
  const pattern = /^\s*(\d+\.\d+)\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+([^:]{1,128}):\s?(.*)$/u;
  for (const line of output.split(/\r?\n/u)) {
    const match = pattern.exec(line); if (match === null) continue;
    if (optionalInteger(match[2]) !== pid || Number(match[1]) < since) continue;
    const level = match[4] === "E" || match[4] === "F" ? "error"
      : match[4] === "W" ? "warning" : match[4] === "D" || match[4] === "V" ? "debug" : "info";
    result.push({
      timestamp: match[1] ?? "", level, message: cleanText(match[6] ?? ""),
      pid: optionalInteger(match[2]), threadId: optionalInteger(match[3]), tag: optionalText(match[5]),
    });
    if (result.length >= maximumEntries) break;
  }
  return result;
}
function delay(durationMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(Object.assign(new Error("Android operation was cancelled."), { name: "AbortError" }));
  return new Promise((resolveDelay, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveDelay();
    }, durationMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(Object.assign(new Error("Android operation was cancelled."), { name: "AbortError" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function combinedSignal(
  shared: AbortSignal | undefined,
  operation: AbortSignal | undefined,
): AbortSignal | undefined {
  if (shared === undefined) return operation;
  if (operation === undefined || operation === shared) return shared;
  return AbortSignal.any([shared, operation]);
}

export class AndroidTvDriver implements TVDoctorDriver {
  readonly #options: NormalisedOptions;
  #resolvedSerial: string | null;
  #closed = false;
  #currentApp: AndroidAppReference | null = null;
  #component: string | null = null;
  #deviceMetadata: AndroidDeviceMetadata | null = null;
  #appMetadata: AndroidAppMetadata | null = null;
  #observer: AndroidObserverConnection | null = null;
  #forwardPort: number | null = null;
  #cachedTree: readonly AndroidUiNodeSnapshot[] | null = null;
  #adbTail: Promise<void> = Promise.resolve();
  #operationTail: Promise<void> = Promise.resolve();
  #logStart: string | null = null;
  #stateMessages = 0;
  #fullTreeMessages = 0;
  #canonicalPayloadBytes = 0;

  constructor(options: AndroidTvDriverOptions = {}) {
    this.#options = normaliseOptions(options);
    this.#resolvedSerial = this.#options.serial ?? null;
  }
  async capabilities(options?: DriverOperationOptions): Promise<ReadonlySet<Capability>> {
    this.#ensureOpen();
    combinedSignal(this.#options.signal, options?.signal)?.throwIfAborted();
    return CAPABILITIES;
  }
  async listDevices(options?: DriverOperationOptions): Promise<readonly AndroidDeviceListEntry[]> {
    const signal = combinedSignal(this.#options.signal, options?.signal);
    return await this.#enqueueOperation(() => this.#listDevices(signal), signal);
  }
  async #listDevices(signal?: AbortSignal): Promise<readonly AndroidDeviceListEntry[]> {
    this.#ensureOpen();
    return parseDevices(utf8((await this.#options.executor.execute(
      ["devices", "-l"], {
        timeoutMs: this.#options.commandTimeoutMs,
        ...(signal === undefined ? {} : { signal }),
      },
    )).stdout));
  }
  async waitForDeviceReady(
    timeoutMs = 180_000,
    options?: DriverOperationOptions,
  ): Promise<AndroidDeviceMetadata> {
    const signal = combinedSignal(this.#options.signal, options?.signal);
    return await this.#enqueueOperation(() => this.#waitForDeviceReady(timeoutMs, signal), signal);
  }
  async #waitForDeviceReady(timeoutMs: number, signal?: AbortSignal): Promise<AndroidDeviceMetadata> {
    this.#ensureOpen();
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
      throw new TypeError("timeoutMs must be a positive safe integer duration.");
    }
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      try {
        const commandOptions = { timeoutMs: Math.min(5_000, Math.max(1, Math.ceil(deadline - performance.now()))) };
        const state = (await this.#deviceText(["get-state"], commandOptions)).trim();
        if (state !== "device") throw new Error("Device is not online.");
        const boot = (await this.#deviceText(["shell", "getprop", "sys.boot_completed"], commandOptions)).trim();
        if (boot !== "1") throw new Error("Device has not completed boot.");
        return await this.#getDeviceMetadata(true, signal);
      } catch {
        if (signal?.aborted === true) throw signal.reason;
        await delay(Math.min(250, Math.max(1, deadline - performance.now())), signal);
      }
    }
    throw new Error(`Android device did not become ready within ${String(timeoutMs)} ms.`);
  }
  async install(artifactPath: string, options?: DriverOperationOptions): Promise<void> {
    const signal = combinedSignal(this.#options.signal, options?.signal);
    return await this.#enqueueOperation(() => this.#install(artifactPath, signal), signal);
  }
  async #install(artifactPath: string, signal?: AbortSignal): Promise<void> {
    this.#ensureOpen(); const absolutePath = resolve(artifactPath);
    if (!isAbsolute(absolutePath)) throw new TypeError("Android APK path could not be resolved.");
    const metadata = await stat(absolutePath);
    if (!metadata.isFile()) throw new TypeError("Android APK path is not a regular file.");
    await this.#deviceCommand(["install", "-r", absolutePath], {
      timeoutMs: Math.max(this.#options.commandTimeoutMs, 120_000), maxOutputBytes: this.#options.maxCommandOutputBytes,
      ...(signal === undefined ? {} : { signal }),
    });
  }
  async launch(app: AndroidAppReference, options?: DriverOperationOptions): Promise<void> {
    const signal = combinedSignal(this.#options.signal, options?.signal);
    return await this.#enqueueOperation(() => this.#launch(app, signal), signal);
  }
  async #launch(app: AndroidAppReference, signal?: AbortSignal): Promise<void> {
    this.#ensureOpen(); const packageName = validatePackage(app.id);
    const component = app.launchUri === undefined ? null : componentName(packageName, app.launchUri);
    if (this.#currentApp !== null && this.#currentApp.id !== packageName) await this.#disconnectObserver();
    this.#currentApp = { ...app, id: packageName }; this.#component = component;
    await this.#getDeviceMetadata(false, signal); await this.#ensureObserver(signal);
    await this.#launchPackage(packageName, component, signal);
    this.#appMetadata = null; this.#cachedTree = null;
    await this.#stabilizeTargetLaunch(packageName, true, signal);
    await this.#getAppMetadata(signal);
  }

  async press(key: RemoteKey, options?: DriverOperationOptions): Promise<ActionResult> {
    const signal = combinedSignal(this.#options.signal, options?.signal);
    return await this.#enqueueOperation(() => this.#press(key, signal), signal);
  }
  async #press(key: RemoteKey, signal?: AbortSignal): Promise<ActionResult> {
    this.#ensureOpen(); const observer = await this.#requiredObserver(signal);
    const totalStarted = performance.now(); const inputSentAtMs = Date.now();
    let inputDelivered = false; let beginRoundTripMs = 0;
    try {
      const beginStarted = performance.now();
      const begin = await observer.request({ type: "begin_action", key }, {
        ...(signal === undefined ? {} : { signal }),
      });
      beginRoundTripMs = performance.now() - beginStarted;
      if (begin.actionId === undefined) throw new Error("Android observer did not return an action identity.");
      const inputStarted = performance.now();
      // Keep input synchronous after the durable focused-window launch guard.
      // This is the delivery barrier that prevents a delayed key from crossing
      // a reset boundary and mutating the next activity instance.
      await this.#deviceCommand(["shell", "input", "keyevent", KEY_CODES[key]], {
        timeoutMs: this.#options.commandTimeoutMs, maxOutputBytes: 4_096,
        ...(signal === undefined ? {} : { signal }),
      });
      const inputDispatchMs = performance.now() - inputStarted; inputDelivered = true;
      const settleRoundTripStarted = performance.now();
      const settled = await observer.request({
        type: "settle_action", actionId: begin.actionId, timeoutMs: this.#options.settleTimeoutMs,
        quietWindowMs: this.#options.quietWindowMs, noResponseGraceMs: this.#options.noResponseGraceMs,
      }, {
        timeoutMs: this.#options.settleTimeoutMs + 1_000,
        ...(signal === undefined ? {} : { signal }),
      });
      const settleRoundTripMs = performance.now() - settleRoundTripStarted;
      const timing = parseSettleTiming(settled.timing);
      const conversionStarted = performance.now();
      const snapshot = this.#snapshotFromState(parseObserverState(settled.state));
      const hostConversionMs = performance.now() - conversionStarted;
      const totalMs = performance.now() - totalStarted;
      const eventLatencyMs = timing.eventLatencyMs ?? undefined;
      return {
        key, outcome: "applied",
        timing: {
          inputSentAtMs,
          ...(eventLatencyMs === undefined ? {} : { firstResponseAtMs: inputSentAtMs + eventLatencyMs }),
          focusSettledAtMs: inputSentAtMs + totalMs, screenSettledAtMs: inputSentAtMs + totalMs,
          profile: {
            baselineSource: "cached", captureCount: timing.noOpConfirmed ? 2 : 1,
            inputDispatchMs, pollCount: 0,
            transportMs: Math.max(
              0,
              beginRoundTripMs + inputDispatchMs + settleRoundTripMs - timing.settlingMs,
            ),
            ...(eventLatencyMs === undefined ? {} : { observerEventLatencyMs: eventLatencyMs }),
            snapshotGenerationMs: timing.snapshotGenerationMs, settlingMs: timing.settlingMs,
            hostConversionMs, totalMs,
          },
        },
        ...(timing.noOpConfirmed ? { message: "Observer confirmed a canonical no-op." } : {}),
        postActionSnapshot: snapshot,
      };
    } catch (error) {
      if (signal?.aborted === true) throw signal.reason;
      if (error instanceof Error && error.name === "AbortError") throw error;
      return {
        key, outcome: inputDelivered ? "inconclusive" : "failed",
        timing: { inputSentAtMs, profile: {
          baselineSource: "cached", captureCount: 0, transportMs: beginRoundTripMs,
          totalMs: performance.now() - totalStarted,
        } },
        message: cleanText(error instanceof Error ? error.message : String(error)),
      };
    }
  }

  async snapshot(options?: DriverOperationOptions): Promise<AndroidStateSnapshot> {
    const signal = combinedSignal(this.#options.signal, options?.signal);
    return await this.#enqueueOperation(() => this.#snapshot(signal), signal);
  }
  async #snapshot(signal?: AbortSignal): Promise<AndroidStateSnapshot> {
    this.#ensureOpen(); const observer = await this.#requiredObserver(signal);
    const response = await observer.request({ type: "current_state", forceFull: this.#cachedTree === null }, {
      ...(signal === undefined ? {} : { signal }),
    });
    return this.#snapshotFromState(parseObserverState(response.state));
  }
  async reset(strategy: ResetStrategy, options?: DriverOperationOptions): Promise<void> {
    const signal = combinedSignal(this.#options.signal, options?.signal);
    return await this.#enqueueOperation(() => this.#reset(strategy, signal), signal);
  }
  async #reset(strategy: ResetStrategy, signal?: AbortSignal): Promise<void> {
    this.#ensureOpen(); const current = this.#currentApp;
    if (current === null) throw new Error("No Android app has been launched.");
    if (strategy === "clear-data") await this.#deviceCommand(["shell", "pm", "clear", current.id], { timeoutMs: 30_000, ...(signal === undefined ? {} : { signal }) });
    await this.#deviceCommand(["shell", "am", "force-stop", current.id], signal === undefined ? {} : { signal });
    await this.#launchPackage(current.id, this.#component, signal);
    this.#appMetadata = null; this.#cachedTree = null;
    await this.#stabilizeTargetLaunch(current.id, true, signal);
    await this.#getAppMetadata(signal);
  }
  async forceStop(
    packageName = this.#currentApp?.id,
    options?: DriverOperationOptions,
  ): Promise<void> {
    const signal = combinedSignal(this.#options.signal, options?.signal);
    return await this.#enqueueOperation(() => this.#forceStop(packageName, signal), signal);
  }
  async #forceStop(packageName: string | undefined, signal?: AbortSignal): Promise<void> {
    this.#ensureOpen();
    if (packageName === undefined) return;
    await this.#deviceCommand(
      ["shell", "am", "force-stop", validatePackage(packageName)],
      { timeoutMs: 5_000, maxOutputBytes: 4_096, ...(signal === undefined ? {} : { signal }) },
    );
  }
  async captureScreenshot(
    artifactPath: string,
    options?: DriverOperationOptions,
  ): Promise<ScreenshotArtifact> {
    const signal = combinedSignal(this.#options.signal, options?.signal);
    return await this.#enqueueOperation(() => this.#captureScreenshot(artifactPath, signal), signal);
  }
  async #captureScreenshot(artifactPath: string, signal?: AbortSignal): Promise<ScreenshotArtifact> {
    this.#ensureOpen();
    if (!/\.png$/iu.test(artifactPath)) throw new TypeError("Android screenshots require a .png artifact path.");
    const absolutePath = resolve(artifactPath); const capturedAt = new Date().toISOString();
    const result = await this.#deviceCommand(["exec-out", "screencap", "-p"], {
      timeoutMs: this.#options.commandTimeoutMs, maxOutputBytes: this.#options.maxScreenshotBytes,
      ...(signal === undefined ? {} : { signal }),
    });
    const dimensions = pngDimensions(result.stdout);
    signal?.throwIfAborted();
    await mkdir(dirname(absolutePath), { recursive: true }); await writeFile(absolutePath, result.stdout);
    return { path: absolutePath, mediaType: "image/png", ...dimensions, capturedAt };
  }
  async getLogs(options?: DriverOperationOptions): Promise<readonly AndroidLogEntry[]> {
    const signal = combinedSignal(this.#options.signal, options?.signal);
    return await this.#enqueueOperation(() => this.#getLogs(signal), signal);
  }
  async #getLogs(signal?: AbortSignal): Promise<readonly AndroidLogEntry[]> {
    this.#ensureOpen();
    const pid = this.#appMetadata?.pid;
    const current = this.#currentApp;
    if (current === null || pid === null || pid === undefined || pid <= 0 || this.#logStart === null) return [];
    const currentPid = async () => optionalInteger((await this.#deviceText(
      ["shell", "pidof", "-s", current.id],
      signal === undefined ? {} : { signal },
    ).catch(() => "")).trim());
    if (await currentPid() !== pid) return [];
    const output = await this.#deviceText(["logcat", "-d", "-v", "epoch", `--pid=${String(pid)}`, "-T", this.#logStart], {
      timeoutMs: this.#options.commandTimeoutMs, maxOutputBytes: this.#options.maxCommandOutputBytes,
      ...(signal === undefined ? {} : { signal }),
    }).catch(() => "");
    if (await currentPid() !== pid) return [];
    return parseLogcat(output, this.#options.maxLogEntries, pid, Number(this.#logStart));
  }
  getObserverMetrics(): AndroidObserverMetrics {
    const transport = this.#observer?.metrics?.() ?? null;
    return {
      stateMessages: this.#stateMessages,
      fullTreeMessages: this.#fullTreeMessages,
      lightweightStateMessages: this.#stateMessages - this.#fullTreeMessages,
      canonicalPayloadBytes: this.#canonicalPayloadBytes,
      transport,
    };
  }

  async getDeviceMetadata(
    refresh = false,
    options?: DriverOperationOptions,
  ): Promise<AndroidDeviceMetadata> {
    const signal = combinedSignal(this.#options.signal, options?.signal);
    return await this.#enqueueOperation(() => this.#getDeviceMetadata(refresh, signal), signal);
  }
  async #getDeviceMetadata(refresh: boolean, signal?: AbortSignal): Promise<AndroidDeviceMetadata> {
    this.#ensureOpen(); if (!refresh && this.#deviceMetadata !== null) return this.#deviceMetadata;
    const commandOptions = signal === undefined ? {} : { signal };
    const serial = await this.#serial(signal);
    const manufacturer = await this.#deviceText(["shell", "getprop", "ro.product.manufacturer"], commandOptions);
    const model = await this.#deviceText(["shell", "getprop", "ro.product.model"], commandOptions);
    const sdk = await this.#deviceText(["shell", "getprop", "ro.build.version.sdk"], commandOptions);
    const release = await this.#deviceText(["shell", "getprop", "ro.build.version.release"], commandOptions);
    const fingerprint = await this.#deviceText(["shell", "getprop", "ro.build.fingerprint"], commandOptions);
    const characteristics = await this.#deviceText(["shell", "getprop", "ro.build.characteristics"], commandOptions);
    const abis = await this.#deviceText(["shell", "getprop", "ro.product.cpu.abilist"], commandOptions);
    const display = await this.#deviceText(["shell", "wm", "size"], commandOptions);
    const sizeMatch = /(\d+)x(\d+)/u.exec(display); const semantic = `${characteristics} ${model} ${fingerprint}`.toLowerCase();
    this.#deviceMetadata = {
      serial, manufacturer: optionalText(manufacturer), model: optionalText(model),
      sdkLevel: optionalInteger(cleanText(sdk)), release: optionalText(release), buildFingerprint: optionalText(fingerprint),
      characteristics: cleanText(characteristics).split(",").map((item) => item.trim()).filter(Boolean),
      supportedAbis: cleanText(abis).split(",").map((item) => item.trim()).filter(Boolean),
      displayWidth: optionalInteger(sizeMatch?.[1]), displayHeight: optionalInteger(sizeMatch?.[2]),
      displayDensityDpi: null,
      isTelevision: /(?:^|[^a-z])(?:tv|atv|leanback|android[_ -]?tv)(?:[^a-z]|$)/u.test(semantic),
    };
    return this.#deviceMetadata;
  }
  async getAppMetadata(options?: DriverOperationOptions): Promise<AndroidAppMetadata> {
    const signal = combinedSignal(this.#options.signal, options?.signal);
    return await this.#enqueueOperation(() => this.#getAppMetadata(signal), signal);
  }
  async #getAppMetadata(signal?: AbortSignal): Promise<AndroidAppMetadata> {
    this.#ensureOpen(); if (this.#appMetadata !== null) return this.#appMetadata;
    const current = this.#currentApp; if (current === null) throw new Error("No Android app has been launched.");
    const commandOptions = signal === undefined ? {} : { signal };
    const pidText = await this.#deviceText(["shell", "pidof", "-s", current.id], commandOptions).catch(() => "");
    const packageText = await this.#deviceText(["shell", "dumpsys", "package", current.id], commandOptions);
    this.#appMetadata = {
      packageName: current.id, component: this.#component, pid: optionalInteger(cleanText(pidText)),
      versionName: optionalText(/\bversionName=([^\s]+)/u.exec(packageText)?.[1]),
      versionCode: optionalInteger(/\bversionCode=(\d+)/u.exec(packageText)?.[1]),
    };
    return this.#appMetadata;
  }
  async close(): Promise<void> {
    return await this.#enqueueOperation(async () => {
      if (this.#closed) return;
      this.#closed = true;
      await this.#disconnectObserver();
      this.#currentApp = null; this.#cachedTree = null; this.#logStart = null;
    });
  }
  async #disconnectObserver(): Promise<void> {
    this.#observer?.close(); this.#observer = null;
    const port = this.#forwardPort; this.#forwardPort = null;
    if (port !== null && this.#resolvedSerial !== null) {
      await this.#options.executor.execute(
        ["-s", this.#resolvedSerial, "forward", "--remove", `tcp:${String(port)}`],
        { timeoutMs: 5_000, maxOutputBytes: 4_096 },
      ).catch(() => undefined);
    }
    this.#cachedTree = null;
  }

  #snapshotFromState(state: ObserverState): AndroidStateSnapshot {
    if (this.#currentApp === null || state.packageName !== this.#currentApp.id) {
      this.#cachedTree = null;
      throw new Error("Android observer returned an observation outside the provisioned target package.");
    }
    this.#stateMessages += 1;
    if (state.nodes !== undefined) this.#fullTreeMessages += 1;
    this.#canonicalPayloadBytes += Buffer.byteLength(JSON.stringify(state), "utf8");
    if (state.nodes !== undefined) this.#cachedTree = state.nodes;
    if (this.#cachedTree === null) throw new Error("Android observer omitted its canonical tree before a full state was established.");
    const tree = withFocus(this.#cachedTree, state.focused?.stableId ?? null); this.#cachedTree = tree;
    const location = state.packageName === null
      ? `android://unknown/window-${String(state.windowId ?? "unknown")}`
      : `android://${state.packageName}/${state.windowClassName ?? `window-${String(state.windowId ?? "unknown")}`}`;
    return {
      capturedAt: new Date(state.timestampMs).toISOString(), location: availableObservation(location),
      focusedElement: availableObservation(state.focused === null ? null : {
        ...(state.focused.stableId === null ? {} : { stableId: state.focused.stableId }),
        ...(state.focused.role === null ? {} : { role: state.focused.role }),
        ...(state.focused.name === null ? {} : { name: state.focused.name }),
        ...(state.focused.bounds === null ? {} : { bounds: state.focused.bounds }),
      }),
      uiTree: availableObservation(tree),
      device: this.#deviceMetadata === null
        ? unavailableObservation("Android device metadata has not been collected.") : availableObservation(this.#deviceMetadata),
      app: this.#appMetadata === null
        ? unavailableObservation("Android app metadata has not been collected.") : availableObservation(this.#appMetadata),
      hierarchyMetadata: availableObservation({
        capturedNodeCount: state.nodeCount,
        maxNodeCount: 4_096,
        maxDepth: state.maxDepth,
        truncated: state.nodeCount >= 4_096 || state.maxDepth >= 64,
      }),
    };
  }

  async #ensureObserver(signal?: AbortSignal): Promise<void> {
    if (this.#observer !== null) return;
    const target = this.#currentApp?.id;
    if (target === undefined) throw new Error("No Android app has been launched.");
    const asset = this.#options.observerAsset ?? await resolveAndroidObserverAsset();
    const commandOptions = signal === undefined ? {} : { signal };
    await this.#deviceCommand(["install", "-r", asset.apkPath], { timeoutMs: 120_000, maxOutputBytes: this.#options.maxCommandOutputBytes, ...commandOptions });
    const installedPath = (await this.#deviceText(["shell", "pm", "path", asset.packageName], commandOptions)).trim();
    if (!/^package:\/data\/app\/[A-Za-z0-9_./=+~-]+\.apk$/u.test(installedPath)) {
      throw new Error("Installed Android observer identity could not be verified.");
    }
    const installedApk = await this.#deviceCommand(["exec-out", "cat", installedPath.slice("package:".length)], {
      maxOutputBytes: 25 * 1024 * 1024,
      ...commandOptions,
    });
    if (createHash("sha256").update(installedApk.stdout).digest("hex") !== asset.sha256) {
      throw new Error("Installed Android observer identity does not match the packaged APK.");
    }
    const token = this.#options.tokenFactory();
    if (!/^[0-9a-f]{64}$/u.test(token)) throw new Error("Android observer session token generator returned an invalid token.");
    await this.#deviceCommand([
      "shell", "content", "call", "--uri", `content://${asset.packageName}.provisioning`, "--method", "provision",
      "--extra", `token:s:${token}`, "--extra", `target_package:s:${target}`,
    ], { timeoutMs: 15_000, ...commandOptions });
    const [enabledFlag, enabledServices] = await Promise.all([
      this.#deviceText(["shell", "settings", "get", "secure", "accessibility_enabled"], commandOptions).catch(() => "0"),
      this.#deviceText(["shell", "settings", "get", "secure", "enabled_accessibility_services"], commandOptions).catch(() => ""),
    ]);
    if (cleanText(enabledFlag) !== "1" || !enabledServices.toLowerCase().includes(asset.packageName.toLowerCase())) {
      throw new Error([
        `TVDoctor could not connect to the Android observer on ${await this.#serial(signal)}.`,
        "Observer APK: installed", "ADB: authorized", "Port forwarding: not started", "Observer service: not enabled",
        "Enable TVDoctor Observer accessibility access on the Android device and retry.",
      ].join("\n"));
    }
    const forwardText = await this.#deviceText(["forward", "tcp:0", `tcp:${String(ANDROID_OBSERVER_DEVICE_PORT)}`], {
      timeoutMs: 10_000, maxOutputBytes: 4_096,
      ...commandOptions,
    });
    const port = Number(cleanText(forwardText));
    if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) throw new Error("ADB did not return a valid local observer forwarding port.");
    this.#forwardPort = port; let lastError: unknown;
    const connectionDeadline = performance.now() + 10_000;
    while (performance.now() < connectionDeadline) {
      try {
        this.#observer = await this.#options.createObserverClient({
          port, token, hostVersion: "0.1.0",
          connectTimeoutMs: Math.min(1_000, this.#options.observerConnectTimeoutMs),
          requestTimeoutMs: this.#options.observerRequestTimeoutMs,
          ...(signal === undefined ? {} : { signal }),
        });
        return;
      } catch (error) {
        lastError = error;
        if (signal?.aborted === true) throw signal.reason;
        await delay(Math.min(100, Math.max(1, connectionDeadline - performance.now())), signal);
      }
    }
    throw new Error([
      `TVDoctor could not connect to the Android observer on ${await this.#serial(signal)}.`,
      "Observer APK: installed", "ADB: authorized", "Port forwarding: active",
      "Observer service: enabled but not accepting the local connection",
      cleanText(lastError instanceof Error ? lastError.message : String(lastError)),
    ].join("\n"));
  }
  async #requiredObserver(signal?: AbortSignal): Promise<AndroidObserverConnection> {
    await this.#ensureObserver(signal); if (this.#observer === null) throw new Error("Android observer is unavailable."); return this.#observer;
  }
  async #launchPackage(packageName: string, component: string | null, signal?: AbortSignal): Promise<void> {
    const commandOptions = signal === undefined ? {} : { signal };
    const start = (await this.#deviceText(["shell", "date", "+%s.%3N"], commandOptions).catch(() => "")).trim();
    this.#logStart = /^\d+\.\d{3}$/u.test(start) ? start : null;
    if (component === null) {
      await this.#deviceCommand(["shell", "monkey", "-p", packageName, "-c", "android.intent.category.LEANBACK_LAUNCHER", "1"], { timeoutMs: 30_000, ...commandOptions });
    } else {
      // Permission-controller activities can remain attached to the app's task
      // after force-stop. Without a clean task, Android may deliver this launch
      // intent to that stale system dialog instead of starting the requested
      // TV activity. NEW_TASK | CLEAR_TASK preserves app data while restoring a
      // deterministic launch boundary.
      await this.#deviceCommand([
        "shell", "am", "start", "-W", "-f", "0x10008000", "-n", component,
      ], { timeoutMs: 30_000, ...commandOptions });
    }
  }
  async #waitForTargetState(packageName: string, forceFull: boolean, signal?: AbortSignal): Promise<AndroidStateSnapshot> {
    const observer = await this.#requiredObserver(signal); const deadline = performance.now() + 8_000; let latestPackage: string | null = null;
    while (performance.now() < deadline) {
      const response = await observer.request({ type: "current_state", forceFull }, {
        timeoutMs: this.#options.observerRequestTimeoutMs,
        ...(signal === undefined ? {} : { signal }),
      });
      const state = parseObserverState(response.state); latestPackage = state.packageName;
      if (state.packageName === packageName) return this.#snapshotFromState(state);
      await delay(75, signal);
    }
    throw new Error(`Android observer did not observe ${packageName}; current window package is ${latestPackage ?? "unknown"}.`);
  }
  async #waitForStableTargetState(packageName: string, signal?: AbortSignal): Promise<AndroidStateSnapshot> {
    const deadline = performance.now() + this.#options.resetSettleTimeoutMs;
    let previousFingerprint: string | null = null;
    let stableSince = performance.now();
    while (performance.now() < deadline) {
      const observer = await this.#requiredObserver(signal);
      const response = await observer.request({ type: "resync" }, {
        timeoutMs: Math.max(1, Math.min(
          this.#options.observerRequestTimeoutMs,
          Math.ceil(deadline - performance.now()),
        )),
        ...(signal === undefined ? {} : { signal }),
      });
      const state = parseObserverState(response.state);
      if (state.packageName !== packageName) {
        throw new Error(`Android observer resync crossed into ${state.packageName ?? "an unknown package"}; expected ${packageName}.`);
      }
      const latest = this.#snapshotFromState(state);
      const observedAt = performance.now();
      if (state.stateFingerprint !== previousFingerprint) {
        previousFingerprint = state.stateFingerprint;
        stableSince = observedAt;
      } else if (observedAt - stableSince >= this.#options.resetStableWindowMs) {
        return latest;
      }
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) break;
      await delay(Math.min(this.#options.quietWindowMs, remainingMs), signal);
    }
    throw new Error(`Android target ${packageName} did not remain stable before the deadline.`);
  }
  async #waitForFocusedTargetWindow(packageName: string, signal?: AbortSignal): Promise<void> {
    const deadline = performance.now() + this.#options.resetSettleTimeoutMs;
    let latestPackage: string | null = null;
    let focusedSince: number | null = null;
    while (performance.now() < deadline) {
      const output = await this.#deviceText(["shell", "dumpsys", "window"], {
        timeoutMs: Math.max(1, Math.min(
          this.#options.commandTimeoutMs,
          Math.ceil(deadline - performance.now()),
        )),
        maxOutputBytes: this.#options.maxCommandOutputBytes,
        ...(signal === undefined ? {} : { signal }),
      });
      latestPackage = focusedWindowPackage(output);
      const observedAt = performance.now();
      if (latestPackage !== packageName) {
        focusedSince = null;
      } else if (focusedSince === null) {
        focusedSince = observedAt;
      } else if (observedAt - focusedSince >= this.#options.resetStableWindowMs) {
        return;
      }
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) break;
      await delay(Math.min(this.#options.quietWindowMs, remainingMs), signal);
    }
    throw new Error(
      `Android did not focus a window owned by ${packageName}; current focused window package is ${latestPackage ?? "unknown"}.`,
    );
  }
  async #stabilizeTargetLaunch(packageName: string, forceFull: boolean, signal?: AbortSignal): Promise<void> {
    let latestError: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await this.#waitForTargetState(packageName, forceFull, signal);
        await this.#waitForFocusedTargetWindow(packageName, signal);
        await this.#waitForStableTargetState(packageName, signal);
        await this.#waitForFocusedTargetWindow(packageName, signal);
        return;
      } catch (error) {
        latestError = error;
        if (attempt < 2) {
          this.#cachedTree = null;
          if (signal?.aborted === true) throw signal.reason;
          await this.#launchPackage(packageName, this.#component, signal);
        }
      }
    }
    const detail = cleanText(latestError instanceof Error ? latestError.message : String(latestError));
    throw new Error(`Android could not establish a stable focused launch for ${packageName}. ${detail}`);
  }
  async #serial(signal?: AbortSignal): Promise<string> {
    if (this.#resolvedSerial !== null) return this.#resolvedSerial;
    const devices = await this.#listDevices(signal); const online = devices.filter((device) => device.state === "device");
    if (online.length !== 1 || online[0] === undefined) {
      const states = devices.map((device) => `${device.serial}:${device.state}`).join(", ");
      throw new Error(`Exactly one online Android device is required when serial is omitted; found ${String(online.length)}${states.length === 0 ? "" : ` (${cleanText(states)})`}.`);
    }
    this.#resolvedSerial = validateSerial(online[0].serial); return this.#resolvedSerial;
  }
  async #deviceCommand(arguments_: readonly string[], options: AdbCommandOptions = {}) {
    const signal = combinedSignal(this.#options.signal, options.signal);
    const serial = await this.#serial(signal);
    const run = async () => {
      return await this.#options.executor.execute(["-s", serial, ...arguments_], {
        ...options,
        ...(signal === undefined ? {} : { signal }),
      });
    };
    const result = this.#adbTail.then(run, run);
    this.#adbTail = result.then(() => undefined, () => undefined);
    return await result;
  }
  async #deviceText(arguments_: readonly string[], options: AdbCommandOptions = {}): Promise<string> {
    return utf8((await this.#deviceCommand(arguments_, options)).stdout);
  }
  async #enqueueOperation<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const run = async (): Promise<T> => {
      signal?.throwIfAborted();
      return await operation();
    };
    const result = this.#operationTail.then(run, run);
    this.#operationTail = result.then(() => undefined, () => undefined);
    return await result;
  }
  #ensureOpen(): void { if (this.#closed) throw new Error("Android TV driver is closed."); }
}
