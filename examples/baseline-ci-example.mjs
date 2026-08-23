/**
 * Locally executable CI example for TVDoctor's semantic baselines.
 *
 * This script demonstrates the consumer workflow documented in
 * docs/baselines-and-ci.md: create a clean baseline, compare a regressed run,
 * compare a restored run, and exit nonzero when a regression is present.
 *
 * It is intentionally self-contained (no browser driver required) so a CI job
 * can validate the baseline library without Playwright. The real-browser gate
 * lives in packages/core/integration/milestone10.integration.spec.ts.
 *
 * Usage:
 *   node examples/baseline-ci-example.mjs
 *
 * Exit codes:
 *   0 — all comparisons behaved as expected (regression detected and resolved)
 *   1 — an assertion failed; the baseline system did not behave correctly
 */

import {
  compareBaseline,
  createBaseline,
} from "@tvdoctor/baseline";

function issue(id, severity) {
  return {
    id,
    rule: "fixture.regression",
    title: `Issue ${id}`,
    description: "A deliberate semantic regression.",
    severity,
    confidence: "deterministic",
    pack: "navigation",
    screen: "home",
    expected: "Expected focus target",
    observed: "Observed different focus target",
    transition: null,
    evidence: [],
    reproduction: { status: "unavailable", reason: "CI example only." },
  };
}

function report(runId, issues) {
  return {
    schemaVersion: "tvdoctor.report/v1",
    run: {
      id: runId,
      tvdoctorVersion: "0.0.0",
      mode: "standard",
      status: "completed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 100,
    },
    target: { name: "CI example", platform: "web", location: "http://127.0.0.1:3000/", environment: {} },
    coverage: {
      screenStatesDiscovered: 1,
      focusStatesDiscovered: 1,
      transitionsTested: 1,
      actionsSent: 1,
      capabilitiesObserved: ["remote-input", "ui-tree"],
      packs: [{ pack: "navigation", status: "completed" }],
      budget: { maxActions: 10, maxStates: 10, maxDepth: 4, maxDurationMs: 30_000, maxRepetitiveItems: 12, exhausted: [] },
    },
    issues: [...issues],
    artifacts: [],
    replays: [],
  };
}

const inventory = {
  status: "complete",
  screens: [{ key: "home", label: "Home" }],
  focusTargets: [{ key: "hero", screenKey: "home", role: "button", name: "Play" }],
  transitions: [{ key: "home/hero:SELECT", fromScreenKey: "home", fromFocusKey: "hero", action: "SELECT", toScreenKey: "home", toFocusKey: "hero" }],
  latencies: [],
};

let failures = 0;

// Step 1: create a clean baseline.
const baseline = createBaseline(report("ci-clean", []), inventory);
console.log("baseline created:", baseline.schemaVersion);

// Step 2: compare against a regressed run → must detect exactly one HIGH issue.
const regressed = compareBaseline(baseline, report("ci-regressed", [issue("regression-1", "high")]), inventory);
if (regressed.changes.newIssues.length !== 1) {
  console.error(`FAIL: expected exactly 1 new issue but got ${String(regressed.changes.newIssues.length)}`);
  failures += 1;
} else if (regressed.changes.newIssues[0]?.severity !== "high") {
  console.error("FAIL: new issue is not HIGH severity");
  failures += 1;
} else if (!regressed.shouldFail) {
  console.error("FAIL: comparison should fail for a regression");
  failures += 1;
} else {
  console.log("clean→regressed detected exactly one HIGH regression ✓");
}

// Step 3: compare restored state against the regressed baseline → resolved.
const regressionBaseline = createBaseline(report("ci-regression-baseline", [issue("regression-1", "high")]), inventory);
const restored = compareBaseline(regressionBaseline, report("ci-restored", []), inventory);
if (restored.changes.resolvedIssues.length !== 1) {
  console.error(`FAIL: expected exactly 1 resolved issue but got ${String(restored.changes.resolvedIssues.length)}`);
  failures += 1;
} else {
  console.log("regressed→restored resolved exactly the seeded issue ✓");
}

// Step 4: compare two identical clean runs → identical, no blockers.
const cleanAgain = compareBaseline(baseline, report("ci-clean-again", []), inventory);
if (cleanAgain.status !== "identical" || cleanAgain.shouldFail || cleanAgain.blockers.length > 0) {
  console.error(`FAIL: expected identical/clean but got status=${cleanAgain.status} shouldFail=${String(cleanAgain.shouldFail)} blockers=${String(cleanAgain.blockers.length)}`);
  failures += 1;
} else {
  console.log("clean→clean reported identical with no blockers ✓");
}

process.exitCode = failures === 0 ? 0 : 1;
if (failures === 0) {
  console.log("\nBaseline CI example passed.");
} else {
  console.error(`\nBaseline CI example failed with ${String(failures)} error(s).`);
}
