#!/usr/bin/env node

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
};

process.exitCode = await runCli(process.argv.slice(2), context);
