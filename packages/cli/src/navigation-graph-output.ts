import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

import {
  createNavigationFocusGraphV2,
  type ExplorationResult,
  type NavigationDiagnosticFinding,
  type NavigationDiagnostics,
  type NavigationElementMetadata,
  type NavigationFocusGraph,
  type NavigationFocusGraphProblem,
  type NavigationFocusGraphTarget,
  type NavigationFocusGraphV2,
  type NavigationFocusGraphV2Problem,
  type NavigationFocusGraphV2Target,
} from "@tvdoctor/core";
import type { ArtifactDescriptor } from "@tvdoctor/protocol";
import {
  aggregateReportJsonChunks,
  sanitiseUntrustedText,
  type ArtifactStore,
} from "@tvdoctor/reporters";

export const NAVIGATION_GRAPH_JSON_PATH = "navigation-graph.json";
export const NAVIGATION_GRAPH_MARKDOWN_PATH = "navigation-graph.md";

const QUICK_FOCUS_ROUTE_LIMIT = 20;
const QUICK_NAVIGATION_MAP_TARGET_LIMIT = 24;
const QUICK_NAVIGATION_MAP_EDGE_LIMIT = 120;
// Markdown is a bounded human review surface; the JSON retains every edge.
// This prevents giant Deep graphs from allocating multi-gigabyte line arrays.
const MARKDOWN_SCREEN_LIMIT = 2_000;
const MARKDOWN_FOCUS_LIMIT = 12_000;
const MARKDOWN_EDGE_LIMIT = 10_000;
const MARKDOWN_PROBLEM_LIMIT = 2_000;
const MARKDOWN_CYCLE_LIMIT = 2_000;
const MARKDOWN_PATH_ACTION_LIMIT = 128;

function descriptor(
  id: string,
  path: string,
  mediaType: string,
  text: string,
): ArtifactDescriptor {
  return {
    id,
    kind: "report",
    status: "available",
    path,
    mediaType,
    byteLength: Buffer.byteLength(text),
    sha256: createHash("sha256").update(text).digest("hex"),
  };
}

