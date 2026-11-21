import { basename, dirname, join } from "node:path";

import {
  diagnoseEnvironment,
  doctorSucceeded,
  renderDoctorReport,
  type DiagnosticCheck,
  type RuntimeEnvironment,
} from "./diagnostics.js";

import {
  isSafeTerminalArgument,
  safeDisplayUrl,
  sanitizeTerminalText,
} from "./terminal.js";
import { defaultOutputDirectory } from "./product-output.js";
import { reconcileCiBaselineExports } from "./ci-baseline-exports.js";
import type { StartTerminal } from "./interactive.js";
import { runGuidedStart } from "./start.js";
import type {
  AndroidBuildToolsPreflightResult,
  AndroidObserverPreflightResult,
  AndroidPreflightResult,
  AndroidScanResult,
  AndroidScanOptions,
  ApkMetadata,
} from "./android-product.js";
import { CLI_VERSION } from "./version.js";
import { PRIVACY_TEXT } from "./privacy.js";
import { REMOTE_KEYS, type RemoteKey } from "@tvdoctor/protocol";
import { MAX_EXPLORATION_BUDGETS, type ExplorationBudgets } from "@tvdoctor/core";
import {
  CI_FAILURE_THRESHOLDS,
  issueViolatesPolicy,
  type CiFailureThreshold,
} from "@tvdoctor/reporters";

export const EXIT_CODES = {
  success: 0,
  environmentFailure: 1,
  usageError: 2,
  inconclusive: 3,
  executionError: 4,
  /** Compatibility aliases retained for callers built against M5. */
  replayInconclusive: 3,
  replayError: 4,
} as const;

export const TEST_PACK_NAMES = [
  "all",
  "navigation",
  "streaming",
  "search",
  "settings",
  "accessibility",
  "layout",
  "performance",
  "crashes",
] as const;

export type TestPackName = (typeof TEST_PACK_NAMES)[number];

export type TestRunMode = "quick" | "standard" | "deep";

export interface TestCommandRequest {
  readonly target: string;
  /** Human-readable report label for trusted first-party flows such as the packaged demo. */
  readonly targetName?: string;
  /** Marks the trusted packaged Northstar activation target so saved replay can relaunch it locally. */
  readonly packagedDemo?: boolean;
  readonly packs: readonly TestPackName[];
  readonly mode: TestRunMode;
  readonly outputPath: string;
  readonly searchQuery: string;
  readonly startupActions?: readonly RemoteKey[];
  readonly startupDecision?: "reject" | "accept";
  readonly maxDurationMs?: number;
  /** Explicit navigation traversal ceilings; unrelated diagnostic packs keep their budgets. */
  readonly navigationBudgets?: Partial<ExplorationBudgets>;
  /** Preserve individually reachable carousel/list cells during navigation. */
  readonly disableRepetitionCompression?: boolean;
  /** Local Northstar fixture only: permit selecting its two harmless profile buttons. */
  readonly fixtureProfileSelection?: boolean;
  readonly ciFailOn?: CiFailureThreshold;
  /** Optional reviewed semantic baseline for scan/CI orchestration only. */
  readonly baselinePath?: string;
  readonly screenshots?: boolean;
  /** Opt-in local browser-context recording for web audits only. */
  readonly recordVideo?: boolean;
  readonly targetRedaction?: "origin";
  readonly journeyPath?: string;
  /** Trusted local source tree used only for exact, bounded source correlation exports. */
  readonly sourceRoot?: string;
  readonly signal?: AbortSignal;
}

export interface TestCommandResult {
  readonly status: "completed" | "partial" | "failed";
  readonly issueCount: number;
  readonly highestSeverity: "critical" | "high" | "medium" | "low" | "info" | null;
  /** Highest VERIFIED severity. An explicit null means no VERIFIED findings were found. */
  readonly highestVerifiedSeverity?: "critical" | "high" | "medium" | "low" | "info" | null;
  readonly reportPath: string | null;
  readonly details: readonly string[];
}

export interface ReplayCommandRequest {
  readonly issueId: string;
  readonly reportPath: string;
  readonly targetOverride?: string;
  readonly apkPath?: string;
  readonly deviceSerial?: string;
  readonly adbPath?: string;
  readonly journeyPath?: string;
  readonly signal?: AbortSignal;
}

export type ReplayCommandStatus =
  | "reproduced"
  | "fixed"
  | "inconclusive"
  | "error";

export interface ReplayCommandResult {
  readonly status: ReplayCommandStatus;
  readonly details: readonly string[];
}

export interface BaselineCreateRequest {
  readonly reportPath: string;
  readonly inventoryPath: string;
  readonly outputPath: string;
}

export interface BaselineCompareRequest extends BaselineCreateRequest {
  readonly baselinePath: string;
}

export interface BaselineCreateResult {
  readonly issueCount: number;
  readonly outputPath: string;
}

export interface BaselineCompareResult {
  readonly status: "identical" | "changed" | "regressed" | "failed-closed";
  readonly shouldFail: boolean;
  readonly newIssues: number;
  readonly resolvedIssues: number;
  readonly unchangedIssues: number;
  readonly structuralRegressions: number;
  readonly addedFocusTargets: number;
  readonly removedFocusTargets: number;
  readonly directionalTransitionChanges: number;
  readonly latencyRegressions: number;
  readonly blockers: readonly string[];
  readonly outputPath: string;
  readonly markdownPath?: string;
}

export interface DemoCommandRequest {
  readonly outputPath: string;
  readonly signal?: AbortSignal;
}

export interface DemoCommandResult {
  readonly status: "verified" | "inconclusive" | "failed";
  readonly issueId: string | null;
  readonly reportPath: string | null;
  readonly replayStatus: ReplayCommandStatus | null;
  readonly details: readonly string[];
}

export interface CliOperations {
  replayIssue(request: ReplayCommandRequest): Promise<ReplayCommandResult>;
  runDemo?(request: DemoCommandRequest): Promise<DemoCommandResult>;
  testTarget?(request: TestCommandRequest): Promise<TestCommandResult>;
  detectWebsiteStartup?(target: string): Promise<WebsiteStartupDetection>;
  androidPreflight?(adbPath?: string): Promise<AndroidPreflightResult>;
  androidBuildToolsPreflight?(): Promise<AndroidBuildToolsPreflightResult>;
  androidObserverPreflight?(adbPath: string, serial: string): Promise<AndroidObserverPreflightResult>;
  inspectApk?(path: string): Promise<ApkMetadata>;
  scanAndroidApk?(request: AndroidScanOptions): Promise<AndroidScanResult>;
  createBaseline?(request: BaselineCreateRequest): Promise<BaselineCreateResult>;
  compareBaseline?(request: BaselineCompareRequest): Promise<BaselineCompareResult>;
}

export interface WebsiteStartupDetection {
  readonly status: "ready" | "blocked" | "unavailable";
  readonly blockerKind?: string;
  readonly textSample?: string;
  readonly detail: string;
}

export interface CliIO {
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}

/**
 * OS integrations used by the report actions displayed at the end of a guided
 * scan. They are injectable so a failed desktop integration is visible and the
 * flow can be exercised without launching external applications in tests.
 */
export interface ReportActionHandlers {
  openReport(path: string): Promise<boolean>;
  showFolder(path: string): Promise<boolean>;
  copyPath(path: string): Promise<boolean>;
}

export interface CliContext {
  readonly environment: RuntimeEnvironment;
  readonly io: CliIO;
  readonly operations?: CliOperations;
  readonly runtimeProbe?: () => Promise<RuntimeProbeResult>;
  readonly runtimeSetup?: (signal?: AbortSignal) => Promise<void>;
  readonly startTerminal?: StartTerminal;
  /** Trusted source root supplied by an embedding host or safely inferred CI environment. */
  readonly sourceRoot?: string;
  readonly signal?: AbortSignal;
  readonly terminalProgress?: {
    readonly isInteractive: boolean;
    update(text: string): void;
    finish(): void;
  };
  readonly reportActions?: ReportActionHandlers;
}

export interface RuntimeProbeResult {
  readonly capabilities: readonly string[];
}

export const HELP_TEXT = `TVDoctor — find broken TV remote navigation before users do

Usage:
  tvdoctor demo [--output PATH]
  tvdoctor start
  tvdoctor scan URL [options] [--baseline PATH]
  tvdoctor test URL [--pack NAME] [--mode MODE] [--output PATH] [--query TEXT]
  tvdoctor test URL [--startup-actions KEY[,KEY...]] [--max-duration-ms N]
  tvdoctor test URL [--journey PATH]
  tvdoctor accessibility URL [--mode MODE] [--output PATH] [--journey PATH]
  tvdoctor test --apk PATH [--device SERIAL] [--mode quick|deep] [--output PATH]
  tvdoctor ci URL --fail-on LEVEL [test options]
  tvdoctor baseline create --report PATH [--inventory PATH] [--output PATH]
  tvdoctor baseline compare --baseline PATH --report PATH [--inventory PATH] [--output PATH]
  tvdoctor privacy
  tvdoctor setup
  tvdoctor doctor
  tvdoctor replay ISSUE_ID [--report PATH] [--target URL]
  tvdoctor version
  tvdoctor --version
  tvdoctor help
  tvdoctor --help

Source checkout: npm run tvdoctor -- <command> [...options]

Commands:
  demo      Run the deterministic Northstar first-success demo.
  start     Open the guided product flow.
  scan      Run the fast navigation-first audit.
  test      Check remote/D-pad navigation and write a report bundle.
  accessibility
            Run the focused web accessibility and caption profile.
  ci        Run an audit with an explicit failure policy and CI exports.
  baseline  Create or compare a semantic regression baseline.
  privacy   Explain local capture, redaction, retention, and sharing controls.
  setup     Install the Chromium runtime matched to this TVDoctor version.
  doctor    Diagnose web and optional Android TV prerequisites.
  replay    Re-run one deterministic issue from a V1 report.
  version   Print the installed TVDoctor version.
  help      Show this help.

Exit codes:
  0  Command completed successfully under the requested failure policy.
  1  Findings failed policy, a standalone replay reproduced the issue, a baseline regressed,
     or a required local environment/device is unavailable.
  2  Command usage is invalid.
  3  The result is partial or inconclusive.
  4  Execution failed before a trustworthy result was produced.`;

