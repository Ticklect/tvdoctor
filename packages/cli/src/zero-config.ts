import type { CliContext } from "./cli.js";
import { ProgressRenderer, type StartTerminal } from "./interactive.js";
import { defaultOutputDirectory } from "./product-output.js";
import type { ZeroConfigTarget } from "./zero-config-target.js";
import { finishInteractiveScan } from "./zero-config-output.js";

const EXIT_SUCCESS = 0;
const EXIT_ENVIRONMENT = 1;
const EXIT_USAGE = 2;
const EXIT_PARTIAL = 3;
const EXIT_EXECUTION = 4;

const nonInteractiveTerminal: StartTerminal = {
  isInteractive: false,
  prompt: async () => null,
  select: async () => null,
};

function write(context: CliContext, text: string): void {
  context.io.writeStdout(`${text}\n`);
}

function writeError(context: CliContext, text: string): void {
  context.io.writeStderr(`${text}\n`);
}

async function ensureWebRuntime(context: CliContext): Promise<void> {
  if (context.runtimeProbe === undefined) return;
  try {
    await context.runtimeProbe();
    return;
  } catch (firstError) {
    if (context.runtimeSetup === undefined) throw firstError;
    write(context, "Installing TVDoctor's browser…");
    await context.runtimeSetup(context.signal);
    await context.runtimeProbe();
  }
}

function exitCodeForStatus(status: "completed" | "partial" | "failed"): number {
  return status === "completed" ? EXIT_SUCCESS : status === "partial" ? EXIT_PARTIAL : EXIT_EXECUTION;
}

async function runZeroConfigWeb(target: string, context: CliContext): Promise<number> {
  if (context.operations?.testTarget === undefined) {
    writeError(context, "Web auditing is unavailable in this TVDoctor installation.");
    return EXIT_EXECUTION;
  }

  const terminal = context.startTerminal ?? nonInteractiveTerminal;
  write(context, "TVDoctor");
  write(context, `Target: ${target}`);
  write(context, "Checking browser…");
  try {
    await ensureWebRuntime(context);
  } catch (error) {
    const message = error instanceof Error ? error.message.split(/\r?\n/u, 1)[0] : String(error);
    writeError(context, `Browser setup failed: ${message}`);
    return EXIT_ENVIRONMENT;
  }

  const outputPath = defaultOutputDirectory({ target, mode: "deep" });
  const startedAtMs = Date.now();
  const progress = new ProgressRenderer(terminal.isInteractive, (line) => write(context, line));
  const intervalMs = terminal.isInteractive ? 1_000 : 30_000;
  const timer = setInterval(() => {
    progress.update({ elapsedSeconds: Math.floor((Date.now() - startedAtMs) / 1_000) });
  }, intervalMs);

  write(context, "Scanning… Press Ctrl+C to stop safely.");
  try {
    const result = await context.operations.testTarget({
      target,
      packs: ["all"],
      mode: "deep",
      outputPath,
      searchQuery: "N",
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    clearInterval(timer);
    progress.finish();
    await finishInteractiveScan(context, terminal, result, startedAtMs);
    return exitCodeForStatus(result.status);
  } catch (error) {
    clearInterval(timer);
    progress.finish();
    const message = error instanceof Error ? error.message.split(/\r?\n/u, 1)[0] : String(error);
    writeError(context, `Scan failed: ${message}`);
    return EXIT_EXECUTION;
  } finally {
    clearInterval(timer);
    progress.finish();
  }
}

export async function runZeroConfigTarget(
  target: ZeroConfigTarget,
  context: CliContext,
): Promise<number> {
  if (target.kind === "web") return await runZeroConfigWeb(target.target, context);
  writeError(context, "Android APK zero-config setup is not available yet in this build.");
  return context.startTerminal?.isInteractive === false ? EXIT_USAGE : EXIT_ENVIRONMENT;
}
