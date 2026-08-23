import {
  diagnoseEnvironment,
  doctorSucceeded,
  renderDoctorReport,
  type RuntimeEnvironment,
} from "./diagnostics.js";

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
}

export interface CliIO {
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}

export interface CliContext {
  readonly environment: RuntimeEnvironment;
  readonly io: CliIO;
  readonly operations?: CliOperations;
}

export const HELP_TEXT = `TVDoctor — automated QA for TV apps

Usage:
  tvdoctor test URL [--pack NAME] [--mode MODE] [--output PATH] [--query TEXT]
  tvdoctor doctor
  tvdoctor replay ISSUE_ID [--report PATH] [--target URL]
  tvdoctor help
  tvdoctor --help

Commands:
  test      Run a bounded local audit and write a report bundle.
  doctor    Diagnose the local foundation environment.
  replay    Re-run one deterministic issue from a V1 report.
  help      Show this help.

Status:
  The experimental web driver, bounded explorer, navigation diagnostics,
  semantic packs, report bundle, deterministic web replay, and local web
  audit orchestration are available.`;

export const TEST_HELP_TEXT = `Usage: tvdoctor test URL [options]

Run a local bounded audit against an absolute HTTP(S) URL.

Options:
  --pack NAME    all, navigation, streaming, search, settings, accessibility,
                 layout, performance, or crashes. Repeat to select multiple packs.
                 Defaults to all.
  --mode MODE    quick, standard, or deep. Defaults to standard.
  --output PATH  Report bundle directory. Defaults to tvdoctor-report.
  --query TEXT   Non-sensitive search query. Defaults to N.`;

export const DOCTOR_HELP_TEXT = `Usage: tvdoctor doctor

Report the local Node.js and host environment together with the capabilities
that are actually available in this foundation build.`;

export const REPLAY_HELP_TEXT = `Usage: tvdoctor replay ISSUE_ID [--report PATH] [--target URL]

Replay one deterministic issue stored in a tvdoctor.report/v1 report. PATH
defaults to tvdoctor-report/report.json. --target overrides the recorded web URL.`;

const PORTABLE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const TEST_PACK_SET: ReadonlySet<string> = new Set(TEST_PACK_NAMES);
const TEST_RUN_MODES: ReadonlySet<string> = new Set(["quick", "standard", "deep"]);

function terminalText(value: string, maximumLength = 500): string {
  let printable = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 27) continue;
    printable += codePoint < 32 || (codePoint >= 127 && codePoint <= 159)
      ? " "
      : character;
  }
  return printable.replace(/\s+/gu, " ").trim().slice(0, maximumLength);
}

function writeLine(write: (text: string) => void, text: string): void {
  write(`${text}\n`);
}

