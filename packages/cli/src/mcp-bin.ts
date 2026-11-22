#!/usr/bin/env node

import { serveMcpStdio } from "./mcp-server.js";

// This executable deliberately writes no human-facing content to stdout.
// MCP stdio reserves stdout exclusively for JSON-RPC messages.
serveMcpStdio({
  input: process.stdin,
  output: process.stdout,
  log(message) {
    process.stderr.write(`TVDoctor MCP: ${message}\n`);
  },
});
process.stdin.resume();
