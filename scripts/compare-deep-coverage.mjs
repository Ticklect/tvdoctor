#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Checks that a more permissive, explicitly authorised fixture run has not
 * hidden any screen, focus or previously applied navigation edge from a
 * conservative Deep run. Counts alone are not sufficient evidence.
 */
export function compareDeepCoverage(baseline, candidate) {
  const errors = [];
  if (baseline.schemaVersion !== "tvdoctor.navigation-focus-graph/v2"
    || candidate.schemaVersion !== baseline.schemaVersion) {
    errors.push("Both inputs must be v2 navigation focus graphs.");
    return { errors, summary: null };
  }

  const preserveKeys = (label, oldValues, newValues) => {
    const seen = new Set(newValues.map((entry) => entry.key));
    const missing = oldValues.filter((entry) => !seen.has(entry.key));
    if (missing.length > 0) {
      errors.push(`${label}: ${missing.length} previously observed identities missing (first: ${missing.slice(0, 3).map((entry) => entry.key).join(", ")}).`);
    }
    return missing.length;
  };
  const missingScreens = preserveKeys("Screens", baseline.screens, candidate.screens);
  const missingFocusTargets = preserveKeys("Focus targets", baseline.focusTargets, candidate.focusTargets);
  const applied = baseline.transitions.filter((transition) => transition.outcome === "applied");
  const missingEdges = preserveKeys("Previously applied edges", applied, candidate.transitions);

  const candidateBySourceAndAction = new Map();
  for (const transition of candidate.transitions) {
    const key = JSON.stringify([transition.fromFocusTargetKey, transition.action]);
    const existing = candidateBySourceAndAction.get(key) ?? [];
    existing.push(transition);
    candidateBySourceAndAction.set(key, existing);
  }
  const excluded = baseline.transitions.filter((transition) => transition.outcome !== "applied");
  const stillExcluded = excluded.filter((transition) => {
    const key = JSON.stringify([transition.fromFocusTargetKey, transition.action]);
    return !(candidateBySourceAndAction.get(key) ?? []).some((entry) => entry.outcome === "applied");
  });
  if (stillExcluded.length > 0) {
    errors.push(`${stillExcluded.length} formerly excluded actions still lack an applied observation.`);
  }
  if (candidate.coverage !== "complete") {
    errors.push(`Candidate navigation coverage is ${String(candidate.coverage)}, not complete.`);
  }
  if (candidate.coverageSummary?.frontier?.status !== "complete") {
    errors.push("Candidate did not exhaust its known navigation frontier.");
  }
  const locallyComplete = candidate.coverageSummary?.locallyCompleteFocusTargetKeys;
  const observedFocusTargets = candidate.coverageSummary?.observedFocusTargets;
  if (!Array.isArray(locallyComplete) || locallyComplete.length !== observedFocusTargets) {
    errors.push("Candidate does not have applied-action verification for every observed focus target.");
  }
  if (candidate.transitions.some((transition) => transition.outcome !== "applied")) {
    errors.push("Candidate contains unapplied action edges; do not claim verified complete coverage.");
  }

  return {
    errors,
    summary: {
      baseline: { screens: baseline.screens.length, focusTargets: baseline.focusTargets.length, transitions: baseline.transitions.length },
      candidate: { screens: candidate.screens.length, focusTargets: candidate.focusTargets.length, transitions: candidate.transitions.length },
      originallyExcluded: excluded.length,
      upgradedActions: excluded.length - stillExcluded.length,
      missingScreens,
      missingFocusTargets,
      missingEdges,
      candidateCoverage: candidate.coverage,
      candidateFrontier: candidate.coverageSummary?.frontier?.status ?? null,
      locallyVerifiedTargets: locallyComplete?.length ?? null,
    },
  };
}

async function main() {
  if (process.argv.length !== 4) {
    throw new Error("Usage: node scripts/compare-deep-coverage.mjs BASELINE_REPORT_DIRECTORY CANDIDATE_REPORT_DIRECTORY");
  }
  const directories = process.argv.slice(2);
  const [baseline, candidate] = await Promise.all(directories.map(async (directory) =>
    JSON.parse(await readFile(join(directory, "navigation-graph.json"), "utf8"))));
  const result = compareDeepCoverage(baseline, candidate);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.errors.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