export const TEST_HELP_TEXT = `Usage:
  tvdoctor test URL [options]
  tvdoctor test --apk PATH [--device SERIAL] [--mode quick|deep] [--output PATH]

Run a bounded remote-navigation audit against an absolute HTTP(S) URL.
The default checks D-pad/focus navigation. Extra packs remain opt-in.

Options:
  --pack NAME    navigation (default), streaming, search, settings, accessibility,
                 layout, performance, crashes, or all. Repeat to select packs.
                 Use all for the legacy full pack set.
  --mode MODE    quick, standard, or deep for web. Defaults to standard.
  --output PATH  Report bundle directory. Defaults under Tests with a readable name.
  --query TEXT   Non-sensitive search query. Defaults to N.
  --startup-actions KEY[,KEY...]
                 Explicit caller-selected remote keys used only to prepare a
                 detected startup setup screen. Defaults to observation-only.
  --max-duration-ms N
                 Navigation exploration ceiling only; setup, extra packs,
                 evidence capture and report generation take additional time.
  --max-actions N  Maximum physical remote inputs including replay (up to 1000000).
  --max-states N   Maximum distinct visited focus states (up to 100000).
  --max-depth N    Maximum path depth (0 to 4096).
  --no-compression
                 Explore every discovered distinct repeated focus target
                 within the selected action, state, depth and time limits.
  --fixture-profile-select
                 Fixture testing only: permit Northstar profile buttons on
                 localhost/loopback when their exact fixture markers match.
  --journey PATH  Safe custom web journey; secret values come only from
                 TVDOCTOR_JOURNEY_* environment variables.
  --no-screenshots
                 Do not persist PNG screenshot evidence.
  --record-video
                 Record one local WebM browser-session sidecar. Web only; off by default.
  --target-redaction origin
                 Store only the target origin as the public web target identity.

Android APK options:
  --apk PATH      Local APK to install and test without prompts.
  --device SERIAL Authorized emulator/device serial. Optional when exactly one
                  online device is available; required to disambiguate multiples.
  --adb PATH      Optional explicit adb executable path.
  --mode MODE     quick or deep. Defaults to quick.
  --output PATH   Report bundle directory.
  --no-screenshots
                 Do not persist before/after PNG evidence.`;

export const SCAN_HELP_TEXT = `Usage:
  tvdoctor scan URL [--mode quick|standard|deep] [--output PATH] [--journey PATH] [--baseline PATH] [--record-video]

Run the navigation-first web audit. Defaults to standard mode with uncompressed
navigation so all discovered controls can be explored within the safety limits.
Use --mode quick for a 30-second navigation sample, or --mode deep for larger
coverage. The default navigation ceilings are 30 seconds (Quick), 120 seconds
(Standard), and 30 minutes (Deep). Browser setup, evidence capture and report
writing occur outside those navigation ceilings and extend total run time.
Override the limits with --max-actions N, --max-states N, --max-depth N and
--max-duration-ms N. --baseline compares against a reviewed semantic baseline.
Use tvdoctor test for diagnostic packs. --record-video is opt-in and may capture
sensitive visual content. --fixture-profile-select works only with the local
Northstar fixture. Even Deep scans can end partial when limits are hit.`;

export const DEMO_HELP_TEXT = `Usage:
  tvdoctor demo [--output PATH]

Run TVDoctor against its packaged Northstar demo fixture, verify the known D-pad
navigation failure, write a normal sanitized report, and reproduce the stored
deterministic replay. No application URL or authored navigation script is needed.`;

export const CI_HELP_TEXT = `Usage:
  tvdoctor ci URL --fail-on LEVEL [test options] [--baseline PATH]

Run the same bounded web audit as tvdoctor test and write exports/ci-summary.md
plus exports/junit.xml. LEVEL is any, critical, high, medium, low, info, or never.
A partial or failed audit remains non-successful regardless of the finding policy.
Remote navigation is the default; pass --pack all for the legacy full pack set.`;

export const BASELINE_HELP_TEXT = `Usage:
  tvdoctor baseline create --report PATH [--inventory PATH] [--output PATH]
  tvdoctor baseline compare --baseline PATH --report PATH [--inventory PATH] [--output PATH]

Create a reviewed semantic baseline from a complete report, or compare a current
complete report with it. Inventory defaults to inventory.json beside the report.
Compare writes JSON plus a sibling Markdown file for human review.`;

export const DOCTOR_HELP_TEXT = `Usage: tvdoctor doctor

Check the local Node.js runtime and both product surfaces. Web readiness includes
Playwright/Chromium launch and audit orchestration. Android TV readiness includes
ADB, Android SDK build-tools (aapt2/aapt), connected/authorized TV device state,
the packaged TVDoctor Observer, and Observer accessibility access. Android TV is
optional: an unconfigured Android surface does not make a ready web install fail.`;

export const SETUP_HELP_TEXT = `Usage: tvdoctor setup

Install the Chromium browser build matched to this TVDoctor version, then verify
that TVDoctor can launch it. The browser is stored in Playwright's user cache.`;

export const START_HELP_TEXT = `Usage: tvdoctor start

Open the guided interactive flow for first-run web or Android TV testing.
For scripted or non-interactive runs, use tvdoctor test instead.`;

export const REPLAY_HELP_TEXT = `Usage:
  tvdoctor replay ISSUE_ID [--report PATH] [--target URL] [--journey PATH]
  tvdoctor replay ISSUE_ID --report PATH --apk PATH --device SERIAL [--adb PATH]

Replay one deterministic issue stored in a tvdoctor.report/v1 report. PATH
defaults to tvdoctor-report/report.json. --target overrides the recorded web URL.
For Android reports, pass --apk PATH --device SERIAL and optionally --adb PATH.
For a journey-prepared web report, pass the same --journey PATH.

Standalone replay exit codes: FIXED exits 0; REPRODUCED exits 1;
INCONCLUSIVE exits 3; execution error exits 4.`;

export const PRIVACY_HELP_TEXT = `Usage: tvdoctor privacy

Print TVDoctor's local-first capture, redaction, retention, and sharing policy.`;

export const ACCESSIBILITY_HELP_TEXT = `Usage:
  tvdoctor accessibility URL [--mode quick|deep] [--output PATH]
  tvdoctor accessibility URL [--journey PATH]

Run the bounded web accessibility profile. It selects the streaming and
accessibility packs to inspect remote focus, semantic labels, hidden focusable
controls, visible focus indication, and reachable caption controls.

Browser evidence does not prove TalkBack, text scaling, audio-description
preferences, autoplay behavior, or rendering on physical TV hardware.`;

const PORTABLE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const TEST_PACK_SET: ReadonlySet<string> = new Set(TEST_PACK_NAMES);
const TEST_RUN_MODES: ReadonlySet<string> = new Set(["quick", "standard", "deep"]);
const REMOTE_KEY_SET: ReadonlySet<string> = new Set(REMOTE_KEYS);

function writeLine(
  write: (text: string) => void,
  text: string,
  maximumLength = 2_048,
): void {
  write(`${sanitizeTerminalText(text, { maximumLength })}\n`);
}

function writeBlock(write: (text: string) => void, text: string): void {
  write(`${sanitizeTerminalText(text, {
    maximumLength: 12_000,
    preserveNewlines: true,
  })}\n`);
}

function writeDetails(
  write: (text: string) => void,
  details: readonly string[],
): void {
  const displayedDetails = details.slice(0, 50);
  for (const detail of displayedDetails) writeLine(write, detail, 1_024);
  if (details.length > displayedDetails.length) {
    writeLine(
      write,
      `${String(details.length - displayedDetails.length)} additional details omitted; see the report bundle.`,
    );
  }
}