function usageError(context: CliContext, message: string): number {
  writeLine(context.io.writeStderr, `Error: ${message}`);
  writeLine(context.io.writeStderr, "Run \"tvdoctor --help\" for usage.");
  return EXIT_CODES.usageError;
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
      else targetOverride = value;
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

function safeTarget(value: string): string | null {
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
  return parsed.href;
}

function parseTestArguments(
  argumentsAfterCommand: readonly string[],
): TestCommandRequest | string {
  let target: string | undefined;
  const packs: TestPackName[] = [];
  let mode: TestRunMode = "standard";
  let outputPath = "tvdoctor-report";
  let searchQuery = "N";

  for (let index = 0; index < argumentsAfterCommand.length; index += 1) {
    const argument = argumentsAfterCommand[index];
    if (argument === undefined) continue;
    if (["--pack", "--mode", "--output", "--query"].includes(argument)) {
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
        outputPath = value;
      } else {
        const safe = terminalText(value, 64);
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
  return { target: parsedTarget, packs: selected, mode, outputPath, searchQuery };
}

async function runTest(
  argumentsAfterCommand: readonly string[],
  context: CliContext,
): Promise<number> {
  if (argumentsAfterCommand.length === 1
    && (argumentsAfterCommand[0] === "--help" || argumentsAfterCommand[0] === "-h")) {
    writeLine(context.io.writeStdout, TEST_HELP_TEXT);
    return EXIT_CODES.success;
  }
  const request = parseTestArguments(argumentsAfterCommand);
  if (typeof request === "string") return usageError(context, request);
  if (context.operations?.testTarget === undefined) {
    writeLine(context.io.writeStderr, "Web audit is unavailable in this CLI host.");
    return EXIT_CODES.executionError;
  }
  writeLine(context.io.writeStdout, `Auditing ${terminalText(request.target)}...`);
  let result: TestCommandResult;
  try {
    result = await context.operations.testTarget(request);
  } catch (error) {
    writeLine(context.io.writeStderr, `Audit failed: ${terminalText(error instanceof Error ? error.message : String(error))}`);
    return EXIT_CODES.executionError;
  }
  for (const detail of result.details) writeLine(context.io.writeStdout, terminalText(detail));
  if (result.reportPath !== null) writeLine(context.io.writeStdout, `Report: ${terminalText(result.reportPath, 1_024)}`);
  if (result.status === "failed") return EXIT_CODES.executionError;
  if (result.status === "partial") return EXIT_CODES.inconclusive;
  if (result.issueCount > 0) {
    writeLine(context.io.writeStdout, `${String(result.issueCount)} issue(s) detected.`);
    return EXIT_CODES.environmentFailure;
  }
  writeLine(context.io.writeStdout, "No issues detected.");
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
    writeLine(context.io.writeStdout, REPLAY_HELP_TEXT);
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
    result = await context.operations.replayIssue(request);
  } catch (error) {
    const message = terminalText(error instanceof Error ? error.message : String(error));
    writeLine(context.io.writeStderr, `Replay failed: ${message}`);
    return EXIT_CODES.replayError;
  }

  for (const detail of result.details) {
    writeLine(context.io.writeStdout, terminalText(detail));
  }
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

function runDoctor(
  argumentsAfterCommand: readonly string[],
  context: CliContext,
): number {
  if (
    argumentsAfterCommand.length === 1 &&
    (argumentsAfterCommand[0] === "--help" ||
      argumentsAfterCommand[0] === "-h")
  ) {
    writeLine(context.io.writeStdout, DOCTOR_HELP_TEXT);
    return EXIT_CODES.success;
  }

  if (argumentsAfterCommand.length > 0) {
    return usageError(
      context,
      `doctor does not accept arguments: ${argumentsAfterCommand.join(" ")}`,
    );
  }

  const report = diagnoseEnvironment(context.environment);
  writeLine(context.io.writeStdout, renderDoctorReport(report));

  return doctorSucceeded(report)
    ? EXIT_CODES.success
    : EXIT_CODES.environmentFailure;
}

export async function runCli(
  arguments_: readonly string[],
  context: CliContext,
): Promise<number> {
  const [command, ...argumentsAfterCommand] = arguments_;

  if (
    command === undefined ||
    command === "--help" ||
    command === "-h"
  ) {
    writeLine(context.io.writeStdout, HELP_TEXT);
    return EXIT_CODES.success;
  }

  if (command === "help") {
    if (argumentsAfterCommand.length === 0) {
      writeLine(context.io.writeStdout, HELP_TEXT);
      return EXIT_CODES.success;
    }

    if (
      argumentsAfterCommand.length === 1 &&
      (argumentsAfterCommand[0] === "test" ||
        argumentsAfterCommand[0] === "doctor" ||
        argumentsAfterCommand[0] === "replay")
    ) {
      writeLine(
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
    return runDoctor(argumentsAfterCommand, context);
  }

  if (command === "test") {
    return await runTest(argumentsAfterCommand, context);
  }

  if (command === "replay") {
    return runReplay(argumentsAfterCommand, context);
  }

  return usageError(context, `unknown command: ${command}`);
}
