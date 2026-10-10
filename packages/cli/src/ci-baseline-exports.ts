import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { BaselineCompareResult } from "./cli.js";

type BaselineVerdict = Pick<BaselineCompareResult, "status" | "shouldFail">;

function withJUnitBaselineCase(junit: string, comparison: BaselineVerdict): string {
  const fail = comparison.shouldFail || comparison.status === "regressed" || comparison.status === "failed-closed";
  const kind = !fail ? "passed" : comparison.status === "failed-closed" ? "error" : "failure";
  const message = comparison.status === "failed-closed"
    ? "TVDoctor baseline comparison was inconclusive."
    : "TVDoctor baseline comparison detected a regression.";
  const caseXml = kind === "passed"
    ? '    <testcase classname="tvdoctor.baseline" name="reviewed baseline comparison"/>'
    : `    <testcase classname="tvdoctor.baseline" name="reviewed baseline comparison">
      <${kind} type="tvdoctor.baseline" message="${message}">${message}</${kind}>
    </testcase>`;
  const opening = /^\s*<(testsuites|testsuite)\b[^>]*>$/gmu;
  let wrappers = 0;
  const withCounts = junit.replace(opening, (tag) => {
    if (wrappers >= 2) throw new Error("CI JUnit contains unexpected suite wrappers.");
    wrappers += 1;
    let replacement = tag.replace(/\btests="(\d+)"/u, (_, n: string) => `tests="${Number(n) + 1}"`);
    if (kind !== "passed") {
      replacement = replacement.replace(
        new RegExp(`\\b${kind}s="(\\d+)"`, "u"),
        (_, n: string) => `${kind}s="${Number(n) + 1}"`,
      );
    }
    return replacement;
  });
  if (wrappers !== 2 || !withCounts.includes("  </testsuite>") || !withCounts.includes("</testsuites>")) {
    throw new Error("CI JUnit has an unexpected structure.");
  }
  const cases = withCounts.replace("  </testsuite>", `${caseXml}\n  </testsuite>`);
  return cases;
}

function withSummaryBaselineVerdict(summary: string, comparison: BaselineVerdict): string {
  const fail = comparison.shouldFail || comparison.status === "regressed" || comparison.status === "failed-closed";
  const headline = comparison.status === "failed-closed" ? "INCONCLUSIVE" : fail ? "FAILED" : null;
  const replacement = headline === null
    ? summary
    : summary.replace(/^# TVDoctor CI: PASSED$/mu, `# TVDoctor CI: ${headline}`);
  if (!replacement.startsWith("# TVDoctor CI: ")) {
    throw new Error("CI summary has an unexpected heading.");
  }
  return `${replacement.trimEnd()}

## Reviewed baseline comparison

- Status: **${comparison.status.toUpperCase()}**
- CI gate: **${fail ? "FAILED" : "PASSED"}**
- Detailed comparison: [baseline-comparison.md](../baseline-comparison.md)
`;
}

/**
 * The report bundle writes audit-only CI exports before the optional baseline
 * comparison. Reconcile the final verdict in the SAME owned report directory.
 * A host that returns a report path outside the requested output root (such as
 * a test double) is left alone. Canonical runs require both exports and fail
 * closed when they cannot be updated. Existing exports are never followed
 * through symlinks.
 */
export async function reconcileCiBaselineExports(
  outputPath: string,
  reportPath: string,
  comparison: BaselineVerdict,
): Promise<boolean> {
  const root = resolve(outputPath);
  if (resolve(reportPath) !== join(root, "report.json") || basename(reportPath) !== "report.json") {
    // Embedded callers may return a report path that is only a test double.
    // Never mutate a different directory through that untrusted result.
    return false;
  }
  const summaryPath = join(root, "exports", "ci-summary.md");
  const junitPath = join(root, "exports", "junit.xml");
  const [rootStat, exportsStat, reportStat, summaryStat, junitStat] = await Promise.all([
    lstat(root), lstat(join(root, "exports")), lstat(reportPath),
    lstat(summaryPath), lstat(junitPath),
  ]);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
    || !exportsStat.isDirectory() || exportsStat.isSymbolicLink()
    || !reportStat.isFile() || reportStat.isSymbolicLink()) {
    throw new Error("CI baseline report must be inside an owned real directory.");
  }
  if (!summaryStat.isFile() || summaryStat.isSymbolicLink() || !junitStat.isFile() || junitStat.isSymbolicLink()) {
    throw new Error("CI baseline export path is not an owned regular file.");
  }
  const [summary, junit] = await Promise.all([
    readFile(summaryPath, "utf8"),
    readFile(junitPath, "utf8"),
  ]);
  const nextSummary = withSummaryBaselineVerdict(summary, comparison);
  const nextJUnit = withJUnitBaselineCase(junit, comparison);
  // Stage BOTH complete outputs before replacing either original. The GitHub
  // Action uses the CLI exit status as authority if a final rename fails.
  const suffix = randomUUID();
  const stagedJUnit = `${junitPath}.${suffix}.tmp`;
  const stagedSummary = `${summaryPath}.${suffix}.tmp`;
  try {
    await Promise.all([
      writeFile(stagedJUnit, nextJUnit, { encoding: "utf8", flag: "wx" }),
      writeFile(stagedSummary, nextSummary, { encoding: "utf8", flag: "wx" }),
    ]);
    await rename(stagedJUnit, junitPath);
    await rename(stagedSummary, summaryPath);
  } finally {
    await Promise.all([
      rm(stagedJUnit, { force: true }), rm(stagedSummary, { force: true }),
    ]);
  }
  return true;
}
