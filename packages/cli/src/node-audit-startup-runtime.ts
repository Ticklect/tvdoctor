import { captureInitialPageRuntimeFailure, type PlaywrightWebDriver, type StartupRuntimeReviewFinding } from "@tvdoctor/driver-web";
import type { TVDoctorIssue } from "@tvdoctor/protocol";

function startupExceptionReviewIssue(observation: StartupRuntimeReviewFinding): TVDoctorIssue {
  // Browser-authored exceptions are untrusted and may include credentials.
  // Persist only a bounded class/phase witness, never text, stack, or URL.
  return {
    id: "TVDOCTOR-WEB-STARTUP-UNCAUGHT-ERROR",
    rule: observation.rule,
    title: "Uncaught JavaScript exception during initial document execution",
    description: "Chromium observed an uncaught pageerror while loading the initial application document. Investigate the startup path, but do not infer a specific root cause or a repaired state from this event alone.",
    severity: "high", confidence: "heuristic", pack: "navigation", screen: null,
    expected: "Initial document startup should complete without an uncaught application exception.",
    observed: "One uncaught browser pageerror was observed in a bounded initial-document window; application-authored message and stack were not stored.",
    transition: null,
    evidence: [{ kind: "heuristic-warning",
      summary: "One Playwright pageerror coincided with initial main-document execution; unrelated later timers, console.error, redirected and ambiguous loads are excluded.",
      source: "PlaywrightWebDriver:initial-document-pageerror/v1", artifact: null }],
    reproduction: { status: "unavailable",
      reason: "An initial pageerror observation is REVIEW-only and has no independent corrected-state fix oracle." },
  };
}

/** Launch exactly once. The Chromium-only witness must not change the driver
 * contract for remote audits, metadata runs, or injected deterministic drivers. */
export async function launchAuditWithStartupReview(
  driver: PlaywrightWebDriver,
  app: { readonly id: string; readonly launchUri: string },
  options: { readonly inputMode?: string; readonly navigation: boolean; readonly signal?: AbortSignal },
): Promise<readonly TVDoctorIssue[]> {
  if (options.inputMode === "keyboard" && options.navigation
    && typeof driver.getPage === "function" && typeof driver.getLogSnapshot === "function") {
    const result = await captureInitialPageRuntimeFailure(driver, app,
      options.signal === undefined ? {} : { signal: options.signal });
    return result.finding === null ? [] : [startupExceptionReviewIssue(result.finding)];
  }
  await driver.launch(app, options.signal === undefined ? undefined : { signal: options.signal });
  return [];
}
