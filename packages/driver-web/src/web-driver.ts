import { mkdir } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import {
  availableObservation,
  unavailableObservation,
  type ActionResult,
  type ActionTiming,
  type AppReference,
  type Capability,
  type DriverOperationOptions,
  type LogEntry,
  type RemoteKey,
  type ResetStrategy,
  type ScreenshotArtifact,
  type TVDoctorDriver,
} from "@tvdoctor/protocol";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type ConsoleMessage,
  type Page,
  type Request,
  type Response,
} from "playwright";
import { capturePageObservation } from "./page-observation.js";
import { sanitiseObservedText, sanitiseUrl } from "./security.js";
import {
  installSettleTracker,
  readSettleBaseline,
  waitForInitialPageSettle,
  waitForPageSettle,
  type SettleConfiguration,
} from "./settling.js";
import type {
  PlaywrightWebDriverOptions,
  WebDriverPerformanceProfile,
  WebLogEntry,
  WebNetworkEntry,
  WebNetworkSnapshot,
  WebStateSnapshot,
} from "./types.js";

const DEFAULT_VIEWPORT = { width: 1280, height: 720 } as const;
const DEFAULT_MAX_LOG_ENTRIES = 500;
const DEFAULT_MAX_PENDING_NETWORK_REQUESTS = 1_000;
const DEFAULT_MAX_UI_DEPTH = 128;
const DEFAULT_MAX_UI_NODES = 750;
const DEFAULT_MAX_UI_SCAN_NODES = 20_000;
const DEFAULT_MAX_UI_TEXT_CHARS = 512_000;
const DEFAULT_RECENT_NETWORK_ENTRIES = 200;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 15_000;
const DEFAULT_SETTLE_CONFIGURATION: SettleConfiguration = {
  noResponseGraceMs: 250,
  quietWindowMs: 120,
  timeoutMs: 4_000,
  ambientChurnEscape: false,
};

export const WEB_REMOTE_KEYBOARD_MAP: Readonly<Record<RemoteKey, string>> = {
  UP: "ArrowUp",
  DOWN: "ArrowDown",
  LEFT: "ArrowLeft",
  RIGHT: "ArrowRight",
  SELECT: "Enter",
  BACK: "Escape",
  HOME: "Home",
  PLAY_PAUSE: "MediaPlayPause",
  PLAY: "MediaPlay",
  PAUSE: "MediaPause",
  STOP: "MediaStop",
  NEXT: "MediaNext",
  PREVIOUS: "MediaPrevious",
  REWIND: "MediaRewind",
  FAST_FORWARD: "MediaFastForward",
};

export const WEB_DRIVER_CAPABILITIES: ReadonlySet<Capability> = new Set([
  "remote-input",
  "ui-tree",
  "screenshot",
  "logs",
  "launch",
  "performance",
  "network",
  "player-state",
]);

interface MutableNetworkEntry {
  method: string;
  url: string;
  resourceType: string;
  outcome: "failed" | "pending" | "succeeded";
  status: number | null;
  startedAt: string;
  startedAtMs: number;
  finishedAt: string | null;
  durationMs: number | null;
  failure: string | null;
}

