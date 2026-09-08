#!/usr/bin/env node

import { PlaywrightWebDriver } from "@tvdoctor/driver-web";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { createNodeCliOperations } from "./node-replay.js";
import { runCli, type CliContext } from "./index.js";
import { ProcessStartTerminal } from "./interactive.js";

const shutdownController = new AbortController();
const require = createRequire(import.meta.url);

async function installChromium(signal?: AbortSignal): Promise<void> {
  const playwrightEntry = require.resolve("playwright");
  const playwrightCli = join(dirname(playwrightEntry), "cli.js");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [playwrightCli, "install", "chromium"], {
      stdio: "inherit",
      windowsHide: true,
    });
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", handleAbort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const handleAbort = (): void => {
      try {
        child.kill();
      } finally {
        finish(new Error("Chromium setup was interrupted."));
      }
    };
    signal?.addEventListener("abort", handleAbort, { once: true });
    if (signal?.aborted === true) handleAbort();
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (code === 0) finish();
      else finish(new Error(
        signal === null
          ? `Playwright Chromium installer exited with code ${String(code)}.`
          : `Playwright Chromium installer stopped after signal ${signal}.`,
      ));
    });
  });
}

const context: CliContext = {
  environment: {
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
  },
  io: {
    writeStdout(text): void {
      process.stdout.write(text);
    },
    writeStderr(text): void {
      process.stderr.write(text);
    },
  },
  operations: createNodeCliOperations(),
  runtimeSetup: installChromium,
  startTerminal: new ProcessStartTerminal(),
  signal: shutdownController.signal,
  terminalProgress: {
    isInteractive: Boolean(process.stdout.isTTY),
    update(text) {
      process.stdout.write(`\u001b[2K\r${text}`);
    },
    finish() {
      if (process.stdout.isTTY) process.stdout.write("\u001b[2K\r");
    },
  },
  async runtimeProbe() {
    const driver = new PlaywrightWebDriver({
      browserLaunchOptions: { timeout: 15_000 },
      navigationTimeoutMs: 10_000,
      settle: { timeoutMs: 2_000 },
    });
    try {
      await driver.launch({ id: "tvdoctor-doctor", launchUri: "about:blank" });
      return { capabilities: [...await driver.capabilities()].sort() };
    } finally {
      await driver.close();
    }
  },
};

let interruptCount = 0;
function handleInterrupt(): void {
  interruptCount += 1;
  if (interruptCount > 1) {
    process.stderr.write("\nForced exit after second interrupt.\n");
    process.exit(130);
  }
  process.stderr.write("\nStopping after the current operation; completed coverage will be retained.\n");
  shutdownController.abort();
}

process.on("SIGINT", handleInterrupt);
try {
  process.exitCode = await runCli(process.argv.slice(2), context);
} finally {
  process.removeListener("SIGINT", handleInterrupt);
}
