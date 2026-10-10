#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Compare the evidence of two scans run against the same authorised fixture,
 * budgets and build. Faster is only better when the observed evidence matches.
 */
export function compareReplayPerformance(baseline, candidate) {
  const errors = [];
  const same = (label, a, b) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) errors.push(`${label} changed.`);
  };
  const keys = (values, pick = (value) => value.key) =>
    values.map(pick).sort((a, b) => a.localeCompare(b));
  const graphA = baseline.graph;
  const graphB = candidate.graph;
  if (graphA.schemaVersion !== "tvdoctor.navigation-focus-graph/v2"
    || graphB.schemaVersion !== graphA.schemaVersion) {
    return { errors: ["Both runs require v2 navigation graphs."], summary: null };
  }

  // An A/B only measures restoration if the fixture, run envelope and action
  // policy are unchanged. In particular, explicit fixture SELECT permission
  // changes coverage and must not be confused with a replay speedup.
  for (const field of ["mode", "target", "selectedPacks", "fixtureProfileSelectionEnabled"]) {
    same(`Run configuration ${field}`, baseline.ledger[field] ?? null, candidate.ledger[field] ?? null);
  }
  same("Scan budget configuration", baseline.report.coverage?.budget ?? null,
    candidate.report.coverage?.budget ?? null);
  same("Selected pack completion", baseline.report.coverage?.packs ?? null,
    candidate.report.coverage?.packs ?? null);
  if (baseline.ledger.navigationRestorationMode === candidate.ledger.navigationRestorationMode) {
    errors.push("Restoration modes are identical; use root-only versus verified-local (or verified-live-only).");
  }

  same("Configured navigation actions", graphA.configuredActions, graphB.configuredActions);
  const navigationIdentity = {
    screens: (s) => JSON.stringify([
      s.key, s.confidence, s.shortestKnownPath, s.focusTargetKeys,
    ]),
    focusTargets: (s) => JSON.stringify([
      s.key, s.focusFingerprint, s.screenKey, s.confidence, s.shortestKnownPath,
      // Bounds can shift without changing D-pad semantics; observable focus
      // identity and availability cannot. A reused stable ID may name a
      // different target despite identical graph keys and edge counts.
      s.observation?.status,
      s.observation?.evidenceClassification,
      s.observation?.element?.stableId,
      s.observation?.element?.role,
      s.observation?.element?.name,
    ]),
    transitions: (t) => JSON.stringify([
      t.key, t.fromFocusTargetKey, t.toFocusTargetKey, t.fromScreenKey, t.toScreenKey,
      t.observedScreenKey, t.observedFocusTargetKey,
      t.action, t.outcome, t.evidenceClassification, t.reproductionPath,
    ]),
    cycles: (c) => JSON.stringify([c.focusTargetKeys, c.transitionKeys]),
    problems: (p) => JSON.stringify([
      p.issueId, p.kind, p.rule, p.evidenceClassification, p.evidenceKinds,
      p.source, p.target, p.reproductionPath, p.locallyComplete,
    ]),
  };
  for (const field of Object.keys(navigationIdentity)) {
    same(`Navigation ${field}`, keys(graphA[field], navigationIdentity[field]),
      keys(graphB[field], navigationIdentity[field]));
  }
  same("Locally verified focus targets",
    [...graphA.coverageSummary.locallyCompleteFocusTargetKeys].sort(),
    [...graphB.coverageSummary.locallyCompleteFocusTargetKeys].sort());
  same("Navigation coverage", graphA.coverage, graphB.coverage);
  same("Known navigation frontier", graphA.coverageSummary.frontier, graphB.coverageSummary.frontier);

  const termA = baseline.ledger.navigation.termination;
  const termB = candidate.ledger.navigation.termination;
  for (const field of ["complete", "reason", "remainingFrontierEntries", "remainingCandidateActions"]) {
    same(`Termination ${field}`, termA[field] ?? null, termB[field] ?? null);
  }
  const issueIdentity = (issue) => JSON.stringify([
    issue.id, issue.rule, issue.severity, issue.confidence, issue.title,
    issue.description, issue.expected, issue.observed, issue.reproduction,
    issue.screen, issue.transition,
  ]);
  same("Issue identities and findings",
    keys(baseline.report.issues, issueIdentity),
    keys(candidate.report.issues, issueIdentity));
  same("Report completion status", baseline.report.run.status, candidate.report.run.status);

  const number = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
  const select = (bundle) => {
    const stats = bundle.ledger.navigation.statistics;
    return {
      restorationMode: bundle.ledger.navigationRestorationMode,
      termination: bundle.ledger.navigation.termination.reason,
      complete: bundle.ledger.navigation.termination.complete,
      coverage: bundle.graph.coverage,
      screens: bundle.graph.screens.length,
      focusTargets: bundle.graph.focusTargets.length,
      transitions: bundle.graph.transitions.length,
      issues: bundle.report.issues.length,
      elapsedMs: number(stats.elapsedMs),
      resetCount: number(stats.resetCount),
      replayActions: number(stats.replayActions),
      explorationActions: number(stats.explorationActions),
      physicalActions: number(stats.physicalActions),
      verifiedStateReuses: number(stats.verifiedStateReuses),
      verifiedPathRestorations: number(stats.verifiedPathRestorations),
      restorationFallbacks: number(stats.restorationFallbacks),
    };
  };
  const previous = select(baseline);
  const current = select(candidate);
  // A stable navigation/issue ID set is distinct from full equivalence of
  // mutable geometry, reproduction artifacts and report status. Never erase
  // strict comparison errors just because this narrower identity test passes.
  const observedIdentityParity = Object.fromEntries([
    ["screens", "screens", "key"],
    ["focusTargets", "focusTargets", "key"],
    ["transitions", "transitions", "key"],
    ["navigationProblems", "problems", "issueId"],
  ].map(([label, collection, field]) => [label, JSON.stringify(keys(graphA[collection], (item) => item[field]))
    === JSON.stringify(keys(graphB[collection], (item) => item[field]))]));
  observedIdentityParity.issues = JSON.stringify(keys(baseline.report.issues, (item) => item.id))
    === JSON.stringify(keys(candidate.report.issues, (item) => item.id));
  const savings = {};
  for (const field of ["elapsedMs", "resetCount", "replayActions", "physicalActions"]) {
    const a = previous[field];
    const b = current[field];
    savings[field] = a === null || b === null ? null : {
      difference: a - b,
      percent: a === 0 ? null : Number(((a - b) / a * 100).toFixed(2)),
    };
  }
  if (previous.explorationActions !== current.explorationActions) {
    errors.push("Exploration action count changed; investigate traversal order/budget differences.");
  }

  return {
    errors,
    summary: {
      evidenceEquivalent: errors.length === 0,
      observedIdentityParity,
      baseline: previous,
      candidate: current,
      savings,
    },
  };
}

export async function readReplayPerformanceBundle(directory) {
  const [graph, ledger, report] = await Promise.all([
    "navigation-graph.json", "stage-ledger.json", "report.json",
  ].map(async (file) => JSON.parse(await readFile(join(directory, file), "utf8"))));
  return { graph, ledger, report };
}

async function main() {
  if (process.argv.length !== 4) {
    throw new Error("Usage: node scripts/compare-replay-performance.mjs ROOT_ONLY_DIRECTORY VERIFIED_LOCAL_DIRECTORY");
  }
  const [root, local] = await Promise.all(process.argv.slice(2).map(readReplayPerformanceBundle));
  const result = compareReplayPerformance(root, local);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.errors.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
