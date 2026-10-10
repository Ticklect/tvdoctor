import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileCiBaselineExports } from "../src/ci-baseline-exports.js";
import { runCli, type BaselineCompareResult } from "../src/cli.js";
import type { RuntimeEnvironment } from "../src/diagnostics.js";

const environment: RuntimeEnvironment = {
  nodeVersion: "v24.18.0", platform: "linux", architecture: "x64",
};
const temporaryRoots: string[] = [];
const auditSummary = "# TVDoctor CI: PASSED\n\nRun: **completed** · Findings: **0**\n";
const auditJunit = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<testsuites tests="1" failures="0" errors="0">',
  '  <testsuite name="TVDoctor" tests="1" failures="0" errors="0" time="0.100">',
  '    <testcase classname="tvdoctor" name="audit completed"/>',
  "  </testsuite>",
  "</testsuites>",
  "",
].join("\n");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tvdoctor-ci-baseline-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "exports"));
  await writeFile(join(root, "report.json"), '{"report":"retained"}\n');
  await writeFile(join(root, "exports", "ci-summary.md"), auditSummary);
  await writeFile(join(root, "exports", "junit.xml"), auditJunit);
  return root;
}

function comparison(status: BaselineCompareResult["status"]): BaselineCompareResult {
  return {
    status,
    shouldFail: status === "regressed" || status === "failed-closed",
    newIssues: status === "regressed" ? 1 : 0,
    resolvedIssues: 0,
    unchangedIssues: 0,
    structuralRegressions: 0,
    addedFocusTargets: 0,
    removedFocusTargets: 0,
    directionalTransitionChanges: 0,
    latencyRegressions: 0,
    blockers: status === "failed-closed" ? ["Missing equivalent coverage"] : [],
    outputPath: "baseline-comparison.json",
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CI baseline export verdicts", () => {
  it.each([
    ["regressed", "FAILED", 'tests="2" failures="1" errors="0"', "<failure"] as const,
    ["failed-closed", "INCONCLUSIVE", 'tests="2" failures="0" errors="1"', "<error"] as const,
    ["identical", "PASSED", 'tests="2" failures="0" errors="0"', "name=\"reviewed baseline comparison\"/>"] as const,
  ])("records %s without discarding audit results", async (status, headline, xmlCounts, testcase) => {
    const root = await fixture();
    await expect(reconcileCiBaselineExports(root, join(root, "report.json"), comparison(status))).resolves.toBe(true);
    const summary = await readFile(join(root, "exports", "ci-summary.md"), "utf8");
    const junit = await readFile(join(root, "exports", "junit.xml"), "utf8");
    expect(summary).toContain(`# TVDoctor CI: ${headline}`);
    expect(summary).toContain("Run: **completed** · Findings: **0**");
    expect(summary).toContain(`- Status: **${status.toUpperCase()}**`);
    expect(junit).toContain(xmlCounts);
    expect(junit).toContain(testcase);
    expect(junit).toContain('name="audit completed"');
    expect(await readFile(join(root, "report.json"), "utf8")).toBe('{"report":"retained"}\n');
  });

  it("leaves any report path outside the owned output directory untouched", async () => {
    const root = await fixture();
    await expect(reconcileCiBaselineExports(root, join(root, "..", "report.json"), comparison("regressed")))
      .resolves.toBe(false);
    expect(await readFile(join(root, "exports", "junit.xml"), "utf8")).toBe(auditJunit);
  });

  it.each(["regressed", "failed-closed"] as const)("makes CLI %s failure agree with emitted JUnit", async (status) => {
    const root = await fixture();
    const code = await runCli([
      "ci", "https://example.test", "--fail-on", "high",
      "--baseline", "reviewed-baseline.json", "--output", root,
    ], {
      environment,
      io: { writeStdout: () => undefined, writeStderr: () => undefined },
      runtimeProbe: async () => ({ capabilities: ["remote-input", "ui-tree"] }),
      operations: {
        replayIssue: async () => ({ status: "fixed", details: [] }),
        testTarget: async () => ({
          status: "completed", issueCount: 0, highestSeverity: null,
          highestVerifiedSeverity: null, reportPath: join(root, "report.json"), details: [],
        }),
        compareBaseline: async () => comparison(status),
      },
    });
    expect(code).toBe(1);
    const summary = await readFile(join(root, "exports", "ci-summary.md"), "utf8");
    const junit = await readFile(join(root, "exports", "junit.xml"), "utf8");
    expect(summary).not.toContain("# TVDoctor CI: PASSED");
    expect(junit).toContain(status === "regressed" ? 'failures="1"' : 'errors="1"');
  });
});
