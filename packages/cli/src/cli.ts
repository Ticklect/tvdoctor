import { dirname, join } from "node:path";

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

export interface CliOperations {
  replayIssue(request: ReplayCommandRequest): Promise<ReplayCommandResult>;
  testTarget?(request: TestCommandRequest): Promise<TestCommandResult>;
  detectWebsiteStartup?(target: string): Promise<WebsiteStartupDetection>;
  androidPreflight?(): Promise<AndroidPreflightResult>;
  inspectApk?(path: string): Promise<ApkMetadata>;
  scanAndroidApk?(request: AndroidScanOptions): Promise<AndroidScanResult>;
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

export interface CliContext {
  readonly environment: RuntimeEnvironment;
  readonly io: CliIO;
  readonly operations?: CliOperations;
  readonly runtimeProbe?: () => Promise<RuntimeProbeResult>;
  readonly startTerminal?: StartTerminal;
  readonly signal?: AbortSignal;
  readonly terminalProgress?: {
    readonly isInteractive: boolean;
    update(text: string): void;
    finish(): void;
  };
}

export interface RuntimeProbeResult {
  readonly capabilities: readonly string[];
}

export const HELP_TEXT = `TVDoctor — automated QA for TV apps

Usage:
  tvdoctor start
  tvdoctor test URL [--pack NAME] [--mode MODE] [--output PATH] [--query TEXT]
  tvdoctor test URL [--startup-actions KEY[,KEY...]] [--max-duration-ms N]
  tvdoctor doctor
  tvdoctor replay ISSUE_ID [--report PATH] [--target URL]
  tvdoctor version
  tvdoctor --version
  tvdoctor help
  tvdoctor --help

Commands:
  start     Open the guided product flow.
  test      Run a bounded local audit and write a report bundle.
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

export const TEST_HELP_TEXT = `Usage: tvdoctor test URL [options]

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
                 Navigation safety-ceiling override for advanced/CI runs.`;

export const DOCTOR_HELP_TEXT = `Usage: tvdoctor doctor

Report the local Node.js and host environment together with the capabilities
that are actually available in this installed CLI.`;

export const REPLAY_HELP_TEXT = `Usage: tvdoctor replay ISSUE_ID [--report PATH] [--target URL]

Replay one deterministic issue stored in a tvdoctor.report/v1 report. PATH
defaults to tvdoctor-report/report.json. --target overrides the recorded web URL.`;

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

  for (let index = 0; index < argumentsAfterCommand.length; index += 1) {
    const argument = argumentsAfterCommand[index];
    if (argument === undefined) continue;

    if (argument === "--report" || argument === "--target") {
      const value = argumentsAfterCommand[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return `${argument} requires a value`;
      }
      if (argument === "--report") reportPath = value;
      else {
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

  return targetOverride === undefined
    ? { issueId, reportPath }
    : { issueId, reportPath, targetOverride };
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
): TestCommandRequest | string {
  let target: string | undefined;
  const packs: TestPackName[] = [];
  let mode: TestRunMode = "standard";
  let explicitOutputPath: string | undefined;
  let searchQuery = "N";
  let startupActions: RemoteKey[] | undefined;
  let maxDurationMs: number | undefined;

  for (let index = 0; index < argumentsAfterCommand.length; index += 1) {
    const argument = argumentsAfterCommand[index];
    if (argument === undefined) continue;
    if (["--pack", "--mode", "--output", "--query", "--startup-actions", "--max-duration-ms"].includes(argument)) {
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
  };
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
  const request = parseTestArguments(argumentsAfterCommand);
  if (typeof request === "string") return usageError(context, request);
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
    writeLine(context.io.writeStdout, `Bundle directory: ${bundleDirectory}`, 1_024);
    writeLine(context.io.writeStdout, `Human report: ${join(bundleDirectory, "report.html")}`, 1_024);
    writeLine(context.io.writeStdout, `Canonical JSON: ${result.reportPath}`, 1_024);
  }
  if (result.status === "failed") return EXIT_CODES.executionError;
  if (result.status === "partial") {
    writeLine(
      context.io.writeStdout,
      "Next action: Review the partial report, resolve the recorded interruption, and rerun the audit.",
    );
    return EXIT_CODES.inconclusive;
  }
  if (result.issueCount > 0) {
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
        argumentsAfterCommand[0] === "doctor" ||
        argumentsAfterCommand[0] === "replay")
    ) {
      writeBlock(
        context.io.writeStdout,
        argumentsAfterCommand[0] === "test"
          ? TEST_HELP_TEXT
          : argumentsAfterCommand[0] === "doctor"
            ? DOCTOR_HELP_TEXT
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

  if (command === "start") {
    return await runStart(argumentsAfterCommand, context);
  }

  if (command === "test") {
    return await runTest(argumentsAfterCommand, context);
  }

  if (command === "replay") {
    return await runReplay(argumentsAfterCommand, context);
  }

  if ((command === "version" || command === "--version" || command === "-V")
    && argumentsAfterCommand.length === 0) {
    writeLine(context.io.writeStdout, `tvdoctor ${CLI_VERSION}`);
    return EXIT_CODES.success;
  }

  return usageError(context, `unknown command: ${command}`);
}
