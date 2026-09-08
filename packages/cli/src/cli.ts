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
import type { StartTerminal } from "./interactive.js";
import { runGuidedStart } from "./start.js";
import type {
  AndroidPreflightResult,
  AndroidScanResult,
  AndroidScanOptions,
  ApkMetadata,
} from "./android-product.js";
import { CLI_VERSION } from "./version.js";
import { REMOTE_KEYS, type RemoteKey } from "@tvdoctor/protocol";
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
  readonly packs: readonly TestPackName[];
  readonly mode: TestRunMode;
  readonly outputPath: string;
  readonly searchQuery: string;
  readonly startupActions?: readonly RemoteKey[];
  readonly startupDecision?: "reject" | "accept";
  readonly maxDurationMs?: number;
  readonly ciFailOn?: CiFailureThreshold;
  readonly journeyPath?: string;
  readonly signal?: AbortSignal;
}

export interface TestCommandResult {
  readonly status: "completed" | "partial" | "failed";
  readonly issueCount: number;
  readonly highestSeverity: "critical" | "high" | "medium" | "low" | "info" | null;
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
  readonly blockers: readonly string[];
  readonly outputPath: string;
}

export interface CliOperations {
  replayIssue(request: ReplayCommandRequest): Promise<ReplayCommandResult>;
  testTarget?(request: TestCommandRequest): Promise<TestCommandResult>;
  detectWebsiteStartup?(target: string): Promise<WebsiteStartupDetection>;
  androidPreflight?(): Promise<AndroidPreflightResult>;
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

export const HELP_TEXT = `TVDoctor — automated QA for TV apps

Usage:
  tvdoctor start
  tvdoctor test URL [--pack NAME] [--mode MODE] [--output PATH] [--query TEXT]
  tvdoctor test URL [--startup-actions KEY[,KEY...]] [--max-duration-ms N]
  tvdoctor test URL [--journey PATH]
  tvdoctor accessibility URL [--mode MODE] [--output PATH] [--journey PATH]
  tvdoctor test --apk PATH --device SERIAL [--mode quick|deep] [--output PATH]
  tvdoctor ci URL --fail-on LEVEL [test options]
  tvdoctor baseline create --report PATH [--inventory PATH] [--output PATH]
  tvdoctor baseline compare --baseline PATH --report PATH [--inventory PATH] [--output PATH]
  tvdoctor setup
  tvdoctor doctor
  tvdoctor replay ISSUE_ID [--report PATH] [--target URL]
  tvdoctor version
  tvdoctor --version
  tvdoctor help
  tvdoctor --help

Commands:
  start     Open the guided product flow.
  test      Run a bounded local audit and write a report bundle.
  accessibility
            Run the focused web accessibility and caption profile.
  ci        Run an audit with an explicit failure policy and CI exports.
  baseline  Create or compare a semantic regression baseline.
  setup     Install the Chromium runtime matched to this TVDoctor version.
  doctor    Diagnose the installed runtime and browser environment.
  replay    Re-run one deterministic issue from a V1 report.
  version   Print the installed TVDoctor version.
  help      Show this help.

Exit codes:
  0  Command completed successfully; no audit issues were found.
  1  Audit issues were found, or doctor found an unavailable requirement.
  2  Command usage is invalid.
  3  The result is partial or inconclusive.
  4  Execution failed before a trustworthy result was produced.`;

export const TEST_HELP_TEXT = `Usage:
  tvdoctor test URL [options]
  tvdoctor test --apk PATH --device SERIAL [--mode quick|deep] [--output PATH]

Run a local bounded audit against an absolute HTTP(S) URL.

Options:
  --pack NAME    all, navigation, streaming, search, settings, accessibility,
                 layout, performance, or crashes. Repeat to select multiple packs.
                 Defaults to all.
  --mode MODE    quick or deep. The advanced standard alias remains accepted.
  --output PATH  Report bundle directory. Defaults under Tests with a readable name.
  --query TEXT   Non-sensitive search query. Defaults to N.
  --startup-actions KEY[,KEY...]
                 Explicit caller-selected remote keys used only to prepare a
                 detected startup setup screen. Defaults to observation-only.
  --max-duration-ms N
                 Navigation safety-ceiling override for advanced/CI runs.
  --journey PATH  Safe custom web journey; secret values come only from
                 TVDOCTOR_JOURNEY_* environment variables.

Android CI options:
  --apk PATH      Local APK to install and test without prompts.
  --device SERIAL Explicit authorized emulator/device serial.
  --adb PATH      Optional explicit adb executable path.
  --mode MODE     quick or deep. Defaults to quick.
  --output PATH   Report bundle directory.`;

export const CI_HELP_TEXT = `Usage:
  tvdoctor ci URL --fail-on LEVEL [test options]

Run the same bounded web audit as tvdoctor test and write exports/ci-summary.md
plus exports/junit.xml. LEVEL is any, critical, high, medium, low, info, or never.
A partial or failed audit remains non-successful regardless of the finding policy.`;

export const BASELINE_HELP_TEXT = `Usage:
  tvdoctor baseline create --report PATH [--inventory PATH] [--output PATH]
  tvdoctor baseline compare --baseline PATH --report PATH [--inventory PATH] [--output PATH]

Create a reviewed semantic baseline from a complete report, or compare a current
complete report with it. Inventory defaults to inventory.json beside the report.`;

export const DOCTOR_HELP_TEXT = `Usage: tvdoctor doctor

Report the local Node.js and host environment together with the capabilities
that are actually available in this installed CLI.`;

export const SETUP_HELP_TEXT = `Usage: tvdoctor setup

Install the Chromium browser build matched to this TVDoctor version, then verify
that TVDoctor can launch it. The browser is stored in Playwright's user cache.`;

export const REPLAY_HELP_TEXT = `Usage: tvdoctor replay ISSUE_ID [--report PATH] [--target URL]

Replay one deterministic issue stored in a tvdoctor.report/v1 report. PATH
defaults to tvdoctor-report/report.json. --target overrides the recorded web URL.
For Android reports, pass --apk PATH --device SERIAL and optionally --adb PATH.
For a journey-prepared web report, pass the same --journey PATH.`;

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
    return "Chromium is unavailable. Run \"npx playwright install chromium\" and try again.";
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
): TestCommandRequest | string {
  let target: string | undefined;
  const packs: TestPackName[] = [];
  let mode: TestRunMode = "standard";
  let explicitOutputPath: string | undefined;
  let searchQuery = "N";
  let startupActions: RemoteKey[] | undefined;
  let maxDurationMs: number | undefined;
  let ciFailOn: CiFailureThreshold | undefined;
  let journeyPath: string | undefined;

  for (let index = 0; index < argumentsAfterCommand.length; index += 1) {
    const argument = argumentsAfterCommand[index];
    if (argument === undefined) continue;
    const options = ["--pack", "--mode", "--output", "--query", "--startup-actions", "--max-duration-ms", "--journey"];
    if (ciMode) options.push("--fail-on");
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
        if (requested.some((key) => !REMOTE_KEY_SET.has(key))) return "--startup-actions accepts only known remote keys";
        if (new Set(requested).size !== requested.length) return "--startup-actions must not contain duplicate remote keys";
        startupActions = requested as RemoteKey[];
      } else if (argument === "--max-duration-ms") {
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
          return "--max-duration-ms must be a positive safe integer no greater than 2147483647";
        }
        maxDurationMs = parsed;
      } else if (argument === "--fail-on") {
        if (!(CI_FAILURE_THRESHOLDS as readonly string[]).includes(value)) {
          return "--fail-on must be any, critical, high, medium, low, info, or never";
        }
        ciFailOn = value as CiFailureThreshold;
      } else if (argument === "--journey") {
        journeyPath = value;
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
  const selected = packs.length === 0 ? ["all" as const] : [...new Set(packs)];
  if (selected.includes("all") && selected.length > 1) return "--pack all cannot be combined with another pack";
  return {
    target: parsedTarget,
    packs: selected,
    mode,
    outputPath: explicitOutputPath ?? defaultOutputDirectory({ target: parsedTarget, mode }),
    searchQuery,
    ...(startupActions === undefined ? {} : { startupActions }),
    ...(maxDurationMs === undefined ? {} : { maxDurationMs }),
    ...(ciFailOn === undefined ? {} : { ciFailOn }),
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
  readonly serial: string;
  readonly adbPath?: string;
  readonly mode: "quick" | "deep";
  readonly outputPath: string;
}

function parseAndroidTestArguments(argumentsAfterCommand: readonly string[]): AndroidTestCommandRequest | string {
  let apkPath: string | undefined;
  let serial: string | undefined;
  let adbPath: string | undefined;
  let mode: "quick" | "deep" = "quick";
  let outputPath: string | undefined;
  for (let index = 0; index < argumentsAfterCommand.length; index += 1) {
    const argument = argumentsAfterCommand[index];
    if (argument === undefined) continue;
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
  if (serial === undefined) return "Android test requires --device SERIAL for deterministic CI selection";
  if (!/^[A-Za-z0-9._:-]{1,256}$/u.test(serial)) return "--device must be a valid Android serial";
  return {
    apkPath,
    serial,
    mode,
    outputPath: outputPath ?? defaultOutputDirectory({
      target: basename(apkPath, ".apk"),
      mode,
      platform: "android-tv",
    }),
    ...(adbPath === undefined ? {} : { adbPath }),
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
  writeLine(context.io.writeStdout, `Auditing Android APK ${basename(request.apkPath)} on ${request.serial}...`);
  writeLine(context.io.writeStdout, `Plan: ${request.mode} mode; no prompts; observer setup must already be authorized.`);
  let result: AndroidScanResult;
  try {
    result = await context.operations.scanAndroidApk({
      apkPath: request.apkPath,
      serial: request.serial,
      mode: request.mode,
      outputPath: request.outputPath,
      ...(request.adbPath === undefined ? {} : { adbPath: request.adbPath }),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
      ...(context.terminalProgress?.isInteractive === true
        ? {
            onProgress: (progress) => context.terminalProgress?.update(
              `${request.serial} | ${request.mode} Android scan | ${String(progress.actions)} actions | ${String(progress.elapsedSeconds)}s`,
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
  writeLine(context.io.writeStdout, `Issues: ${String(result.issueCount)}; highest severity: ${result.highestSeverity ?? "none"}`);
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
  const request = parseTestArguments(argumentsAfterCommand, true);
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
  writeLine(context.io.writeStdout, `Auditing ${safeDisplayUrl(request.target)}...`);
  writeLine(
    context.io.writeStdout,
    `Plan: ${request.mode} mode; packs ${request.packs.join(", ")}; startup preparation ${
      request.startupActions === undefined ? "observation-only" : "explicit remote sequence"
    }; bounded resets and replays can take several minutes.`,
  );
  let result: TestCommandResult;
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
    result = await context.operations.testTarget({
      ...request,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
  } catch (error) {
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
    if (request.ciFailOn !== undefined) {
      writeLine(context.io.writeStdout, `CI summary: ${join(bundleDirectory, "exports", "ci-summary.md")}`, 1_024);
      writeLine(context.io.writeStdout, `JUnit: ${join(bundleDirectory, "exports", "junit.xml")}`, 1_024);
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
  const violatesPolicy = request.ciFailOn === undefined
    ? result.issueCount > 0
    : request.ciFailOn === "any"
      ? result.issueCount > 0
      : result.highestSeverity !== null
        && issueViolatesPolicy(result.highestSeverity, request.ciFailOn);
  if (violatesPolicy) {
    return EXIT_CODES.environmentFailure;
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

  writeLine(context.io.writeStdout, `Replaying ${request.issueId}...`);
  let result: ReplayCommandResult;
  try {
    result = await context.operations.replayIssue({
      ...request,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
  } catch (error) {
    writeLine(context.io.writeStderr, `Replay failed: ${classifyCliError(error, "replay")}`);
    return EXIT_CODES.replayError;
  }

  writeDetails(context.io.writeStdout, result.details);
  switch (result.status) {
    case "fixed":
      writeLine(context.io.writeStdout, `${request.issueId} FIXED`);
      return EXIT_CODES.success;
    case "reproduced":
      writeLine(context.io.writeStdout, "Issue reproduced.");
      return EXIT_CODES.environmentFailure;
    case "inconclusive":
      writeLine(context.io.writeStdout, "Replay inconclusive.");
      return EXIT_CODES.replayInconclusive;
    case "error":
      writeLine(context.io.writeStderr, "Replay failed.");
      return EXIT_CODES.replayError;
  }
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
  const report = diagnoseEnvironment(context.environment, {
    auditOrchestrationAvailable: context.operations?.testTarget !== undefined,
    browser,
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
    const result = await context.operations.compareBaseline({
      baselinePath: request.baselinePath,
      reportPath: request.reportPath,
      inventoryPath: request.inventoryPath,
      outputPath: request.outputPath,
    });
    writeLine(context.io.writeStdout, `Baseline result: ${result.status.toUpperCase()}`);
    writeLine(
      context.io.writeStdout,
      `${String(result.newIssues)} new, ${String(result.resolvedIssues)} resolved, ${String(result.unchangedIssues)} unchanged findings.`,
    );
    if (result.structuralRegressions > 0) {
      writeLine(context.io.writeStdout, `${String(result.structuralRegressions)} structural or latency regressions.`);
    }
    for (const blocker of result.blockers) writeLine(context.io.writeStdout, `Blocked: ${blocker}`, 1_024);
    writeLine(context.io.writeStdout, `Comparison: ${result.outputPath}`, 1_024);
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
  writeLine(context.io.writeStdout, "Installing TVDoctor's Chromium runtime...");
  try {
    await context.runtimeSetup(context.signal);
    await context.runtimeProbe();
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const firstLine = raw.split(/\r?\n/u, 1)[0] ?? "Unknown error";
    writeLine(
      context.io.writeStderr,
      `Chromium setup failed: ${sanitizeTerminalText(firstLine, { maximumLength: 240 })}`,
    );
    return EXIT_CODES.executionError;
  }
  writeLine(context.io.writeStdout, "Chromium is installed and ready for TVDoctor.");
  return EXIT_CODES.success;
}

async function runStart(
  argumentsAfterCommand: readonly string[],
  context: CliContext,
): Promise<number> {
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
      (argumentsAfterCommand[0] === "test" ||
        argumentsAfterCommand[0] === "accessibility" ||
        argumentsAfterCommand[0] === "doctor" ||
        argumentsAfterCommand[0] === "ci" ||
        argumentsAfterCommand[0] === "baseline" ||
        argumentsAfterCommand[0] === "setup" ||
        argumentsAfterCommand[0] === "replay")
    ) {
      writeBlock(
        context.io.writeStdout,
        argumentsAfterCommand[0] === "test"
          ? TEST_HELP_TEXT
          : argumentsAfterCommand[0] === "accessibility"
            ? ACCESSIBILITY_HELP_TEXT
          : argumentsAfterCommand[0] === "ci"
            ? CI_HELP_TEXT
            : argumentsAfterCommand[0] === "baseline"
              ? BASELINE_HELP_TEXT
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

  if ((command === "version" || command === "--version" || command === "-V")
    && argumentsAfterCommand.length === 0) {
    writeLine(context.io.writeStdout, `tvdoctor ${CLI_VERSION}`);
    return EXIT_CODES.success;
  }

  return usageError(context, `unknown command: ${command}`);
}
