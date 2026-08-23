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
  readonly focusableIds: readonly string[];
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

function collectFocusableIds(snapshot: StateSnapshot): readonly string[] {
  if (snapshot.uiTree.status !== "available") return [];
  const visit = (nodes: readonly UiNodeSnapshot[]): readonly string[] => (
    nodes.flatMap((node) => [
      ...(node.focusable === true && node.stableId !== null ? [node.stableId] : []),
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
    for (const key of PROBE_PATH) {
      const result = await driver.press(key);
      if (result.outcome !== "applied") throw new Error(`Navigation ${key} was ${result.outcome}.`);
    }
    const before = await driver.snapshot();
    const action = await driver.press("SELECT");
    if (action.outcome !== "applied") throw new Error("SELECT failed.");
    const after = await driver.snapshot();
    const beforeFocus = focusId(before);
    const afterFocus = focusId(after);
    return {
      beforeFocus,
      afterFocus,
      focusRetained: afterFocus !== null && afterFocus !== undefined,
      focusableIds: collectFocusableIds(after),
    };
  } finally {
    await driver.close();
  }
}

function buildInventory(result: ProbeResult): BaselineObservationInventory {
  const screens: BaselineScreenObservation[] = [
    { key: "home", label: "Home screen" },
  ];
  const focusTargets: BaselineFocusObservation[] = result.focusableIds.map((id) => ({
    key: id,
    screenKey: "home",
    role: "button",
    name: id,
  }));
  const transitions: BaselineTransitionObservation[] = [
    ...(result.beforeFocus !== null && result.afterFocus !== null
      ? [{
          key: `home/${result.beforeFocus}:SELECT`,
          fromScreenKey: "home",
          fromFocusKey: result.beforeFocus,
          action: "SELECT" as const,
          toScreenKey: "home",
          toFocusKey: result.afterFocus ?? "",
        }]
      : []),
  ];
  return {
    status: "complete",
    screens,
    focusTargets,
    transitions,
    latencies: [],
  };
}

function buildReport(
  runId: string,
  location: string,
  issues: readonly TVDoctorIssue[],
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
      screenStatesDiscovered: 1,
      focusStatesDiscovered: 2,
      transitionsTested: 1,
      actionsSent: 5,
      capabilitiesObserved: ["remote-input", "ui-tree"],
      packs: [{ pack: "navigation", status: "completed" }],
      budget: {
        maxActions: 10,
        maxStates: 50,
        maxDepth: 4,
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

  const cleanReport = buildReport("m10-clean", cleanLocation, []);
  const regressedReport = buildReport("m10-regressed", regressedLocation, regressedIssues);
  const restoredReport = buildReport("m10-restored", cleanLocation, []);

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
  const cleanAgain = compareBaseline(baseline, buildReport("m10-clean-again", cleanLocation, []), cleanInventory);
  expect(cleanAgain.status).toBe("identical");
  expect(cleanAgain.shouldFail).toBe(false);
  expect(cleanAgain.blockers).toEqual([]);

  // GAUNTLET 4: false-positive resistance — an irrelevant metadata change
  // must not produce the seeded HIGH regression.
  const noisyReport = buildReport("m10-noisy", `${cleanLocation}&irrelevant=noise`, []);
  const noisyInventory = buildInventory(cleanRun);
  const noisyComparison = compareBaseline(baseline, noisyReport, noisyInventory);
  expect(noisyComparison.changes.newIssues).toHaveLength(0);
  expect(noisyComparison.changes.resolvedIssues).toHaveLength(0);
  expect(noisyComparison.shouldFail).toBe(false);
});
