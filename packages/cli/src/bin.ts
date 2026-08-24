#!/usr/bin/env node

import { PlaywrightWebDriver } from "@tvdoctor/driver-web";

import { createNodeCliOperations } from "./node-replay.js";
import { runCli, type CliContext } from "./index.js";

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

process.exitCode = await runCli(process.argv.slice(2), context);
