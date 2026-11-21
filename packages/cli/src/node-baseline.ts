import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import {
  compareBaseline as compareSemanticBaseline,
  createBaseline as createSemanticBaseline,
  parseBaseline,
  renderBaselineJson,
  renderComparisonJson,
  renderComparisonMarkdown,
  type BaselineObservationInventory,
  type BaselineTransitionObservation,
  type TVDoctorBaselineComparisonV1,
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

const DIRECTIONAL_ACTIONS: ReadonlySet<string> = new Set(["UP", "DOWN", "LEFT", "RIGHT"]);

const BASELINE_JSON_LIMIT = 16 * 1024 * 1024;
const COMPARISON_GRAPH_EDGE_LIMIT = 40;

interface ChangedNavigationEdge {
  readonly prefix: "+" | "-" | "was" | "now";
  readonly transition: BaselineTransitionObservation;
}

function mermaidLabel(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("[", "&#91;")
    .replaceAll("]", "&#93;")
    .replaceAll("{", "&#123;")
    .replaceAll("}", "&#125;")
    .replace(/\s+/gu, " ")
    .trim();
}

function transitionEndpoint(screenKey: string, focusKey: string | null): string {
  return focusKey === null ? screenKey : `${screenKey}/${focusKey}`;
}

function renderChangedNavigationMermaid(comparison: TVDoctorBaselineComparisonV1): string | null {
  if (comparison.status === "failed-closed") return null;
  const edges: ChangedNavigationEdge[] = [
    ...comparison.changes.transitionsRemoved.map((transition) => ({ prefix: "-" as const, transition })),
    ...comparison.changes.transitionsChanged.flatMap((change) => [
      { prefix: "was" as const, transition: change.before },
      { prefix: "now" as const, transition: change.after },
    ]),
    ...comparison.changes.transitionsAdded.map((transition) => ({ prefix: "+" as const, transition })),
  ];
  if (edges.length === 0) return null;

  const nodeIds = new Map<string, string>();
  const lines = ["flowchart LR"];
  let nextNode = 0;
  const ensureNode = (screenKey: string, focusKey: string | null): string => {
    const identity = JSON.stringify([screenKey, focusKey]);
    const existing = nodeIds.get(identity);
    if (existing !== undefined) return existing;
    const id = `N${String(nextNode)}`;
    nextNode += 1;
    nodeIds.set(identity, id);
    lines.push(`  ${id}["${mermaidLabel(transitionEndpoint(screenKey, focusKey))}"]`);
    return id;
  };

  for (const edge of edges.slice(0, COMPARISON_GRAPH_EDGE_LIMIT)) {
    const transition = edge.transition;
    const from = ensureNode(transition.fromScreenKey, transition.fromFocusKey);
    const to = ensureNode(transition.toScreenKey, transition.toFocusKey);
    lines.push(`  ${from} -- "${edge.prefix} ${transition.action}" --> ${to}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderComparisonReviewMarkdown(comparison: TVDoctorBaselineComparisonV1): string {
  const markdown = renderComparisonMarkdown(comparison).trimEnd();
  const graph = renderChangedNavigationMermaid(comparison);
  if (graph === null) return `${markdown}\n`;
  const changedEdgeCount = comparison.changes.transitionsRemoved.length
    + (comparison.changes.transitionsChanged.length * 2)
    + comparison.changes.transitionsAdded.length;
  const truncation = changedEdgeCount > COMPARISON_GRAPH_EDGE_LIMIT
    ? `\n\nShowing the first ${String(COMPARISON_GRAPH_EDGE_LIMIT)} of ${String(changedEdgeCount)} changed transition edges.`
    : "";
  return `${markdown}\n\n## Changed navigation map\n\nEdge labels use \`+\` for added, \`-\` for removed, and \`was\` / \`now\` for changed transitions.\n\n\`\`\`mermaid\n${graph}\`\`\`${truncation}\n`;
}

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

function markdownSibling(path: string): string {
  const absolutePath = resolve(path);
  return extname(absolutePath).toLowerCase() === ".json"
    ? `${absolutePath.slice(0, -5)}.md`
    : `${absolutePath}.md`;
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
  const outputPath = await writeNewJson(request.outputPath, renderComparisonJson(comparison));
  const markdownPath = await writeNewJson(markdownSibling(request.outputPath), renderComparisonReviewMarkdown(comparison));
  return {
    status: comparison.status,
    shouldFail: comparison.shouldFail,
    newIssues: comparison.changes.newIssues.length,
    resolvedIssues: comparison.changes.resolvedIssues.length,
    unchangedIssues: comparison.status === "failed-closed"
      ? 0
      : Math.max(0, baselineIssueCount - comparison.changes.resolvedIssues.length),
    structuralRegressions,
    addedFocusTargets: comparison.changes.focusAdded.length,
    removedFocusTargets: comparison.changes.focusRemoved.length,
    directionalTransitionChanges: comparison.changes.transitionsChanged.filter((change) => (
      DIRECTIONAL_ACTIONS.has(change.before.action)
      || DIRECTIONAL_ACTIONS.has(change.after.action)
    )).length,
    latencyRegressions: comparison.changes.latencyRegressions.length,
    blockers: comparison.blockers.map((blocker) => blocker.detail),
    outputPath,
    markdownPath,
  };
}