function usageError(context: CliContext, message: string): number {
  writeLine(context.io.writeStderr, `Error: ${message}`);
  writeLine(context.io.writeStderr, "Run \"tvdoctor --help\" for usage.");
  return EXIT_CODES.usageError;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function classifyCliError(error: unknown, activity: "audit" | "replay" | "doctor"): string {
  const raw = error instanceof Error ? error.message : String(error);
  const code = errorCode(error);
  if (code === "ENOENT") {
    return activity === "replay"
      ? "The report file was not found. Check --report and try again."
      : "A required file was not found. Check the path and try again.";
  }
  if (code === "EEXIST") {
    return activity === "audit"
      ? "The report output already exists. Choose a new --output directory and try again."
      : "A destination already exists. Choose a new path and try again.";
  }
  if (code === "EACCES" || code === "EPERM") {
    return "Access was denied. Check file and directory permissions, then try again.";
  }
  if (code === "ENOSPC") {
    return "The report could not be written because the disk is full. Free space and try again.";
  }
  if (/executable.*doesn.t exist|browser.*(?:not found|missing)|playwright.*install/iu.test(raw)) {
    return "Chromium is unavailable. Run \"tvdoctor setup\" and try again.";
  }
  if (/timeout|timed out|ERR_(?:CONNECTION|NAME|TIMED)|ECONNREFUSED|ENOTFOUND/iu.test(raw)) {
    return "The target did not become reachable in time. Check the URL and network, then try again.";
  }
  if (activity === "replay" && /json|schema|report|parse|unexpected token/iu.test(raw)) {
    return "The replay report is unreadable or incompatible. Check --report points to a valid TVDoctor V1 JSON report.";
  }
  const firstLine = raw.split(/\r?\n/u, 1)[0] ?? "Unknown error";
  return `${sanitizeTerminalText(firstLine, { maximumLength: 240 })} Check the command inputs and try again.`;
}

/**
 * Make the first web scan self-starting while keeping runtime setup injectable
 * for tests and alternate hosts. A successful probe is intentionally silent;
 * only the recovery path is surfaced to the user.
 */
export async function ensureWebRuntime(context: CliContext): Promise<boolean> {
  if (context.runtimeProbe === undefined) return true;
  try {
    await context.runtimeProbe();
    return true;
  } catch {
    if (context.runtimeSetup === undefined) {
      writeLine(
        context.io.writeStderr,
        "Chromium is required for web audits, but automatic setup is unavailable in this CLI host.",
      );
      return false;
    }
    writeLine(
      context.io.writeStdout,
      "Chromium runtime not found. Installing the matched runtime...",
    );
    try {
      await context.runtimeSetup(context.signal);
      await context.runtimeProbe();
    } catch (setupError) {
      const raw = setupError instanceof Error ? setupError.message : String(setupError);
      const firstLine = raw.split(/\r?\n/u, 1)[0] ?? "Unknown error";
      writeLine(
        context.io.writeStderr,
        `Chromium setup failed: ${sanitizeTerminalText(firstLine, { maximumLength: 240 })}`,
      );
      return false;
    }
    writeLine(context.io.writeStdout, "Chromium is installed and ready for TVDoctor.");
    return true;
  }
}

function summaryMetric(details: readonly string[], pattern: RegExp): string {
  for (const detail of details) {
    const match = pattern.exec(detail);
    if (match?.[1] !== undefined) return match[1];
  }
  return "unavailable";
}

function writeAuditSummary(
  write: (text: string) => void,
  result: Pick<TestCommandResult, "details" | "issueCount" | "reportPath">,
): void {
  const actions = summaryMetric(result.details, /^Actions\s+(\d+(?:\/\d+)?)/iu);
  const states = summaryMetric(result.details, /^States\s+(\d+(?:\/\d+)?)/iu);
  const transitions = summaryMetric(result.details, /^Transitions\s+(\d+(?:\/\d+)?)/iu);
  writeLine(
    write,
    `Summary: actions ${actions}; states ${states}; transitions ${transitions}; findings ${String(result.issueCount)}.`,
  );
  if (result.reportPath !== null) {
    writeLine(write, `Report: ${join(dirname(result.reportPath), "report.html")}`, 1_024);
  }
}

function writeComparisonSummary(
  write: (text: string) => void,
  result: BaselineCompareResult,
): void {
  writeLine(write, `Status: ${result.status.toUpperCase()}`);
  writeLine(
    write,
    `Comparison summary: findings +${String(result.newIssues)}/-${String(result.resolvedIssues)}; focus targets +${String(result.addedFocusTargets)}/-${String(result.removedFocusTargets)}; directional transitions ${String(result.directionalTransitionChanges)}; latency regressions ${String(result.latencyRegressions)}.`,
  );
  writeLine(write, `Next action: Review comparison: ${result.markdownPath ?? result.outputPath}`, 1_024);
}

function parseReplayArguments(
  argumentsAfterCommand: readonly string[],
): ReplayCommandRequest | string {
  let issueId: string | undefined;
  let reportPath = "tvdoctor-report/report.json";
  let targetOverride: string | undefined;
  let apkPath: string | undefined;
  let deviceSerial: string | undefined;
  let adbPath: string | undefined;
  let journeyPath: string | undefined;

  for (let index = 0; index < argumentsAfterCommand.length; index += 1) {
    const argument = argumentsAfterCommand[index];
    if (argument === undefined) continue;

    if (["--report", "--target", "--apk", "--device", "--adb", "--journey"].includes(argument)) {
      const value = argumentsAfterCommand[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return `${argument} requires a value`;
      }
      if (argument === "--report") reportPath = value;
      else if (argument === "--apk") {
        if (!/\.apk$/iu.test(value)) return "--apk must reference an .apk file";
        apkPath = value;
      } else if (argument === "--device") {
        if (!/^[A-Za-z0-9._:-]{1,256}$/u.test(value)) return "--device must be a valid Android serial";
        deviceSerial = value;
      } else if (argument === "--adb") {
        adbPath = value;
      } else if (argument === "--journey") {
        journeyPath = value;
      } else {
        const override = safeTarget(value);
        if (override === null) return "--target must be an absolute HTTP(S) URL without credentials";
        targetOverride = override;
      }
      index += 1;
      continue;
    }

    if (argument.startsWith("--")) return `unknown replay option: ${argument}`;
    if (issueId !== undefined) return `replay accepts exactly one ISSUE_ID`;
    issueId = argument;
  }

  if (issueId === undefined || issueId.trim().length === 0) {
    return "replay requires an ISSUE_ID";
  }
  if (issueId.length > 256 || !PORTABLE_IDENTIFIER_PATTERN.test(issueId)) {
    return "ISSUE_ID must be a portable identifier";
  }

  return {
    issueId,
    reportPath,
    ...(targetOverride === undefined ? {} : { targetOverride }),
    ...(apkPath === undefined ? {} : { apkPath }),
    ...(deviceSerial === undefined ? {} : { deviceSerial }),
    ...(adbPath === undefined ? {} : { adbPath }),
    ...(journeyPath === undefined ? {} : { journeyPath }),
  };
}

export function safeTarget(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username.length > 0
    || parsed.password.length > 0) {
    return null;
  }
  // Return the URL parser's canonical form so ignored whitespace, backslash
  // path separators, Unicode host spelling, and equivalent default ports do
  // not create different audit/replay identities for the same destination.
  return parsed.href;
}

