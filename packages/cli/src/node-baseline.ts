import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  compareBaseline as compareSemanticBaseline,
  createBaseline as createSemanticBaseline,
  parseBaseline,
  renderBaselineJson,
  renderComparisonJson,
  type BaselineObservationInventory,
} from "@tvdoctor/baseline";
import {
  PROTOCOL_VALIDATION_LIMITS,
  REPORT_SCHEMA_VERSION_V1,
  parseTVDoctorReportJson,
} from "@tvdoctor/protocol";
import type {
  BaselineCompareRequest,
  BaselineCompareResult,
  BaselineCreateRequest,
  BaselineCreateResult,
} from "./cli.js";

const BASELINE_JSON_LIMIT = 16 * 1024 * 1024;

async function loadJson(path: string, maximumBytes: number): Promise<unknown> {
  const absolutePath = resolve(path);
  const metadata = await stat(absolutePath);
  if (!metadata.isFile()) throw new TypeError(`${path} is not a regular file.`);
  if (metadata.size > maximumBytes) throw new TypeError(`${path} exceeds the supported JSON size limit.`);
  return JSON.parse(await readFile(absolutePath, "utf8")) as unknown;
}

async function loadReport(path: string) {
  const value = await loadJson(path, PROTOCOL_VALIDATION_LIMITS.maxJsonBytes);
  const report = parseTVDoctorReportJson(JSON.stringify(value));
  if (report.schemaVersion !== REPORT_SCHEMA_VERSION_V1) {
    throw new TypeError("Baseline commands require a tvdoctor.report/v1 report.");
  }
  return report;
}

async function writeNewJson(path: string, content: string): Promise<string> {
  const absolutePath = resolve(path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, { encoding: "utf8", flag: "wx" });
  return absolutePath;
}

export async function createBaselineFromFiles(
  request: BaselineCreateRequest,
): Promise<BaselineCreateResult> {
  const report = await loadReport(request.reportPath);
  const inventory = await loadJson(request.inventoryPath, BASELINE_JSON_LIMIT) as BaselineObservationInventory;
  const baseline = createSemanticBaseline(report, inventory);
  return {
    issueCount: baseline.issues.length,
    outputPath: await writeNewJson(request.outputPath, renderBaselineJson(baseline)),
  };
}

export async function compareBaselineFromFiles(
  request: BaselineCompareRequest,
): Promise<BaselineCompareResult> {
  const baselineInput = await loadJson(request.baselinePath, BASELINE_JSON_LIMIT);
  const report = await loadReport(request.reportPath);
  const inventory = await loadJson(request.inventoryPath, BASELINE_JSON_LIMIT) as BaselineObservationInventory;
  const comparison = compareSemanticBaseline(baselineInput, report, inventory);
  let baselineIssueCount = 0;
  try {
    baselineIssueCount = parseBaseline(baselineInput).issues.length;
  } catch {
    // The comparison preserves the baseline library's fail-closed blocker.
  }
  const structuralRegressions = comparison.changes.screensRemoved.length
    + comparison.changes.focusRemoved.length
    + comparison.changes.transitionsRemoved.length
    + comparison.changes.transitionsChanged.length
    + comparison.changes.latencyRegressions.length;
  return {
    status: comparison.status,
    shouldFail: comparison.shouldFail,
    newIssues: comparison.changes.newIssues.length,
    resolvedIssues: comparison.changes.resolvedIssues.length,
    unchangedIssues: comparison.status === "failed-closed"
      ? 0
      : Math.max(0, baselineIssueCount - comparison.changes.resolvedIssues.length),
    structuralRegressions,
    blockers: comparison.blockers.map((blocker) => blocker.detail),
    outputPath: await writeNewJson(request.outputPath, renderComparisonJson(comparison)),
  };
}
