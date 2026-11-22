import type { AppReference } from "@tvdoctor/protocol";
import type { PlaywrightWebDriver } from "./web-driver.js";

export const WEB_STARTUP_UNCAUGHT_PAGE_ERROR_RULE = "web.startup-uncaught-page-error" as const;
// Synchronous inline script exceptions can reach Playwright a few milliseconds
// after DOMContentLoaded. Do not extend this to the entire page-settle window.
const MAX_BROWSER_EVENT_DELIVERY_GRACE_MS = 25;

/** A directly observed uncaught exception in initial document execution.
 *
 * It is NOT an independently verified root cause or fixed-state oracle. In
 * particular, pageerror does not establish that the UI actually crashed.
 */
export interface StartupRuntimeReviewFinding {
  readonly rule: typeof WEB_STARTUP_UNCAUGHT_PAGE_ERROR_RULE;
  readonly classification: "review";
  readonly severity: "high";
  readonly exceptionClass: "UncaughtPageError";
  readonly count: 1;
  readonly phase: "initial-document-bounded-delivery";
  readonly evidence: "playwright-pageerror-in-initial-document-window";
  readonly reproduction: "unavailable";
}

export interface StartupRuntimeCaptureResult {
  readonly finding: StartupRuntimeReviewFinding | null;
  /** Coverage is intentionally bounded to initial main-document execution. */
  readonly coverage: "initial-document" | "inconclusive";
}

export interface StartupRuntimeCaptureOptions {
  /** Upper bound on document execution up to DOMContentLoaded. Default 3s. */
  readonly maxInitialDocumentMs?: number;
  /** Propagated to the same driver.launch operation; no extra launch occurs. */
  readonly signal?: AbortSignal;
}

type InitialPageDriver = Pick<PlaywrightWebDriver, "launch" | "getPage" | "getLogSnapshot">;

function boundedDuration(raw: number | undefined): number {
  if (raw === undefined) return 3_000;
  if (!Number.isSafeInteger(raw) || raw < 100 || raw > 5_000) {
    throw new TypeError("maxInitialDocumentMs must be an integer from 100 to 5000.");
  }
  return raw;
}

/**
 * Run the driver's existing launch exactly once. Its own pageerror listener is
 * installed BEFORE goto; this module must not install a duplicate listener,
 * observe arbitrary old logs, touch the DOM, or perform additional navigation.
 *
 * Immediately after launch, use read-only browser navigation timing to
 * attribute only pageerrors emitted up to DOMContentLoaded plus at most 25ms
 * of browser event-delivery grace. Later timers, hydration, background network
 * and key events are deliberately outside the finding. This cannot prove
 * synchronous cause; the finding remains REVIEW-only.
 *
 * A launch failure is propagated unchanged. An unavailable/ambiguous timing
 * witness fails closed rather than turning arbitrary logs into a finding.
 */
export async function captureInitialPageRuntimeFailure(
  driver: InitialPageDriver,
  app: AppReference,
  options: StartupRuntimeCaptureOptions = {},
): Promise<StartupRuntimeCaptureResult> {
  const maxInitialDocumentMs = boundedDuration(options.maxInitialDocumentMs);
  options.signal?.throwIfAborted();
  await driver.launch(app, options.signal === undefined ? undefined : { signal: options.signal });
  options.signal?.throwIfAborted();

  const incomplete: StartupRuntimeCaptureResult = {
    finding: null, coverage: "inconclusive",
  };
  const page = driver.getPage();
  if (page.isClosed() || app.launchUri === undefined) return incomplete;

  // No DOM access, untrusted app JS text, exception message or stack is read.
  // The navigation timing comes from Chromium's native Performance timeline.
  const timing = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation");
    const entry = nav.length === 1 ? nav[0] : undefined;
    if (entry === undefined || !(entry instanceof PerformanceNavigationTiming)) return null;
    return {
      navigationStartEpochMs: performance.timeOrigin,
      domContentLoadedEpochMs: performance.timeOrigin + entry.domContentLoadedEventEnd,
      durationMs: entry.domContentLoadedEventEnd,
      navigationType: entry.type,
    };
  }).catch(() => null);
  options.signal?.throwIfAborted();
  if (timing === null || !Number.isFinite(timing.navigationStartEpochMs)
    || !Number.isFinite(timing.domContentLoadedEpochMs)
    || timing.durationMs <= 0 || timing.durationMs > maxInitialDocumentMs
    || timing.navigationType !== "navigate") return incomplete;
  // A redirect, script-driven route change, or credentials-bearing URL makes
  // attribution to the user's requested root ambiguous. Keep the URL private.
  let target: URL;
  try { target = new URL(app.launchUri); } catch { return incomplete; }
  if ((target.protocol !== "http:" && target.protocol !== "https:")
    || target.username !== "" || target.password !== ""
    || page.url() !== target.href) return incomplete;

  const snapshot = await driver.getLogSnapshot(
    options.signal === undefined ? undefined : { signal: options.signal },
  );
  options.signal?.throwIfAborted();
  if (snapshot.droppedEntries !== 0) return incomplete;
  const pageErrors = snapshot.logs.filter((entry) => entry.source === "page-error");
  const inDocument = pageErrors.filter((entry) => {
    const timestamp = Date.parse(entry.timestamp);
    return Number.isFinite(timestamp)
      && timestamp >= timing.navigationStartEpochMs
      && timestamp <= timing.domContentLoadedEpochMs + MAX_BROWSER_EVENT_DELIVERY_GRACE_MS;
  });
  // More than one event (including a later unrelated pageerror) makes this
  // conservative REVIEW lead ambiguous. Never inspect messages or stacks.
  if (pageErrors.length !== 1 || inDocument.length !== 1) {
    return { finding: null, coverage: "initial-document" };
  }
  return {
    coverage: "initial-document",
    finding: {
      rule: WEB_STARTUP_UNCAUGHT_PAGE_ERROR_RULE,
      classification: "review",
      severity: "high",
      exceptionClass: "UncaughtPageError",
      count: 1,
      phase: "initial-document-bounded-delivery",
      evidence: "playwright-pageerror-in-initial-document-window",
      reproduction: "unavailable",
    },
  };
}
