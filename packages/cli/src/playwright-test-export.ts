import { open, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import {
  PROTOCOL_VALIDATION_LIMITS,
  REPORT_SCHEMA_VERSION_V1,
  parseTVDoctorReportJson,
  type RemoteKey,
  type TVDoctorIssue,
  type TVDoctorReplayV1,
} from "@tvdoctor/protocol";
import { compileReplay } from "@tvdoctor/core";
import {
  PACKAGED_REPLAY_TARGET_ENVIRONMENT_KEY,
  REPLAY_TARGET_OVERRIDE_ENVIRONMENT_KEY,
} from "./node-audit-contracts.js";
import { JOURNEY_HASH_ENVIRONMENT_KEY } from "./journey.js";
import { parseSiteArguments } from "./site-scan.js";

export interface ExportPlaywrightTestRequest {
  readonly issueId: string;
  readonly reportPath: string;
  readonly outputPath: string;
}

export interface ExportPlaywrightTestResult {
  readonly outputPath: string;
  readonly issueId: string;
  readonly steps: number;
}

/** Use the same physical keyboard inputs as the TVDoctor Chromium driver. */
const PLAYWRIGHT_KEYS: Readonly<Record<RemoteKey, string>> = {
  UP: "ArrowUp",
  DOWN: "ArrowDown",
  LEFT: "ArrowLeft",
  RIGHT: "ArrowRight",
  SELECT: "Enter",
  BACK: "Escape",
  TAB: "Tab",
  SHIFT_TAB: "Shift+Tab",
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

/** Generated scripts must remain practical to review and execute. */
const MAX_EXPORTED_PRESSES = 250;
const SAFE_ISSUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SAFE_NAVIGATION_SETUP_KEYS: ReadonlySet<RemoteKey> = new Set([
  "UP", "DOWN", "LEFT", "RIGHT", "TAB", "SHIFT_TAB",
]);

/** Only a complete audit with a proved transition can be turned into a regression test. */
function selectDeterministicReplay(
  report: ReturnType<typeof parseTVDoctorReportJson>,
  issueId: string,
): { readonly issue: TVDoctorIssue; readonly replay: TVDoctorReplayV1; readonly targetUrl: string } {
  if (report.schemaVersion !== REPORT_SCHEMA_VERSION_V1) {
    throw new TypeError("Export requires a tvdoctor.report/v1 report.");
  }
  if (report.run.status !== "completed"
    || report.coverage.budget.exhausted.length > 0
    || report.coverage.packs.some((pack) => pack.status === "partial")) {
    throw new TypeError("Export requires a completed report without partial coverage or exhausted budgets.");
  }
  if (report.target.platform !== "web") {
    throw new TypeError("Playwright export supports web findings only.");
  }
  const environment = report.target.environment;
  if (environment[REPLAY_TARGET_OVERRIDE_ENVIRONMENT_KEY] !== undefined
    || environment[PACKAGED_REPLAY_TARGET_ENVIRONMENT_KEY] !== undefined
    || environment[JOURNEY_HASH_ENVIRONMENT_KEY] !== undefined) {
    throw new TypeError("Export cannot reconstruct a redacted target, packaged demo, or custom journey.");
  }
  let url: URL;
  try {
    url = new URL(report.target.location);
  } catch {
    throw new TypeError("Export requires an absolute, unredacted HTTP(S) target URL.");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:")
    || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== ""
    || url.href !== report.target.location) {
    throw new TypeError("Export requires an absolute, unredacted HTTP(S) target URL without credentials or query data.");
  }
  if (typeof parseSiteArguments([url.href, "--input", "keyboard"]) === "string") {
    throw new TypeError("Export refuses protected, unsafe or ambiguous target routes.");
  }
  const issues = report.issues.filter((candidate) => candidate.id === issueId);
  if (issues.length !== 1) {
    throw new TypeError("Export requires exactly one matching issue ID.");
  }
  const issue = issues[0];
  if (issue === undefined) throw new TypeError("The recorded issue was not found.");
  if (issue.confidence !== "deterministic"
    || issue.reproduction.status !== "available"
    || issue.reproduction.confidence !== "deterministic") {
    throw new TypeError("Export requires a deterministic issue with an available deterministic reproduction.");
  }
  const replays = report.replays.filter((candidate) => candidate.issueId === issue.id);
  if (replays.length !== 1) {
    throw new TypeError("Export requires exactly one embedded deterministic replay.");
  }
  const replay = replays[0];
  if (replay === undefined) throw new TypeError("The recorded replay was not found.");
  if (replay.reset.strategy !== "reload") {
    throw new TypeError("Playwright export supports only reload reset, which can be represented by a fresh browser page.");
  }
  const compiled = compileReplay(replay, { sourceIssue: issue });
  if (compiled.status !== "compiled" || compiled.plan.confidence !== "deterministic") {
    throw new TypeError("The stored replay cannot be safely compiled as a deterministic replay.");
  }
  if (compiled.plan.totalActions > MAX_EXPORTED_PRESSES) {
    throw new TypeError(`Export replay exceeds the ${String(MAX_EXPORTED_PRESSES)}-keypress safety ceiling.`);
  }
  // The report cannot prove what an arbitrary Enter/Escape/media press will
  // activate in a fresh session. A generated test must never trigger one.
  if (replay.steps.some((step) => !SAFE_NAVIGATION_SETUP_KEYS.has(step.key))) {
    throw new TypeError("Export refuses replay activation, Escape, Home and media keys; only bounded navigation inputs are safe to generate.");
  }
  if (issue.rule !== "keyboard.modal-focus-escape"
    || (replay.assertion.action !== "TAB" && replay.assertion.action !== "SHIFT_TAB")
    || environment["inputMode"] !== "keyboard") {
    throw new TypeError(
      "This finding has no supported, provable Playwright DOM assertion. Currently supported: keyboard.modal-focus-escape.",
    );
  }
  return { issue, replay, targetUrl: url.href };
}

/** Reviewable JavaScript that proves the same modal remains open and contains keyboard focus. */
export function renderPlaywrightTest(
  report: ReturnType<typeof parseTVDoctorReportJson>,
  issueId: string,
): string {
  if (!SAFE_ISSUE_ID.test(issueId)) throw new TypeError("ISSUE_ID must be a portable identifier.");
  const { issue, replay, targetUrl } = selectDeterministicReplay(report, issueId);
  const setupSteps = replay.steps.map((step) => ({ key: PLAYWRIGHT_KEYS[step.key], repeat: step.repeat }));
  const assertionStep = setupSteps.at(-1);
  if (assertionStep === undefined) throw new TypeError("The recorded replay is empty.");
  if (assertionStep.repeat === 1) setupSteps.pop();
  else setupSteps[setupSteps.length - 1] = { key: assertionStep.key, repeat: assertionStep.repeat - 1 };

  return `// Generated by TVDoctor from a deterministic, completed web audit.
// Issue: ${issue.id}
// Set TVDOCTOR_AUTHORIZED_TARGET_URL to the recorded URL before running with Playwright.
// Review this script and run it only against a target you are authorized to test.
import { test, expect } from "@playwright/test";

const RECORDED_TARGET_URL = ${JSON.stringify(targetUrl)};
const AUTHORIZED_TARGET_URL = process.env.TVDOCTOR_AUTHORIZED_TARGET_URL;
if (!AUTHORIZED_TARGET_URL || AUTHORIZED_TARGET_URL !== RECORDED_TARGET_URL) {
  throw new Error("Set TVDOCTOR_AUTHORIZED_TARGET_URL to the exact authorized URL recorded in the report.");
}
const SETUP_STEPS = ${JSON.stringify(setupSteps, null, 2)};
const ASSERTION_KEY = ${JSON.stringify(assertionStep.key)};

test(${JSON.stringify(`TVDoctor ${issue.id}: keyboard focus remains within an open modal`)}, async ({ page }) => {
  await page.goto(AUTHORIZED_TARGET_URL, { waitUntil: "domcontentloaded" });
  for (const step of SETUP_STEPS) {
    for (let press = 0; press < step.repeat; press += 1) {
      // Arrow keys can silently edit focused sliders/inputs or select values.
      // Never execute those mutations just to reconstruct a navigation path.
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(step.key)) {
        const editing = await page.evaluate(() => {
          const element = document.activeElement;
          return element instanceof Element && (
            element.matches('input, textarea, select, [contenteditable], [role="slider"], [role="spinbutton"], [role="combobox"]')
            || element.closest('[contenteditable], [role="slider"], [role="spinbutton"], [role="combobox"]') !== null
          );
        });
        if (editing) throw new Error("Refusing arrow-key setup on an editable control");
      }
      await page.keyboard.press(step.key);
    }
  }

  // The recorded state must be reproducible; missing preconditions fail the test.
  // Non-modal <dialog open> and hidden duplicate templates are not the modal
  // the scanner observed. Only one visibly active modal is admissible.
  const modal = page.locator('dialog[open]:modal:visible, [role="dialog"][aria-modal="true"]:visible, [role="alertdialog"][aria-modal="true"]:visible');
  await expect(modal, "Exactly one modal should be open at the recorded checkpoint").toHaveCount(1);
  await expect(modal).toBeVisible();
  expect(await modal.evaluate((element) => !element.closest('[inert], [aria-hidden="true"]')),
    "The recorded modal must not be inert or aria-hidden").toBe(true);
  expect(await modal.evaluate((element) => element.contains(document.activeElement)),
    "Focus must begin inside the modal").toBe(true);

  const originalModal = await modal.elementHandle();
  if (!originalModal) throw new Error("The recorded modal disappeared before the assertion");
  await page.keyboard.press(ASSERTION_KEY);

  // A passing first poll can complete BEFORE a delayed focus leak or DOM
  // replacement. Sample the original element after settling and over time.
  await page.waitForTimeout(180);
  for (let check = 0; check < 5; check += 1) {
    const retained = await originalModal.evaluate((element) => {
      const stillModal = element.matches('dialog[open]:modal, [role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]');
      return element.isConnected && stillModal && element.getClientRects().length > 0
        && !element.closest('[inert], [aria-hidden="true"]')
        && element.contains(document.activeElement);
    });
    expect(retained, "The recorded modal must remain open and retain keyboard focus").toBe(true);
    if (check < 4) await page.waitForTimeout(80);
  }
});
`;
}

/** Avoid unbounded reads even if a report changes between stat and read. */
async function readBoundedReport(path: string): Promise<ReturnType<typeof parseTVDoctorReportJson>> {
  const file = await open(path, "r");
  try {
    const stats = await file.stat();
    if (!stats.isFile() || stats.size > PROTOCOL_VALIDATION_LIMITS.maxJsonBytes) {
      throw new TypeError("The report must be a regular JSON file within the protocol size limit.");
    }
    const buffer = Buffer.alloc(stats.size + 1);
    let bytes = 0;
    while (bytes < buffer.byteLength) {
      const read = await file.read(buffer, bytes, buffer.byteLength - bytes, bytes);
      if (read.bytesRead === 0) break;
      bytes += read.bytesRead;
    }
    if (bytes !== stats.size) {
      throw new TypeError("The report changed during reading; export refused.");
    }
    return parseTVDoctorReportJson(buffer.toString("utf8", 0, bytes));
  } finally {
    await file.close();
  }
}

export async function exportPlaywrightTest(
  request: ExportPlaywrightTestRequest,
): Promise<ExportPlaywrightTestResult> {
  if (!SAFE_ISSUE_ID.test(request.issueId)) throw new TypeError("ISSUE_ID must be a portable identifier.");
  if (!/\.(?:spec|test)\.js$/u.test(request.outputPath)
    || extname(request.outputPath) !== ".js") {
    throw new TypeError("The output must be a .spec.js or .test.js Playwright file.");
  }
  const reportPath = resolve(request.reportPath);
  const outputPath = resolve(request.outputPath);
  if (reportPath === outputPath) throw new TypeError("Output must not overwrite the source report.");
  const report = await readBoundedReport(reportPath);
  const replay = selectDeterministicReplay(report, request.issueId).replay;
  const generated = renderPlaywrightTest(report, request.issueId);
  await writeFile(outputPath, generated, { encoding: "utf8", flag: "wx" });
  return {
    outputPath,
    issueId: request.issueId,
    steps: replay.steps.reduce((sum, step) => sum + step.repeat, 0),
  };
}
