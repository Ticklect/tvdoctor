import type {
  BaselineFocusObservation,
  BaselineIssueObservation,
  BaselineScreenObservation,
  BaselineTransitionObservation,
  TVDoctorBaselineComparisonV1,
  TransitionChange,
} from "./types.js";
import { sanitiseUntrustedText } from "./baseline.js";

const DIRECTIONAL_ACTIONS: ReadonlySet<string> = new Set(["UP", "DOWN", "LEFT", "RIGHT"]);

function inline(value: string): string {
  return sanitiseUntrustedText(value).replace(/\s+/gu, " ").trim().replace(/[\\`*_[\]<>|]/gu, "\\$&");
}

function issueLine(issue: BaselineIssueObservation): string {
  return `- **${issue.severity.toUpperCase()}** \`${inline(issue.id)}\` — \`${inline(issue.rule)}\``;
}

function screenLine(screen: BaselineScreenObservation): string {
  return `- \`${inline(screen.key)}\`${screen.label === null ? "" : ` — ${inline(screen.label)}`}`;
}

function focusLine(focus: BaselineFocusObservation): string {
  const detail = [focus.role, focus.name].filter((value): value is string => value !== null).map(inline).join(" · ");
  return `- \`${inline(focus.screenKey)}/${inline(focus.key)}\`${detail.length === 0 ? "" : ` — ${detail}`}`;
}

function endpoint(screenKey: string, focusKey: string | null): string {
  return focusKey === null ? inline(screenKey) : `${inline(screenKey)}/${inline(focusKey)}`;
}

function transitionLine(transition: BaselineTransitionObservation): string {
  return `- **${transition.action}** \`${endpoint(transition.fromScreenKey, transition.fromFocusKey)}\` → \`${endpoint(transition.toScreenKey, transition.toFocusKey)}\``;
}

function changedTransitionLine(change: TransitionChange): string {
  const before = change.before;
  const after = change.after;
  return `- \`${inline(change.key)}\` — **${before.action}** was \`${endpoint(before.fromScreenKey, before.fromFocusKey)}\` → \`${endpoint(before.toScreenKey, before.toFocusKey)}\`; now **${after.action}** is \`${endpoint(after.fromScreenKey, after.fromFocusKey)}\` → \`${endpoint(after.toScreenKey, after.toFocusKey)}\``;
}

function section(title: string, lines: readonly string[]): string {
  return `### ${title}\n\n${lines.length === 0 ? "None." : lines.join("\n")}`;
}

/** Human-readable baseline diff for CI/job summaries and review artifacts. */
export function renderComparisonMarkdown(comparison: TVDoctorBaselineComparisonV1): string {
  const directional = comparison.changes.transitionsChanged.filter((change) => DIRECTIONAL_ACTIONS.has(change.before.action) || DIRECTIONAL_ACTIONS.has(change.after.action));
  const otherChanged = comparison.changes.transitionsChanged.filter((change) => !directional.includes(change));
  const blockers = comparison.blockers.map((blocker) => `- **${inline(blocker.code)}** — ${inline(blocker.detail)}`);
  return `# TVDoctor Baseline Comparison

- Status: **${comparison.status.toUpperCase()}**
- Baseline run: \`${inline(comparison.baselineRunId)}\`
- Current run: \`${inline(comparison.currentRunId)}\`
- CI failure: **${comparison.shouldFail ? "yes" : "no"}**

## Finding changes

| Category | Count |
| --- | ---: |
| Introduced | ${String(comparison.changes.newIssues.length)} |
| Resolved | ${String(comparison.changes.resolvedIssues.length)} |
| Unchanged | ${String(comparison.changes.unchangedIssues.length)} |

${section("Introduced findings", comparison.changes.newIssues.map(issueLine))}

${section("Resolved findings", comparison.changes.resolvedIssues.map(issueLine))}

${section("Unchanged findings", comparison.changes.unchangedIssues.map(issueLine))}

## Navigation inventory changes

${section("New screens", comparison.changes.screensAdded.map(screenLine))}

${section("Removed screens", comparison.changes.screensRemoved.map(screenLine))}

${section("New focus targets", comparison.changes.focusAdded.map(focusLine))}

${section("Removed focus targets", comparison.changes.focusRemoved.map(focusLine))}

${section("Added transitions", comparison.changes.transitionsAdded.map(transitionLine))}

${section("Removed transitions", comparison.changes.transitionsRemoved.map(transitionLine))}

${section("Changed directional transitions", directional.map(changedTransitionLine))}

${section("Changed other transitions", otherChanged.map(changedTransitionLine))}

## Latency regressions

${comparison.changes.latencyRegressions.length === 0
    ? "None."
    : comparison.changes.latencyRegressions.map((entry) => `- \`${inline(entry.key)}\` — ${inline(entry.operation)}: ${String(entry.baselineMs)} ms → ${String(entry.currentMs)} ms (+${String(entry.increaseMs)} ms, ${entry.ratio.toFixed(2)}×)`).join("\n")}

## Comparison blockers

${blockers.length === 0 ? "None." : blockers.join("\n")}
`;
}
