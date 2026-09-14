import type { CliContext } from "./cli.js";
import { runCli } from "./cli.js";
import { isSafeTerminalArgument } from "./terminal.js";
import { classifyZeroConfigTarget } from "./zero-config-target.js";
import { runZeroConfigTarget } from "./zero-config.js";

const KNOWN_COMMANDS: ReadonlySet<string> = new Set([
  "test",
  "start",
  "doctor",
  "setup",
  "replay",
  "ci",
  "baseline",
  "accessibility",
  "version",
  "--version",
  "-V",
  "help",
  "--help",
  "-h",
]);

export const START_HELP_TEXT = `Usage:
  tvdoctor start
  tvdoctor start URL
  tvdoctor start PATH.apk

Start TVDoctor's normal zero-config scan. With no target, TVDoctor asks once for
a website URL or local APK path. The normal Scan uses completion-driven coverage
with safety bounds; use tvdoctor test for advanced pack/mode controls.`;

function usageError(context: CliContext, message: string): number {
  context.io.writeStderr(`Error: ${message}\n`);
  context.io.writeStderr('Run "tvdoctor --help" for usage.\n');
  return 2;
}

function writeHelp(context: CliContext): number {
  context.io.writeStdout(`${START_HELP_TEXT}\n`);
  return 0;
}

async function runExplicitStart(arguments_: readonly string[], context: CliContext): Promise<number> {
  if (arguments_.length === 0) return await runCli(["start"], context);
  if (arguments_.length === 1 && (arguments_[0] === "--help" || arguments_[0] === "-h")) {
    return writeHelp(context);
  }
  if (arguments_.length !== 1) {
    return usageError(context, "start accepts one website URL or APK path.");
  }
  const input = arguments_[0];
  if (input === undefined) return usageError(context, "start requires a target.");
  const classification = await classifyZeroConfigTarget(input);
  if (classification.status === "invalid") return usageError(context, classification.message);
  if (classification.status === "not-target") {
    return usageError(context, "start requires an absolute HTTP(S) URL or local .apk path.");
  }
  return await runZeroConfigTarget(classification.target, context);
}

export async function runProductCli(
  arguments_: readonly string[],
  context: CliContext,
): Promise<number> {
  if (arguments_.length > 128 || arguments_.some((argument) => !isSafeTerminalArgument(argument))) {
    return usageError(
      context,
      "arguments must be bounded and must not contain terminal control or bidirectional formatting characters",
    );
  }

  if (arguments_.length === 2 && arguments_[0] === "help" && arguments_[1] === "start") {
    return writeHelp(context);
  }
  if (arguments_[0] === "start") {
    return await runExplicitStart(arguments_.slice(1), context);
  }

  const command = arguments_[0];
  if (command === undefined || KNOWN_COMMANDS.has(command)) {
    return await runCli(arguments_, context);
  }
  if (arguments_.length !== 1) return await runCli(arguments_, context);

  const classification = await classifyZeroConfigTarget(command);
  if (classification.status === "target") {
    return await runZeroConfigTarget(classification.target, context);
  }
  if (classification.status === "invalid") return usageError(context, classification.message);
  return await runCli(arguments_, context);
}