function inline(value: string): string {
  return sanitiseUntrustedText(value, 2_000)
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[\\`|*_[\]<>]/gu, "\\$&");
}

function code(value: string): string {
  return `\`${inline(value)}\``;
}

function pathText(path: readonly string[]): string {
  if (path.length === 0) return "(root)";
  const visible = path.slice(0, MARKDOWN_PATH_ACTION_LIMIT).map((action) => code(action)).join(" → ");
  return path.length > MARKDOWN_PATH_ACTION_LIMIT
    ? `${visible} → … (${String(path.length - MARKDOWN_PATH_ACTION_LIMIT)} more actions in JSON)`
    : visible;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareTargetRoute(
  left: NavigationFocusGraphV2Target,
  right: NavigationFocusGraphV2Target,
): number {
  return left.shortestKnownPath.length - right.shortestKnownPath.length
    || compareText(JSON.stringify(left.shortestKnownPath), JSON.stringify(right.shortestKnownPath))
    || compareText(left.screenKey, right.screenKey)
    || compareText(left.key, right.key);
}

function mermaidLabel(value: string): string {
  return sanitiseUntrustedText(value, 2_000)
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

function elementText(element: NavigationElementMetadata | null): string {
  if (element === null) return "none observed";
  const pieces = [
    element.role === null ? null : `role ${code(element.role)}`,
    element.name === null ? null : `name ${code(element.name)}`,
    element.stableId === null ? null : `id ${code(element.stableId)}`,
  ].filter((value): value is string => value !== null);
  return pieces.length === 0 ? "observed element (no semantic label)" : pieces.join("; ");
}

function targetObservation(target: NavigationFocusGraphTarget | NavigationFocusGraphV2Target): string {
  if (target.observation.status === "present") return elementText(target.observation.element);
  if (target.observation.status === "missing") return "no focused element observed";
  return `unavailable — ${inline(target.observation.reason)}`;
}

function targetMermaidText(target: NavigationFocusGraphV2Target): string {
  if (target.observation.status !== "present") return `${target.screenKey} · ${target.key}`;
  const element = target.observation.element;
  const identity = element.name ?? element.stableId ?? target.key;
  return `${target.screenKey} · ${identity}${element.role === null ? "" : ` (${element.role})`}`;
}

/**
 * Bounded review visualization. Machine-readable graph evidence remains in the JSON artifact,
 * while this diagram keeps CI/job Markdown readable on large navigation surfaces.
 */
export function renderNavigationFocusGraphMermaid(graph: NavigationFocusGraphV2): string {
  const selectedTargets = [...graph.focusTargets]
    .sort(compareTargetRoute)
    .slice(0, QUICK_NAVIGATION_MAP_TARGET_LIMIT);
  const selectedKeys = new Set(selectedTargets.map((target) => target.key));
  const ids = new Map<string, string>();
  const lines = ["flowchart LR"];

  for (const [index, target] of selectedTargets.entries()) {
    const id = `F${String(index)}`;
    ids.set(target.key, id);
    lines.push(`  ${id}["${mermaidLabel(targetMermaidText(target))}"]`);
  }

  let renderedEdges = 0;
  for (const transition of graph.transitions) {
    if (renderedEdges >= QUICK_NAVIGATION_MAP_EDGE_LIMIT) break;
    if (transition.toFocusTargetKey === null) continue;
    if (!selectedKeys.has(transition.fromFocusTargetKey) || !selectedKeys.has(transition.toFocusTargetKey)) continue;
    const from = ids.get(transition.fromFocusTargetKey);
    const to = ids.get(transition.toFocusTargetKey);
    if (from === undefined || to === undefined) continue;
    lines.push(`  ${from} -- "${transition.action}" --> ${to}`);
    renderedEdges += 1;
  }

  return `${lines.join("\n")}\n`;
}

function endpoint(screenKey: string, focusTargetKey: string | null): string {
  return focusTargetKey === null
    ? code(screenKey)
    : `${code(screenKey)} / ${code(focusTargetKey)}`;
}

function problemClassification(problem: NavigationFocusGraphProblem | NavigationFocusGraphV2Problem): string {
  return problem.evidenceClassification === "heuristic"
    ? "heuristic — not confirmed"
    : "deterministic evidence";
}

function problemTarget(problem: NavigationFocusGraphProblem | NavigationFocusGraphV2Problem): string {
  const location = endpoint(problem.target.screenKey, problem.target.focusTargetKey);
  const reference = problem.target.expectedElement === null
    ? ""
    : `; reference candidate ${elementText(problem.target.expectedElement)}`;
  const observed = problem.target.observedElement === null
    ? ""
    : `; observed ${elementText(problem.target.observedElement)}`;
  return `${location}${reference}${observed}`;
}

export function renderNavigationFocusGraphMarkdown(
  graph: NavigationFocusGraph | NavigationFocusGraphV2,
): string {
  const lines: string[] = [
    "# TVDoctor Navigation Graph",
    "",
    `- Schema: ${code(graph.schemaVersion)}`,
    `- Coverage: **${graph.coverage.toUpperCase()}**`,
    `- Configured remote actions: ${graph.configuredActions.length === 0 ? "none observed" : graph.configuredActions.map(code).join(", ")}`,
    `- Screens: ${String(graph.screens.length)}`,
    `- Focus targets: ${String(graph.focusTargets.length)}`,
    `- Observed edges: ${String(graph.transitions.length)}`,
    `- Problem annotations: ${String(graph.problems.length)}`,
    "",
    "Problem annotations preserve TVDoctor's evidence classification. A heuristic row is a lead for review, not a confirmed failure.",
    "",
  ];

  if (graph.screens.length > MARKDOWN_SCREEN_LIMIT
    || graph.focusTargets.length > MARKDOWN_FOCUS_LIMIT
    || graph.transitions.length > MARKDOWN_EDGE_LIMIT
    || graph.problems.length > MARKDOWN_PROBLEM_LIMIT
    || (graph.schemaVersion === "tvdoctor.navigation-focus-graph/v2" && graph.cycles.length > MARKDOWN_CYCLE_LIMIT)) {
    lines.push(
      "**Large graph:** Some Markdown tables are limited for readability and output size. navigation-graph.json contains every serialized observation.",
      "",
    );
  }

  if (graph.schemaVersion === "tvdoctor.navigation-focus-graph/v2") {
    const coverage = graph.coverageSummary;
    lines.push(
      "## Exploration coverage",
      "",
      `- Observed screens: **${String(coverage.observedScreens)}**`,
      `- Observed focus targets: **${String(coverage.observedFocusTargets)}**`,
      `- Observed transitions: **${String(coverage.observedTransitions)}**`,
      `- Locally complete focus targets: **${String(coverage.locallyCompleteFocusTargetKeys.length)} / ${String(coverage.observedFocusTargets)}**`,
    );
    if (coverage.frontier.status === "complete") {
      lines.push(`- Known frontier: **complete** (${code(coverage.frontier.reason)})`);
    } else {
      lines.push(
        `- Known deferred frontier: **${inline(coverage.frontier.category ?? "termination")}** (${code(coverage.frontier.reason)}) — ${String(coverage.frontier.remainingFrontierEntries)} queued entries / up to ${String(coverage.frontier.remainingCandidateActions)} candidate actions`,
      );
      if (coverage.frontier.deferredStates > 0) {
        lines.push(`- Repetition-compressed deferred states: **${String(coverage.frontier.deferredStates)}**`);
      }
    }
    if (graph.coverage === "partial" && coverage.frontier.status === "complete") {
      const unverifiedActions = graph.transitions.filter((transition) => transition.outcome !== "applied").length;
      lines.push(
        `- Verification: **partial despite exhausted known frontier** — ${String(unverifiedActions)} recorded action(s) not applied; additional observational omissions may remain. Excluded controls are not counted as tested.`,
      );
    }
    lines.push("");

    const quickTargets = [...graph.focusTargets]
      .sort(compareTargetRoute)
      .slice(0, QUICK_FOCUS_ROUTE_LIMIT);
    lines.push(
      "## Quick focus routes",
      "",
      "Shortest verified routes to observed focus targets, ordered by route length.",
      "",
    );
    if (quickTargets.length === 0) {
      lines.push("No focus routes were observed.", "");
    } else {
      lines.push(
        "| Focus target | Screen | Shortest known path |",
        "| --- | --- | --- |",
      );
      for (const target of quickTargets) {
        lines.push(`| ${targetObservation(target)} | ${code(target.screenKey)} | ${pathText(target.shortestKnownPath)} |`);
      }
      if (graph.focusTargets.length > quickTargets.length) {
        lines.push("", `Showing ${String(quickTargets.length)} of ${String(graph.focusTargets.length)} focus targets. The complete per-screen tables follow.`);
      }
      lines.push("");
    }

    lines.push(
      "## Quick navigation map",
      "",
      `This Mermaid view includes up to ${String(QUICK_NAVIGATION_MAP_TARGET_LIMIT)} observed focus targets and ${String(QUICK_NAVIGATION_MAP_EDGE_LIMIT)} observed edges.`,
      "",
      "```mermaid",
      renderNavigationFocusGraphMermaid(graph).trimEnd(),
      "```",
      "",
    );
    if (graph.focusTargets.length > QUICK_NAVIGATION_MAP_TARGET_LIMIT) {
      lines.push(`The map shows ${String(QUICK_NAVIGATION_MAP_TARGET_LIMIT)} of ${String(graph.focusTargets.length)} focus targets.`, "");
    }
  }

  lines.push("## Screens and focus targets", "");

  if (graph.screens.length === 0) {
    lines.push("No navigation screens were observed.", "");
  } else {
    const targetsByScreen = new Map<string, NavigationFocusGraphTarget[]>();
    for (const target of graph.focusTargets.slice(0, MARKDOWN_FOCUS_LIMIT)) {
      const targets = targetsByScreen.get(target.screenKey) ?? [];
      targets.push(target);
      targetsByScreen.set(target.screenKey, targets);
    }
    for (const screen of graph.screens.slice(0, MARKDOWN_SCREEN_LIMIT)) {
      lines.push(
        `### Screen ${code(screen.key)}`,
        "",
        `- Match confidence: ${code(screen.confidence)}`,
        `- First observed by: ${pathText(screen.firstSeenPath)}`,
        "",
      );
      const targets = targetsByScreen.get(screen.key) ?? [];
      if (targets.length === 0) {
        lines.push("No focus target was observed on this screen.", "");
        continue;
      }
      const v2 = graph.schemaVersion === "tvdoctor.navigation-focus-graph/v2";
      lines.push(
        v2
          ? "| Focus target | Observation | Confidence | First observed by | Shortest known path |"
          : "| Focus target | Observation | Confidence | First observed by |",
        v2
          ? "| --- | --- | --- | --- | --- |"
          : "| --- | --- | --- | --- |",
      );
      for (const target of targets) {
        lines.push(v2
          ? `| ${code(target.key)} | ${targetObservation(target)} | ${code(target.confidence)} | ${pathText(target.firstSeenPath)} | ${pathText((target as NavigationFocusGraphV2Target).shortestKnownPath)} |`
          : `| ${code(target.key)} | ${targetObservation(target)} | ${code(target.confidence)} | ${pathText(target.firstSeenPath)} |`);
      }
      lines.push("");
    }
    if (graph.screens.length > MARKDOWN_SCREEN_LIMIT || graph.focusTargets.length > MARKDOWN_FOCUS_LIMIT) {
      lines.push(
        `Limited Markdown detail to ${String(MARKDOWN_SCREEN_LIMIT)} screens and ${String(MARKDOWN_FOCUS_LIMIT)} focus targets; all observed states are in navigation-graph.json.`,
        "",
      );
    }
  }

  lines.push(
    "## Observed remote edges",
    "",
    "Only observed UP/DOWN/LEFT/RIGHT/SELECT/BACK transitions are listed. Missing edges are not inferred.",
    "",
  );
  if (graph.transitions.length === 0) {
    lines.push("No matching remote edges were observed.", "");
  } else {
    lines.push(
      "| From | Action | To | Outcome | Evidence | Reproduction path |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const transition of graph.transitions.slice(0, MARKDOWN_EDGE_LIMIT)) {
      const to = transition.toScreenKey === null
        ? `unregistered observation ${endpoint(transition.observedScreenKey, transition.observedFocusTargetKey)}`
        : endpoint(transition.toScreenKey, transition.toFocusTargetKey);
      lines.push(`| ${endpoint(transition.fromScreenKey, transition.fromFocusTargetKey)} | **${transition.action}** | ${to} | ${code(transition.outcome)} | ${inline(transition.evidenceClassification)} | ${pathText(transition.reproductionPath)} |`);
    }
    lines.push("");
    if (graph.transitions.length > MARKDOWN_EDGE_LIMIT) {
      lines.push(`Showing ${String(MARKDOWN_EDGE_LIMIT)} of ${String(graph.transitions.length)} observed edges. All edges are in navigation-graph.json.`, "");
    }
  }

  if (graph.schemaVersion === "tvdoctor.navigation-focus-graph/v2") {
    lines.push(
      "## Observed cycle analysis",
      "",
      "Cycles are observed graph structure, not automatically defects.",
      "",
    );
    if (graph.cycles.length === 0) {
      lines.push("No observed navigation cycles were identified.", "");
    } else {
      for (const cycle of graph.cycles.slice(0, MARKDOWN_CYCLE_LIMIT)) {
        const targets = cycle.focusTargetKeys.slice(0, MARKDOWN_PATH_ACTION_LIMIT).map(code).join(" → ");
        const omission = cycle.focusTargetKeys.length > MARKDOWN_PATH_ACTION_LIMIT
          ? ` → … (${String(cycle.focusTargetKeys.length - MARKDOWN_PATH_ACTION_LIMIT)} more targets in JSON)`
          : "";
        lines.push(`- ${targets}${omission} (${String(cycle.transitionKeys.length)} observed edges)`);
      }
      lines.push("");
      if (graph.cycles.length > MARKDOWN_CYCLE_LIMIT) {
        lines.push(`Showing ${String(MARKDOWN_CYCLE_LIMIT)} of ${String(graph.cycles.length)} observed cycles. All cycles are in navigation-graph.json.`, "");
      }
    }
  }

  lines.push("## Evidence-backed problem annotations", "");
  if (graph.problems.length === 0) {
    lines.push("No graph problem annotations were produced from the observed navigation evidence.", "");
  } else {
    lines.push(
      "| Problem | Classification | Evidence | Source | Target | Local expansion | Reproduction path |",
      "| --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const problem of graph.problems.slice(0, MARKDOWN_PROBLEM_LIMIT)) {
      const evidenceKinds = problem.evidenceKinds.length === 0
        ? "none recorded"
        : problem.evidenceKinds.map(code).join(", ");
      const localExpansion = problem.locallyComplete === null
        ? "not required/proven"
        : problem.locallyComplete ? "complete" : "incomplete";
      lines.push(`| ${code(problem.kind)} · ${code(problem.issueId)} | ${inline(problemClassification(problem))} | ${evidenceKinds} | ${endpoint(problem.source.screenKey, problem.source.focusTargetKey)} | ${problemTarget(problem)} | ${inline(localExpansion)} | ${pathText(problem.reproductionPath)} |`);
    }
    lines.push("");
    if (graph.problems.length > MARKDOWN_PROBLEM_LIMIT) {
      lines.push(`Showing ${String(MARKDOWN_PROBLEM_LIMIT)} of ${String(graph.problems.length)} annotated problems. All annotations are in navigation-graph.json.`, "");
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function diagnosticsFor(findings: readonly NavigationDiagnosticFinding[]): NavigationDiagnostics {
  return {
    findings,
    deterministicFindings: findings.filter((finding) => finding.classification === "deterministic"),
    heuristicFindings: findings.filter((finding) => finding.classification === "heuristic"),
  };
}

export async function writeNavigationGraphArtifacts(
  store: ArtifactStore,
  result: ExplorationResult,
  findings: readonly NavigationDiagnosticFinding[],
): Promise<readonly ArtifactDescriptor[]> {
  const graph = createNavigationFocusGraphV2(result, diagnosticsFor(findings));
  const jsonFile = await store.writeBundleFileStream(
    NAVIGATION_GRAPH_JSON_PATH,
    aggregateReportJsonChunks(graph),
  );
  const markdownText = renderNavigationFocusGraphMarkdown(graph);
  await store.writeBundleFile(NAVIGATION_GRAPH_MARKDOWN_PATH, markdownText);
  return [
    {
      id: "run:navigation-graph-json",
      kind: "report",
      status: "available",
      path: NAVIGATION_GRAPH_JSON_PATH,
      mediaType: "application/json",
      byteLength: jsonFile.byteLength,
      sha256: jsonFile.sha256,
    },
    descriptor("run:navigation-graph-markdown", NAVIGATION_GRAPH_MARKDOWN_PATH, "text/markdown", markdownText),
  ];
}
