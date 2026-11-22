import { expect, test } from "@playwright/test";
import { PlaywrightWebDriver } from "@tvdoctor/driver-web";
import type {
  RemoteKey,
  StateSnapshot,
  TVDoctorIssue,
  TVDoctorReportV1,
  UiNodeSnapshot,
} from "@tvdoctor/protocol";
import {
  compareBaseline,
  createBaseline,
  type BaselineObservationInventory,
  type BaselineFocusObservation,
  type BaselineScreenObservation,
  type BaselineTransitionObservation,
} from "@tvdoctor/baseline";

const PROBE_PATH: readonly RemoteKey[] = ["RIGHT", "DOWN", "DOWN", "DOWN"];

interface ProbeResult {
  readonly beforeFocus: string | null;
  readonly afterFocus: string | null;
  readonly focusRetained: boolean;
  readonly focusTargets: readonly BaselineFocusObservation[];
  readonly transitions: readonly BaselineTransitionObservation[];
}

function requireBaseURL(baseURL: string | undefined): string {
  if (baseURL === undefined) throw new Error("The M10 fixture URL is required.");
  return baseURL;
}

function focusId(snapshot: StateSnapshot): string | null {
  return snapshot.focusedElement.status === "available"
    ? snapshot.focusedElement.value?.stableId ?? null
    : null;
}

function collectFocusableTargets(snapshot: StateSnapshot): readonly BaselineFocusObservation[] {
  if (snapshot.uiTree.status !== "available") {
    throw new Error("The M10 probe requires an observed UI tree for its focus inventory.");
  }
  const visit = (nodes: readonly UiNodeSnapshot[]): readonly BaselineFocusObservation[] => (
    nodes.flatMap((node) => [
      ...(node.focusable === true && node.stableId !== null
        ? [{ key: node.stableId, screenKey: "home", role: node.role, name: node.name }]
        : []),
      ...visit(node.children),
    ])
  );
  return visit(snapshot.uiTree.value);
}

async function runProbe(
  fixtureUrl: string,
  variant: "clean" | "regressed",
): Promise<ProbeResult> {
  const driver = new PlaywrightWebDriver({
    settle: {
      noResponseGraceMs: 15,
      quietWindowMs: 20,
      timeoutMs: 2_500,
    },
  });
  const url = `${fixtureUrl}/?baselineVariant=${variant}`;
  await driver.launch({ id: `m10-probe-${variant}`, launchUri: url });
  try {
    let current = await driver.snapshot();
    const transitions: BaselineTransitionObservation[] = [];
    for (const key of PROBE_PATH) {
      const fromFocus = focusId(current);
      if (fromFocus === null) throw new Error(`Navigation ${key} has no observed source focus.`);
      const result = await driver.press(key);
      if (result.outcome !== "applied") throw new Error(`Navigation ${key} was ${result.outcome}.`);
      current = await driver.snapshot();
      transitions.push({
        key: `home/${fromFocus}:${key}`,
        fromScreenKey: "home",
        fromFocusKey: fromFocus,
        action: key,
        toScreenKey: "home",
        toFocusKey: focusId(current),
      });
    }
    const before = current;
    const action = await driver.press("SELECT");
    if (action.outcome !== "applied") throw new Error("SELECT failed.");
    const after = await driver.snapshot();
    const beforeFocus = focusId(before);
    const afterFocus = focusId(after);
    if (beforeFocus !== "m10-probe-a") {
      throw new Error(`The probe reached ${String(beforeFocus)}, not the expected M10 control.`);
    }
    const beforeTargets = collectFocusableTargets(before);
    const afterTargets = collectFocusableTargets(after);
    for (const requiredId of ["m10-probe-a", "m10-probe-b"]) {
      expect(afterTargets.some((target) => target.key === requiredId), `Missing ${requiredId} from observed focus inventory`)
        .toBe(true);
    }
    expect(afterTargets.map((target) => target.key).sort())
      .toEqual(beforeTargets.map((target) => target.key).sort());
    transitions.push({
      key: `home/${beforeFocus}:SELECT`,
      fromScreenKey: "home",
      fromFocusKey: beforeFocus,
      action: "SELECT",
      toScreenKey: "home",
      toFocusKey: afterFocus,
    });
    return {
      beforeFocus,
      afterFocus,
      focusRetained: afterFocus !== null && afterFocus !== undefined,
      focusTargets: afterTargets,
      transitions,
    };
  } finally {
    await driver.close();
  }
}

function buildInventory(result: ProbeResult): BaselineObservationInventory {
  const screens: BaselineScreenObservation[] = [
    { key: "home", label: "Home screen" },
  ];
  return {
    status: "complete",
    screens,
    focusTargets: result.focusTargets,
    transitions: result.transitions,
    latencies: [],
  };
}

