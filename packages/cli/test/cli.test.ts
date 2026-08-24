import { describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  CLI_VERSION,
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

function ignoreOutput(text: string): void {
  void text;
}

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
    async runtimeProbe() {
      return { capabilities: ["remote-input", "ui-tree"] };
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
      "Project: TVDoctor command-line audit [ok]",
    );
    expect(result.stdout).toContain("Node.js: v24.18.0 (supported) [ok]");
    expect(result.stdout).toContain("Host: linux x64 [ok]");
    expect(result.stdout).toContain(
      "Platform drivers: Chromium launched (remote-input, ui-tree) [ok]",
    );
    expect(result.stdout).toContain(
      "Runnable audits: Local web audit orchestration is available [ok]",
    );
    expect(result.stdout).toContain("AI/API key: not required [ok]");
    expect(result.stdout).toContain(
      "Doctor checks this host only; target availability is verified when an audit starts.",
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
        "Plan: deep mode; packs streaming, accessibility; bounded resets and replays can take several minutes.\n" +
        "Result: COMPLETED\n" +
        "Packs 6/6 completed\n" +
        "Actions 42/900\n" +
        "Issues: 2 issues; highest severity: high\n" +
        "Bundle directory: tvdoctor-report\n" +
        `Human report: ${join("tvdoctor-report", "report.html")}\n` +
        "Canonical JSON: tvdoctor-report/report.json\n",
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
    [["test", "https://example.test", "--unknown"], "unknown test option: --unknown"],
  ] as const)("rejects invalid test arguments %j", async (arguments_, message) => {
    await expect(captureRun(arguments_)).resolves.toEqual({
      code: EXIT_CODES.usageError,
      stdout: "",
      stderr: `Error: ${message}\nRun "tvdoctor --help" for usage.\n`,
    });
  });

  it("rejects terminal control and bidi characters before parsing argv", async () => {
    const message = "arguments must be bounded and must not contain terminal control or bidirectional formatting characters";
    for (const argument of [
      "bad\u001b[31mquery",
      "bad\u001b]0;forged-title\u0007query",
      "safe\u202Etxt",
    ]) {
      await expect(captureRun(["test", "https://example.test", "--query", argument]))
        .resolves.toEqual({
          code: EXIT_CODES.usageError,
          stdout: "",
          stderr: `Error: ${message}\nRun "tvdoctor --help" for usage.\n`,
        });
    }
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
      "Replay failed: CLI replay supports only deterministic issues with deterministic reproductions. Check the command inputs and try again.",
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
  ] as const)("rejects invalid replay arguments %j", async (arguments_, message) => {
    await expect(captureRun(arguments_)).resolves.toEqual({
      code: EXIT_CODES.usageError,
      stdout: "",
      stderr: `Error: ${message}\nRun "tvdoctor --help" for usage.\n`,
    });
  });

  it.each(["version", "--version", "-V"])("prints package-derived version for %s", async (command) => {
    await expect(captureRun([command])).resolves.toEqual({
      code: EXIT_CODES.success,
      stderr: "",
      stdout: `tvdoctor ${CLI_VERSION}\n`,
    });
    expect(CLI_VERSION).toBe("0.1.0");
  });

  it("keeps the navigation target intact while removing secrets from terminal output", async () => {
    let stdout = "";
    let stderr = "";
    let receivedTarget = "";
    const secretTarget = "https://example.test/watch?token=top-secret#account";
    const context: CliContext = {
      environment: SUPPORTED_ENVIRONMENT,
      io: {
        writeStdout(text) { stdout += text; },
        writeStderr(text) { stderr += text; },
      },
      operations: {
        async replayIssue() { return { status: "fixed", details: [] }; },
        async testTarget(request) {
          receivedTarget = request.target;
          throw new Error(
            "page.goto: failed at https://user:password@example.test/watch?token=top-secret#account\nCall log:\n - navigating",
          );
        },
      },
    };

    await expect(runCli(["test", secretTarget], context)).resolves.toBe(EXIT_CODES.executionError);
    expect(receivedTarget).toBe(secretTarget);
    expect(stdout).toBe(
      "Auditing https://example.test/watch...\n" +
      "Plan: standard mode; packs all; bounded resets and replays can take several minutes.\n",
    );
    expect(stderr).toContain("https://example.test/watch");
    expect(`${stdout}${stderr}`).not.toMatch(/top-secret|password|#account|Call log/iu);
  });

  it("canonicalises accepted audit and replay URLs before dispatch", async () => {
    const received: string[] = [];
    const context: CliContext = {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: ignoreOutput, writeStderr: ignoreOutput },
      operations: {
        async replayIssue(request) {
          received.push(request.targetOverride ?? "");
          return { status: "fixed", details: [] };
        },
        async testTarget(request) {
          received.push(request.target);
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

    await expect(runCli(["test", "https://EXAMPLE.test:443\\watch"], context))
      .resolves.toBe(EXIT_CODES.success);
    await expect(runCli([
      "replay",
      "TVDOCTOR-NAV-TEST",
      "--target",
      "http://EXAMPLE.test:80\\replay",
    ], context)).resolves.toBe(EXIT_CODES.success);
    expect(received).toEqual([
      "https://example.test/watch",
      "http://example.test/replay",
    ]);
  });

  it("reports a missing browser as an actionable doctor failure", async () => {
    let stdout = "";
    let stderr = "";
    const context: CliContext = {
      environment: SUPPORTED_ENVIRONMENT,
      io: {
        writeStdout(text) { stdout += text; },
        writeStderr(text) { stderr += text; },
      },
      operations: {
        async replayIssue() { return { status: "fixed", details: [] }; },
        async testTarget() {
          return { status: "completed", issueCount: 0, highestSeverity: null, reportPath: null, details: [] };
        },
      },
      async runtimeProbe() {
        throw new Error("browserType.launch: Executable doesn't exist\nCall log:\n secret");
      },
    };

    await expect(runCli(["doctor"], context)).resolves.toBe(EXIT_CODES.environmentFailure);
    expect(stderr).toBe("");
    expect(stdout).toContain(
      "Platform drivers: Chromium is unavailable. Run \"npx playwright install chromium\" and try again. [unavailable]",
    );
    expect(stdout).not.toContain("Call log");
  });

  it("reports unavailable audit orchestration from the actual operations context", async () => {
    let stdout = "";
    const context: CliContext = {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout(text) { stdout += text; }, writeStderr: ignoreOutput },
      operations: {
        async replayIssue() { return { status: "fixed", details: [] }; },
      },
      async runtimeProbe() { return { capabilities: ["remote-input"] }; },
    };

    await expect(runCli(["doctor"], context)).resolves.toBe(EXIT_CODES.environmentFailure);
    expect(stdout).toContain(
      "Runnable audits: Local web audit orchestration is unavailable in this host [unavailable]",
    );
  });

  it("labels a partial result and identifies every report entry point and next action", async () => {
    let stdout = "";
    const context: CliContext = {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout(text) { stdout += text; }, writeStderr: ignoreOutput },
      operations: {
        async replayIssue() { return { status: "fixed", details: [] }; },
        async testTarget() {
          return {
            status: "partial",
            issueCount: 1,
            highestSeverity: "medium",
            reportPath: join("output", "report.json"),
            details: ["One pack did not complete"],
          };
        },
      },
    };

    await expect(runCli(["test", "https://example.test"] , context))
      .resolves.toBe(EXIT_CODES.inconclusive);
    expect(stdout).toContain("Result: PARTIAL-INCONCLUSIVE\n");
    expect(stdout).toContain("Issues: 1 issue; highest severity: medium\n");
    expect(stdout).toContain("Bundle directory: output\n");
    expect(stdout).toContain(`Human report: ${join("output", "report.html")}\n`);
    expect(stdout).toContain(`Canonical JSON: ${join("output", "report.json")}\n`);
    expect(stdout).toContain("Next action: Review the partial report");
  });

  it("labels a failed audit and renders a zero-issue severity summary truthfully", async () => {
    let stdout = "";
    const context: CliContext = {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout(text) { stdout += text; }, writeStderr: ignoreOutput },
      operations: {
        async replayIssue() { return { status: "fixed", details: [] }; },
        async testTarget() {
          return {
            status: "failed",
            issueCount: 0,
            highestSeverity: null,
            reportPath: null,
            details: ["Audit could not finish"],
          };
        },
      },
    };

    await expect(runCli(["test", "https://example.test"], context))
      .resolves.toBe(EXIT_CODES.executionError);
    expect(stdout).toContain("Result: FAILED\n");
    expect(stdout).toContain("Issues: 0 issues; highest severity: none\n");
  });

  it("sanitizes operation details at the central terminal boundary", async () => {
    let stdout = "";
    const context: CliContext = {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout(text) { stdout += text; }, writeStderr: ignoreOutput },
      operations: {
        async replayIssue() {
          return {
            status: "fixed",
            details: ["Detail \u001b[31mRED\u001b[0m \u001b]8;;https://evil.test/?secret=yes\u0007link\u001b]8;;\u0007 \u202Etxt"],
          };
        },
      },
    };

    await expect(runCli(["replay", "SAFE-ID"], context)).resolves.toBe(EXIT_CODES.success);
    expect(stdout).toContain("Detail RED link txt");
    expect(stdout).not.toContain("\u001b");
    expect(stdout).not.toContain("\u0007");
    expect(stdout).not.toContain("\u202e");
    expect(stdout).not.toContain("secret=yes");
  });

  it("validates a replay target override before printing a replay preamble", async () => {
    const result = await captureRun([
      "replay",
      "SAFE-ID",
      "--target",
      "javascript:alert(1)",
    ]);
    expect(result.code).toBe(EXIT_CODES.usageError);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--target must be an absolute HTTP(S) URL without credentials");
  });

  it.each([
    [Object.assign(new Error("read failed"), { code: "ENOENT" }), "The report file was not found. Check --report and try again."],
    [Object.assign(new Error("write failed"), { code: "EACCES" }), "Access was denied. Check file and directory permissions, then try again."],
    [new SyntaxError("Unexpected token at position 1\nraw parser trace"), "The replay report is unreadable or incompatible. Check --report points to a valid TVDoctor V1 JSON report."],
  ] as const)("classifies common replay/report failures without raw call logs", async (failure, expected) => {
    let stderr = "";
    const context: CliContext = {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: ignoreOutput, writeStderr(text) { stderr += text; } },
      operations: {
        async replayIssue() { throw failure; },
      },
    };

    await expect(runCli(["replay", "SAFE-ID"], context)).resolves.toBe(EXIT_CODES.replayError);
    expect(stderr).toBe(`Replay failed: ${expected}\n`);
    expect(stderr).not.toMatch(/raw parser trace|read failed|write failed/iu);
  });

  it("classifies an output preflight collision before exposing a raw filesystem error", async () => {
    let stderr = "";
    const context: CliContext = {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: ignoreOutput, writeStderr(text) { stderr += text; } },
      operations: {
        async replayIssue() { return { status: "fixed", details: [] }; },
        async testTarget() {
          throw Object.assign(new Error("EEXIST: file already exists, mkdir 'private-path'"), {
            code: "EEXIST",
          });
        },
      },
    };

    await expect(runCli(["test", "https://example.test"], context))
      .resolves.toBe(EXIT_CODES.executionError);
    expect(stderr).toBe("Audit failed: The report output already exists. Choose a new --output directory and try again.\n");
    expect(stderr).not.toContain("private-path");
  });

  it("bounds verbose operation detail output", async () => {
    let stdout = "";
    const context: CliContext = {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout(text) { stdout += text; }, writeStderr: ignoreOutput },
      operations: {
        async replayIssue() {
          return {
            status: "fixed",
            details: Array.from({ length: 60 }, (_, index) => `Detail ${String(index + 1)} ${"x".repeat(2_000)}`),
          };
        },
      },
    };

    await expect(runCli(["replay", "SAFE-ID"], context)).resolves.toBe(EXIT_CODES.success);
    expect(stdout).toContain("10 additional details omitted; see the report bundle.");
    expect(stdout).not.toContain("Detail 51");
    expect(stdout.length).toBeLessThan(52_000);
  });
});