function parseTestArguments(
  argumentsAfterCommand: readonly string[],
  ciMode = false,
  allowBaseline = false,
): TestCommandRequest | string {
  let target: string | undefined;
  const packs: TestPackName[] = [];
  let mode: TestRunMode = "standard";
  let explicitOutputPath: string | undefined;
  let searchQuery = "N";
  let startupActions: RemoteKey[] | undefined;
  let maxDurationMs: number | undefined;
  const navigationBudgets: Partial<Record<keyof ExplorationBudgets, number>> = {};
  let disableRepetitionCompression = false;
  let fixtureProfileSelection = false;
  let ciFailOn: CiFailureThreshold | undefined;
  let baselinePath: string | undefined;
  let screenshots = true;
  let recordVideo = false;
  let targetRedaction: "origin" | undefined;
  let journeyPath: string | undefined;

  for (let index = 0; index < argumentsAfterCommand.length; index += 1) {
    const argument = argumentsAfterCommand[index];
    if (argument === undefined) continue;
    if (argument === "--no-screenshots") {
      screenshots = false;
      continue;
    }
    if (argument === "--record-video") {
      recordVideo = true;
      continue;
    }
    if (argument === "--no-compression") {
      disableRepetitionCompression = true;
      continue;
    }
    if (argument === "--fixture-profile-select") {
      fixtureProfileSelection = true;
      continue;
    }
    const options = ["--pack", "--mode", "--output", "--query", "--startup-actions", "--max-duration-ms", "--max-actions", "--max-states", "--max-depth", "--journey", "--target-redaction"];
    if (ciMode) options.push("--fail-on");
    if (allowBaseline) options.push("--baseline");
    if (options.includes(argument)) {
      const value = argumentsAfterCommand[index + 1];
      if (value === undefined || value.startsWith("--")) return `${argument} requires a value`;
      if (argument === "--pack") {
        if (!TEST_PACK_SET.has(value)) return `unknown test pack: ${value}`;
        packs.push(value as TestPackName);
      } else if (argument === "--mode") {
        if (!TEST_RUN_MODES.has(value)) return `unknown test mode: ${value}`;
        mode = value as TestRunMode;
      } else if (argument === "--output") {
        if (value.trim().length === 0 || value.length > 1_024) return "--output requires a bounded non-empty path";
        explicitOutputPath = value;
      } else if (argument === "--startup-actions") {
        const requested = value.split(",").map((key) => key.trim()).filter((key) => key.length > 0);
        if (requested.length === 0) return "--startup-actions requires at least one remote key";
        if (requested.length > 64) return "--startup-actions accepts no more than 64 remote keys";
        if (requested.some((key) => !REMOTE_KEY_SET.has(key))) return "--startup-actions accepts only known remote keys";
        startupActions = requested as RemoteKey[];
      } else if (argument === "--max-duration-ms") {
        if (!/^[0-9]+$/u.test(value)) {
          return "--max-duration-ms must be a positive safe integer no greater than 2147483647";
        }
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
          return "--max-duration-ms must be a positive safe integer no greater than 2147483647";
        }
        maxDurationMs = parsed;
      } else if (argument === "--max-actions" || argument === "--max-states" || argument === "--max-depth") {
        const budgetKey = argument === "--max-actions" ? "maxActions"
          : argument === "--max-states" ? "maxStates" : "maxDepth";
        const maximum = MAX_EXPLORATION_BUDGETS[budgetKey];
        if (!/^[0-9]+$/u.test(value)) {
          return `${argument} must be a ${budgetKey === "maxDepth" ? "non-negative" : "positive"} safe integer no greater than ${String(maximum)}`;
        }
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < (budgetKey === "maxDepth" ? 0 : 1) || parsed > maximum) {
          return `${argument} must be a ${budgetKey === "maxDepth" ? "non-negative" : "positive"} safe integer no greater than ${String(maximum)}`;
        }
        navigationBudgets[budgetKey] = parsed;
      } else if (argument === "--fail-on") {
        if (!(CI_FAILURE_THRESHOLDS as readonly string[]).includes(value)) {
          return "--fail-on must be any, critical, high, medium, low, info, or never";
        }
        ciFailOn = value as CiFailureThreshold;
      } else if (argument === "--journey") {
        journeyPath = value;
      } else if (argument === "--baseline") {
        if (value.trim().length === 0 || value.length > 1_024 || value.includes("\0")) {
          return "--baseline requires a bounded non-empty path";
        }
        baselinePath = value;
      } else if (argument === "--target-redaction") {
        if (value !== "origin") return "--target-redaction must be origin";
        targetRedaction = "origin";
      } else {
        const safe = sanitizeTerminalText(value, { maximumLength: 64 });
        if (safe.length === 0 || safe !== value.trim()) {
          return "--query must be printable, non-empty, and at most 64 characters";
        }
        searchQuery = safe;
      }
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) return `unknown test option: ${argument}`;
    if (target !== undefined) return "test accepts exactly one URL";
    target = argument;
  }

  if (target === undefined) return "test requires a URL";
  if (journeyPath !== undefined && startupActions !== undefined) {
    return "--journey cannot be combined with --startup-actions";
  }
  if (ciMode && ciFailOn === undefined) return "ci requires --fail-on LEVEL";
  const parsedTarget = safeTarget(target);
  if (parsedTarget === null) return "test target must be an absolute HTTP(S) URL without credentials";
  const selected = packs.length === 0 ? ["navigation" as const] : [...new Set(packs)];
  if (selected.includes("all") && selected.length > 1) return "--pack all cannot be combined with another pack";
  if (fixtureProfileSelection) {
    const host = new URL(parsedTarget).hostname;
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]") {
      return "--fixture-profile-select is restricted to localhost/loopback fixture URLs";
    }
    if (!selected.includes("navigation") && !selected.includes("all")) {
      return "--fixture-profile-select requires the navigation pack";
    }
  }
  return {
    target: parsedTarget,
    packs: selected,
    mode,
    outputPath: explicitOutputPath ?? defaultOutputDirectory({ target: parsedTarget, mode }),
    searchQuery,
    ...(startupActions === undefined ? {} : { startupActions }),
    ...(maxDurationMs === undefined ? {} : { maxDurationMs }),
    ...(Object.keys(navigationBudgets).length === 0 ? {} : { navigationBudgets }),
    ...(disableRepetitionCompression ? { disableRepetitionCompression: true } : {}),
    ...(fixtureProfileSelection ? { fixtureProfileSelection: true } : {}),
    ...(ciFailOn === undefined ? {} : { ciFailOn }),
    ...(baselinePath === undefined ? {} : { baselinePath }),
    ...(screenshots ? {} : { screenshots: false }),
    ...(recordVideo ? { recordVideo: true } : {}),
    ...(targetRedaction === undefined ? {} : { targetRedaction }),
    ...(journeyPath === undefined ? {} : { journeyPath }),
  };
}

type ParsedBaselineCommand =
  | ({ readonly action: "create" } & BaselineCreateRequest)
  | ({ readonly action: "compare" } & BaselineCompareRequest);

function parseBaselineArguments(argumentsAfterCommand: readonly string[]): ParsedBaselineCommand | string {
  const [action, ...options] = argumentsAfterCommand;
  if (action !== "create" && action !== "compare") {
    return "baseline requires create or compare";
  }
  let reportPath: string | undefined;
  let inventoryPath: string | undefined;
  let outputPath: string | undefined;
  let baselinePath: string | undefined;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === undefined) continue;
    if (!["--report", "--inventory", "--output", "--baseline"].includes(option)) {
      return `unknown baseline option: ${option}`;
    }
    if (action === "create" && option === "--baseline") {
      return "baseline create does not accept --baseline";
    }
    const value = options[index + 1];
    if (value === undefined || value.startsWith("--")) return `${option} requires a value`;
    if (value.trim().length === 0 || value.length > 1_024) return `${option} requires a bounded non-empty path`;
    if (option === "--report") reportPath = value;
    else if (option === "--inventory") inventoryPath = value;
    else if (option === "--output") outputPath = value;
    else baselinePath = value;
    index += 1;
  }
  if (reportPath === undefined) return "baseline requires --report PATH";
  const resolvedInventory = inventoryPath ?? join(dirname(reportPath), "inventory.json");
  if (action === "create") {
    return {
      action,
      reportPath,
      inventoryPath: resolvedInventory,
      outputPath: outputPath ?? "tvdoctor-baseline.json",
    };
  }
  if (baselinePath === undefined) return "baseline compare requires --baseline PATH";
  return {
    action,
    baselinePath,
    reportPath,
    inventoryPath: resolvedInventory,
    outputPath: outputPath ?? join(dirname(reportPath), "baseline-comparison.json"),
  };
}

interface AndroidTestCommandRequest {
  readonly apkPath: string;
  readonly serial?: string;
  readonly adbPath?: string;
  readonly mode: "quick" | "deep";
  readonly outputPath: string;
  readonly screenshots?: boolean;
}

function parseAndroidTestArguments(argumentsAfterCommand: readonly string[]): AndroidTestCommandRequest | string {
  let apkPath: string | undefined;
  let serial: string | undefined;
  let adbPath: string | undefined;
  let mode: "quick" | "deep" = "quick";
  let outputPath: string | undefined;
  let screenshots = true;
  for (let index = 0; index < argumentsAfterCommand.length; index += 1) {
    const argument = argumentsAfterCommand[index];
    if (argument === undefined) continue;
    if (argument === "--no-screenshots") {
      screenshots = false;
      continue;
    }
    if (argument === "--record-video") {
      return "--record-video is available only for web audits";
    }
    if (!["--apk", "--device", "--adb", "--mode", "--output"].includes(argument)) {
      return argument.startsWith("--") ? `unknown Android test option: ${argument}` : "Android test does not accept a positional URL";
    }
    const value = argumentsAfterCommand[index + 1];
    if (value === undefined || value.startsWith("--")) return `${argument} requires a value`;
    if (value.trim().length === 0 || value.length > 1_024 || value.includes("\0")) return `${argument} requires a bounded non-empty value`;
    if (argument === "--apk") apkPath = value;
    else if (argument === "--device") serial = value;
    else if (argument === "--adb") adbPath = value;
    else if (argument === "--output") outputPath = value;
    else if (value === "quick" || value === "deep") mode = value;
    else return "Android --mode must be quick or deep";
    index += 1;
  }
  if (apkPath === undefined) return "Android test requires --apk PATH";
  if (!/\.apk$/iu.test(apkPath)) return "--apk must reference an .apk file";
  if (serial !== undefined && !/^[A-Za-z0-9._:-]{1,256}$/u.test(serial)) return "--device must be a valid Android serial";
  return {
    apkPath,
    ...(serial === undefined ? {} : { serial }),
    mode,
    outputPath: outputPath ?? defaultOutputDirectory({
      target: basename(apkPath, ".apk"),
      mode,
      platform: "android-tv",
    }),
    ...(adbPath === undefined ? {} : { adbPath }),
    ...(screenshots ? {} : { screenshots: false }),
  };
}

