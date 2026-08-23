import { describe, expect, it } from "vitest";

import {
  DOCTOR_HELP_TEXT,
  EXIT_CODES,
  HELP_TEXT,
  REPLAY_HELP_TEXT,
  TEST_HELP_TEXT,
  diagnoseEnvironment,
  runCli,
  type CliContext,
  type RuntimeEnvironment,
} from "../src/index.js";

interface CapturedRun {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}

const SUPPORTED_ENVIRONMENT: RuntimeEnvironment = {
  nodeVersion: "v24.18.0",
  platform: "linux",
  architecture: "x64",
};

async function captureRun(
  arguments_: readonly string[],
  environment: RuntimeEnvironment = SUPPORTED_ENVIRONMENT,
  replayStatus: "reproduced" | "fixed" | "inconclusive" | "error" = "fixed",
): Promise<CapturedRun> {
  let stdout = "";
  let stderr = "";
  const context: CliContext = {
    environment,
    io: {
      writeStdout(text): void {
        stdout += text;
      },
      writeStderr(text): void {
        stderr += text;
      },
    },
    operations: {
      async replayIssue() {
        return { status: replayStatus, details: ["Checkpoint PASS"] };
      },
      async testTarget() {
        return {
          status: "completed",
          issueCount: 2,
          highestSeverity: "high",
          reportPath: "tvdoctor-report/report.json",
          details: ["Packs 6/6 completed", "Actions 42/900"],
        };
      },
    },
  };

  return {
    code: await runCli(arguments_, context),
    stderr,
    stdout,
  };
}

