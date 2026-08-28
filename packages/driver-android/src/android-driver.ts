import { randomBytes } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import {
  availableObservation,
  unavailableObservation,
  type ActionResult,
  type Capability,
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
  if (quietWindowMs >= settleTimeoutMs || noResponseGraceMs >= settleTimeoutMs) {
    throw new TypeError("Android observer quiet and no-response windows must be shorter than settleTimeoutMs.");
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
    settleTimeoutMs, quietWindowMs, noResponseGraceMs,
    observerConnectTimeoutMs: positiveInteger(options.observerConnectTimeoutMs, 5_000, "observerConnectTimeoutMs"),
    observerRequestTimeoutMs: positiveInteger(options.observerRequestTimeoutMs, 5_000, "observerRequestTimeoutMs"),
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
function parseLogcat(output: string, maximumEntries: number): readonly AndroidLogEntry[] {
  const result: AndroidLogEntry[] = [];
  const pattern = /^(\d\d-\d\d\s+\d\d:\d\d:\d\d\.\d+)\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+([^:]{1,128}):\s?(.*)$/u;
  for (const line of output.split(/\r?\n/u)) {
    const match = pattern.exec(line); if (match === null) continue;
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
  #stateMessages = 0;
  #fullTreeMessages = 0;
  #canonicalPayloadBytes = 0;

  constructor(options: AndroidTvDriverOptions = {}) {
    this.#options = normaliseOptions(options);
    this.#resolvedSerial = this.#options.serial ?? null;
  }
  async capabilities(): Promise<ReadonlySet<Capability>> { this.#ensureOpen(); return CAPABILITIES; }
  async listDevices(): Promise<readonly AndroidDeviceListEntry[]> {
    this.#ensureOpen();
    return parseDevices(utf8((await this.#options.executor.execute(
      ["devices", "-l"], {
        timeoutMs: this.#options.commandTimeoutMs,
        ...(this.#options.signal === undefined ? {} : { signal: this.#options.signal }),
      },
    )).stdout));
  }
  async waitForDeviceReady(timeoutMs = 180_000): Promise<AndroidDeviceMetadata> {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      try {
        await this.#deviceText(["get-state"], { timeoutMs: Math.min(5_000, Math.max(1, deadline - performance.now())) });
        return await this.getDeviceMetadata(true);
      } catch { await delay(Math.min(250, Math.max(1, deadline - performance.now())), this.#options.signal); }
    }
    throw new Error(`Android device did not become ready within ${String(timeoutMs)} ms.`);
  }
  async install(artifactPath: string): Promise<void> {
    this.#ensureOpen(); const absolutePath = resolve(artifactPath);
    if (!isAbsolute(absolutePath)) throw new TypeError("Android APK path could not be resolved.");
    const metadata = await stat(absolutePath);
    if (!metadata.isFile()) throw new TypeError("Android APK path is not a regular file.");
    await this.#deviceCommand(["install", "-r", absolutePath], {
      timeoutMs: Math.max(this.#options.commandTimeoutMs, 120_000), maxOutputBytes: this.#options.maxCommandOutputBytes,
    });
  }
  async launch(app: AndroidAppReference): Promise<void> {
    this.#ensureOpen(); const packageName = validatePackage(app.id);
    await this.getDeviceMetadata(false); await this.#ensureObserver();
    const component = app.launchUri === undefined ? null : componentName(packageName, app.launchUri);
    await this.#launchPackage(packageName, component);
    this.#currentApp = { ...app, id: packageName }; this.#component = component;
    this.#appMetadata = null; this.#cachedTree = null;
    await this.#waitForTargetState(packageName, true);
    await this.#waitForStableTargetState(packageName);
    await this.getAppMetadata();
  }

  async press(key: RemoteKey): Promise<ActionResult> {
    this.#ensureOpen(); const observer = await this.#requiredObserver();
    const totalStarted = performance.now(); const inputSentAtMs = Date.now();
    let inputDelivered = false; let beginRoundTripMs = 0;
    try {
      const beginStarted = performance.now();
      const begin = await observer.request({ type: "begin_action", key }, {
        ...(this.#options.signal === undefined ? {} : { signal: this.#options.signal }),
      });
      beginRoundTripMs = performance.now() - beginStarted;
      if (begin.actionId === undefined) throw new Error("Android observer did not return an action identity.");
      const inputStarted = performance.now();
      await this.#deviceCommand(["shell", "input", "keyevent", KEY_CODES[key]], {
        timeoutMs: this.#options.commandTimeoutMs, maxOutputBytes: 4_096,
      });
      const inputDispatchMs = performance.now() - inputStarted; inputDelivered = true;
      const settleRoundTripStarted = performance.now();
      const settled = await observer.request({
        type: "settle_action", actionId: begin.actionId, timeoutMs: this.#options.settleTimeoutMs,
        quietWindowMs: this.#options.quietWindowMs, noResponseGraceMs: this.#options.noResponseGraceMs,
      }, {
        timeoutMs: this.#options.settleTimeoutMs + 1_000,
        ...(this.#options.signal === undefined ? {} : { signal: this.#options.signal }),
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

  async snapshot(): Promise<AndroidStateSnapshot> {
    this.#ensureOpen(); const observer = await this.#requiredObserver();
    const response = await observer.request({ type: "current_state", forceFull: this.#cachedTree === null }, {
      ...(this.#options.signal === undefined ? {} : { signal: this.#options.signal }),
    });
    return this.#snapshotFromState(parseObserverState(response.state));
  }
  async reset(strategy: ResetStrategy): Promise<void> {
    this.#ensureOpen(); const current = this.#currentApp;
    if (current === null) throw new Error("No Android app has been launched.");
    if (strategy === "clear-data") await this.#deviceCommand(["shell", "pm", "clear", current.id], { timeoutMs: 30_000 });
    await this.#deviceCommand(["shell", "am", "force-stop", current.id]);
    await this.#launchPackage(current.id, this.#component);
    this.#appMetadata = null; this.#cachedTree = null;
    await this.#waitForTargetState(current.id, true);
    await this.#waitForStableTargetState(current.id);
    await this.getAppMetadata();
  }
  async forceStop(packageName = this.#currentApp?.id): Promise<void> {
    if (packageName === undefined) return;
    const serial = await this.#serial();
    await this.#adbTail;
    await this.#options.executor.execute(
      ["-s", serial, "shell", "am", "force-stop", validatePackage(packageName)],
      { timeoutMs: 5_000, maxOutputBytes: 4_096 },
    );
  }
  async captureScreenshot(artifactPath: string): Promise<ScreenshotArtifact> {
    this.#ensureOpen();
    if (!/\.png$/iu.test(artifactPath)) throw new TypeError("Android screenshots require a .png artifact path.");
    const absolutePath = resolve(artifactPath); const capturedAt = new Date().toISOString();
    const result = await this.#deviceCommand(["exec-out", "screencap", "-p"], {
      timeoutMs: this.#options.commandTimeoutMs, maxOutputBytes: this.#options.maxScreenshotBytes,
    });
    const dimensions = pngDimensions(result.stdout);
    await mkdir(dirname(absolutePath), { recursive: true }); await writeFile(absolutePath, result.stdout);
    return { path: absolutePath, mediaType: "image/png", ...dimensions, capturedAt };
  }
  async getLogs(): Promise<readonly AndroidLogEntry[]> {
    this.#ensureOpen();
    const output = await this.#deviceText(["shell", "logcat", "-d", "-v", "threadtime", "-t", String(this.#options.maxLogEntries)], {
      timeoutMs: this.#options.commandTimeoutMs, maxOutputBytes: this.#options.maxCommandOutputBytes,
    });
    const entries = parseLogcat(output, this.#options.maxLogEntries); const pid = this.#appMetadata?.pid;
    return pid === null || pid === undefined ? entries : entries.filter((entry) => entry.pid === pid);
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

  async getDeviceMetadata(refresh = false): Promise<AndroidDeviceMetadata> {
    this.#ensureOpen(); if (!refresh && this.#deviceMetadata !== null) return this.#deviceMetadata;
    const serial = await this.#serial();
    const manufacturer = await this.#deviceText(["shell", "getprop", "ro.product.manufacturer"]);
    const model = await this.#deviceText(["shell", "getprop", "ro.product.model"]);
    const sdk = await this.#deviceText(["shell", "getprop", "ro.build.version.sdk"]);
    const release = await this.#deviceText(["shell", "getprop", "ro.build.version.release"]);
    const fingerprint = await this.#deviceText(["shell", "getprop", "ro.build.fingerprint"]);
    const characteristics = await this.#deviceText(["shell", "getprop", "ro.build.characteristics"]);
    const abis = await this.#deviceText(["shell", "getprop", "ro.product.cpu.abilist"]);
    const display = await this.#deviceText(["shell", "wm", "size"]);
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
  async getAppMetadata(): Promise<AndroidAppMetadata> {
    this.#ensureOpen(); if (this.#appMetadata !== null) return this.#appMetadata;
    const current = this.#currentApp; if (current === null) throw new Error("No Android app has been launched.");
    const pidText = await this.#deviceText(["shell", "pidof", "-s", current.id]).catch(() => "");
    const packageText = await this.#deviceText(["shell", "dumpsys", "package", current.id]);
    this.#appMetadata = {
      packageName: current.id, component: this.#component, pid: optionalInteger(cleanText(pidText)),
      versionName: optionalText(/\bversionName=([^\s]+)/u.exec(packageText)?.[1]),
      versionCode: optionalInteger(/\bversionCode=(\d+)/u.exec(packageText)?.[1]),
    };
    return this.#appMetadata;
  }
  async close(): Promise<void> {
    if (this.#closed) return; this.#closed = true; this.#observer?.close(); this.#observer = null;
    const port = this.#forwardPort; this.#forwardPort = null;
    if (port !== null && this.#resolvedSerial !== null) {
      await this.#options.executor.execute(
        ["-s", this.#resolvedSerial, "forward", "--remove", `tcp:${String(port)}`],
        { timeoutMs: 5_000, maxOutputBytes: 4_096 },
      ).catch(() => undefined);
    }
    this.#currentApp = null; this.#cachedTree = null;
  }

  #snapshotFromState(state: ObserverState): AndroidStateSnapshot {
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

  async #ensureObserver(): Promise<void> {
    if (this.#observer !== null) return;
    const asset = this.#options.observerAsset ?? await resolveAndroidObserverAsset();
    const installed = await this.#deviceText(["shell", "dumpsys", "package", asset.packageName]).catch(() => "");
    if (!new RegExp(`\\bversionName=${asset.versionName.replaceAll(".", "\\.")}\\b`, "u").test(installed)) {
      await this.#deviceCommand(["install", "-r", asset.apkPath], { timeoutMs: 120_000, maxOutputBytes: this.#options.maxCommandOutputBytes });
    }
    const token = this.#options.tokenFactory();
    if (!/^[0-9a-f]{64}$/u.test(token)) throw new Error("Android observer session token generator returned an invalid token.");
    await this.#deviceCommand([
      "shell", "am", "start", "-W", "-n", `${asset.packageName}/.SetupActivity`, "--es", "tvdoctor_token", token,
    ], { timeoutMs: 15_000 });
    const [enabledFlag, enabledServices] = await Promise.all([
      this.#deviceText(["shell", "settings", "get", "secure", "accessibility_enabled"]).catch(() => "0"),
      this.#deviceText(["shell", "settings", "get", "secure", "enabled_accessibility_services"]).catch(() => ""),
    ]);
    if (cleanText(enabledFlag) !== "1" || !enabledServices.toLowerCase().includes(asset.packageName.toLowerCase())) {
      throw new Error([
        `TVDoctor could not connect to the Android observer on ${await this.#serial()}.`,
        "Observer APK: installed", "ADB: authorized", "Port forwarding: not started", "Observer service: not enabled",
        "Enable TVDoctor Observer accessibility access on the Android device and retry.",
      ].join("\n"));
    }
    const forwardText = await this.#deviceText(["forward", "tcp:0", `tcp:${String(ANDROID_OBSERVER_DEVICE_PORT)}`], {
      timeoutMs: 10_000, maxOutputBytes: 4_096,
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
          requestTimeoutMs: Math.min(1_000, this.#options.observerRequestTimeoutMs),
          ...(this.#options.signal === undefined ? {} : { signal: this.#options.signal }),
        });
        return;
      } catch (error) {
        lastError = error;
        await delay(Math.min(100, Math.max(1, connectionDeadline - performance.now())), this.#options.signal);
      }
    }
    throw new Error([
      `TVDoctor could not connect to the Android observer on ${await this.#serial()}.`,
      "Observer APK: installed", "ADB: authorized", "Port forwarding: active",
      "Observer service: enabled but not accepting the local connection",
      cleanText(lastError instanceof Error ? lastError.message : String(lastError)),
    ].join("\n"));
  }
  async #requiredObserver(): Promise<AndroidObserverConnection> {
    await this.#ensureObserver(); if (this.#observer === null) throw new Error("Android observer is unavailable."); return this.#observer;
  }
  async #launchPackage(packageName: string, component: string | null): Promise<void> {
    if (component === null) {
      await this.#deviceCommand(["shell", "monkey", "-p", packageName, "-c", "android.intent.category.LEANBACK_LAUNCHER", "1"], { timeoutMs: 30_000 });
    } else await this.#deviceCommand(["shell", "am", "start", "-W", "-n", component], { timeoutMs: 30_000 });
  }
  async #waitForTargetState(packageName: string, forceFull: boolean): Promise<AndroidStateSnapshot> {
    const observer = await this.#requiredObserver(); const deadline = performance.now() + 8_000; let latestPackage: string | null = null;
    while (performance.now() < deadline) {
      const response = await observer.request({ type: "current_state", forceFull }, {
        timeoutMs: 5_000,
        ...(this.#options.signal === undefined ? {} : { signal: this.#options.signal }),
      });
      const state = parseObserverState(response.state); latestPackage = state.packageName;
      if (state.packageName === packageName) return this.#snapshotFromState(state);
      await delay(75, this.#options.signal);
    }
    throw new Error(`Android observer did not observe ${packageName}; current window package is ${latestPackage ?? "unknown"}.`);
  }
  async #resyncTargetState(packageName: string): Promise<AndroidStateSnapshot> {
    const observer = await this.#requiredObserver();
    const response = await observer.request({ type: "resync" }, {
      timeoutMs: 5_000,
      ...(this.#options.signal === undefined ? {} : { signal: this.#options.signal }),
    });
    const state = parseObserverState(response.state);
    if (state.packageName !== packageName) {
      throw new Error(`Android observer resync crossed into ${state.packageName ?? "an unknown package"}; expected ${packageName}.`);
    }
    return this.#snapshotFromState(state);
  }
  async #waitForStableTargetState(packageName: string): Promise<AndroidStateSnapshot> {
    const deadline = performance.now() + this.#options.settleTimeoutMs;
    let previousFingerprint: string | null = null;
    let stableSince = performance.now();
    let latest: AndroidStateSnapshot | null = null;
    while (performance.now() < deadline) {
      const observer = await this.#requiredObserver();
      const response = await observer.request({ type: "resync" }, {
        timeoutMs: Math.max(1, Math.min(5_000, Math.ceil(deadline - performance.now()))),
        ...(this.#options.signal === undefined ? {} : { signal: this.#options.signal }),
      });
      const state = parseObserverState(response.state);
      if (state.packageName !== packageName) {
        throw new Error(`Android observer resync crossed into ${state.packageName ?? "an unknown package"}; expected ${packageName}.`);
      }
      latest = this.#snapshotFromState(state);
      const observedAt = performance.now();
      if (state.stateFingerprint !== previousFingerprint) {
        previousFingerprint = state.stateFingerprint;
        stableSince = observedAt;
      } else if (observedAt - stableSince >= this.#options.noResponseGraceMs) {
        return latest;
      }
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) break;
      await delay(Math.min(this.#options.quietWindowMs, remainingMs), this.#options.signal);
    }
    if (latest !== null) return latest;
    return await this.#resyncTargetState(packageName);
  }
  async #serial(): Promise<string> {
    if (this.#resolvedSerial !== null) return this.#resolvedSerial;
    const devices = await this.listDevices(); const online = devices.filter((device) => device.state === "device");
    if (online.length !== 1 || online[0] === undefined) {
      const states = devices.map((device) => `${device.serial}:${device.state}`).join(", ");
      throw new Error(`Exactly one online Android device is required when serial is omitted; found ${String(online.length)}${states.length === 0 ? "" : ` (${cleanText(states)})`}.`);
    }
    this.#resolvedSerial = validateSerial(online[0].serial); return this.#resolvedSerial;
  }
  async #deviceCommand(arguments_: readonly string[], options: AdbCommandOptions = {}) {
    const serial = await this.#serial();
    const run = async () => {
      const signal = options.signal ?? this.#options.signal;
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
  #ensureOpen(): void { if (this.#closed) throw new Error("Android TV driver is closed."); }
}
