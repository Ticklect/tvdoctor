import { describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  ACCESSIBILITY_HELP_TEXT,
  BASELINE_HELP_TEXT,
  CI_HELP_TEXT,
  CLI_VERSION,
  DOCTOR_HELP_TEXT,
  EXIT_CODES,
  HELP_TEXT,
  REPLAY_HELP_TEXT,
  SETUP_HELP_TEXT,
  START_HELP_TEXT,
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
  it("supports a short navigation-first scan command", async () => {
    const result = await captureRun(["scan", "https://example.test"]);
    expect(result.code).toBe(EXIT_CODES.environmentFailure);
    expect(result.stdout).toContain("Plan: standard mode; remote navigation;");
    expect(HELP_TEXT).toContain("tvdoctor scan URL");
    expect(HELP_TEXT).toContain("a standalone replay reproduced the issue");
  });

  it("shows scan-specific help with the standard navigation default", async () => {
    for (const arguments_ of [["help", "scan"], ["scan", "--help"], ["scan", "-h"]] as const) {
      const result = await captureRun(arguments_);
      expect(result.code).toBe(EXIT_CODES.success);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Usage:\n  tvdoctor scan URL");
      expect(result.stdout).toContain("Defaults to standard");
      expect(result.stdout).not.toContain("Usage:\n  tvdoctor test URL");
    }
  });

  it("keeps scan navigation-only instead of accepting diagnostic pack overrides", async () => {
    const result = await captureRun(["scan", "https://example.test", "--pack", "all"]);
    expect(result.code).toBe(EXIT_CODES.usageError);
    expect(result.stderr).toContain("scan is navigation-only");
  });

  it("allows bounded navigation overrides and disables lossy repeated-item compression for scan", async () => {
    let captured: import("../src/index.js").TestCommandRequest | undefined;
    const code = await runCli([
      "scan", "https://example.test/guide",
      "--mode", "deep",
      "--max-duration-ms", "240000",
      "--max-actions", "6000",
      "--max-states", "900",
      "--max-depth", "80",
    ], {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: ignoreOutput, writeStderr: ignoreOutput },
      runtimeProbe: async () => ({ capabilities: ["remote-input", "ui-tree"] }),
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        testTarget: async (request) => {
          captured = request;
          return { status: "completed", issueCount: 0, highestSeverity: null, reportPath: null, details: [] };
        },
      },
    });
    expect(code).toBe(EXIT_CODES.success);
    expect(captured).toMatchObject({
      mode: "deep",
      maxDurationMs: 240000,
      navigationBudgets: { maxActions: 6000, maxStates: 900, maxDepth: 80 },
      disableRepetitionCompression: true,
    });
  });

  it("passes explicit fixture-profile selection through scan without enabling it by default", async () => {
    const requests: import("../src/index.js").TestCommandRequest[] = [];
    const context: CliContext = {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: ignoreOutput, writeStderr: ignoreOutput },
      runtimeProbe: async () => ({ capabilities: ["remote-input", "ui-tree"] }),
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        testTarget: async (request) => {
          requests.push(request);
          return { status: "completed", issueCount: 0, highestSeverity: null, reportPath: null, details: [] };
        },
      },
    };
    expect(await runCli(["scan", "http://127.0.0.1:5173/", "--fixture-profile-select"], context))
      .toBe(EXIT_CODES.success);
    expect(await runCli(["scan", "http://127.0.0.1:5173/"], context))
      .toBe(EXIT_CODES.success);
    expect(requests[0]?.fixtureProfileSelection).toBe(true);
    expect(requests[1]?.fixtureProfileSelection).toBeUndefined();
  });

  it.each([
    [["scan", "https://example.test/", "--fixture-profile-select"], "localhost/loopback"],
    [["test", "http://127.0.0.2:5173/", "--fixture-profile-select"], "localhost/loopback"],
    [["test", "http://localhost:5173/", "--pack", "streaming", "--fixture-profile-select"], "navigation pack"],
  ] as const)("rejects fixture profile selection outside the local navigation fixture (%j)", async (args, reason) => {
    const result = await captureRun(args);
    expect(result.code).toBe(EXIT_CODES.usageError);
    expect(result.stderr).toContain(reason);
  });

  it("runs scan and reviewed-baseline comparison in one invocation", async () => {
    let stdout = "";
    let auditRequest: import("../src/index.js").TestCommandRequest | undefined;
    let comparisonRequest: import("../src/index.js").BaselineCompareRequest | undefined;
    const code = await runCli([
      "scan", "https://example.test/app", "--output", join("reports", "current"), "--baseline", "reviewed.json",
    ], {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: (text) => { stdout += text; }, writeStderr: ignoreOutput },
      runtimeProbe: async () => ({ capabilities: ["remote-input", "ui-tree"] }),
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        testTarget: async (request) => {
          auditRequest = request;
          return {
            status: "completed",
            issueCount: 3,
            highestSeverity: "high",
            reportPath: join("reports", "current", "report.json"),
            details: ["Actions 18/900", "States 4/40", "Transitions 12"],
          };
        },
        compareBaseline: async (request) => {
          comparisonRequest = request;
          return {
            status: "changed",
            shouldFail: false,
            newIssues: 0,
            resolvedIssues: 1,
            unchangedIssues: 2,
            structuralRegressions: 0,
            addedFocusTargets: 2,
            removedFocusTargets: 0,
            directionalTransitionChanges: 0,
            latencyRegressions: 0,
            blockers: [],
            outputPath: join("reports", "current", "baseline-comparison.json"),
            markdownPath: join("reports", "current", "baseline-comparison.md"),
          };
        },
      },
    });

    expect(code).toBe(EXIT_CODES.success);
    expect(auditRequest).not.toHaveProperty("baselinePath");
    expect(comparisonRequest).toEqual({
      baselinePath: "reviewed.json",
      reportPath: join("reports", "current", "report.json"),
      inventoryPath: join("reports", "current", "inventory.json"),
      outputPath: join("reports", "current", "baseline-comparison.json"),
    });
    expect(stdout).toContain("Baseline result: CHANGED");
    expect(stdout).toContain("0 introduced, 1 resolved findings.");
    expect(stdout).toContain("Focus targets: 2 added, 0 removed.");
    expect(stdout).toContain("Directional transition changes: 0; latency regressions: 0.");
    expect(stdout).toContain(`Comparison: ${join("reports", "current", "baseline-comparison.json")}`);
    expect(stdout).toContain(`Readable comparison: ${join("reports", "current", "baseline-comparison.md")}`);
  });

  it("fails a combined scan on baseline regression and still compares a partial report fail-closed", async () => {
    for (const scenario of [
      { auditStatus: "completed" as const, compareStatus: "regressed" as const, compareFail: true, expected: EXIT_CODES.environmentFailure },
      { auditStatus: "partial" as const, compareStatus: "failed-closed" as const, compareFail: true, expected: EXIT_CODES.inconclusive },
    ]) {
      let compared = 0;
      const code = await runCli(["scan", "https://example.test", "--baseline", "reviewed.json"], {
        environment: SUPPORTED_ENVIRONMENT,
        io: { writeStdout: ignoreOutput, writeStderr: ignoreOutput },
        runtimeProbe: async () => ({ capabilities: ["remote-input", "ui-tree"] }),
        operations: {
          replayIssue: async () => ({ status: "fixed", details: [] }),
          testTarget: async () => ({
            status: scenario.auditStatus,
            issueCount: 1,
            highestSeverity: "high",
            reportPath: join("tvdoctor-report", "report.json"),
            details: [],
          }),
          compareBaseline: async () => {
            compared += 1;
            return {
              status: scenario.compareStatus,
              shouldFail: scenario.compareFail,
              newIssues: scenario.compareStatus === "regressed" ? 1 : 0,
              resolvedIssues: 0,
              unchangedIssues: 0,
              structuralRegressions: 0,
              addedFocusTargets: 0,
              removedFocusTargets: 0,
              directionalTransitionChanges: 0,
              latencyRegressions: 0,
              blockers: scenario.compareStatus === "failed-closed" ? ["The current run was partial."] : [],
              outputPath: join("tvdoctor-report", "baseline-comparison.json"),
              markdownPath: join("tvdoctor-report", "baseline-comparison.md"),
            };
          },
        },
      });
      expect(compared).toBe(1);
      expect(code).toBe(scenario.expected);
    }
  });

  it("keeps --baseline scoped to scan and CI rather than broadening ordinary test", async () => {
    const result = await captureRun(["test", "https://example.test", "--baseline", "reviewed.json"]);
    expect(result.code).toBe(EXIT_CODES.usageError);
    expect(result.stderr).toContain("unknown test option: --baseline");
  });

  it("runs the deterministic demo contract and reports replay proof", async () => {
    let stdout = "";
    const operations = {
      replayIssue: async () => ({ status: "fixed" as const, details: [] }),
      runDemo: async () => ({
        status: "verified" as const,
        issueId: "TVDOCTOR-NAV-DEMO",
        reportPath: "demo-output/report.json",
        replayStatus: "reproduced" as const,
        details: ["Seeded More info D-pad failure VERIFIED"],
      }),
    };
    const context: CliContext = {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: (text) => { stdout += text; }, writeStderr: ignoreOutput },
      operations: operations as unknown as NonNullable<CliContext["operations"]>,
      runtimeProbe: async () => ({ capabilities: ["remote-input", "ui-tree"] }),
    };

    await expect(runCli(["demo", "--output", "demo-output"], context))
      .resolves.toBe(EXIT_CODES.success);
    expect(stdout).toContain("Demo VERIFIED");
    expect(stdout).toContain("More info D-pad failure VERIFIED");
    expect(stdout).toContain("Replay: REPRODUCED");
    expect(stdout).toContain("Replay command: tvdoctor replay TVDOCTOR-NAV-DEMO --report");
    expect(stdout).toContain("demo-output");
    expect(stdout).toContain("controlled seeded fixture");
    expect(stdout).toContain("not production-app accuracy");
  });

  it("opens a verified demo report automatically in an interactive terminal", async () => {
    let openedPath: string | null = null;
    let stdout = "";
    const context: CliContext = {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: (text) => { stdout += text; }, writeStderr: ignoreOutput },
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        runDemo: async () => ({
          status: "verified",
          issueId: "TVDOCTOR-NAV-DEMO",
          reportPath: "demo-output/report.json",
          replayStatus: "reproduced",
          details: [],
        }),
      },
      runtimeProbe: async () => ({ capabilities: ["remote-input", "ui-tree"] }),
      terminalProgress: { isInteractive: true, update: ignoreOutput, finish: () => undefined },
      reportActions: {
        openReport: async (path) => { openedPath = path; return true; },
        showFolder: async () => true,
        copyPath: async () => true,
      },
    };

    await expect(runCli(["demo", "--output", "demo-output"], context))
      .resolves.toBe(EXIT_CODES.success);
    expect(openedPath).toMatch(/demo-output[\\/]report\.html$/u);
    expect(stdout).toContain("Opened report:");
  });

  it("keeps a verified demo successful when the desktop report opener fails", async () => {
    let stdout = "";
    const context: CliContext = {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: (text) => { stdout += text; }, writeStderr: ignoreOutput },
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        runDemo: async () => ({
          status: "verified",
          issueId: "TVDOCTOR-NAV-DEMO",
          reportPath: "demo-output/report.json",
          replayStatus: "reproduced",
          details: [],
        }),
      },
      runtimeProbe: async () => ({ capabilities: ["remote-input", "ui-tree"] }),
      terminalProgress: { isInteractive: true, update: ignoreOutput, finish: () => undefined },
      reportActions: {
        openReport: async () => { throw new Error("desktop integration unavailable"); },
        showFolder: async () => true,
        copyPath: async () => true,
      },
    };

    await expect(runCli(["demo", "--output", "demo-output"], context))
      .resolves.toBe(EXIT_CODES.success);
    expect(stdout).toContain("Could not open the report automatically:");
    expect(stdout).toContain("demo-output");
  });

  it("installs the matched Chromium runtime automatically on the first scan", async () => {
    let setupCalls = 0;
    let probeCalls = 0;
    let stdout = "";
    const context: CliContext = {
      environment: SUPPORTED_ENVIRONMENT,
      io: {
        writeStdout: (text) => { stdout += text; },
        writeStderr: () => undefined,
      },
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
      runtimeProbe: async () => {
        probeCalls += 1;
        if (probeCalls === 1) throw new Error("browser executable is missing");
        return { capabilities: ["remote-input"] };
      },
      runtimeSetup: async () => { setupCalls += 1; },
    };

    await expect(runCli(["scan", "https://example.test"], context)).resolves.toBe(EXIT_CODES.success);
    expect(setupCalls).toBe(1);
    expect(stdout).toContain("Chromium runtime not found");
    expect(stdout).toContain("Chromium is installed and ready");
  });

  it("runs the first-class web accessibility profile with caption and accessibility packs", async () => {
    let received: import("../src/index.js").TestCommandRequest | null = null;
    const code = await runCli([
      "accessibility", "https://example.test/tv", "--mode", "deep", "--journey", "journey.json",
    ], {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: ignoreOutput, writeStderr: ignoreOutput },
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        testTarget: async (request) => {
          received = request;
          return {
            status: "completed",
            issueCount: 0,
            highestSeverity: null,
            reportPath: "accessibility-report/report.json",
            details: [],
          };
        },
      },
    });

    expect(code).toBe(EXIT_CODES.success);
    expect(received).toMatchObject({
      target: "https://example.test/tv",
      mode: "deep",
      journeyPath: "journey.json",
      packs: ["streaming", "accessibility"],
    });
  });

  it("keeps accessibility-profile pack selection fixed", async () => {
    await expect(captureRun([
      "accessibility", "https://example.test", "--pack", "layout",
    ])).resolves.toMatchObject({
      code: EXIT_CODES.usageError,
      stderr: expect.stringContaining("accessibility selects its packs automatically"),
    });
  });

  it.each<readonly [readonly string[]]>([
    [["accessibility", "--help"]],
    [["accessibility", "-h"]],
    [["help", "accessibility"]],
  ])("prints accessibility-specific help for %j", async (arguments_) => {
    await expect(captureRun(arguments_)).resolves.toEqual({
      code: EXIT_CODES.success,
      stderr: "",
      stdout: `${ACCESSIBILITY_HELP_TEXT}\n`,
    });
  });

  it("prints a static local-first privacy policy", async () => {
    const result = await captureRun(["privacy"]);

    expect(result.code).toBe(EXIT_CODES.success);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("TVDoctor privacy");
    expect(result.stdout).toContain("does not upload reports by default");
    expect(result.stdout).toContain("--no-screenshots");
    expect(result.stdout).toContain("--target-redaction origin");
    expect(result.stdout).toContain("Redaction is defense-in-depth, not a guarantee");
    expect(result.stdout).toContain("review report artifacts before sharing");
    expect(result.stdout).toContain("Android");
    expect(result.stdout).toContain("install");
    expect(result.stdout).toContain("optional video");
    await expect(captureRun(["privacy", "extra"])).resolves.toMatchObject({ code: EXIT_CODES.usageError });
  });

  it("passes screenshot and origin-only privacy controls through web scans", async () => {
    let request: import("../src/index.js").TestCommandRequest | undefined;
    const code = await runCli([
      "scan",
      "https://example.test/private/route?session=secret#fragment",
      "--no-screenshots",
      "--target-redaction",
      "origin",
    ], {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: ignoreOutput, writeStderr: ignoreOutput },
      runtimeProbe: async () => ({ capabilities: ["remote-input", "ui-tree"] }),
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        testTarget: async (received) => {
          request = received;
          return {
            status: "completed",
            issueCount: 0,
            highestSeverity: null,
            reportPath: join("bundle", "report.json"),
            details: [],
          };
        },
      },
    });

    expect(code).toBe(EXIT_CODES.success);
    expect(request).toMatchObject({ screenshots: false, targetRedaction: "origin" });
  });

  it("records web video only when the caller explicitly opts in", async () => {
    const requests: import("../src/index.js").TestCommandRequest[] = [];
    const context: CliContext = {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: ignoreOutput, writeStderr: ignoreOutput },
      runtimeProbe: async () => ({ capabilities: ["remote-input", "ui-tree"] }),
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        testTarget: async (request) => {
          requests.push(request);
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

    await expect(runCli(["scan", "https://example.test"], context)).resolves.toBe(EXIT_CODES.success);
    await expect(runCli(["scan", "https://example.test", "--record-video"], context)).resolves.toBe(EXIT_CODES.success);

    expect(requests[0]?.recordVideo).toBeUndefined();
    expect(requests[1]?.recordVideo).toBe(true);
  });

  it("rejects video recording for Android APK audits instead of simulating support", async () => {
    const result = await captureRun([
      "test", "--apk", "fixture.apk", "--record-video",
    ]);

    expect(result.code).toBe(EXIT_CODES.usageError);
    expect(result.stderr).toContain("--record-video is available only for web audits");
  });

  it("rejects unsupported target-redaction modes", async () => {
    const result = await captureRun([
      "scan", "https://example.test", "--target-redaction", "full",
    ]);
    expect(result.code).toBe(EXIT_CODES.usageError);
    expect(result.stderr).toContain("--target-redaction must be origin");
  });

  it("runs Android APK audits non-interactively with deterministic device selection", async () => {
    let received: { readonly apkPath: string; readonly serial: string; readonly mode: string; readonly screenshots?: boolean } | null = null;
    let stdout = "";
    const code = await runCli([
      "test", "--apk", "D:/apps/example.apk", "--device", "emulator-5554", "--mode", "quick", "--output", "D:/reports/android", "--no-screenshots",
    ], {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: (text) => { stdout += text; }, writeStderr: ignoreOutput },
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        scanAndroidApk: async (request) => {
          received = request;
          return {
            status: "completed",
            issueCount: 0,
            highestSeverity: null,
            reportPath: "D:/reports/android/report.json",
            details: ["All reachable navigation work was exhausted."],
          };
        },
      },
    });
    expect(code).toBe(EXIT_CODES.success);
    expect(received).toMatchObject({ apkPath: "D:/apps/example.apk", serial: "emulator-5554", mode: "quick", screenshots: false });
    expect(stdout).toContain("Result: COMPLETED");
  });

  it("auto-selects the only online Android device when --device is omitted", async () => {
    let receivedSerial: string | null = null;
    let receivedAdbPath: string | undefined;
    let stdout = "";
    const code = await runCli([
      "test", "--apk", "D:/apps/example.apk", "--adb", "D:/sdk/adb.exe",
    ], {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: (text) => { stdout += text; }, writeStderr: ignoreOutput },
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        androidPreflight: async (adbPath) => {
          receivedAdbPath = adbPath;
          return {
            available: true,
            adbPath: adbPath ?? "adb",
            message: "Found 1 online Android device.",
            devices: [{
              serial: "emulator-5554",
              state: "device",
              online: true,
              model: "TV",
              manufacturer: "Android",
              apiLevel: 35,
              supportedAbis: ["x86_64"],
              isTelevision: true,
              detail: null,
            }],
          };
        },
        scanAndroidApk: async (request) => {
          receivedSerial = request.serial;
          return {
            status: "completed",
            issueCount: 0,
            highestSeverity: null,
            reportPath: null,
            details: [],
          };
        },
      },
    });

    expect(code).toBe(EXIT_CODES.success);
    expect(receivedAdbPath).toBe("D:/sdk/adb.exe");
    expect(receivedSerial).toBe("emulator-5554");
    expect(stdout).toContain("Using the only online Android device: emulator-5554\n");
  });

  it("requires --device when multiple Android devices are online", async () => {
    let stderr = "";
    const code = await runCli(["test", "--apk", "D:/apps/example.apk"], {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: ignoreOutput, writeStderr: (text) => { stderr += text; } },
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        androidPreflight: async () => ({
          available: true,
          adbPath: "adb",
          message: "Found 2 online Android devices.",
          devices: [
            {
              serial: "emulator-5554",
              state: "device",
              online: true,
              model: "TV A",
              manufacturer: "Android",
              apiLevel: 35,
              supportedAbis: ["x86_64"],
              isTelevision: true,
              detail: null,
            },
            {
              serial: "emulator-5556",
              state: "device",
              online: true,
              model: "TV B",
              manufacturer: "Android",
              apiLevel: 35,
              supportedAbis: ["x86_64"],
              isTelevision: true,
              detail: null,
            },
          ],
        }),
        scanAndroidApk: async () => {
          throw new Error("scan should not run while device selection is ambiguous");
        },
      },
    });

    expect(code).toBe(EXIT_CODES.usageError);
    expect(stderr).toContain("2 online devices were found; pass --device SERIAL");
  });

  it("reports an environment failure when no Android device is online", async () => {
    let stderr = "";
    const code = await runCli(["test", "--apk", "D:/apps/example.apk"], {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: ignoreOutput, writeStderr: (text) => { stderr += text; } },
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        androidPreflight: async () => ({
          available: true,
          adbPath: "adb",
          message: "ADB is available, but no online Android devices were found.",
          devices: [],
        }),
        scanAndroidApk: async () => {
          throw new Error("scan should not run without an online device");
        },
      },
    });

    expect(code).toBe(EXIT_CODES.environmentFailure);
    expect(stderr).toContain("No online authorized Android device was found.");
    expect(stderr).not.toContain("Run \"tvdoctor --help\" for usage.");
  });

  it("surfaces unavailable ADB/device discovery as an environment failure", async () => {
    let stderr = "";
    const code = await runCli(["test", "--apk", "D:/apps/example.apk"], {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: ignoreOutput, writeStderr: (text) => { stderr += text; } },
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        androidPreflight: async () => ({
          available: false,
          adbPath: null,
          message: "Android platform-tools (ADB) was not found.",
          devices: [],
        }),
        scanAndroidApk: async () => {
          throw new Error("scan should not run without ADB");
        },
      },
    });

    expect(code).toBe(EXIT_CODES.environmentFailure);
    expect(stderr).toBe("Android environment unavailable: Android platform-tools (ADB) was not found.\n");
  });

  it("treats a device discovery crash as execution failure rather than bad usage", async () => {
    let stderr = "";
    const code = await runCli(["test", "--apk", "D:/apps/example.apk"], {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: ignoreOutput, writeStderr: (text) => { stderr += text; } },
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        androidPreflight: async () => {
          throw new Error("ADB server failed unexpectedly");
        },
        scanAndroidApk: async () => {
          throw new Error("scan should not run after discovery failure");
        },
      },
    });

    expect(code).toBe(EXIT_CODES.executionError);
    expect(stderr).toContain("Android device discovery failed: ADB server failed unexpectedly");
    expect(stderr).not.toContain("Run \"tvdoctor --help\" for usage.");
  });

  it("passes Android replay deployment options to the replay operation", async () => {
    let request: import("../src/index.js").ReplayCommandRequest | null = null;
    const code = await runCli([
      "replay", "NAV-1", "--report", "D:/report.json", "--apk", "D:/apps/example.apk", "--device", "emulator-5554",
    ], {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: ignoreOutput, writeStderr: ignoreOutput },
      operations: {
        replayIssue: async (value) => {
          request = value;
          return { status: "reproduced", details: ["Replay classification REPRODUCED"] };
        },
      },
    });
    expect(code).toBe(EXIT_CODES.environmentFailure);
    expect(request).toMatchObject({ apkPath: "D:/apps/example.apk", deviceSerial: "emulator-5554" });
  });

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
    [["start", "--help"]],
    [["start", "-h"]],
    [["help", "start"]],
  ])("prints start-specific help for %j", async (arguments_) => {
    await expect(captureRun(arguments_)).resolves.toEqual({
      code: EXIT_CODES.success,
      stderr: "",
      stdout: `${START_HELP_TEXT}\n`,
    });
  });

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
      expect(DOCTOR_HELP_TEXT).toContain("Chromium");
      expect(DOCTOR_HELP_TEXT).toContain("ADB");
      expect(DOCTOR_HELP_TEXT).toContain("aapt2/aapt");
      expect(DOCTOR_HELP_TEXT).toContain("Observer accessibility");
    },
  );

  it.each<readonly [readonly string[]]>([
    [["setup", "--help"]],
    [["setup", "-h"]],
    [["help", "setup"]],
  ])("prints setup-specific help for %j", async (arguments_) => {
    await expect(captureRun(arguments_)).resolves.toEqual({
      code: EXIT_CODES.success,
      stderr: "",
      stdout: `${SETUP_HELP_TEXT}\n`,
    });
  });

  it.each<readonly [readonly string[]]>([
    [["ci", "--help"]],
    [["ci", "-h"]],
    [["help", "ci"]],
  ])("prints CI-specific help for %j", async (arguments_) => {
    await expect(captureRun(arguments_)).resolves.toEqual({
      code: EXIT_CODES.success,
      stderr: "",
      stdout: `${CI_HELP_TEXT}\n`,
    });
  });

  it.each<readonly [readonly string[]]>([
    [["baseline", "--help"]],
    [["baseline", "-h"]],
    [["help", "baseline"]],
  ])("prints baseline-specific help for %j", async (arguments_) => {
    await expect(captureRun(arguments_)).resolves.toEqual({
      code: EXIT_CODES.success,
      stderr: "",
      stdout: `${BASELINE_HELP_TEXT}\n`,
    });
  });

  it("creates a baseline with an inventory beside the report by default", async () => {
    let stdout = "";
    let request: import("../src/index.js").BaselineCreateRequest | undefined;
    const code = await runCli([
      "baseline", "create", "--report", join("scan", "report.json"), "--output", "baseline.json",
    ], {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: (text) => { stdout += text; }, writeStderr: ignoreOutput },
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        createBaseline: async (value) => {
          request = value;
          return { issueCount: 4, outputPath: "baseline.json" };
        },
      },
    });
    expect(code).toBe(EXIT_CODES.success);
    expect(request).toEqual({
      reportPath: join("scan", "report.json"),
      inventoryPath: join("scan", "inventory.json"),
      outputPath: "baseline.json",
    });
    expect(stdout).toContain("Baseline created from 4 findings.");
  });

  it("prints baseline finding counts and fails only for a regressed comparison", async () => {
    let stdout = "";
    const context: CliContext = {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: (text) => { stdout += text; }, writeStderr: ignoreOutput },
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        compareBaseline: async () => ({
          status: "regressed",
          shouldFail: true,
          newIssues: 2,
          resolvedIssues: 1,
          unchangedIssues: 4,
          structuralRegressions: 1,
          addedFocusTargets: 0,
          removedFocusTargets: 1,
          directionalTransitionChanges: 0,
          latencyRegressions: 0,
          blockers: [],
          outputPath: "comparison.json",
          markdownPath: "comparison.md",
        }),
      },
    };
    const code = await runCli([
      "baseline", "compare", "--baseline", "baseline.json", "--report", join("scan", "report.json"),
    ], context);
    expect(code).toBe(EXIT_CODES.environmentFailure);
    expect(stdout).toContain("2 new, 1 resolved, 4 unchanged findings.");
    expect(stdout).toContain("1 structural or latency regressions.");
    expect(stdout).toContain("Readable comparison: comparison.md");
  });

  it("requires an explicit CI failure policy", async () => {
    await expect(captureRun(["ci", "https://example.test"])).resolves.toMatchObject({
      code: EXIT_CODES.usageError,
      stderr: expect.stringContaining("ci requires --fail-on LEVEL"),
    });
  });

  it("applies the CI severity policy and identifies both CI exports", async () => {
    const passing = await captureRun(["ci", "https://example.test", "--fail-on", "critical"]);
    expect(passing.code).toBe(EXIT_CODES.success);
    expect(passing.stdout).toContain(`CI summary: ${join("tvdoctor-report", "exports", "ci-summary.md")}\n`);
    expect(passing.stdout).toContain(`JUnit: ${join("tvdoctor-report", "exports", "junit.xml")}\n`);

    const failing = await captureRun(["ci", "https://example.test", "--fail-on", "high"]);
    expect(failing.code).toBe(EXIT_CODES.environmentFailure);
  });

  it("keeps review-only high-severity findings visible without failing CI", async () => {
    let stdout = "";
    const code = await runCli(["ci", "https://example.test", "--fail-on", "any"], {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout(text) { stdout += text; }, writeStderr: ignoreOutput },
      runtimeProbe: async () => ({ capabilities: ["remote-input", "ui-tree"] }),
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        testTarget: async () => ({
          status: "completed",
          issueCount: 2,
          highestSeverity: "critical",
          highestVerifiedSeverity: null,
          reportPath: join("tvdoctor-report", "report.json"),
          details: [],
        }),
      },
    });
    expect(code).toBe(EXIT_CODES.success);
    expect(stdout).toContain("2 issues; highest severity: critical");
  });

  it("supports baseline comparison in CI without weakening the explicit finding policy", async () => {
    let comparisons = 0;
    const code = await runCli([
      "ci", "https://example.test", "--fail-on", "high", "--baseline", "reviewed.json",
    ], {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: ignoreOutput, writeStderr: ignoreOutput },
      runtimeProbe: async () => ({ capabilities: ["remote-input", "ui-tree"] }),
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        testTarget: async () => ({
          status: "completed",
          issueCount: 1,
          highestSeverity: "high",
          reportPath: join("tvdoctor-report", "report.json"),
          details: [],
        }),
        compareBaseline: async () => {
          comparisons += 1;
          return {
            status: "identical",
            shouldFail: false,
            newIssues: 0,
            resolvedIssues: 0,
            unchangedIssues: 1,
            structuralRegressions: 0,
            addedFocusTargets: 0,
            removedFocusTargets: 0,
            directionalTransitionChanges: 0,
            latencyRegressions: 0,
            blockers: [],
            outputPath: join("tvdoctor-report", "baseline-comparison.json"),
            markdownPath: join("tvdoctor-report", "baseline-comparison.md"),
          };
        },
      },
    });

    expect(comparisons).toBe(1);
    expect(code).toBe(EXIT_CODES.environmentFailure);
  });

  it("passes a custom journey to web audit and replay but rejects ambiguous startup preparation", async () => {
    let testJourney: string | undefined;
    let replayJourney: string | undefined;
    const context: CliContext = {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: ignoreOutput, writeStderr: ignoreOutput },
      operations: {
        replayIssue: async (request) => {
          replayJourney = request.journeyPath;
          return { status: "fixed", details: [] };
        },
        testTarget: async (request) => {
          testJourney = request.journeyPath;
          return { status: "completed", issueCount: 0, highestSeverity: null, reportPath: null, details: [] };
        },
      },
    };
    await expect(runCli(["test", "https://example.test", "--journey", "journey.json"], context))
      .resolves.toBe(EXIT_CODES.success);
    await expect(runCli(["replay", "TVDOCTOR-NAV-TEST", "--journey", "journey.json"], context))
      .resolves.toBe(EXIT_CODES.success);
    expect(testJourney).toBe("journey.json");
    expect(replayJourney).toBe("journey.json");
    await expect(captureRun([
      "test", "https://example.test", "--journey", "journey.json", "--startup-actions", "SELECT",
    ])).resolves.toMatchObject({
      code: EXIT_CODES.usageError,
      stderr: expect.stringContaining("--journey cannot be combined with --startup-actions"),
    });
  });

  it("installs and verifies the matched Chromium runtime", async () => {
    const events: string[] = [];
    let stdout = "";
    const controller = new AbortController();
    const code = await runCli(["setup"], {
      environment: SUPPORTED_ENVIRONMENT,
      signal: controller.signal,
      io: { writeStdout: (text) => { stdout += text; }, writeStderr: ignoreOutput },
      runtimeSetup: async (signal) => {
        expect(signal).toBe(controller.signal);
        events.push("install");
      },
      runtimeProbe: async () => {
        events.push("verify");
        return { capabilities: ["remote-input"] };
      },
    });
    expect(code).toBe(EXIT_CODES.success);
    expect(events).toEqual(["install", "verify"]);
    expect(stdout).toBe(
      "Phase: SETUP\n" +
      "Status: INSTALLING\n" +
      "Installing TVDoctor's Chromium runtime...\n" +
      "Status: READY\n" +
      "Chromium is installed and ready for TVDoctor.\n",
    );
  });

  it("fails setup without reporting readiness when verification fails", async () => {
    let stdout = "";
    let stderr = "";
    const code = await runCli(["setup"], {
      environment: SUPPORTED_ENVIRONMENT,
      io: {
        writeStdout: (text) => { stdout += text; },
        writeStderr: (text) => { stderr += text; },
      },
      runtimeSetup: async () => undefined,
      runtimeProbe: async () => { throw new Error("browser launch failed\nsecret detail"); },
    });
    expect(code).toBe(EXIT_CODES.executionError);
    expect(stdout).not.toContain("ready");
    expect(stderr).toBe("Chromium setup failed: browser launch failed\n");
    expect(stderr).not.toContain("secret detail");
  });

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
      "Web / Chromium: Chromium launched (remote-input, ui-tree) [ok]",
    );
    expect(result.stdout).toContain(
      "Web audits: ready [ok]",
    );
    expect(result.stdout).toContain("AI/API key: not required [ok]");
    expect(result.stdout).toContain(
      "Doctor checks this host and connected devices only; target application availability is verified when an audit starts.",
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
      "Node.js: v23.9.0 (unsupported; requires >=22.13.0 <23 || >=24.0.0 <25) [unsupported]",
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
        "development-build (unsupported; requires >=22.13.0 <23 || >=24.0.0 <25)",
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
        "Target: https://example.test/app\n" +
        "Status: RUNNING\n" +
        "Auditing https://example.test/app...\n" +
        "Plan: deep mode; packs streaming, accessibility; startup preparation observation-only; bounded resets and replays can take several minutes.\n" +
        "Status: COMPLETED\n" +
        "Result: COMPLETED\n" +
        "Packs 6/6 completed\n" +
        "Actions 42/900\n" +
        "Issues: 2 issues; highest severity: high\n" +
        "Summary: actions 42/900; states unavailable; transitions unavailable; findings 2.\n" +
        `Report: ${join("tvdoctor-report", "report.html")}\n` +
        `Open report: ${join("tvdoctor-report", "report.html")}\n` +
        "Next action: Open the report and replay a VERIFIED finding before accepting the run.\n",
    });
  });

  it("accepts the oldest supported Node.js line", async () => {
    const result = await captureRun(["doctor"], {
      ...SUPPORTED_ENVIRONMENT,
      nodeVersion: "v22.13.0",
    });

    expect(result.code).toBe(EXIT_CODES.success);
    expect(result.stdout).toContain("Node.js: v22.13.0 (supported) [ok]");
  });

  it("defaults web test and CI runs to remote navigation while keeping the full pack explicit", async () => {
    const requests: string[][] = [];
    const context: CliContext = {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: ignoreOutput, writeStderr: ignoreOutput },
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        testTarget: async (request) => {
          requests.push([...request.packs]);
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

    await expect(runCli(["test", "https://example.test"], context)).resolves.toBe(EXIT_CODES.success);
    await expect(runCli(["test", "https://example.test", "--pack", "all"], context)).resolves.toBe(EXIT_CODES.success);
    await expect(runCli(["ci", "https://example.test", "--fail-on", "never"], context)).resolves.toBe(EXIT_CODES.success);
    await expect(runCli([
      "ci", "https://example.test", "--fail-on", "never", "--pack", "all",
    ], context)).resolves.toBe(EXIT_CODES.success);
    expect(requests).toEqual([["navigation"], ["all"], ["navigation"], ["all"]]);
  });

  it("rejects unknown commands with a deterministic usage exit code", async () => {
    await expect(captureRun(["nonsense", "https://example.test"])).resolves.toEqual({
      code: EXIT_CODES.usageError,
      stdout: "",
      stderr:
        "Error: unknown command: nonsense\nRun \"tvdoctor --help\" for usage.\n",
    });
  });

  it("accepts repeated TAB inputs for explicit startup preparation", async () => {
    const received: import("../src/index.js").TestCommandRequest[] = [];
    const code = await runCli([
      "test", "https://example.test", "--startup-actions", "TAB,TAB,TAB,TAB,SELECT",
    ], {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: ignoreOutput, writeStderr: ignoreOutput },
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        testTarget: async (request) => {
          received.push(request);
          return {
            status: "completed",
            issueCount: 0,
            highestSeverity: null,
            reportPath: "tvdoctor-report/report.json",
            details: [],
          };
        },
      },
    });

    expect(code).toBe(EXIT_CODES.success);
    expect(received[0]?.startupActions).toEqual(["TAB", "TAB", "TAB", "TAB", "SELECT"]);
  });

  it.each([
    [["test"], "test requires a URL"],
    [["test", "not-a-url"], "test target must be an absolute HTTP(S) URL without credentials"],
    [["test", "https://u:p@example.test"], "test target must be an absolute HTTP(S) URL without credentials"],
    [["test", "https://example.test", "--pack", "unknown"], "unknown test pack: unknown"],
    [["test", "https://example.test", "--mode", "turbo"], "unknown test mode: turbo"],
    [["test", "https://example.test", "--pack", "all", "--pack", "streaming"], "--pack all cannot be combined with another pack"],
    [["test", "https://example.test", "--startup-actions", "POWER"], "--startup-actions accepts only known remote keys"],
    [["test", "https://example.test", "--max-duration-ms", "0"], "--max-duration-ms must be a positive safe integer no greater than 2147483647"],
    [["test", "https://example.test", "--max-duration-ms", "99999999999"], "--max-duration-ms must be a positive safe integer no greater than 2147483647"],
    [["test", "https://example.test", "--max-actions", "0"], "--max-actions must be a positive safe integer no greater than 1000000"],
    [["test", "https://example.test", "--max-actions", "1000001"], "--max-actions must be a positive safe integer no greater than 1000000"],
    [["test", "https://example.test", "--max-states", "100001"], "--max-states must be a positive safe integer no greater than 100000"],
    [["test", "https://example.test", "--max-depth", "-1"], "--max-depth must be a non-negative safe integer no greater than 4096"],
    [["test", "https://example.test", "--max-depth", "4097"], "--max-depth must be a non-negative safe integer no greater than 4096"],
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
    expect(stdout).toBe(
      "Phase: REPLAY\n" +
      "Status: RUNNING\n" +
      "Replaying TVDOCTOR-NAV-HEURISTIC...\n" +
      "Status: ERROR\n",
    );
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
      expect(result.code).toBe(code);
      expect(result.stderr).toBe(finalStderr);
      expect(result.stdout).toContain("Phase: REPLAY\nStatus: RUNNING\nReplaying TVDOCTOR-NAV-TEST...\n");
      expect(result.stdout).toContain("Checkpoint PASS\n");
      expect(result.stdout).toContain(`Status: ${status.toUpperCase()}\n`);
      expect(result.stdout).toContain("Report: bundle/report.json\n");
      if (finalStdout.length > 0) expect(result.stdout).toContain(finalStdout);
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
      "Target: https://example.test/watch\n" +
      "Status: RUNNING\n" +
      "Auditing https://example.test/watch...\n" +
      "Plan: standard mode; remote navigation; startup preparation observation-only; bounded resets and replays can take several minutes.\n" +
      "Status: FAILED\n",
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

  it("passes the cooperative shutdown signal to replay", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const context: CliContext = {
      environment: SUPPORTED_ENVIRONMENT,
      signal: controller.signal,
      io: { writeStdout: ignoreOutput, writeStderr: ignoreOutput },
      operations: {
        async replayIssue(request) {
          receivedSignal = request.signal;
          return { status: "inconclusive", details: [] };
        },
      },
    };

    await expect(runCli(["replay", "TVDOCTOR-NAV-TEST"], context))
      .resolves.toBe(EXIT_CODES.replayInconclusive);
    expect(receivedSignal).toBe(controller.signal);
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
      "Web / Chromium: Chromium is unavailable. Run \"tvdoctor setup\" and try again. [unavailable]",
    );
    expect(stdout).not.toContain("Call log");
  });

  it("diagnoses Android prerequisites without making optional Android setup fail a ready web install", async () => {
    let stdout = "";
    const operations = {
      replayIssue: async () => ({ status: "fixed" as const, details: [] }),
      testTarget: async () => ({
        status: "completed" as const,
        issueCount: 0,
        highestSeverity: null,
        reportPath: null,
        details: [],
      }),
      androidPreflight: async () => ({
        available: false,
        adbPath: null,
        message: "Android platform-tools (ADB) was not found.",
        devices: [],
      }),
      androidBuildToolsPreflight: async () => ({
        available: false,
        path: null,
        detail: "Android SDK build-tools (aapt2/aapt) were not found.",
      }),
      androidObserverPreflight: async () => ({
        status: "unavailable" as const,
        detail: "No authorized Android TV device is available to inspect Observer accessibility readiness.",
      }),
    };
    const context: CliContext = {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: (text) => { stdout += text; }, writeStderr: ignoreOutput },
      operations: operations as unknown as NonNullable<CliContext["operations"]>,
      runtimeProbe: async () => ({ capabilities: ["remote-input", "ui-tree"] }),
    };

    await expect(runCli(["doctor"], context)).resolves.toBe(EXIT_CODES.success);
    expect(stdout).toContain("Web audits: ready [ok]");
    expect(stdout).toContain("Android ADB: Android platform-tools (ADB) was not found. Install Android SDK platform-tools");
    expect(stdout).toContain("Android build-tools: Android SDK build-tools (aapt2/aapt) were not found. Install Android SDK build-tools");
    expect(stdout).toContain("Android TV: not configured; web audits are still ready [unavailable]");
    expect(stdout).toContain("Install Android SDK platform-tools");
  });

  it("reports an Android TV as ready only when ADB, build-tools, device, and Observer are ready", async () => {
    let stdout = "";
    const operations = {
      replayIssue: async () => ({ status: "fixed" as const, details: [] }),
      testTarget: async () => ({
        status: "completed" as const,
        issueCount: 0,
        highestSeverity: null,
        reportPath: null,
        details: [],
      }),
      androidPreflight: async () => ({
        available: true,
        adbPath: "/sdk/platform-tools/adb",
        message: "Found 1 online Android device.",
        devices: [{
          serial: "emulator-5554",
          state: "device",
          online: true,
          model: "Android TV",
          manufacturer: "Google",
          apiLevel: 36,
          supportedAbis: ["x86_64"],
          isTelevision: true,
          detail: null,
        }],
      }),
      androidBuildToolsPreflight: async () => ({
        available: true,
        path: "/sdk/build-tools/36.0.0/aapt2",
        detail: "aapt2 36.0.0 is available.",
      }),
      androidObserverPreflight: async () => ({
        status: "ok" as const,
        detail: "TVDoctor Observer is installed and accessibility access is enabled on emulator-5554.",
      }),
      scanAndroidApk: async () => { throw new Error("doctor should not run an Android audit"); },
    };
    const context: CliContext = {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: (text) => { stdout += text; }, writeStderr: ignoreOutput },
      operations: operations as unknown as NonNullable<CliContext["operations"]>,
      runtimeProbe: async () => ({ capabilities: ["remote-input", "ui-tree"] }),
    };

    await expect(runCli(["doctor"], context)).resolves.toBe(EXIT_CODES.success);
    expect(stdout).toContain("Android device: Google Android TV; API 36; emulator-5554 [ok]");
    expect(stdout).toContain("Android Observer: TVDoctor Observer is installed and accessibility access is enabled on emulator-5554. [ok]");
    expect(stdout).toContain("Android TV: ready [ok]");
  });

  it("keeps web-ready doctor successful when Android build-tools are missing", async () => {
    let stdout = "";
    const context: CliContext = {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: (text) => { stdout += text; }, writeStderr: ignoreOutput },
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        testTarget: async () => ({
          status: "completed", issueCount: 0, highestSeverity: null, reportPath: null, details: [],
        }),
        androidPreflight: async () => ({
          available: true,
          adbPath: "adb",
          message: "Found 1 online Android device.",
          devices: [{
            serial: "tv-1", state: "device", online: true, model: "Android TV", manufacturer: "Google",
            apiLevel: 36, supportedAbis: ["arm64-v8a"], isTelevision: true, detail: null,
          }],
        }),
        androidBuildToolsPreflight: async () => ({
          available: false,
          path: null,
          detail: "Android SDK build-tools (aapt2/aapt) were not found.",
        }),
        androidObserverPreflight: async () => ({
          status: "ok",
          detail: "TVDoctor Observer is installed and accessibility access is enabled on tv-1.",
        }),
      },
      runtimeProbe: async () => ({ capabilities: ["remote-input", "ui-tree"] }),
    };

    await expect(runCli(["doctor"], context)).resolves.toBe(EXIT_CODES.success);
    expect(stdout).toContain("Android build-tools: Android SDK build-tools (aapt2/aapt) were not found. Install Android SDK build-tools");
    expect(stdout).toContain("Android TV: not configured; web audits are still ready [unavailable]");
  });

  it("keeps web-ready doctor successful when ADB has no connected device", async () => {
    let stdout = "";
    let observerCalls = 0;
    const context: CliContext = {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: (text) => { stdout += text; }, writeStderr: ignoreOutput },
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        testTarget: async () => ({
          status: "completed", issueCount: 0, highestSeverity: null, reportPath: null, details: [],
        }),
        androidPreflight: async () => ({
          available: true,
          adbPath: "adb",
          message: "ADB is available, but no online Android devices were found.",
          devices: [],
        }),
        androidBuildToolsPreflight: async () => ({ available: true, path: "aapt2", detail: "aapt2 is available." }),
        androidObserverPreflight: async () => {
          observerCalls += 1;
          return { status: "ok", detail: "unexpected" };
        },
      },
      runtimeProbe: async () => ({ capabilities: ["remote-input", "ui-tree"] }),
    };

    await expect(runCli(["doctor"], context)).resolves.toBe(EXIT_CODES.success);
    expect(stdout).toContain("Android device: No authorized Android TV device is online. Connect or start one and accept ADB authorization. [unavailable]");
    expect(stdout).toContain("Android TV: not configured; web audits are still ready [unavailable]");
    expect(observerCalls).toBe(0);
  });

  it.each([
    ["unauthorized", "Unauthorized. Accept the USB debugging prompt on the device."],
    ["offline", "Offline. Wake or reconnect the device."],
  ] as const)("surfaces %s Android state without failing a ready web surface", async (state, detail) => {
    let stdout = "";
    const context: CliContext = {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: (text) => { stdout += text; }, writeStderr: ignoreOutput },
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        testTarget: async () => ({
          status: "completed", issueCount: 0, highestSeverity: null, reportPath: null, details: [],
        }),
        androidPreflight: async () => ({
          available: true,
          adbPath: "adb",
          message: "ADB is available, but no online Android devices were found.",
          devices: [{
            serial: "tv-1", state, online: false, model: "Android TV", manufacturer: null,
            apiLevel: null, supportedAbis: [], isTelevision: null, detail,
          }],
        }),
        androidBuildToolsPreflight: async () => ({ available: true, path: "aapt2", detail: "aapt2 is available." }),
      },
      runtimeProbe: async () => ({ capabilities: ["remote-input", "ui-tree"] }),
    };

    await expect(runCli(["doctor"], context)).resolves.toBe(EXIT_CODES.success);
    expect(stdout).toContain(`Android device: ${detail} [unavailable]`);
    expect(stdout).toContain("Android TV: not configured; web audits are still ready [unavailable]");
  });

  it("marks an authorized non-TV Android device unsupported", async () => {
    let stdout = "";
    const context: CliContext = {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: (text) => { stdout += text; }, writeStderr: ignoreOutput },
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        testTarget: async () => ({
          status: "completed", issueCount: 0, highestSeverity: null, reportPath: null, details: [],
        }),
        androidPreflight: async () => ({
          available: true,
          adbPath: "adb",
          message: "Found 1 online Android device.",
          devices: [{
            serial: "phone-1", state: "device", online: true, model: "Pixel", manufacturer: "Google",
            apiLevel: 36, supportedAbis: ["arm64-v8a"], isTelevision: false, detail: null,
          }],
        }),
        androidBuildToolsPreflight: async () => ({ available: true, path: "aapt2", detail: "aapt2 is available." }),
      },
      runtimeProbe: async () => ({ capabilities: ["remote-input", "ui-tree"] }),
    };

    await expect(runCli(["doctor"], context)).resolves.toBe(EXIT_CODES.success);
    expect(stdout).toContain("Android device: Connected authorized Android devices are not identified as television devices. [unsupported]");
    expect(stdout).toContain("Android TV: not configured; web audits are still ready [unsupported]");
  });

  it("marks Android TV API below the Observer minimum unsupported", async () => {
    let stdout = "";
    const context: CliContext = {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: (text) => { stdout += text; }, writeStderr: ignoreOutput },
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        testTarget: async () => ({
          status: "completed", issueCount: 0, highestSeverity: null, reportPath: null, details: [],
        }),
        androidPreflight: async () => ({
          available: true,
          adbPath: "adb",
          message: "Found 1 online Android device.",
          devices: [{
            serial: "tv-22", state: "device", online: true, model: "Legacy TV", manufacturer: "Example",
            apiLevel: 22, supportedAbis: ["armeabi-v7a"], isTelevision: true, detail: null,
          }],
        }),
        androidBuildToolsPreflight: async () => ({ available: true, path: "aapt2", detail: "aapt2 is available." }),
      },
      runtimeProbe: async () => ({ capabilities: ["remote-input", "ui-tree"] }),
    };

    await expect(runCli(["doctor"], context)).resolves.toBe(EXIT_CODES.success);
    expect(stdout).toContain("Android device: Android TV API 22 is unsupported; TVDoctor Observer requires API 23 or newer. [unsupported]");
    expect(stdout).toContain("Android TV: not configured; web audits are still ready [unsupported]");
  });

  it.each([
    [
      "absent",
      "TVDoctor Observer is not installed on tv-1. Start an Android TV scan once to install it, then enable its accessibility access.",
    ],
    [
      "disabled",
      "TVDoctor Observer is installed on tv-1, but accessibility access is not enabled. Enable TVDoctor Observer in Android Accessibility settings.",
    ],
  ] as const)("keeps web-ready doctor successful when the Android Observer is %s", async (_state, detail) => {
    let stdout = "";
    const context: CliContext = {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: (text) => { stdout += text; }, writeStderr: ignoreOutput },
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        testTarget: async () => ({
          status: "completed", issueCount: 0, highestSeverity: null, reportPath: null, details: [],
        }),
        androidPreflight: async () => ({
          available: true,
          adbPath: "adb",
          message: "Found 1 online Android device.",
          devices: [{
            serial: "tv-1", state: "device", online: true, model: "Android TV", manufacturer: "Google",
            apiLevel: 36, supportedAbis: ["arm64-v8a"], isTelevision: true, detail: null,
          }],
        }),
        androidBuildToolsPreflight: async () => ({ available: true, path: "aapt2", detail: "aapt2 is available." }),
        androidObserverPreflight: async () => ({ status: "unavailable", detail }),
      },
      runtimeProbe: async () => ({ capabilities: ["remote-input", "ui-tree"] }),
    };

    await expect(runCli(["doctor"], context)).resolves.toBe(EXIT_CODES.success);
    expect(stdout).toContain(`Android Observer: ${detail} [unavailable]`);
    expect(stdout).toContain("Android TV: not configured; web audits are still ready [unavailable]");
  });

  it("surfaces Android metadata-probe failure without claiming the device is absent", async () => {
    let stdout = "";
    const context: CliContext = {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: (text) => { stdout += text; }, writeStderr: ignoreOutput },
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        testTarget: async () => ({
          status: "completed", issueCount: 0, highestSeverity: null, reportPath: null, details: [],
        }),
        androidPreflight: async () => ({
          available: true,
          adbPath: "adb",
          message: "ADB found 1 online Android device, but TVDoctor could not read its metadata.",
          devices: [{
            serial: "tv-1", state: "device", online: false, model: "Android TV", manufacturer: null,
            apiLevel: null, supportedAbis: [], isTelevision: null, detail: "device metadata probe failed",
          }],
        }),
        androidBuildToolsPreflight: async () => ({ available: true, path: "aapt2", detail: "aapt2 is available." }),
      },
      runtimeProbe: async () => ({ capabilities: ["remote-input", "ui-tree"] }),
    };

    await expect(runCli(["doctor"], context)).resolves.toBe(EXIT_CODES.success);
    expect(stdout).toContain("Android device: device metadata probe failed [unavailable]");
    expect(stdout).not.toContain("Android device: No authorized Android TV device is online");
  });

  it("returns success when web is unavailable but the Android surface is fully ready", async () => {
    let stdout = "";
    const context: CliContext = {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: (text) => { stdout += text; }, writeStderr: ignoreOutput },
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        testTarget: async () => ({
          status: "completed", issueCount: 0, highestSeverity: null, reportPath: null, details: [],
        }),
        androidPreflight: async () => ({
          available: true,
          adbPath: "adb",
          message: "Found 1 online Android device.",
          devices: [{
            serial: "tv-1", state: "device", online: true, model: "Android TV", manufacturer: "Google",
            apiLevel: 36, supportedAbis: ["arm64-v8a"], isTelevision: true, detail: null,
          }],
        }),
        androidBuildToolsPreflight: async () => ({ available: true, path: "aapt2", detail: "aapt2 is available." }),
        androidObserverPreflight: async () => ({
          status: "ok",
          detail: "TVDoctor Observer is installed and accessibility access is enabled on tv-1.",
        }),
        scanAndroidApk: async () => { throw new Error("doctor should not run an Android audit"); },
      },
      runtimeProbe: async () => { throw new Error("browserType.launch: Executable doesn't exist"); },
    };

    await expect(runCli(["doctor"], context)).resolves.toBe(EXIT_CODES.success);
    expect(stdout).toContain("Web / Chromium: Chromium is unavailable. Run \"tvdoctor setup\" and try again. [unavailable]");
    expect(stdout).toContain("Android TV: ready [ok]");
  });

  it("finds a ready Observer on a later compatible TV instead of failing on the first device", async () => {
    let stdout = "";
    const probedSerials: string[] = [];
    const context: CliContext = {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: (text) => { stdout += text; }, writeStderr: ignoreOutput },
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        testTarget: async () => ({
          status: "completed", issueCount: 0, highestSeverity: null, reportPath: null, details: [],
        }),
        androidPreflight: async () => ({
          available: true,
          adbPath: "adb",
          message: "Found 2 online Android devices.",
          devices: [
            {
              serial: "tv-1", state: "device", online: true, model: "TV A", manufacturer: "Google",
              apiLevel: 36, supportedAbis: ["arm64-v8a"], isTelevision: true, detail: null,
            },
            {
              serial: "tv-2", state: "device", online: true, model: "TV B", manufacturer: "Google",
              apiLevel: 36, supportedAbis: ["arm64-v8a"], isTelevision: true, detail: null,
            },
          ],
        }),
        androidBuildToolsPreflight: async () => ({ available: true, path: "aapt2", detail: "aapt2 is available." }),
        androidObserverPreflight: async (_adbPath, serial) => {
          probedSerials.push(serial);
          return serial === "tv-2"
            ? { status: "ok", detail: "TVDoctor Observer is installed and accessibility access is enabled on tv-2." }
            : { status: "unavailable", detail: "TVDoctor Observer is not installed on tv-1." };
        },
        scanAndroidApk: async () => { throw new Error("doctor should not run an Android audit"); },
      },
      runtimeProbe: async () => { throw new Error("browserType.launch: Executable doesn't exist"); },
    };

    await expect(runCli(["doctor"], context)).resolves.toBe(EXIT_CODES.success);
    expect(probedSerials).toEqual(["tv-1", "tv-2"]);
    expect(stdout).toContain("Android device: Google TV B; API 36; tv-2 [ok]");
    expect(stdout).toContain("Android Observer: TVDoctor Observer is installed and accessibility access is enabled on tv-2. [ok]");
    expect(stdout).toContain("Android TV: ready [ok]");
  });

  it("does not claim Android-only readiness when the Android audit operation is unavailable", async () => {
    let stdout = "";
    const context: CliContext = {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: (text) => { stdout += text; }, writeStderr: ignoreOutput },
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        testTarget: async () => ({
          status: "completed", issueCount: 0, highestSeverity: null, reportPath: null, details: [],
        }),
        androidPreflight: async () => ({
          available: true,
          adbPath: "adb",
          message: "Found 1 online Android device.",
          devices: [{
            serial: "tv-1", state: "device", online: true, model: "Android TV", manufacturer: "Google",
            apiLevel: 36, supportedAbis: ["arm64-v8a"], isTelevision: true, detail: null,
          }],
        }),
        androidBuildToolsPreflight: async () => ({ available: true, path: "aapt2", detail: "aapt2 is available." }),
        androidObserverPreflight: async () => ({
          status: "ok",
          detail: "TVDoctor Observer is installed and accessibility access is enabled on tv-1.",
        }),
      },
      runtimeProbe: async () => { throw new Error("browserType.launch: Executable doesn't exist"); },
    };

    await expect(runCli(["doctor"], context)).resolves.toBe(EXIT_CODES.environmentFailure);
    expect(stdout).toContain("Android TV: audit operation unavailable in this host [unavailable]");
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
      "Web audits: unavailable in this host [unavailable]",
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
    expect(stdout).toContain(`Open report: ${join("output", "report.html")}\n`);
    expect(stdout).not.toContain("Canonical JSON:");
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

  it("prints deterministic scan phase, status, coverage summary, and sanitized target", async () => {
    let stdout = "";
    const code = await runCli([
      "scan",
      "https://example.test/watch?token=top-secret#account",
      "--output",
      "scan-output",
    ], {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: (text) => { stdout += text; }, writeStderr: ignoreOutput },
      runtimeProbe: async () => ({ capabilities: ["remote-input", "ui-tree"] }),
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        testTarget: async () => ({
          status: "completed",
          issueCount: 2,
          highestSeverity: "high",
          reportPath: join("scan-output", "report.json"),
          details: ["Actions 18/900", "States 4/40", "Transitions 12"],
        }),
      },
    });

    expect(code).toBe(EXIT_CODES.environmentFailure);
    expect(stdout).toContain("Phase: SCAN\n");
    expect(stdout).toContain("Status: RUNNING\n");
    expect(stdout).toContain("Target: https://example.test/watch\n");
    expect(stdout).toContain("Status: COMPLETED\n");
    expect(stdout).toContain("Summary: actions 18/900; states 4/40; transitions 12; findings 2.\n");
    expect(stdout).toContain(`Report: ${join("scan-output", "report.html")}\n`);
    expect(stdout).toContain("Next action: Open the report and replay a VERIFIED finding");
    expect(stdout).not.toMatch(/top-secret|#account/u);
  });

  it("prints deterministic setup and replay phase/status lines with the replay report and next action", async () => {
    let setupStdout = "";
    await expect(runCli(["setup"], {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: (text) => { setupStdout += text; }, writeStderr: ignoreOutput },
      runtimeSetup: async () => undefined,
      runtimeProbe: async () => ({ capabilities: ["remote-input"] }),
    })).resolves.toBe(EXIT_CODES.success);
    expect(setupStdout).toContain("Phase: SETUP\n");
    expect(setupStdout).toContain("Status: INSTALLING\n");
    expect(setupStdout).toContain("Status: READY\n");

    let replayStdout = "";
    await expect(runCli([
      "replay", "TVDOCTOR-NAV-TEST", "--report", join("bundle", "report.json"),
    ], {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: (text) => { replayStdout += text; }, writeStderr: ignoreOutput },
      operations: {
        replayIssue: async () => ({ status: "reproduced", details: ["Replay classification REPRODUCED"] }),
      },
    })).resolves.toBe(EXIT_CODES.environmentFailure);
    expect(replayStdout).toContain("Phase: REPLAY\n");
    expect(replayStdout).toContain("Status: RUNNING\n");
    expect(replayStdout).toContain("Status: REPRODUCED\n");
    expect(replayStdout).toContain(`Report: ${join("bundle", "report.json")}\n`);
    expect(replayStdout).toContain("Next action: Open the report and fix the reproduced finding, then rerun replay.\n");
  });

  it("prints deterministic demo coverage summary and replay next action", async () => {
    let stdout = "";
    const code = await runCli(["demo", "--output", "demo-output"], {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: (text) => { stdout += text; }, writeStderr: ignoreOutput },
      runtimeProbe: async () => ({ capabilities: ["remote-input", "ui-tree"] }),
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        runDemo: async () => ({
          status: "verified",
          issueId: "TVDOCTOR-NAV-DEMO",
          reportPath: join("demo-output", "report.json"),
          replayStatus: "reproduced",
          details: ["Actions 6/300", "States 1; issues 1; evidence failures 0", "Transitions 5"],
        }),
      },
    });

    expect(code).toBe(EXIT_CODES.success);
    expect(stdout).toContain("Phase: DEMO\n");
    expect(stdout).toContain("Status: RUNNING\n");
    expect(stdout).toContain("Status: VERIFIED\n");
    expect(stdout).toContain("Summary: actions 6/300; states 1; transitions 5; findings 1.\n");
    expect(stdout).toContain(`Report: ${join("demo-output", "report.html")}\n`);
    expect(stdout).toContain("Next action: tvdoctor replay TVDOCTOR-NAV-DEMO --report");
  });

  it("prints deterministic baseline-comparison phase/status and review next action", async () => {
    let stdout = "";
    const code = await runCli([
      "baseline", "compare", "--baseline", "baseline.json", "--report", join("scan", "report.json"),
    ], {
      environment: SUPPORTED_ENVIRONMENT,
      io: { writeStdout: (text) => { stdout += text; }, writeStderr: ignoreOutput },
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        compareBaseline: async () => ({
          status: "changed",
          shouldFail: false,
          newIssues: 0,
          resolvedIssues: 1,
          unchangedIssues: 2,
          structuralRegressions: 0,
          addedFocusTargets: 1,
          removedFocusTargets: 0,
          directionalTransitionChanges: 1,
          latencyRegressions: 0,
          blockers: [],
          outputPath: "comparison.json",
          markdownPath: "comparison.md",
        }),
      },
    });

    expect(code).toBe(EXIT_CODES.success);
    expect(stdout).toContain("Phase: BASELINE COMPARISON\n");
    expect(stdout).toContain("Status: RUNNING\n");
    expect(stdout).toContain("Status: CHANGED\n");
    expect(stdout).toContain("Comparison summary: findings +0/-1; focus targets +1/-0; directional transitions 1; latency regressions 0.\n");
    expect(stdout).toContain("Next action: Review comparison: comparison.md\n");
  });

  it("documents source-checkout invocation and exact standalone replay exit codes in CLI help", () => {
    expect(HELP_TEXT).toContain("Source checkout: npm run tvdoctor -- <command> [...options]");
    expect(REPLAY_HELP_TEXT).toContain("REPRODUCED exits 1");
    expect(REPLAY_HELP_TEXT).toContain("FIXED exits 0");
    expect(REPLAY_HELP_TEXT).toContain("INCONCLUSIVE exits 3");
  });
});
