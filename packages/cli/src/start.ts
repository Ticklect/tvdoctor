import type { CliContext } from "./cli.js";
import type { StartTerminal } from "./interactive.js";
import { classifyZeroConfigTarget } from "./zero-config-target.js";
import { runZeroConfigTarget } from "./zero-config.js";

function write(context: CliContext, text: string): void {
  context.io.writeStdout(`${text}\n`);
}

export async function runGuidedStart(
  context: CliContext & { readonly startTerminal?: StartTerminal },
  initialInput?: string,
): Promise<number> {
  const terminal = context.startTerminal;
  if (terminal === undefined || !terminal.isInteractive) {
    context.io.writeStderr(
      "TVDoctor start requires an interactive terminal; use tvdoctor test URL [options] in CI.\n",
    );
    return 2;
  }

  try {
    const input = initialInput ?? await terminal.prompt(
      "What do you want to test? Paste a website URL or APK path:",
      context.signal,
    );
    if (input === null) return 2;

    const classification = await classifyZeroConfigTarget(input);
    if (classification.status === "invalid") {
      write(context, classification.message);
      return 2;
    }
    if (classification.status === "not-target") {
      write(context, "Enter an absolute HTTP(S) URL or a local .apk path.");
      return 2;
    }

    return await runZeroConfigTarget(classification.target, context);
  } finally {
    terminal.close?.();
  }
}
