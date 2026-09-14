import { describe, expect, it } from "vitest";

import {
  EXIT_CODES,
  runProductCli,
  type CliContext,
  type RuntimeEnvironment,
  type TestCommandRequest,
} from "../src/index.js";
import type { StartTerminal } from "../src/interactive.js";

const environment: RuntimeEnvironment = {
  nodeVersion: "v24.18.0",
  platform: "linux",
  architecture: "x64",
};

function terminal(input = "https://example.test/tv"): StartTerminal {
  return {
    isInteractive: true,
    prompt: async () => input,
    select: async () => 0,
  };
}

function baseContext(): CliContext {
  return {
    environment,
    io: { writeStdout: () => undefined, writeStderr: () => undefined },
    startTerminal: terminal(),
    operations: {
      replayIssue: async () => ({ status: "fixed", details: [] }),
    },
  };
}

describe("zero-config product entry", () => {
  it("routes a root URL to one completion-driven deep scan", async () => {
    let request: TestCommandRequest | null = null;
    const context: CliContext = {
      ...baseContext(),
      runtimeProbe: async () => ({ capabilities: [] }),
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        testTarget: async (value) => {
          request = value;
          return {
            status: "completed",
            issueCount: 0,
            highestSeverity: null,
            reportPath: null,
            details: [],
          };
        },
      },
    };

    const code = await runProductCli(["https://example.test/tv"], context);

    expect(code).toBe(EXIT_CODES.success);
    expect(request).toMatchObject({
      target: "https://example.test/tv",
      mode: "deep",
      packs: ["all"],
      searchQuery: "N",
    });
  });

  it("installs a missing browser and resumes the same command", async () => {
    const events: string[] = [];
    let probes = 0;
    const context: CliContext = {
      ...baseContext(),
      runtimeProbe: async () => {
        probes += 1;
        events.push(`probe-${String(probes)}`);
        if (probes === 1) throw new Error("browser missing");
        return { capabilities: [] };
      },
      runtimeSetup: async () => { events.push("install"); },
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        testTarget: async () => {
          events.push("scan");
          return {
            status: "completed",
            issueCount: 0,
            highestSeverity: null,
            reportPath: null,
            details: [],
          };
        },
      },
    };

    await expect(runProductCli(["https://example.test/tv"], context)).resolves.toBe(EXIT_CODES.success);
    expect(events).toEqual(["probe-1", "install", "probe-2", "scan"]);
  });

  it("accepts start TARGET without platform or mode selection", async () => {
    let selections = 0;
    const context: CliContext = {
      ...baseContext(),
      startTerminal: {
        isInteractive: true,
        prompt: async () => { throw new Error("should not prompt"); },
        select: async () => { selections += 1; return 0; },
      },
      runtimeProbe: async () => ({ capabilities: [] }),
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        testTarget: async () => ({
          status: "completed",
          issueCount: 0,
          highestSeverity: null,
          reportPath: null,
          details: [],
        }),
      },
    };

    await expect(runProductCli(["start", "https://example.test/tv"], context)).resolves.toBe(EXIT_CODES.success);
    expect(selections).toBe(0);
  });

  it("auto-opens a retained HTML report and keeps the path visible", async () => {
    let stdout = "";
    let openedPath: string | null = null;
    const context: CliContext = {
      ...baseContext(),
      io: { writeStdout: (value) => { stdout += value; }, writeStderr: () => undefined },
      reportActions: {
        openReport: async (path) => { openedPath = path; return true; },
        showFolder: async () => false,
        copyPath: async () => false,
      },
      runtimeProbe: async () => ({ capabilities: [] }),
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        testTarget: async () => ({
          status: "completed",
          issueCount: 3,
          highestSeverity: "high",
          reportPath: "D:/reports/report.json",
          details: ["All reachable work was exhausted."],
        }),
      },
    };

    await expect(runProductCli(["https://example.test/tv"], context)).resolves.toBe(EXIT_CODES.success);
    expect(openedPath).toMatch(/[\\/]reports[\\/]report\.html$/u);
    expect(stdout).toContain("3 findings");
    expect(stdout).toContain("highest: HIGH");
    expect(stdout).toContain("report.html");
  });
});