async function runAndroidTest(
  argumentsAfterCommand: readonly string[],
  context: CliContext,
): Promise<number> {
  const request = parseAndroidTestArguments(argumentsAfterCommand);
  if (typeof request === "string") return usageError(context, request);
  if (context.operations?.scanAndroidApk === undefined) {
    writeLine(context.io.writeStderr, "Android audit is unavailable in this CLI host.");
    return EXIT_CODES.executionError;
  }
  let serial = request.serial;
  if (serial === undefined) {
    if (context.operations.androidPreflight === undefined) {
      return usageError(context, "Android test requires --device SERIAL when device auto-selection is unavailable");
    }
    let preflight: AndroidPreflightResult;
    try {
      preflight = await context.operations.androidPreflight(request.adbPath);
    } catch (error) {
      writeLine(
        context.io.writeStderr,
        `Android device discovery failed: ${classifyCliError(error, "audit")}`,
      );
      return EXIT_CODES.executionError;
    }
    if (!preflight.available) {
      writeLine(
        context.io.writeStderr,
        `Android environment unavailable: ${sanitizeTerminalText(preflight.message, { maximumLength: 512 })}`,
      );
      return EXIT_CODES.environmentFailure;
    }
    const readyDevices = preflight.devices.filter((device) => device.online);
    if (readyDevices.length === 0) {
      writeLine(
        context.io.writeStderr,
        "No online authorized Android device was found. Start or connect a device, accept ADB authorization, and retry.",
      );
      return EXIT_CODES.environmentFailure;
    }
    if (readyDevices.length > 1) {
      return usageError(
        context,
        `Android test could not auto-select a device: ${String(readyDevices.length)} online devices were found; pass --device SERIAL`,
      );
    }
    serial = readyDevices[0]?.serial;
    if (serial === undefined) {
      return usageError(context, "Android test could not auto-select a device; pass --device SERIAL");
    }
    writeLine(context.io.writeStdout, `Using the only online Android device: ${serial}`);
  }
  writeLine(context.io.writeStdout, `Auditing Android APK ${basename(request.apkPath)} on ${serial}...`);
  writeLine(context.io.writeStdout, `Plan: ${request.mode} remote-navigation scan; observer setup must already be authorized.`);
  let result: AndroidScanResult;
  try {
    result = await context.operations.scanAndroidApk({
      apkPath: request.apkPath,
      serial,
      mode: request.mode,
      outputPath: request.outputPath,
      ...(request.adbPath === undefined ? {} : { adbPath: request.adbPath }),
      ...(request.screenshots === false ? { screenshots: false } : {}),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
      ...(context.terminalProgress?.isInteractive === true
        ? {
            onProgress: (progress) => context.terminalProgress?.update(
              `${serial} | ${request.mode} remote-navigation scan | ${String(progress.actions)} actions | ${String(progress.elapsedSeconds)}s`,
            ),
          }
        : {}),
    });
  } catch (error) {
    writeLine(context.io.writeStderr, `Android audit failed: ${classifyCliError(error, "audit")}`);
    return EXIT_CODES.executionError;
  } finally {
    context.terminalProgress?.finish();
  }
  const statusLabel = result.status === "completed" ? "COMPLETED"
    : result.status === "partial" ? "PARTIAL-INCONCLUSIVE"
      : result.status === "setup-blocker" ? "SETUP-BLOCKED" : "FAILED";
  writeLine(context.io.writeStdout, `Result: ${statusLabel}`);
  writeDetails(context.io.writeStdout, result.details);
  const issueNoun = result.issueCount === 1 ? "issue" : "issues";
  writeLine(
    context.io.writeStdout,
    `Issues: ${String(result.issueCount)} ${issueNoun}; highest severity: ${result.highestSeverity ?? "none"}`,
  );
  if (result.reportPath !== null) {
    const bundleDirectory = dirname(result.reportPath);
    writeLine(context.io.writeStdout, `Open report: ${join(bundleDirectory, "report.html")}`, 1_024);
  }
  if (result.status === "failed") return EXIT_CODES.executionError;
  if (result.status === "partial" || result.status === "setup-blocker") return EXIT_CODES.inconclusive;
  return result.issueCount > 0 ? EXIT_CODES.environmentFailure : EXIT_CODES.success;
}

async function runTest(
  argumentsAfterCommand: readonly string[],
  context: CliContext,
): Promise<number> {
  if (argumentsAfterCommand.length === 1
    && (argumentsAfterCommand[0] === "--help" || argumentsAfterCommand[0] === "-h")) {
    writeBlock(context.io.writeStdout, TEST_HELP_TEXT);
    return EXIT_CODES.success;
  }
  if (argumentsAfterCommand.includes("--apk")) {
    return await runAndroidTest(argumentsAfterCommand, context);
  }
  const request = parseTestArguments(argumentsAfterCommand);
  if (typeof request === "string") return usageError(context, request);
  return await runWebTestRequest(request, context);
}

async function runScan(
  argumentsAfterCommand: readonly string[],
  context: CliContext,
): Promise<number> {
  if (argumentsAfterCommand.length === 1
    && (argumentsAfterCommand[0] === "--help" || argumentsAfterCommand[0] === "-h")) {
    writeBlock(context.io.writeStdout, SCAN_HELP_TEXT);
    return EXIT_CODES.success;
  }
  if (argumentsAfterCommand.includes("--pack")) {
    return usageError(context, "scan is navigation-only; use tvdoctor test --pack NAME for diagnostic packs");
  }
  if (argumentsAfterCommand.includes("--apk")) {
    return usageError(context, "scan accepts web URLs; use tvdoctor test --apk PATH for Android TV");
  }
  const modeIndex = argumentsAfterCommand.indexOf("--mode");
  const scanArguments = modeIndex >= 0
    ? argumentsAfterCommand
    : [...argumentsAfterCommand, "--mode", "standard"];
  const request = parseTestArguments(scanArguments, false, true);
  if (typeof request === "string") return usageError(context, request);
  writeLine(context.io.writeStdout, "Phase: SCAN");
  return await runWebTestRequest({ ...request, disableRepetitionCompression: true }, context);
}

async function runAccessibility(
  argumentsAfterCommand: readonly string[],
  context: CliContext,
): Promise<number> {
  if (argumentsAfterCommand.length === 1
    && (argumentsAfterCommand[0] === "--help" || argumentsAfterCommand[0] === "-h")) {
    writeBlock(context.io.writeStdout, ACCESSIBILITY_HELP_TEXT);
    return EXIT_CODES.success;
  }
  if (argumentsAfterCommand.includes("--pack")) {
    return usageError(context, "accessibility selects its packs automatically; remove --pack");
  }
  if (argumentsAfterCommand.includes("--apk")) {
    return usageError(context, "accessibility currently accepts web URLs; Android hardware proof is not yet available");
  }
  const request = parseTestArguments([
    ...argumentsAfterCommand,
    "--pack",
    "streaming",
    "--pack",
    "accessibility",
  ]);
  if (typeof request === "string") return usageError(context, request);
  return await runWebTestRequest(request, context);
}

async function runCi(
  argumentsAfterCommand: readonly string[],
  context: CliContext,
): Promise<number> {
  if (argumentsAfterCommand.length === 1
    && (argumentsAfterCommand[0] === "--help" || argumentsAfterCommand[0] === "-h")) {
    writeBlock(context.io.writeStdout, CI_HELP_TEXT);
    return EXIT_CODES.success;
  }
  if (argumentsAfterCommand.includes("--apk")) {
    return usageError(context, "ci currently accepts web URLs; use tvdoctor test for Android APKs");
  }
  const request = parseTestArguments(argumentsAfterCommand, true, true);
  if (typeof request === "string") return usageError(context, request);
  return await runWebTestRequest(request, context);
}

