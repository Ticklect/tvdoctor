#!/usr/bin/env node

import { PlaywrightWebDriver } from "@tvdoctor/driver-web";

import { createNodeCliOperations } from "./node-replay.js";
import { runCli, type CliContext } from "./index.js";
import { ProcessStartTerminal } from "./interactive.js";

const shutdownController = new AbortController();

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
