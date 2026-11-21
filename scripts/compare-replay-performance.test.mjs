import assert from "node:assert/strict";
import test from "node:test";

import { compareReplayPerformance } from "./compare-replay-performance.mjs";

function sample({ mode = "root-only", replay = 40, changed = false, pending = 0 } = {}) {
  return {
    graph: {
      schemaVersion: "tvdoctor.navigation-focus-graph/v2",
      configuredActions: ["UP", "DOWN", "SELECT"],
      screens: [{ key: "screen-home" }],
      focusTargets: [{ key: "focus-home" }],
      transitions: [{ key: changed ? "edge-changed" : "edge-home" }],
      cycles: [],
      problems: [{ issueId: "TVDOCTOR-1", kind: "focus", rule: "focus-loss", evidenceClassification: "deterministic" }],
      coverage: "complete",
      coverageSummary: {
        locallyCompleteFocusTargetKeys: ["focus-home"],
        frontier: { status: "complete", remainingEntries: pending },
      },
    },
    ledger: {
      mode: "deep",
      target: { kind: "web", id: "northstar-fixture" },
      selectedPacks: ["navigation"],
      navigationRestorationMode: mode,
      navigation: {
        termination: { reason: "queue-exhausted", complete: true, remainingFrontierEntries: pending },
        statistics: {
          elapsedMs: replay * 100,
          resetCount: replay / 4,
          replayActions: replay,
          explorationActions: 15,
          physicalActions: replay + 15,
          verifiedStateReuses: mode === "root-only" ? 0 : 3,
          verifiedPathRestorations: mode === "root-only" ? 0 : 2,
          restorationFallbacks: 0,
        },
      },
    },
    report: {
      run: { status: "completed" },
      coverage: { budget: { maxActions: 100, maxDepth: 8 }, packs: [{ pack: "navigation", status: "completed" }] },
      issues: [{ id: "TVDOCTOR-1", confidence: "deterministic" }],
    },
  };
}

test("reports replay reductions when all screen, focus, transition, issue, and frontier identities match", () => {
  const result = compareReplayPerformance(sample(), sample({ mode: "verified-local", replay: 12 }));
  assert.deepEqual(result.errors, []);
  assert.equal(result.summary.evidenceEquivalent, true);
  assert.deepEqual(Object.values(result.summary.observedIdentityParity), Array(5).fill(true));
  assert.equal(result.summary.savings.replayActions.difference, 28);
  assert.equal(result.summary.savings.replayActions.percent, 70);
  assert.equal(result.summary.candidate.verifiedPathRestorations, 2);
});

test("rejects changed navigation transitions despite identical screen/action counts", () => {
  const result = compareReplayPerformance(sample(), sample({ mode: "verified-local", replay: 12, changed: true }));
  assert.ok(result.errors.some((e) => e.includes("Navigation transitions")));
  assert.equal(result.summary.evidenceEquivalent, false);
});

test("rejects different pending frontier and report status", () => {
  const candidate = sample({ mode: "verified-local", replay: 12, pending: 2 });
  candidate.report.run.status = "partial";
  const result = compareReplayPerformance(sample(), candidate);
  assert.ok(result.errors.some((e) => e.includes("Known navigation frontier")));
  assert.ok(result.errors.some((e) => e.includes("Report completion status")));
});

test("rejects changed issue confidence and exploration-action count", () => {
  const candidate = sample({ mode: "verified-local", replay: 12 });
  candidate.report.issues[0].confidence = "heuristic";
  candidate.ledger.navigation.statistics.explorationActions += 1;
  const result = compareReplayPerformance(sample(), candidate);
  assert.ok(result.errors.some((e) => e.includes("Issue identities")));
  assert.ok(result.errors.some((e) => e.includes("Exploration action count")));
});

test("rejects finding reproduction changes even when issue IDs and confidences match", () => {
  const baseline = sample();
  baseline.report.issues[0].reproduction = { path: ["DOWN", "SELECT"] };
  const candidate = sample({ mode: "verified-local", replay: 12 });
  candidate.report.issues[0].reproduction = { path: ["UP", "SELECT"] };
  const result = compareReplayPerformance(baseline, candidate);
  assert.ok(result.errors.some((e) => e.includes("Issue identities and findings")));
  assert.equal(result.summary.observedIdentityParity.issues, true);
  assert.equal(result.summary.evidenceEquivalent, false);
});

test("rejects unchanged restoration settings and mismatched fixture safety policy", () => {
  const baseline = sample();
  const candidate = sample({ replay: 12 });
  candidate.ledger.fixtureProfileSelectionEnabled = true;
  const result = compareReplayPerformance(baseline, candidate);
  assert.ok(result.errors.some((e) => e.includes("Restoration modes are identical")));
  assert.ok(result.errors.some((e) => e.includes("fixtureProfileSelectionEnabled")));
});

test("rejects different target even if the two apps expose equal numbers of controls", () => {
  const candidate = sample({ mode: "verified-local", replay: 12 });
  candidate.ledger.target.id = "different-app";
  const result = compareReplayPerformance(sample(), candidate);
  assert.ok(result.errors.some((e) => e.includes("Run configuration target")));
});

test("rejects unmatched Deep ceilings or changed pack results", () => {
  const candidate = sample({ mode: "verified-local", replay: 12 });
  candidate.report.coverage.budget.maxActions = 200;
  candidate.report.coverage.packs[0].status = "partial";
  const result = compareReplayPerformance(sample(), candidate);
  assert.ok(result.errors.some((error) => error.includes("Scan budget configuration")));
  assert.ok(result.errors.some((error) => error.includes("Selected pack completion")));
});

test("rejects changed observed focus identity despite equal fingerprints, edge keys and counts", () => {
  const baseline = sample();
  baseline.graph.focusTargets[0].confidence = "high";
  baseline.graph.focusTargets[0].observation = {
    status: "present", evidenceClassification: "verified-fact",
    element: { stableId: "recycled-card", name: "Episode 12", role: "button" },
  };
  const candidate = sample({ mode: "verified-local", replay: 12 });
  candidate.graph.focusTargets[0].confidence = "high";
  candidate.graph.focusTargets[0].observation = {
    status: "present", evidenceClassification: "verified-fact",
    element: { stableId: "recycled-card", name: "Episode 13", role: "button" },
  };
  const result = compareReplayPerformance(baseline, candidate);
  assert.ok(result.errors.some((error) => error.includes("Navigation focusTargets")));
  assert.equal(result.summary.observedIdentityParity.focusTargets, true);
  assert.equal(result.summary.evidenceEquivalent, false);
});

test("rejects weakened screen certainty and changed observed destination even with unchanged edge key", () => {
  const baseline = sample();
  baseline.graph.screens[0].confidence = "high";
  baseline.graph.transitions[0].observedFocusTargetKey = "state-a";
  baseline.graph.transitions[0].observedScreenKey = "screen-a";
  const candidate = sample({ mode: "verified-local", replay: 12 });
  candidate.graph.screens[0].confidence = "low";
  candidate.graph.transitions[0].observedFocusTargetKey = "state-b";
  candidate.graph.transitions[0].observedScreenKey = "screen-b";
  const result = compareReplayPerformance(baseline, candidate);
  assert.ok(result.errors.some((error) => error.includes("Navigation screens")));
  assert.ok(result.errors.some((error) => error.includes("Navigation transitions")));
  assert.equal(result.summary.evidenceEquivalent, false);
});