describe("TVDoctor CLI", () => {
  it.each<readonly [readonly string[]]>([
    [["test", "--help"]],
    [["test", "-h"]],
    [["help", "test"]],
  ])("prints test-specific help for %j", async (arguments_) => {
    await expect(captureRun(arguments_)).resolves.toEqual({
      code: EXIT_CODES.success,
      stderr: "",
      stdout: `${TEST_HELP_TEXT}\n`,
    });
  });

  it.each<readonly [readonly string[]]>([
    [[]],
    [["--help"]],
    [["-h"]],
    [["help"]],
  ])(
    "prints help successfully for %j",
    async (arguments_) => {
      await expect(captureRun(arguments_)).resolves.toEqual({
        code: EXIT_CODES.success,
        stderr: "",
        stdout: `${HELP_TEXT}\n`,
      });
    },
  );

  it.each<readonly [readonly string[]]>([
    [["doctor", "--help"]],
    [["doctor", "-h"]],
    [["help", "doctor"]],
  ])(
    "prints doctor-specific help for %j",
    async (arguments_) => {
      await expect(captureRun(arguments_)).resolves.toEqual({
        code: EXIT_CODES.success,
        stderr: "",
        stdout: `${DOCTOR_HELP_TEXT}\n`,
      });
    },
  );

  it.each<readonly [readonly string[]]>([
    [["replay", "--help"]],
    [["replay", "-h"]],
    [["help", "replay"]],
  ])("prints replay-specific help for %j", async (arguments_) => {
    await expect(captureRun(arguments_)).resolves.toEqual({
      code: EXIT_CODES.success,
      stderr: "",
      stdout: `${REPLAY_HELP_TEXT}\n`,
    });
  });

  it("reports only the capabilities that currently exist", async () => {
    const result = await captureRun(["doctor"]);

    expect(result.code).toBe(EXIT_CODES.success);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "Project: Milestone 6 semantic streaming and player pack (experimental) [ok]",
    );
    expect(result.stdout).toContain("Node.js: v24.18.0 (supported) [ok]");
    expect(result.stdout).toContain("Host: linux x64 [ok]");
    expect(result.stdout).toContain(
      "Platform drivers: Playwright web adapter (experimental library) [ok]",
    );
    expect(result.stdout).toContain(
      "Runnable audits: CLI audit orchestration is not implemented [unavailable]",
    );
    expect(result.stdout).toContain("AI/API key: not required [ok]");
    expect(result.stdout).toContain(
      "Experimental web-library support only; no production TV platform support is claimed.",
    );
  });

  it("returns an environment failure for an unsupported Node.js runtime", async () => {
    const result = await captureRun(["doctor"], {
      ...SUPPORTED_ENVIRONMENT,
      nodeVersion: "v23.9.0",
    });

    expect(result.code).toBe(EXIT_CODES.environmentFailure);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "Node.js: v23.9.0 (unsupported; requires >=24.0.0 <25) [unsupported]",
    );
  });

  it("treats an unparseable Node.js version as unsupported", () => {
    expect(
      diagnoseEnvironment({
        ...SUPPORTED_ENVIRONMENT,
        nodeVersion: "development-build",
      }).runtime,
    ).toEqual({
      status: "unsupported",
      detail:
        "development-build (unsupported; requires >=24.0.0 <25)",
    });
  });

  it("runs a bounded web audit through the CLI operation", async () => {
    await expect(captureRun([
      "test",
      "https://example.test/app",
      "--pack",
      "streaming",
      "--pack",
      "accessibility",
      "--mode",
      "deep",
      "--output",
      "audit-output",
      "--query",
      "NOVA",
    ])).resolves.toEqual({
      code: EXIT_CODES.environmentFailure,
      stderr: "",
      stdout:
        "Auditing https://example.test/app...\n" +
        "Packs 6/6 completed\n" +
        "Actions 42/900\n" +
        "Report: tvdoctor-report/report.json\n" +
        "2 issue(s) detected.\n",
    });
  });

  it("rejects unknown commands with a deterministic usage exit code", async () => {
    await expect(captureRun(["scan", "https://example.test"])).resolves.toEqual({
      code: EXIT_CODES.usageError,
      stdout: "",
      stderr:
        "Error: unknown command: scan\nRun \"tvdoctor --help\" for usage.\n",
    });
  });

  it.each([
    [["test"], "test requires a URL"],
    [["test", "not-a-url"], "test target must be an absolute HTTP(S) URL without credentials"],
    [["test", "https://u:p@example.test"], "test target must be an absolute HTTP(S) URL without credentials"],
    [["test", "https://example.test", "--pack", "unknown"], "unknown test pack: unknown"],
    [["test", "https://example.test", "--mode", "turbo"], "unknown test mode: turbo"],
    [["test", "https://example.test", "--pack", "all", "--pack", "streaming"], "--pack all cannot be combined with another pack"],
    [["test", "https://example.test", "--query", "bad\u001bquery"], "--query must be printable, non-empty, and at most 64 characters"],
    [["test", "https://example.test", "--unknown"], "unknown test option: --unknown"],
  ] as const)("rejects invalid test arguments %j", async (arguments_, message) => {
    await expect(captureRun(arguments_)).resolves.toEqual({
      code: EXIT_CODES.usageError,
      stdout: "",
      stderr: `Error: ${message}\nRun "tvdoctor --help" for usage.\n`,
    });
  });

  it("reports a rejected best-effort replay without claiming reproduction", async () => {
    let stdout = "";
    let stderr = "";
    const context: CliContext = {
      environment: SUPPORTED_ENVIRONMENT,
      io: {
        writeStdout(text): void {
          stdout += text;
        },
        writeStderr(text): void {
          stderr += text;
        },
      },
      operations: {
        async replayIssue() {
          throw new TypeError(
            "CLI replay supports only deterministic issues with deterministic reproductions.",
          );
        },
      },
    };

    await expect(runCli([
      "replay",
      "TVDOCTOR-NAV-HEURISTIC",
      "--report",
      "bundle/report.json",
    ], context)).resolves.toBe(EXIT_CODES.replayError);
    expect(stdout).toBe("Replaying TVDOCTOR-NAV-HEURISTIC...\n");
    expect(stderr).toContain(
      "Replay failed: CLI replay supports only deterministic issues with deterministic reproductions.",
    );
    expect(`${stdout}${stderr}`).not.toContain("Issue reproduced.");
  });

  it("rejects unexpected doctor arguments", async () => {
    await expect(captureRun(["doctor", "--json"])).resolves.toEqual({
      code: EXIT_CODES.usageError,
      stdout: "",
      stderr:
        "Error: doctor does not accept arguments: --json\n" +
        "Run \"tvdoctor --help\" for usage.\n",
    });
  });

  it.each([
    ["reproduced", EXIT_CODES.environmentFailure, "Issue reproduced.\n", ""],
    ["fixed", EXIT_CODES.success, "TVDOCTOR-NAV-TEST FIXED\n", ""],
    ["inconclusive", EXIT_CODES.replayInconclusive, "Replay inconclusive.\n", ""],
    ["error", EXIT_CODES.replayError, "", "Replay failed.\n"],
  ] as const)(
    "maps a %s replay to a deterministic exit code",
    async (status, code, finalStdout, finalStderr) => {
      const result = await captureRun(
        ["replay", "TVDOCTOR-NAV-TEST", "--report", "bundle/report.json"],
        SUPPORTED_ENVIRONMENT,
        status,
      );
      expect(result).toEqual({
        code,
        stderr: finalStderr,
        stdout: `Replaying TVDOCTOR-NAV-TEST...\nCheckpoint PASS\n${finalStdout}`,
      });
    },
  );

  it.each([
    [["replay"], "replay requires an ISSUE_ID"],
    [["replay", "ONE", "TWO"], "replay accepts exactly one ISSUE_ID"],
    [["replay", "ONE", "--report"], "--report requires a value"],
    [["replay", "ONE", "--unknown"], "unknown replay option: --unknown"],
    [["replay", "BAD\u001b[31m"], "ISSUE_ID must be a portable identifier"],
  ] as const)("rejects invalid replay arguments %j", async (arguments_, message) => {
    await expect(captureRun(arguments_)).resolves.toEqual({
      code: EXIT_CODES.usageError,
      stdout: "",
      stderr: `Error: ${message}\nRun "tvdoctor --help" for usage.\n`,
    });
  });
});
