import { join } from "node:path";

import { EXPLORATION_BUDGET_PROFILES, MAX_EXPLORATION_BUDGETS } from "@tvdoctor/core";
import { describe, expect, it, vi } from "vitest";

import {
  EXIT_CODES,
  runCli,
  type CliContext,
  type TestCommandRequest,
} from "../src/cli.js";

const TARGET = "https://example.test/app";

function harness(result: "completed" | "partial" | "failed" = "completed") {
  let stdout = "";
  let stderr = "";
  const captured: TestCommandRequest[] = [];
  const runtimeProbe = vi.fn(async () => ({ capabilities: ["remote-input", "ui-tree"] }));
  const testTarget = vi.fn(async (request: TestCommandRequest) => {
    captured.push(request);
    return {
      status: result,
      issueCount: 0,
      highestSeverity: null,
      reportPath: join(request.outputPath, "report.json"),
      details: ["Actions 6/300", "States 3/75", "Transitions 4"],
    } as const;
  });
  const context: CliContext = {
    environment: { nodeVersion: "v24.18.0", platform: "win32", architecture: "x64" },
    io: {
      writeStdout: (text) => { stdout += text; },
      writeStderr: (text) => { stderr += text; },
    },
    runtimeProbe,
    operations: {
      replayIssue: async () => ({ status: "fixed", details: [] }),
      testTarget,
    },
  };
  return {
    run: (args: readonly string[]) => runCli(args, context),
    captured,
    testTarget,
    runtimeProbe,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe("scan mode selection and resource envelopes (no real browser/scans)", () => {
  it.each([
    { mode: "quick" as const, seconds: 30, actions: 300, states: 75, depth: 8 },
    { mode: "standard" as const, seconds: 120, actions: 2500, states: 250, depth: 16 },
    { mode: "deep" as const, seconds: 1800, actions: 10000, states: 1000, depth: 32 },
  ])("selects $mode with the $seconds-second exploration profile", async ({ mode, seconds, actions, states, depth }) => {
    const h = harness();
    const result = await h.run(["scan", TARGET, "--mode", mode, "--output", `${mode}-results`]);
    expect(result).toBe(EXIT_CODES.success);
    expect(h.captured).toHaveLength(1);
    const request = h.captured[0];
    expect(request).toMatchObject({
      target: TARGET,
      mode,
      packs: ["navigation"],
      outputPath: `${mode}-results`,
      searchQuery: "N",
      disableRepetitionCompression: true,
    });
    expect(request?.maxDurationMs).toBeUndefined();
    expect(request?.navigationBudgets).toBeUndefined();
    expect(EXPLORATION_BUDGET_PROFILES[mode]).toEqual({
      maxDurationMs: seconds * 1000,
      maxActions: actions,
      maxStates: states,
      maxDepth: depth,
    });
    expect(h.stdout()).toContain("Phase: SCAN");
    expect(h.stdout()).toContain(`Plan: ${mode} mode; remote navigation`);
    expect(h.stdout()).toContain(`Report: ${join(`${mode}-results`, "report.html")}`);
    expect(h.stderr()).toBe("");
  });

  it("defaults scan to standard, keeps default output mode-specific, and never adds diagnostic packs", async () => {
    const standard = harness();
    expect(await standard.run(["scan", TARGET])).toBe(EXIT_CODES.success);
    expect(standard.captured[0]).toMatchObject({
      mode: "standard", packs: ["navigation"], disableRepetitionCompression: true,
    });
    expect(standard.captured[0]?.outputPath).toContain("standard");

    const quick = harness();
    expect(await quick.run(["scan", TARGET, "--mode", "quick"])).toBe(EXIT_CODES.success);
    expect(quick.captured[0]?.outputPath).toContain("quick");
    expect(quick.captured[0]?.packs).toEqual(["navigation"]);
    expect(quick.captured[0]?.outputPath).not.toBe(standard.captured[0]?.outputPath);
  });

  it("overrides only explicitly supplied navigation ceilings, including 0-depth", async () => {
    const h = harness();
    expect(await h.run([
      "scan", TARGET, "--mode", "deep", "--max-duration-ms", "240000",
      "--max-actions", "6000", "--max-states", "900", "--max-depth", "0",
      "--no-compression", "--no-screenshots", "--record-video",
    ])).toBe(EXIT_CODES.success);
    expect(h.captured[0]).toMatchObject({
      mode: "deep",
      maxDurationMs: 240000,
      navigationBudgets: { maxActions: 6000, maxStates: 900, maxDepth: 0 },
      disableRepetitionCompression: true,
      screenshots: false,
      recordVideo: true,
      packs: ["navigation"],
    });
    const onlyDuration = harness();
    expect(await onlyDuration.run(["scan", TARGET, "--mode", "quick", "--max-duration-ms", "120000"])).toBe(EXIT_CODES.success);
    expect(onlyDuration.captured[0]?.navigationBudgets).toBeUndefined();
    expect(onlyDuration.captured[0]?.maxDurationMs).toBe(120000);
  });

  it("respects exact numeric ceilings, but rejects every value beyond them", async () => {
    const accepted = harness();
    expect(await accepted.run([
      "scan", TARGET, "--max-duration-ms", String(MAX_EXPLORATION_BUDGETS.maxDurationMs),
      "--max-actions", String(MAX_EXPLORATION_BUDGETS.maxActions),
      "--max-states", String(MAX_EXPLORATION_BUDGETS.maxStates),
      "--max-depth", String(MAX_EXPLORATION_BUDGETS.maxDepth),
    ])).toBe(EXIT_CODES.success);
    expect(accepted.captured[0]).toMatchObject({
      maxDurationMs: MAX_EXPLORATION_BUDGETS.maxDurationMs,
      navigationBudgets: {
        maxActions: MAX_EXPLORATION_BUDGETS.maxActions,
        maxStates: MAX_EXPLORATION_BUDGETS.maxStates,
        maxDepth: MAX_EXPLORATION_BUDGETS.maxDepth,
      },
    });
    for (const [flag, above] of [
      ["--max-duration-ms", MAX_EXPLORATION_BUDGETS.maxDurationMs + 1],
      ["--max-actions", MAX_EXPLORATION_BUDGETS.maxActions + 1],
      ["--max-states", MAX_EXPLORATION_BUDGETS.maxStates + 1],
      ["--max-depth", MAX_EXPLORATION_BUDGETS.maxDepth + 1],
    ] as const) {
      const h = harness();
      expect(await h.run(["scan", TARGET, flag, String(above)])).toBe(EXIT_CODES.usageError);
      expect(h.testTarget).not.toHaveBeenCalled();
      expect(h.runtimeProbe).not.toHaveBeenCalled();
    }
  });

  it.each(["--max-duration-ms", "--max-actions", "--max-states", "--max-depth"])(
    "rejects missing and malformed %s values before any scan starts", async (flag) => {
      for (const args of [
        [flag], [flag, "--mode", "quick"], [flag, ""], [flag, "-1"], [flag, "1.5"],
        [flag, "1e3"], [flag, "0x10"], [flag, "Infinity"], [flag, "9007199254740992"],
      ]) {
        const h = harness();
        const code = await h.run(["scan", TARGET, ...args]);
        expect(code, `${flag}: ${args.join(" ")}`).toBe(EXIT_CODES.usageError);
        expect(h.testTarget).not.toHaveBeenCalled();
        expect(h.runtimeProbe).not.toHaveBeenCalled();
        expect(h.stderr()).not.toBe("");
      }
      if (flag !== "--max-depth") {
        const h = harness();
        expect(await h.run(["scan", TARGET, flag, "0"])).toBe(EXIT_CODES.usageError);
        expect(h.testTarget).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects invalid scan modes, unknown flags, Android APKs and diagnostic packs before operation", async () => {
    for (const flags of [
      ["--mode"], ["--mode", "fast"], ["--mode", "Quick"],
      ["--max-duration"], ["--some-unknown-flag"], ["--pack", "all"],
      ["--pack", "navigation"], ["--apk", "application.apk"], ["--output"],
      ["--output", ""], ["--baseline"], ["--target-redaction", "full"],
    ]) {
      const h = harness();
      expect(await h.run(["scan", TARGET, ...flags]), flags.join(" ")).toBe(EXIT_CODES.usageError);
      expect(h.testTarget).not.toHaveBeenCalled();
      expect(h.runtimeProbe).not.toHaveBeenCalled();
    }
  });

  it("rejects invalid URLs and conflicting startup preparation before running", async () => {
    for (const args of [
      ["scan", "https://user:password@example.test"],
      ["scan", "file:///tmp/example.html"],
      ["scan", TARGET, "--journey", "journey.json", "--startup-actions", "SELECT"],
      ["scan", TARGET, TARGET],
    ]) {
      const h = harness();
      expect(await h.run(args)).toBe(EXIT_CODES.usageError);
      expect(h.testTarget).not.toHaveBeenCalled();
    }
  });

  it("keeps test pack selection opt-in rather than silently expanding scan packs", async () => {
    const normal = harness();
    expect(await normal.run(["test", TARGET, "--mode", "quick"])).toBe(EXIT_CODES.success);
    expect(normal.captured[0]?.packs).toEqual(["navigation"]);
    expect(normal.captured[0]?.disableRepetitionCompression).toBeUndefined();

    const selected = harness();
    expect(await selected.run([
      "test", TARGET, "--pack", "search", "--pack", "settings", "--pack", "search",
      "--mode", "deep", "--no-compression", "--output", "selected-packs",
    ])).toBe(EXIT_CODES.success);
    expect(selected.captured[0]).toMatchObject({
      packs: ["search", "settings"], mode: "deep", disableRepetitionCompression: true,
      outputPath: "selected-packs",
    });

    const legacy = harness();
    expect(await legacy.run(["test", TARGET, "--pack", "all"])).toBe(EXIT_CODES.success);
    expect(legacy.captured[0]?.packs).toEqual(["all"]);

    const conflict = harness();
    expect(await conflict.run(["test", TARGET, "--pack", "all", "--pack", "navigation"]))
      .toBe(EXIT_CODES.usageError);
    expect(conflict.testTarget).not.toHaveBeenCalled();
  });

  it.each([
    { status: "completed" as const, expected: EXIT_CODES.success, text: "Status: COMPLETED" },
    { status: "partial" as const, expected: EXIT_CODES.inconclusive, text: "Status: PARTIAL-INCONCLUSIVE" },
    { status: "failed" as const, expected: EXIT_CODES.executionError, text: "Status: FAILED" },
  ])("reports $status scan status/exit codes without claiming complete coverage", async ({ status, expected, text }) => {
    const h = harness(status);
    expect(await h.run(["scan", TARGET, "--output", "case-output"])).toBe(expected);
    expect(h.stdout()).toContain(text);
    expect(h.stdout()).toContain(`Open report: ${join("case-output", "report.html")}`);
    expect(h.captured[0]).toMatchObject({ mode: "standard", packs: ["navigation"] });
  });
});