async function runWebTestRequest(
  request: TestCommandRequest,
  context: CliContext,
): Promise<number> {
  if (context.operations?.testTarget === undefined) {
    writeLine(context.io.writeStderr, "Web audit is unavailable in this CLI host.");
    return EXIT_CODES.executionError;
  }
  if (!await ensureWebRuntime(context)) return EXIT_CODES.environmentFailure;
  writeLine(context.io.writeStdout, `Target: ${safeDisplayUrl(request.target)}`);
  writeLine(context.io.writeStdout, "Status: RUNNING");
  writeLine(context.io.writeStdout, `Auditing ${safeDisplayUrl(request.target)}...`);
  writeLine(
    context.io.writeStdout,
    `Plan: ${request.mode} mode; ${
      request.packs.length === 1 && request.packs[0] === "navigation"
        ? "remote navigation"
        : `packs ${request.packs.join(", ")}`
    }; startup preparation ${
      request.startupActions === undefined ? "observation-only" : "explicit remote sequence"
    }; bounded resets and replays can take several minutes.`,
  );
  let result: TestCommandResult;
  const { baselinePath, ...auditRequest } = request;
  const progressStartedAt = Date.now();
  const interactive = context.terminalProgress?.isInteractive === true;
  const progressTimer = setInterval(() => {
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - progressStartedAt) / 1_000));
    const message = `${safeDisplayUrl(request.target)} | ${request.mode} scan | elapsed ${elapsedSeconds}s`;
    if (interactive) context.terminalProgress?.update(message);
    else writeLine(context.io.writeStdout, `Progress: ${message}; budgets remain enforced.`);
  }, interactive ? 1_000 : 30_000);
  progressTimer.unref();
  try {
    const sourceRoot = auditRequest.sourceRoot ?? context.sourceRoot;
    result = await context.operations.testTarget({
      ...auditRequest,
      ...(sourceRoot === undefined ? {} : { sourceRoot }),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
  } catch (error) {
    writeLine(context.io.writeStdout, "Status: FAILED");
    writeLine(context.io.writeStderr, `Audit failed: ${classifyCliError(error, "audit")}`);
    return EXIT_CODES.executionError;
  } finally {
    clearInterval(progressTimer);
    if (interactive) context.terminalProgress?.finish();
  }
  const statusLabel = result.status === "completed"
    ? "COMPLETED"
    : result.status === "partial"
      ? "PARTIAL-INCONCLUSIVE"
      : "FAILED";
  writeLine(context.io.writeStdout, `Status: ${statusLabel}`);
  writeLine(context.io.writeStdout, `Result: ${statusLabel}`);
  writeDetails(context.io.writeStdout, result.details);
  const issueNoun = result.issueCount === 1 ? "issue" : "issues";
  writeLine(
    context.io.writeStdout,
    `Issues: ${String(result.issueCount)} ${issueNoun}; highest severity: ${result.highestSeverity ?? "none"}`,
  );
  writeAuditSummary(context.io.writeStdout, result);
  if (result.reportPath !== null) {
    const bundleDirectory = dirname(result.reportPath);
    writeLine(context.io.writeStdout, `Open report: ${join(bundleDirectory, "report.html")}`, 1_024);
    if (request.ciFailOn !== undefined) {
      writeLine(context.io.writeStdout, `CI summary: ${join(bundleDirectory, "exports", "ci-summary.md")}`, 1_024);
      writeLine(context.io.writeStdout, `JUnit: ${join(bundleDirectory, "exports", "junit.xml")}`, 1_024);
    }
  }
  let comparisonResult: BaselineCompareResult | null = null;
  if (baselinePath !== undefined) {
    writeLine(context.io.writeStdout, "Phase: BASELINE COMPARISON");
    writeLine(context.io.writeStdout, "Status: RUNNING");
    if (result.reportPath === null) {
      writeLine(context.io.writeStderr, "Baseline comparison unavailable: the audit did not produce a report.");
      return result.status === "partial" ? EXIT_CODES.inconclusive : EXIT_CODES.executionError;
    }
    if (context.operations?.compareBaseline === undefined) {
      writeLine(context.io.writeStderr, "Baseline comparison is unavailable in this CLI host.");
      return EXIT_CODES.executionError;
    }
    const bundleDirectory = dirname(result.reportPath);
    try {
      comparisonResult = await context.operations.compareBaseline({
        baselinePath,
        reportPath: result.reportPath,
        inventoryPath: join(bundleDirectory, "inventory.json"),
        outputPath: join(bundleDirectory, "baseline-comparison.json"),
      });
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const firstLine = raw.split(/\r?\n/u, 1)[0] ?? "Unknown error";
      writeLine(
        context.io.writeStderr,
        `Baseline comparison failed: ${sanitizeTerminalText(firstLine, { maximumLength: 500 })}`,
      );
      if (request.ciFailOn !== undefined) {
        try {
          await reconcileCiBaselineExports(request.outputPath, result.reportPath, {
            status: "failed-closed", shouldFail: true,
          });
        } catch (exportError) {
          writeLine(context.io.writeStderr, `CI baseline export update failed: ${classifyCliError(exportError, "audit")}`);
        }
      }
      return EXIT_CODES.executionError;
    }
    if (request.ciFailOn !== undefined) {
      try {
        await reconcileCiBaselineExports(request.outputPath, result.reportPath, comparisonResult);
      } catch (exportError) {
        writeLine(context.io.writeStderr, `CI baseline export update failed: ${classifyCliError(exportError, "audit")}`);
        return EXIT_CODES.executionError;
      }
    }
    writeLine(context.io.writeStdout, `Baseline result: ${comparisonResult.status.toUpperCase()}`);
    writeComparisonSummary(context.io.writeStdout, comparisonResult);
    writeLine(
      context.io.writeStdout,
      `${String(comparisonResult.newIssues)} introduced, ${String(comparisonResult.resolvedIssues)} resolved findings.`,
    );
    writeLine(
      context.io.writeStdout,
      `Focus targets: ${String(comparisonResult.addedFocusTargets)} added, ${String(comparisonResult.removedFocusTargets)} removed.`,
    );
    writeLine(
      context.io.writeStdout,
      `Directional transition changes: ${String(comparisonResult.directionalTransitionChanges)}; latency regressions: ${String(comparisonResult.latencyRegressions)}.`,
    );
    for (const blocker of comparisonResult.blockers) {
      writeLine(context.io.writeStdout, `Blocked: ${blocker}`, 1_024);
    }
    writeLine(context.io.writeStdout, `Comparison: ${comparisonResult.outputPath}`, 1_024);
    if (comparisonResult.markdownPath !== undefined) {
      writeLine(context.io.writeStdout, `Readable comparison: ${comparisonResult.markdownPath}`, 1_024);
    }
  }
  if (result.status === "failed") return EXIT_CODES.executionError;
  if (result.status === "partial") {
    writeLine(
      context.io.writeStdout,
      "Next action: Review the partial report, resolve the recorded interruption, and rerun the audit.",
    );
    return EXIT_CODES.inconclusive;
  }
  if (comparisonResult?.shouldFail === true
    || comparisonResult?.status === "regressed"
    || comparisonResult?.status === "failed-closed") return EXIT_CODES.environmentFailure;
  const gatedSeverity = result.highestVerifiedSeverity === undefined
    ? result.highestSeverity
    : result.highestVerifiedSeverity;
  const violatesPolicy = request.ciFailOn === undefined
    ? baselinePath === undefined && result.issueCount > 0
    : gatedSeverity !== null && issueViolatesPolicy(gatedSeverity, request.ciFailOn);
  if (violatesPolicy) {
    if (result.reportPath !== null) {
      writeLine(
        context.io.writeStdout,
        "Next action: Open the report and replay a VERIFIED finding before accepting the run.",
      );
    }
    return EXIT_CODES.environmentFailure;
  }
  if (result.issueCount > 0 && result.reportPath !== null) {
    writeLine(
      context.io.writeStdout,
      "Next action: Open the report and replay a VERIFIED finding before accepting the run.",
    );
  }
  return EXIT_CODES.success;
}

async function runReplay(
  argumentsAfterCommand: readonly string[],
  context: CliContext,
): Promise<number> {
  if (
    argumentsAfterCommand.length === 1 &&
    (argumentsAfterCommand[0] === "--help" || argumentsAfterCommand[0] === "-h")
  ) {
    writeBlock(context.io.writeStdout, REPLAY_HELP_TEXT);
    return EXIT_CODES.success;
  }

  const request = parseReplayArguments(argumentsAfterCommand);
  if (typeof request === "string") return usageError(context, request);
  if (context.operations === undefined) {
    writeLine(context.io.writeStderr, "Replay is unavailable in this CLI host.");
    return EXIT_CODES.replayError;
  }

  writeLine(context.io.writeStdout, "Phase: REPLAY");
  writeLine(context.io.writeStdout, "Status: RUNNING");
  writeLine(context.io.writeStdout, `Replaying ${request.issueId}...`);
  let result: ReplayCommandResult;
  try {
    result = await context.operations.replayIssue({
      ...request,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
  } catch (error) {
    writeLine(context.io.writeStdout, "Status: ERROR");
    writeLine(context.io.writeStderr, `Replay failed: ${classifyCliError(error, "replay")}`);
    return EXIT_CODES.replayError;
  }

  writeDetails(context.io.writeStdout, result.details);
  writeLine(context.io.writeStdout, `Status: ${result.status.toUpperCase()}`);
  writeLine(context.io.writeStdout, `Report: ${request.reportPath}`, 1_024);
  switch (result.status) {
    case "fixed":
      writeLine(context.io.writeStdout, `${request.issueId} FIXED`);
      writeLine(context.io.writeStdout, "Next action: Review the report evidence before closing the finding.");
      return EXIT_CODES.success;
    case "reproduced":
      writeLine(context.io.writeStdout, "Issue reproduced.");
      writeLine(context.io.writeStdout, "Next action: Open the report and fix the reproduced finding, then rerun replay.");
      return EXIT_CODES.environmentFailure;
    case "inconclusive":
      writeLine(context.io.writeStdout, "Replay inconclusive.");
      writeLine(context.io.writeStdout, "Next action: Review the report and replay details, resolve the blocker, then retry.");
      return EXIT_CODES.replayInconclusive;
    case "error":
      writeLine(context.io.writeStdout, "Next action: Review the report and replay details before retrying.");
      writeLine(context.io.writeStderr, "Replay failed.");
      return EXIT_CODES.replayError;
  }
}

async function runDemo(
  argumentsAfterCommand: readonly string[],
  context: CliContext,
): Promise<number> {
  if (argumentsAfterCommand.length === 1
    && (argumentsAfterCommand[0] === "--help" || argumentsAfterCommand[0] === "-h")) {
    writeBlock(context.io.writeStdout, DEMO_HELP_TEXT);
    return EXIT_CODES.success;
  }
  let outputPath = defaultOutputDirectory({
    target: "northstar-demo",
    mode: "quick",
    platform: "web",
  });
  for (let index = 0; index < argumentsAfterCommand.length; index += 1) {
    const argument = argumentsAfterCommand[index];
    if (argument !== "--output") {
      return usageError(context, `unknown demo option: ${argument ?? ""}`);
    }
    const value = argumentsAfterCommand[index + 1];
    if (value === undefined || value.startsWith("--") || value.trim().length === 0 || value.length > 1_024) {
      return usageError(context, "--output requires a bounded non-empty path");
    }
    outputPath = value;
    index += 1;
  }
  if (context.operations?.runDemo === undefined) {
    writeLine(context.io.writeStderr, "The deterministic demo is unavailable in this CLI host.");
    return EXIT_CODES.executionError;
  }
  writeLine(context.io.writeStdout, "Phase: DEMO");
  if (!await ensureWebRuntime(context)) return EXIT_CODES.environmentFailure;
  writeLine(context.io.writeStdout, "Status: RUNNING");
  writeLine(context.io.writeStdout, "Running the packaged Northstar D-pad demo...");
  writeLine(
    context.io.writeStdout,
    "This is a controlled seeded fixture: it proves the installed audit/report/replay path, not production-app accuracy.",
  );
  let result: DemoCommandResult;
  try {
    result = await context.operations.runDemo({
      outputPath,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
  } catch (error) {
    writeLine(context.io.writeStdout, "Status: FAILED");
    writeLine(context.io.writeStderr, `Demo failed: ${classifyCliError(error, "audit")}`);
    return EXIT_CODES.executionError;
  }
  writeDetails(context.io.writeStdout, result.details);
  if (result.status === "inconclusive") {
    writeLine(context.io.writeStdout, "Status: INCONCLUSIVE");
    if (result.reportPath !== null) {
      writeLine(context.io.writeStdout, `Review partial report: ${join(dirname(result.reportPath), "report.html")}`, 1_024);
    }
    writeLine(context.io.writeStdout, "Demo INCONCLUSIVE: the controlled audit or replay did not complete.");
    return EXIT_CODES.inconclusive;
  }
  if (result.status !== "verified"
    || result.issueId === null
    || result.reportPath === null
    || result.replayStatus !== "reproduced") {
    writeLine(context.io.writeStdout, "Status: FAILED");
    if (result.reportPath !== null) {
      writeLine(context.io.writeStdout, `Review report: ${join(dirname(result.reportPath), "report.html")}`, 1_024);
    }
    writeLine(context.io.writeStderr, "Demo could not verify its seeded navigation failure and replay proof.");
    return EXIT_CODES.executionError;
  }
  writeLine(context.io.writeStdout, "Status: VERIFIED");
  writeAuditSummary(context.io.writeStdout, {
    details: result.details,
    issueCount: 1,
    reportPath: result.reportPath,
  });
  writeLine(context.io.writeStdout, "Demo VERIFIED: the seeded D-pad failure was found with deterministic evidence.");
  writeLine(context.io.writeStdout, `Issue: ${result.issueId}`);
  writeLine(context.io.writeStdout, "Replay: REPRODUCED");
  writeLine(
    context.io.writeStdout,
    `Replay command: tvdoctor replay ${result.issueId} --report "${result.reportPath}"`,
    2_048,
  );
  writeLine(
    context.io.writeStdout,
    `Next action: tvdoctor replay ${result.issueId} --report "${result.reportPath}"`,
    2_048,
  );
  const htmlReport = join(dirname(result.reportPath), "report.html");
  writeLine(context.io.writeStdout, `Open report: ${htmlReport}`, 1_024);
  if (context.terminalProgress?.isInteractive === true && context.reportActions !== undefined) {
    let opened: boolean;
    try {
      opened = await context.reportActions.openReport(htmlReport);
    } catch {
      opened = false;
    }
    writeLine(
      context.io.writeStdout,
      opened ? `Opened report: ${htmlReport}` : `Could not open the report automatically: ${htmlReport}`,
      1_024,
    );
  }
  return EXIT_CODES.success;
}

async function runDoctor(
  argumentsAfterCommand: readonly string[],
  context: CliContext,
): Promise<number> {
  if (
    argumentsAfterCommand.length === 1 &&
    (argumentsAfterCommand[0] === "--help" ||
      argumentsAfterCommand[0] === "-h")
  ) {
    writeBlock(context.io.writeStdout, DOCTOR_HELP_TEXT);
    return EXIT_CODES.success;
  }

  if (argumentsAfterCommand.length > 0) {
    return usageError(
      context,
      `doctor does not accept arguments: ${argumentsAfterCommand.join(" ")}`,
    );
  }

  let browser: DiagnosticCheck = {
    status: "unavailable",
    detail: "Browser runtime probe is unavailable in this host",
  };
  if (context.runtimeProbe !== undefined) {
    try {
      const probe = await context.runtimeProbe();
      browser = {
        status: "ok",
        detail: `Chromium launched (${probe.capabilities.length === 0 ? "no capabilities reported" : probe.capabilities.join(", ")})`,
      };
    } catch (error) {
      browser = {
        status: "unavailable",
        detail: classifyCliError(error, "doctor"),
      };
    }
  }
  let adb: DiagnosticCheck = {
    status: "unavailable",
    detail: "Android platform-tools (ADB) were not probed.",
  };
  let buildTools: DiagnosticCheck = {
    status: "unavailable",
    detail: "Android SDK build-tools (aapt2/aapt) were not probed.",
  };
  let device: DiagnosticCheck = {
    status: "unavailable",
    detail: "No authorized Android TV device was found.",
  };
  let observer: DiagnosticCheck = {
    status: "unavailable",
    detail: "No authorized Android TV device is available to inspect Observer accessibility readiness.",
  };
  let androidAdbPath: string | null = null;
  let compatibleAndroidDevices: AndroidPreflightResult["devices"] = [];

  if (context.operations?.androidBuildToolsPreflight !== undefined) {
    try {
      const result = await context.operations.androidBuildToolsPreflight();
      buildTools = result.available
        ? { status: "ok", detail: result.detail }
        : {
            status: "unavailable",
            detail: `${result.detail} Install Android SDK build-tools (aapt2/aapt) to inspect APKs.`,
          };
    } catch (error) {
      buildTools = { status: "unavailable", detail: classifyCliError(error, "doctor") };
    }
  }

  if (context.operations?.androidPreflight !== undefined) {
    try {
      const result = await context.operations.androidPreflight();
      if (!result.available || result.adbPath === null) {
        adb = {
          status: "unavailable",
          detail: `${result.message} Install Android SDK platform-tools and add adb to PATH or set ANDROID_SDK_ROOT.`,
        };
      } else {
        adb = { status: "ok", detail: `ADB is available at ${result.adbPath}.` };
        androidAdbPath = result.adbPath;
        const online = result.devices.filter((candidate) => candidate.online);
        const tvDevices = online.filter((candidate) => candidate.isTelevision === true);
        const compatible = tvDevices.filter((candidate) => candidate.apiLevel !== null && candidate.apiLevel >= 23);
        compatibleAndroidDevices = compatible;
        const chosen = compatible[0];
        if (chosen !== undefined) {
          const manufacturer = chosen.manufacturer ?? "Android";
          const model = chosen.model ?? "TV device";
          device = {
            status: "ok",
            detail: `${manufacturer} ${model}; API ${String(chosen.apiLevel)}; ${chosen.serial}`,
          };
        } else if (online.length === 0) {
          const blocked = result.devices.find((candidate) => candidate.detail !== null);
          device = {
            status: "unavailable",
            detail: blocked?.detail
              ?? "No authorized Android TV device is online. Connect or start one and accept ADB authorization.",
          };
        } else if (tvDevices.length === 0) {
          device = {
            status: "unsupported",
            detail: "Connected authorized Android devices are not identified as television devices.",
          };
        } else {
          const api = tvDevices.map((candidate) => candidate.apiLevel).filter((value): value is number => value !== null)[0];
          device = {
            status: "unsupported",
            detail: `Android TV API ${api === undefined ? "unknown" : String(api)} is unsupported; TVDoctor Observer requires API 23 or newer.`,
          };
        }
      }
    } catch (error) {
      adb = { status: "unavailable", detail: classifyCliError(error, "doctor") };
    }
  }

  if (androidAdbPath !== null
    && compatibleAndroidDevices.length > 0
    && context.operations?.androidObserverPreflight !== undefined) {
    let firstObserverResult: DiagnosticCheck | null = null;
    for (const candidate of compatibleAndroidDevices) {
      let candidateObserver: DiagnosticCheck;
      try {
        candidateObserver = await context.operations.androidObserverPreflight(androidAdbPath, candidate.serial);
      } catch (error) {
        candidateObserver = { status: "unavailable", detail: classifyCliError(error, "doctor") };
      }
      firstObserverResult ??= candidateObserver;
      if (candidateObserver.status !== "ok") continue;

      const manufacturer = candidate.manufacturer ?? "Android";
      const model = candidate.model ?? "TV device";
      device = {
        status: "ok",
        detail: `${manufacturer} ${model}; API ${String(candidate.apiLevel)}; ${candidate.serial}`,
      };
      observer = candidateObserver;
      break;
    }
    if (observer.status !== "ok" && firstObserverResult !== null) observer = firstObserverResult;
  }

  const report = diagnoseEnvironment(context.environment, {
    auditOrchestrationAvailable: context.operations?.testTarget !== undefined,
    androidAuditOrchestrationAvailable: context.operations?.scanAndroidApk !== undefined,
    browser,
    android: { adb, buildTools, device, observer },
  });
  writeBlock(context.io.writeStdout, renderDoctorReport(report));

  return doctorSucceeded(report)
    ? EXIT_CODES.success
    : EXIT_CODES.environmentFailure;
}

async function runBaseline(
  argumentsAfterCommand: readonly string[],
  context: CliContext,
): Promise<number> {
  if (argumentsAfterCommand.length === 1
    && (argumentsAfterCommand[0] === "--help" || argumentsAfterCommand[0] === "-h")) {
    writeBlock(context.io.writeStdout, BASELINE_HELP_TEXT);
    return EXIT_CODES.success;
  }
  const request = parseBaselineArguments(argumentsAfterCommand);
  if (typeof request === "string") return usageError(context, request);
  try {
    if (request.action === "create") {
      if (context.operations?.createBaseline === undefined) {
        writeLine(context.io.writeStderr, "Baseline creation is unavailable in this CLI host.");
        return EXIT_CODES.executionError;
      }
      const result = await context.operations.createBaseline({
        reportPath: request.reportPath,
        inventoryPath: request.inventoryPath,
        outputPath: request.outputPath,
      });
      writeLine(context.io.writeStdout, `Baseline created from ${String(result.issueCount)} findings.`);
      writeLine(context.io.writeStdout, `Baseline: ${result.outputPath}`, 1_024);
      return EXIT_CODES.success;
    }
    if (context.operations?.compareBaseline === undefined) {
      writeLine(context.io.writeStderr, "Baseline comparison is unavailable in this CLI host.");
      return EXIT_CODES.executionError;
    }
    writeLine(context.io.writeStdout, "Phase: BASELINE COMPARISON");
    writeLine(context.io.writeStdout, "Status: RUNNING");
    const result = await context.operations.compareBaseline({
      baselinePath: request.baselinePath,
      reportPath: request.reportPath,
      inventoryPath: request.inventoryPath,
      outputPath: request.outputPath,
    });
    writeLine(context.io.writeStdout, `Baseline result: ${result.status.toUpperCase()}`);
    writeComparisonSummary(context.io.writeStdout, result);
    writeLine(
      context.io.writeStdout,
      `${String(result.newIssues)} new, ${String(result.resolvedIssues)} resolved, ${String(result.unchangedIssues)} unchanged findings.`,
    );
    if (result.structuralRegressions > 0) {
      writeLine(context.io.writeStdout, `${String(result.structuralRegressions)} structural or latency regressions.`);
    }
    for (const blocker of result.blockers) writeLine(context.io.writeStdout, `Blocked: ${blocker}`, 1_024);
    writeLine(context.io.writeStdout, `Comparison: ${result.outputPath}`, 1_024);
    if (result.markdownPath !== undefined) {
      writeLine(context.io.writeStdout, `Readable comparison: ${result.markdownPath}`, 1_024);
    }
    return result.shouldFail ? EXIT_CODES.environmentFailure : EXIT_CODES.success;
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const firstLine = raw.split(/\r?\n/u, 1)[0] ?? "Unknown error";
    writeLine(
      context.io.writeStderr,
      `Baseline failed: ${sanitizeTerminalText(firstLine, { maximumLength: 500 })}`,
    );
    return EXIT_CODES.executionError;
  }
}

async function runSetup(
  argumentsAfterCommand: readonly string[],
  context: CliContext,
): Promise<number> {
  if (
    argumentsAfterCommand.length === 1
    && (argumentsAfterCommand[0] === "--help" || argumentsAfterCommand[0] === "-h")
  ) {
    writeBlock(context.io.writeStdout, SETUP_HELP_TEXT);
    return EXIT_CODES.success;
  }
  if (argumentsAfterCommand.length > 0) {
    return usageError(context, `setup does not accept arguments: ${argumentsAfterCommand.join(" ")}`);
  }
  if (context.runtimeSetup === undefined || context.runtimeProbe === undefined) {
    writeLine(context.io.writeStderr, "Chromium setup is unavailable in this CLI host.");
    return EXIT_CODES.executionError;
  }
  writeLine(context.io.writeStdout, "Phase: SETUP");
  writeLine(context.io.writeStdout, "Status: INSTALLING");
  writeLine(context.io.writeStdout, "Installing TVDoctor's Chromium runtime...");
  try {
    await context.runtimeSetup(context.signal);
    await context.runtimeProbe();
  } catch (error) {
    writeLine(context.io.writeStdout, "Status: FAILED");
    const raw = error instanceof Error ? error.message : String(error);
    const firstLine = raw.split(/\r?\n/u, 1)[0] ?? "Unknown error";
    writeLine(
      context.io.writeStderr,
      `Chromium setup failed: ${sanitizeTerminalText(firstLine, { maximumLength: 240 })}`,
    );
    return EXIT_CODES.executionError;
  }
  writeLine(context.io.writeStdout, "Status: READY");
  writeLine(context.io.writeStdout, "Chromium is installed and ready for TVDoctor.");
  return EXIT_CODES.success;
}

async function runStart(
  argumentsAfterCommand: readonly string[],
  context: CliContext,
): Promise<number> {
  if (argumentsAfterCommand.length === 1
    && (argumentsAfterCommand[0] === "--help" || argumentsAfterCommand[0] === "-h")) {
    writeBlock(context.io.writeStdout, START_HELP_TEXT);
    return EXIT_CODES.success;
  }
  if (argumentsAfterCommand.length > 0) {
    return usageError(context, "start does not accept arguments; use tvdoctor test for scripted runs.");
  }
  return await runGuidedStart(context);
}

export async function runCli(
  arguments_: readonly string[],
  context: CliContext,
): Promise<number> {
  const [command, ...argumentsAfterCommand] = arguments_;

  if (arguments_.length > 128
    || arguments_.some((argument) => !isSafeTerminalArgument(argument))) {
    return usageError(
      context,
      "arguments must be bounded and must not contain terminal control or bidirectional formatting characters",
    );
  }

  if (
    command === undefined ||
    command === "--help" ||
    command === "-h"
  ) {
    writeBlock(context.io.writeStdout, HELP_TEXT);
    return EXIT_CODES.success;
  }

  if (command === "help") {
    if (argumentsAfterCommand.length === 0) {
      writeBlock(context.io.writeStdout, HELP_TEXT);
      return EXIT_CODES.success;
    }

    if (
      argumentsAfterCommand.length === 1 &&
      (argumentsAfterCommand[0] === "demo" ||
        argumentsAfterCommand[0] === "test" ||
        argumentsAfterCommand[0] === "scan" ||
        argumentsAfterCommand[0] === "start" ||
        argumentsAfterCommand[0] === "accessibility" ||
        argumentsAfterCommand[0] === "doctor" ||
        argumentsAfterCommand[0] === "ci" ||
        argumentsAfterCommand[0] === "baseline" ||
        argumentsAfterCommand[0] === "privacy" ||
        argumentsAfterCommand[0] === "setup" ||
        argumentsAfterCommand[0] === "replay")
    ) {
      writeBlock(
        context.io.writeStdout,
        argumentsAfterCommand[0] === "demo"
          ? DEMO_HELP_TEXT
          : argumentsAfterCommand[0] === "scan"
            ? SCAN_HELP_TEXT
            : argumentsAfterCommand[0] === "test"
          ? TEST_HELP_TEXT
          : argumentsAfterCommand[0] === "start"
            ? START_HELP_TEXT
          : argumentsAfterCommand[0] === "accessibility"
            ? ACCESSIBILITY_HELP_TEXT
          : argumentsAfterCommand[0] === "ci"
            ? CI_HELP_TEXT
          : argumentsAfterCommand[0] === "baseline"
              ? BASELINE_HELP_TEXT
          : argumentsAfterCommand[0] === "privacy"
            ? PRIVACY_HELP_TEXT
          : argumentsAfterCommand[0] === "doctor"
            ? DOCTOR_HELP_TEXT
            : argumentsAfterCommand[0] === "setup"
              ? SETUP_HELP_TEXT
            : REPLAY_HELP_TEXT,
      );
      return EXIT_CODES.success;
    }

    return usageError(
      context,
      `no help is available for: ${argumentsAfterCommand.join(" ")}`,
    );
  }

  if (command === "doctor") {
    return await runDoctor(argumentsAfterCommand, context);
  }

  if (command === "setup") {
    return await runSetup(argumentsAfterCommand, context);
  }

  if (command === "start") {
    return await runStart(argumentsAfterCommand, context);
  }

  if (command === "test") {
    return await runTest(argumentsAfterCommand, context);
  }

  if (command === "demo") {
    return await runDemo(argumentsAfterCommand, context);
  }

  if (command === "scan") {
    return await runScan(argumentsAfterCommand, context);
  }

  if (command === "accessibility") {
    return await runAccessibility(argumentsAfterCommand, context);
  }

  if (command === "ci") {
    return await runCi(argumentsAfterCommand, context);
  }

  if (command === "replay") {
    return await runReplay(argumentsAfterCommand, context);
  }

  if (command === "baseline") {
    return await runBaseline(argumentsAfterCommand, context);
  }

  if (command === "privacy") {
    if (argumentsAfterCommand.length > 0) {
      return usageError(context, "privacy does not accept arguments");
    }
    writeBlock(context.io.writeStdout, PRIVACY_TEXT.trimEnd());
    return EXIT_CODES.success;
  }

  if ((command === "version" || command === "--version" || command === "-V")
    && argumentsAfterCommand.length === 0) {
    writeLine(context.io.writeStdout, `tvdoctor ${CLI_VERSION}`);
    return EXIT_CODES.success;
  }

  return usageError(context, `unknown command: ${command}`);
}