interface NormalisedOptions {
  readonly artifactsDirectory: string;
  readonly browserLaunchOptions: NonNullable<PlaywrightWebDriverOptions["browserLaunchOptions"]>;
  readonly contextOptions: NonNullable<PlaywrightWebDriverOptions["contextOptions"]>;
  readonly headless: boolean;
  readonly maxLogEntries: number;
  readonly maxPendingNetworkRequests: number;
  readonly maxUiDepth: number;
  readonly maxUiNodes: number;
  readonly maxUiScanNodes: number;
  readonly maxUiTextChars: number;
  readonly navigationTimeoutMs: number;
  readonly recentNetworkEntries: number;
  readonly settle: SettleConfiguration;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeDuration(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function normaliseOptions(options: PlaywrightWebDriverOptions): NormalisedOptions {
  return {
    artifactsDirectory: resolve(options.artifactsDirectory ?? "artifacts/web-driver"),
    browserLaunchOptions: options.browserLaunchOptions ?? {},
    contextOptions: options.contextOptions ?? {},
    headless: options.headless ?? options.browserLaunchOptions?.headless ?? true,
    maxLogEntries: positiveInteger(options.maxLogEntries, DEFAULT_MAX_LOG_ENTRIES),
    maxPendingNetworkRequests: positiveInteger(
      options.maxPendingNetworkRequests,
      DEFAULT_MAX_PENDING_NETWORK_REQUESTS,
    ),
    maxUiDepth: positiveInteger(options.maxUiDepth, DEFAULT_MAX_UI_DEPTH),
    maxUiNodes: positiveInteger(options.maxUiNodes, DEFAULT_MAX_UI_NODES),
    maxUiScanNodes: positiveInteger(options.maxUiScanNodes, DEFAULT_MAX_UI_SCAN_NODES),
    maxUiTextChars: positiveInteger(options.maxUiTextChars, DEFAULT_MAX_UI_TEXT_CHARS),
    navigationTimeoutMs: positiveDuration(options.navigationTimeoutMs, DEFAULT_NAVIGATION_TIMEOUT_MS),
    recentNetworkEntries: positiveInteger(options.recentNetworkEntries, DEFAULT_RECENT_NETWORK_ENTRIES),
    settle: {
      noResponseGraceMs: nonNegativeDuration(
        options.settle?.noResponseGraceMs,
        DEFAULT_SETTLE_CONFIGURATION.noResponseGraceMs,
      ),
      quietWindowMs: nonNegativeDuration(
        options.settle?.quietWindowMs,
        DEFAULT_SETTLE_CONFIGURATION.quietWindowMs,
      ),
      timeoutMs: positiveDuration(options.settle?.timeoutMs, DEFAULT_SETTLE_CONFIGURATION.timeoutMs),
      ambientChurnEscape: options.settle?.ambientChurnEscape
        ?? DEFAULT_SETTLE_CONFIGURATION.ambientChurnEscape,
    },
  };
}

function consoleLevel(message: ConsoleMessage): LogEntry["level"] {
  switch (message.type()) {
    case "error":
      return "error";
    case "warning":
      return "warning";
    case "debug":
      return "debug";
    default:
      return "info";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toPublicNetworkEntry(entry: MutableNetworkEntry): WebNetworkEntry {
  return {
    method: entry.method,
    url: entry.url,
    resourceType: entry.resourceType,
    outcome: entry.outcome,
    status: entry.status,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
    durationMs: entry.durationMs,
    failure: entry.failure,
  };
}

export class PlaywrightWebDriver implements TVDoctorDriver {
  readonly #options: NormalisedOptions;
  #browser: Browser | null = null;
  #context: BrowserContext | null = null;
  #currentApp: AppReference | null = null;
  #logs: WebLogEntry[] = [];
  #networkEntries: MutableNetworkEntry[] = [];
  #pendingRequestEntries = new WeakMap<Request, MutableNetworkEntry>();
  #pendingRequestsRetained = new Set<Request>();
  #pendingRequestsDropped = 0;
  #page: Page | null = null;
  readonly #performanceProfile = {
    resetCount: 0,
    resetMs: 0,
    pressCount: 0,
    pressMs: 0,
    snapshotCount: 0,
    snapshotMs: 0,
    observation: {
      browserEvaluationMs: 0,
      domEnumerationMs: 0,
      semanticAnalysisMs: 0,
      auxiliaryObservationMs: 0,
      transportAndSanitisationMs: 0,
      browserRoundTripAndQueueingMs: 0,
    },
  };
  #requestsFailed = 0;
  #requestsInFlight = 0;
  #requestsStarted = 0;
  #requestsSucceeded = 0;
  #retirement: Promise<void> | null = null;
  #screenshotSequence = 0;
  #unusable = false;

  constructor(options: PlaywrightWebDriverOptions = {}) {
    this.#options = normaliseOptions(options);
  }

  async capabilities(options?: DriverOperationOptions): Promise<ReadonlySet<Capability>> {
    return await this.#runOperation(options, async () => new Set(WEB_DRIVER_CAPABILITIES));
  }

  getPerformanceProfile(): WebDriverPerformanceProfile {
    return {
      ...this.#performanceProfile,
      observation: { ...this.#performanceProfile.observation },
    };
  }

  async launch(app: AppReference, options?: DriverOperationOptions): Promise<void> {
    return await this.#runOperation(options, async () => {
    if (app.launchUri === undefined || app.launchUri.trim().length === 0) {
      throw new Error("The Playwright web driver requires app.launchUri.");
    }

    await this.#closeContext();
    this.#clearTelemetry();
    this.#currentApp = app;

    try {
      if (this.#browser === null || !this.#browser.isConnected()) {
        this.#browser = await chromium.launch({
          ...this.#options.browserLaunchOptions,
          headless: this.#options.headless,
        });
      }

      this.#context = await this.#browser.newContext({
        viewport: DEFAULT_VIEWPORT,
        ...this.#options.contextOptions,
      });
      this.#page = await this.#context.newPage();
      this.#attachPageTelemetry(this.#page);
      await installSettleTracker(this.#page);
      this.#page.setDefaultNavigationTimeout(this.#options.navigationTimeoutMs);
      await this.#page.goto(app.launchUri, { waitUntil: "domcontentloaded" });
      await waitForInitialPageSettle(this.#page, this.#options.settle);
    } catch (error) {
      try {
        await this.close();
      } catch {
        // Preserve the launch failure; all lifecycle references were cleared by close().
      }
      throw error;
    }
    });
  }