function buildReport(
  runId: string,
  location: string,
  issues: readonly TVDoctorIssue[],
  inventory: BaselineObservationInventory,
): TVDoctorReportV1 {
  return {
    schemaVersion: "tvdoctor.report/v1",
    run: {
      id: runId,
      tvdoctorVersion: "0.0.0",
      mode: "standard",
      status: "completed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 1_000,
    },
    target: {
      name: "Northstar baseline variant",
      platform: "web",
      location,
      environment: {},
    },
    coverage: {
      screenStatesDiscovered: inventory.screens.length,
      focusStatesDiscovered: inventory.focusTargets.length,
      transitionsTested: inventory.transitions.length,
      actionsSent: PROBE_PATH.length + 1,
      capabilitiesObserved: ["remote-input", "ui-tree"],
      packs: [{ pack: "navigation", status: "completed" }],
      budget: {
        maxActions: 10,
        maxStates: 50,
        maxDepth: PROBE_PATH.length + 1,
        maxDurationMs: 30_000,
        maxRepetitiveItems: 12,
        exhausted: [],
      },
    },
    issues: [...issues],
    artifacts: [],
    replays: [],
  };
}

test("M10 baseline: clean → regressed → restored lifecycle proves exactly one HIGH regression and clean→clean identical", async ({ baseURL }) => {
  test.slow();
  test.setTimeout(120_000);
  const fixtureUrl = requireBaseURL(baseURL);

  // Run targeted probes against all three fixture states.
  const cleanRun = await runProbe(fixtureUrl, "clean");
  const regressedRun = await runProbe(fixtureUrl, "regressed");
  const restoredRun = await runProbe(fixtureUrl, "clean");

  // The regressed variant must lose focus; the clean variant must not.
  expect(cleanRun.focusRetained, "Clean variant must retain focus after SELECT").toBe(true);
  expect(regressedRun.focusRetained, "Regressed variant must lose focus after SELECT").toBe(false);
  expect(restoredRun.focusRetained, "Restored variant must retain focus").toBe(true);

  // Build the synthetic HIGH issue for the regressed variant.
  const regressedIssues: TVDoctorIssue[] = [{
    id: "TVDOCTOR-M10-FOCUS-LOSS",
    rule: "remote.lost-focus",
    title: "M10 controlled focus regression detected",
    description: "Select on m10-probe-a removed descendant focus in the regressed variant.",
    severity: "high",
    confidence: "deterministic",
    pack: "navigation",
    screen: "home",
    expected: "Focus should be retained after Select on m10-probe-a.",
    observed: "Focused element was unavailable (null) after Select.",
    transition: null,
    evidence: [{ kind: "deterministic-failure", summary: "Real Chromium probe observed lost focus.", source: "PlaywrightWebDriver", artifact: null }],
    reproduction: { status: "unavailable", reason: "Comparison-only synthetic finding." },
  }];

  const cleanLocation = `${fixtureUrl}/?baselineVariant=clean`;
  const regressedLocation = `${fixtureUrl}/?baselineVariant=regressed`;
  const cleanInventory = buildInventory(cleanRun);
  const regressedInventory = buildInventory(regressedRun);
  const restoredInventory = buildInventory(restoredRun);

  const cleanReport = buildReport("m10-clean", cleanLocation, [], cleanInventory);
  const regressedReport = buildReport("m10-regressed", regressedLocation, regressedIssues, regressedInventory);
  const restoredReport = buildReport("m10-restored", cleanLocation, [], restoredInventory);

  // GAUNTLET 1: clean baseline vs regressed → exactly one new HIGH.
  const baseline = createBaseline(cleanReport, cleanInventory, { createdAt: "2026-08-23T00:00:00Z" });
  const comparison = compareBaseline(baseline, regressedReport, regressedInventory);
  expect(comparison.status, JSON.stringify(comparison.blockers)).not.toBe("failed-closed");
  expect(comparison.changes.newIssues).toHaveLength(1);
  expect(comparison.changes.newIssues[0]?.severity).toBe("high");
  expect(comparison.changes.resolvedIssues).toHaveLength(0);

  // GAUNTLET 2: regressed baseline vs restored → exactly one resolved.
  const regressionBaseline = createBaseline(regressedReport, regressedInventory, { createdAt: "2026-08-23T00:01:00Z" });
  const restoredComparison = compareBaseline(regressionBaseline, restoredReport, restoredInventory);
  expect(restoredComparison.changes.newIssues).toHaveLength(0);
  expect(restoredComparison.changes.resolvedIssues).toHaveLength(1);
  expect(restoredComparison.changes.resolvedIssues[0]?.id).toBe("TVDOCTOR-M10-FOCUS-LOSS");

  // GAUNTLET 3: clean vs clean → identical.
  const cleanAgain = compareBaseline(baseline, buildReport("m10-clean-again", cleanLocation, [], cleanInventory), cleanInventory);
  expect(cleanAgain.status).toBe("identical");
  expect(cleanAgain.shouldFail).toBe(false);
  expect(cleanAgain.blockers).toEqual([]);

  // GAUNTLET 4: false-positive resistance — an irrelevant metadata change
  // must not produce the seeded HIGH regression.
  const noisyReport = buildReport("m10-noisy", `${cleanLocation}&irrelevant=noise`, [], cleanInventory);
  const noisyInventory = buildInventory(cleanRun);
  const noisyComparison = compareBaseline(baseline, noisyReport, noisyInventory);
  expect(noisyComparison.changes.newIssues).toHaveLength(0);
  expect(noisyComparison.changes.resolvedIssues).toHaveLength(0);
  expect(noisyComparison.shouldFail).toBe(false);
});