  async close(): Promise<void> {
    let closeFailure: unknown;
    try {
      await this.#closeContext();
    } catch (error) {
      closeFailure = error;
    }

    const browser = this.#browser;
    this.#browser = null;
    if (browser !== null) {
      try {
        await browser.close();
      } catch (error) {
        closeFailure ??= error;
      }
    }
    this.#currentApp = null;
    if (closeFailure !== undefined) {
      throw closeFailure;
    }
  }

  async press(key: RemoteKey, options?: DriverOperationOptions): Promise<ActionResult> {
    return await this.#runOperation(options, async () => {
    this.#performanceProfile.pressCount += 1;
    const profileStartedAt = performance.now();
    try {
    const inputSentAtMs = Date.now();
    const page = this.#activePage();
    if (page === null) {
      return {
        key,
        outcome: "failed",
        timing: { inputSentAtMs },
        message: "No web app is launched.",
      };
    }

    try {
      const baseline = await readSettleBaseline(page);
      await page.keyboard.press(WEB_REMOTE_KEYBOARD_MAP[key]);
      const settled = await waitForPageSettle(page, baseline, this.#options.settle);
      const timing: ActionTiming = {
        inputSentAtMs,
        ...(settled.firstResponseAtMs === null ? {} : { firstResponseAtMs: settled.firstResponseAtMs }),
        ...(settled.focusSettledAtMs === null ? {} : { focusSettledAtMs: settled.focusSettledAtMs }),
        screenSettledAtMs: settled.screenSettledAtMs,
      };
      return {
        key,
        outcome: "applied",
        timing,
        ...(settled.timedOut
          ? { message: "Input was delivered, but the page did not reach the configured stability threshold." }
          : {}),
      };
    } catch (error) {
      return {
        key,
        outcome: "failed",
        timing: { inputSentAtMs },
        message: sanitiseObservedText(errorMessage(error)),
      };
    }
    } finally {
      this.#performanceProfile.pressMs += Math.max(0, performance.now() - profileStartedAt);
    }
    });
  }

  async snapshot(options?: DriverOperationOptions): Promise<WebStateSnapshot> {
    return await this.#runOperation(options, async () => {
    this.#performanceProfile.snapshotCount += 1;
    const profileStartedAt = performance.now();
    try {
    const capturedAt = new Date().toISOString();
    const page = this.#activePage();
    if (page === null) {
      const reason = "No web app is launched.";
      return {
        capturedAt,
        location: unavailableObservation(reason),
        focusedElement: unavailableObservation(reason),
        uiTree: unavailableObservation(reason),
        uiTreeMetadata: unavailableObservation(reason),
        viewport: unavailableObservation(reason),
        mediaElements: unavailableObservation(reason),
        network: unavailableObservation(reason),
        performance: unavailableObservation(reason),
      };
    }

    const location = availableObservation(sanitiseUrl(page.url()));
    try {
      const observation = await capturePageObservation(page, this.#options.maxUiNodes, {
        maxDepth: this.#options.maxUiDepth,
        maxScannedNodeCount: this.#options.maxUiScanNodes,
        maxTextChars: this.#options.maxUiTextChars,
      });
      this.#performanceProfile.observation.browserEvaluationMs += observation.timings.browserEvaluationMs;
      this.#performanceProfile.observation.domEnumerationMs += observation.timings.domEnumerationMs;
      this.#performanceProfile.observation.semanticAnalysisMs += observation.timings.semanticAnalysisMs;
      this.#performanceProfile.observation.auxiliaryObservationMs += observation.timings.auxiliaryObservationMs;
      this.#performanceProfile.observation.transportAndSanitisationMs += observation.timings.transportAndSanitisationMs;
      this.#performanceProfile.observation.browserRoundTripAndQueueingMs += observation.timings.browserRoundTripAndQueueingMs;
      return {
        capturedAt,
        location,
        focusedElement: availableObservation(observation.focus),
        uiTree: availableObservation(observation.uiTree),
        uiTreeMetadata: availableObservation(observation.uiTreeMetadata),
        viewport: availableObservation(observation.viewport),
        mediaElements: availableObservation(observation.mediaElements),
        network: availableObservation(this.getNetworkSnapshot()),
        performance: availableObservation(observation.performance),
      };
    } catch (error) {
      const reason = `Page observation failed: ${sanitiseObservedText(errorMessage(error))}`;
      return {
        capturedAt,
        location,
        focusedElement: unavailableObservation(reason),
        uiTree: unavailableObservation(reason),
        uiTreeMetadata: unavailableObservation(reason),
        viewport: unavailableObservation(reason),
        mediaElements: unavailableObservation(reason),
        network: availableObservation(this.getNetworkSnapshot()),
        performance: unavailableObservation(reason),
      };
    }
    } finally {
      this.#performanceProfile.snapshotMs += Math.max(0, performance.now() - profileStartedAt);
    }
    });
  }

  async captureScreenshot(
    artifactPath?: string,
    options?: DriverOperationOptions,
  ): Promise<ScreenshotArtifact> {
    return await this.#runOperation(options, async () => {
    const page = this.#requirePage();
    this.#screenshotSequence += 1;
    const fallbackName = `screenshot-${Date.now()}-${this.#screenshotSequence}.png`;
    const absolutePath = resolve(artifactPath ?? resolve(this.#options.artifactsDirectory, fallbackName));
    const extension = extname(absolutePath).toLowerCase();
    if (extension !== ".png" && extension !== ".jpg" && extension !== ".jpeg") {
      throw new Error("Screenshot artifact paths must end in .png, .jpg, or .jpeg.");
    }
    const mediaType = extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : "image/png";
    await mkdir(dirname(absolutePath), { recursive: true });
    await page.screenshot({
      path: absolutePath,
      type: mediaType === "image/jpeg" ? "jpeg" : "png",
      animations: "disabled",
      fullPage: false,
      scale: "css",
    });
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    return {
      path: absolutePath,
      mediaType,
      width: viewport.width,
      height: viewport.height,
      capturedAt: new Date().toISOString(),
    };
    });
  }

  async reset(strategy: ResetStrategy, options?: DriverOperationOptions): Promise<void> {
    return await this.#runOperation(options, async () => {
    this.#performanceProfile.resetCount += 1;
    const profileStartedAt = performance.now();
    try {
    const page = this.#requirePage();
    const launchUri = this.#currentApp?.launchUri;
    if (launchUri === undefined) {
      throw new Error("The launched web app has no launch URI.");
    }

    this.#clearTelemetry();
    if (strategy === "clear-data") {
      await this.#context?.clearCookies();
      await page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
      });
    }

    if (strategy === "reload") {
      await page.reload({ waitUntil: "domcontentloaded" });
    } else {
      await page.goto(launchUri, { waitUntil: "domcontentloaded" });
    }
    await waitForInitialPageSettle(page, this.#options.settle);
    } finally {
      this.#performanceProfile.resetMs += Math.max(0, performance.now() - profileStartedAt);
    }
    });
  }

  async getLogs(options?: DriverOperationOptions): Promise<readonly WebLogEntry[]> {
    return await this.#runOperation(options, async () => this.#logs.map((entry) => ({ ...entry })));
  }

  getNetworkSnapshot(): WebNetworkSnapshot {
    return {
      requestsStarted: this.#requestsStarted,
      requestsSucceeded: this.#requestsSucceeded,
      requestsFailed: this.#requestsFailed,
      requestsInFlight: this.#requestsInFlight,
      pendingRequestsTracked: this.#pendingRequestsRetained.size,
      pendingRequestsDropped: this.#pendingRequestsDropped,
      recentEntries: this.#networkEntries.map((entry) => toPublicNetworkEntry(entry)),
    };
  }

  /**
   * An explicit escape hatch for advanced diagnostics and driver integration
   * tests. Core exploration should use the platform-neutral methods instead.
   */
  getPage(): Page {
    return this.#requirePage();
  }

  #activePage(): Page | null {
    return this.#page !== null && !this.#page.isClosed() ? this.#page : null;
  }

  async #runOperation<T>(
    options: DriverOperationOptions | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.#unusable) {
      throw new Error("Playwright web driver is unusable after cancellation.");
    }
    const signal = options?.signal;
    if (signal === undefined) return await operation();
    if (signal.aborted) {
      await this.#retireAfterCancellation();
      throw signal.reason;
    }

    let abortHandler: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abortHandler = () => {
        void this.#retireAfterCancellation().then(
          () => reject(signal.reason),
          () => reject(signal.reason),
        );
      };
      signal.addEventListener("abort", abortHandler, { once: true });
    });
    try {
      return await Promise.race([operation(), cancelled]);
    } finally {
      if (abortHandler !== undefined) signal.removeEventListener("abort", abortHandler);
    }
  }

  async #retireAfterCancellation(): Promise<void> {
    this.#unusable = true;
    this.#retirement ??= this.close().catch(() => undefined);
    await this.#retirement;
  }

  #requirePage(): Page {
    const page = this.#activePage();
    if (page === null) {
      throw new Error("No web app is launched.");
    }
    return page;
  }

  async #closeContext(): Promise<void> {
    const context = this.#context;
    this.#page = null;
    this.#context = null;
    this.#pendingRequestEntries = new WeakMap();
    this.#pendingRequestsRetained.clear();
    if (context !== null) {
      await context.close();
    }
  }

  #clearTelemetry(): void {
    this.#logs = [];
    this.#networkEntries = [];
    this.#pendingRequestEntries = new WeakMap();
    this.#pendingRequestsRetained.clear();
    this.#pendingRequestsDropped = 0;
    this.#requestsFailed = 0;
    this.#requestsInFlight = 0;
    this.#requestsStarted = 0;
    this.#requestsSucceeded = 0;
  }

  #pushLog(entry: WebLogEntry): void {
    this.#logs.push(entry);
    if (this.#logs.length > this.#options.maxLogEntries) {
      this.#logs.splice(0, this.#logs.length - this.#options.maxLogEntries);
    }
  }

  #pushNetworkEntry(entry: MutableNetworkEntry): void {
    this.#networkEntries.push(entry);
    if (this.#networkEntries.length > this.#options.recentNetworkEntries) {
      this.#networkEntries.splice(0, this.#networkEntries.length - this.#options.recentNetworkEntries);
    }
  }

  #attachPageTelemetry(page: Page): void {
    page.on("console", (message) => {
      const location = message.location();
      const sourceLocation = location.url.length === 0
        ? null
        : `${sanitiseUrl(location.url)}:${location.lineNumber}:${location.columnNumber}`;
      this.#pushLog({
        timestamp: new Date().toISOString(),
        level: consoleLevel(message),
        message: sanitiseObservedText(message.text()),
        source: "console",
        location: sourceLocation,
        stack: null,
      });
    });

    page.on("pageerror", (error) => {
      this.#pushLog({
        timestamp: new Date().toISOString(),
        level: "error",
        message: sanitiseObservedText(error.message),
        source: "page-error",
        location: null,
        stack: error.stack === undefined ? null : sanitiseObservedText(error.stack),
      });
    });

    page.on("crash", () => {
      this.#pushLog({
        timestamp: new Date().toISOString(),
        level: "error",
        message: "The Playwright page crashed.",
        source: "browser",
        location: null,
        stack: null,
      });
    });

    page.on("request", (request) => this.#recordRequest(request));
    page.on("response", (response) => this.#recordResponse(response));
    page.on("requestfinished", (request) => this.#finishRequest(request));
    page.on("requestfailed", (request) => this.#failRequest(request));
  }

  #recordRequest(request: Request): void {
    const startedAtMs = Date.now();
    const entry: MutableNetworkEntry = {
      method: request.method(),
      url: sanitiseUrl(request.url()),
      resourceType: request.resourceType(),
      outcome: "pending",
      status: null,
      startedAt: new Date(startedAtMs).toISOString(),
      startedAtMs,
      finishedAt: null,
      durationMs: null,
      failure: null,
    };
    this.#requestsStarted += 1;
    this.#requestsInFlight += 1;
    this.#pendingRequestEntries.set(request, entry);
    if (this.#pendingRequestsRetained.size >= this.#options.maxPendingNetworkRequests) {
      const oldest = this.#pendingRequestsRetained.values().next().value as Request | undefined;
      if (oldest !== undefined) {
        this.#pendingRequestsRetained.delete(oldest);
        this.#pendingRequestsDropped += 1;
      }
    }
    this.#pendingRequestsRetained.add(request);
    this.#pushNetworkEntry(entry);
  }

  #recordResponse(response: Response): void {
    const entry = this.#pendingRequestEntries.get(response.request());
    if (entry !== undefined) {
      entry.status = response.status();
    }
  }

  #finishRequest(request: Request): void {
    const entry = this.#pendingRequestEntries.get(request);
    if (entry === undefined) {
      return;
    }
    const finishedAtMs = Date.now();
    entry.outcome = "succeeded";
    entry.finishedAt = new Date(finishedAtMs).toISOString();
    entry.durationMs = finishedAtMs - entry.startedAtMs;
    this.#pendingRequestEntries.delete(request);
    this.#pendingRequestsRetained.delete(request);
    this.#requestsInFlight = Math.max(0, this.#requestsInFlight - 1);
    this.#requestsSucceeded += 1;
  }

  #failRequest(request: Request): void {
    const entry = this.#pendingRequestEntries.get(request);
    if (entry === undefined) {
      return;
    }
    const finishedAtMs = Date.now();
    entry.outcome = "failed";
    entry.finishedAt = new Date(finishedAtMs).toISOString();
    entry.durationMs = finishedAtMs - entry.startedAtMs;
    entry.failure = sanitiseObservedText(request.failure()?.errorText ?? "Request failed");
    this.#pendingRequestEntries.delete(request);
    this.#pendingRequestsRetained.delete(request);
    this.#requestsInFlight = Math.max(0, this.#requestsInFlight - 1);
    this.#requestsFailed += 1;
  }
}
