import { writeFile } from "node:fs/promises";
import { expect, test, type TestInfo } from "@playwright/test";
import { diagnoseNavigation, explore, type ExplorationBudgets, type ExplorationResult, type ExplorationRestorationMode } from "@tvdoctor/core";
import { PlaywrightWebDriver } from "@tvdoctor/driver-web";
import type { RemoteKey } from "@tvdoctor/protocol";
import { createSafeExplorationDriver } from "../src/node-audit-navigation.js";

// Real Chromium and Northstar fixture are deliberately used here. This is
// synthetic fixture stress evidence, never a production-app performance claim.
// Trace/recording off: retaining every replay of a 240-card DOM distorts times.
test.use({ trace: "off", video: "off", screenshot: "off" });

const ACTIONS = ["UP", "DOWN", "LEFT", "RIGHT", "SELECT", "BACK"] as const;
const BUDGETS = { maxActions: 140, maxStates: 85, maxDepth: 18, maxDurationMs: 120_000 } as const;

interface GraphIdentities {
  readonly screens: readonly string[];
  readonly focus: readonly string[];
  readonly actions: readonly string[];
  readonly transitions: readonly string[];
  readonly findings: readonly string[];
  readonly focusStableIds: readonly string[];
}

function focusedId(snapshot: ExplorationResult["graph"]["actions"][number]["beforeSnapshot"]): string {
  return snapshot.focusedElement.status === "available"
    ? snapshot.focusedElement.value?.stableId ?? "<no-focus>"
    : "<unavailable>";
}

function graphIdentities(result: ExplorationResult): GraphIdentities {
  const focusFingerprints = new Map(result.graph.focus.states.map((state) => [state.id, state.fingerprint.value]));
  const transitions = [...result.graph.focus.transitions, ...result.graph.screens.transitions];
  return {
    screens: result.graph.screens.states.map((state) => state.fingerprint.value).sort(),
    focus: [...focusFingerprints.values()].sort(),
    actions: result.graph.actions.map((action) => (
      `${focusedId(action.beforeSnapshot)}|${action.key}|${action.actionResult.outcome}|${focusedId(action.afterSnapshot)}`
    )).sort(),
    transitions: transitions.map((edge) => (
      `${focusFingerprints.get(edge.fromFocusStateId) ?? "missing"}|${edge.key}|${edge.actionResult.outcome}|${focusFingerprints.get(edge.toFocusStateId) ?? "missing"}`
    )).sort(),
    findings: diagnoseNavigation(result).findings.map(({ issue, classification }) => (
      `${issue.id}|${issue.rule}|${classification}|${issue.confidence}`
    )).sort(),
    focusStableIds: result.graph.focus.states.map((state) => focusedId(state.representativeSnapshot)).sort(),
  };
}

async function run(
  url: string,
  restorationMode: ExplorationRestorationMode,
  fixtureProfileSelection: boolean,
  budgets: ExplorationBudgets,
  actions: readonly RemoteKey[],
) {
  const driver = new PlaywrightWebDriver({
    settle: { noResponseGraceMs: 15, quietWindowMs: 50, timeoutMs: 2_500 },
  });
  const startedAt = performance.now();
  await driver.launch({ id: `complex-${restorationMode}`, launchUri: url });
  try {
    if (new URL(url).searchParams.get("carouselSize") === "240") {
      expect(await driver.getPage().locator(".stress-shelf [data-tv-id^='stress-card-']").count())
        .toBe(240);
    }
    if (new URL(url).pathname.endsWith("/deep-profile-route.html")) {
      expect(focusedId(await driver.snapshot())).toBe("profile-primary");
      const stressSize = Number(new URL(url).searchParams.get("stressCards") ?? "0");
      if (stressSize > 0) {
        // Inspect only the static template after page launch, not application
        // hidden test route data or any expected navigation graph.
        expect(stressSize).toBeGreaterThanOrEqual(3);
      }
    }
    const result = await explore(createSafeExplorationDriver(driver, { fixtureProfileSelection }), {
      profile: "deep",
      actions,
      budgets,
      restorationMode,
      resetStrategy: "relaunch",
      allowRootRestorationFallback: true,
      refreshVisibleSelfLoops: true,
      repetitionCompression: { enabled: false },
      settling: { strategy: "stable-snapshot", maxSnapshots: 3, pollIntervalMs: 20, requiredStableSnapshots: 2 },
    });
    return { result, graph: graphIdentities(result), wallMs: Math.round(performance.now() - startedAt) };
  } finally {
    await driver.close();
  }
}

function missing(before: readonly string[], after: readonly string[]): readonly string[] {
  const remaining = new Map<string, number>();
  for (const value of after) remaining.set(value, (remaining.get(value) ?? 0) + 1);
  return before.filter((value) => {
    const quantity = remaining.get(value) ?? 0;
    if (quantity === 0) return true;
    remaining.set(value, quantity - 1);
    return false;
  });
}

async function compareScenario(
  testInfo: TestInfo,
  baseURL: string,
  name: string,
  route: string,
  fixtureProfileSelection: boolean,
  options: {
    readonly budgets?: ExplorationBudgets;
    readonly actions?: readonly RemoteKey[];
    readonly requireProfile?: boolean;
    readonly requireQueueExhaustion?: boolean;
    readonly requireStressCards?: number;
    readonly artifactName?: string;
  } = {},
) {
  const budgets = options.budgets ?? BUDGETS;
  const actions = options.actions ?? ACTIONS;
  const target = new URL(route, baseURL).href;
  const baseline = await run(target, "root-only", fixtureProfileSelection, budgets, actions);
  const local = await run(target, "verified-local", fixtureProfileSelection, budgets, actions);
  const comparisons = Object.fromEntries(([
    "screens", "focus", "actions", "transitions", "findings",
  ] as const).map((key) => [key, {
    equal: JSON.stringify(baseline.graph[key]) === JSON.stringify(local.graph[key]),
    missingFromLocal: missing(baseline.graph[key], local.graph[key]),
    addedByLocal: missing(local.graph[key], baseline.graph[key]),
  }]));

  const details = (value: typeof baseline) => ({
    wallMs: value.wallMs,
    termination: value.result.termination,
    counts: {
      ...value.result.statistics,
      unsupportedSelects: value.result.graph.actions.filter((entry) => (
        entry.key === "SELECT" && entry.actionResult.outcome === "unsupported"
      )).length,
      stressFocusCount: value.graph.focusStableIds.filter((id) => id.startsWith("stress-card-")).length,
      profileFocusCount: value.graph.focusStableIds.filter((id) => id.startsWith("profile-")).length,
    },
    identities: value.graph,
  });
  const report = { schemaVersion: 1, type: "synthetic-fixture-stress", fixture: name,
    route, budgets, actions, fixtureProfileSelection,
    rootOnly: details(baseline), verifiedLocal: details(local), comparisons };
  const outputPath = testInfo.outputPath(options.artifactName ?? "deep-complex-ab.json");
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.info(`DEEP_COMPLEX_AB ${JSON.stringify({
    fixture: name, artifact: outputPath, budgets,
    rootOnly: { wallMs: baseline.wallMs, termination: baseline.result.termination,
      ...baseline.result.statistics, unsupportedSelects: report.rootOnly.counts.unsupportedSelects },
    verifiedLocal: { wallMs: local.wallMs, termination: local.result.termination,
      ...local.result.statistics, unsupportedSelects: report.verifiedLocal.counts.unsupportedSelects },
    comparison: Object.fromEntries(Object.entries(comparisons).map(([key, entry]) => {
      const comparison = entry as { equal: boolean; missingFromLocal: readonly string[]; addedByLocal: readonly string[] };
      return [key, { equal: comparison.equal, missing: comparison.missingFromLocal.length, added: comparison.addedByLocal.length }];
    })),
  })}`);

  for (const value of [baseline, local]) {
    expect(value.result.statistics.physicalActions).toBe(value.result.statistics.explorationActions + value.result.statistics.replayActions);
    expect(value.result.statistics.physicalActions).toBeLessThanOrEqual(budgets.maxActions);
    expect(value.result.statistics.deferredStates ?? 0).toBe(0);
    expect(value.result.termination.complete || value.result.termination.reason !== "queue-exhausted").toBe(true);
    if (options.requireProfile === true) {
      expect(value.graph.focusStableIds).toContain("profile-primary");
      expect(value.graph.focusStableIds).toContain("profile-kids");
      expect(value.graph.focusStableIds).toContain("home-browse");
      expect(value.result.graph.actions.some((action) => action.key === "SELECT"
        && focusedId(action.beforeSnapshot).startsWith("profile-")
        && action.actionResult.outcome === "applied")).toBe(true);
    }
    if (options.requireStressCards !== undefined) {
      for (let index = 1; index <= options.requireStressCards; index += 1) {
        const id = `stress-card-${String(index).padStart(2, "0")}`;
        const detailId = `details-back-${id}`;
        expect(value.graph.focusStableIds, `${name}: catalogue focus ${String(index)}`)
          .toContain(id);
        expect(value.graph.focusStableIds, `${name}: distinct details for ${id}`)
          .toContain(detailId);
        expect(value.result.graph.actions.some((action) => (
          focusedId(action.beforeSnapshot) === id
          && action.key === "SELECT"
          && action.actionResult.outcome === "applied"
          && focusedId(action.afterSnapshot) === detailId
        )), `${name}: SELECT visits individually identified ${id} details`).toBe(true);
      }
      for (const focusId of ["home-search", "home-settings", "details-back", "settings-close", "search-result-a"]) {
        expect(value.graph.focusStableIds, `${name}: ${focusId} reachable`)
          .toContain(focusId === "details-back" ? "details-back-search-result-a" : focusId);
      }
      expect(value.result.statistics.screenStates, `${name}: carousel title-specific screens`)
        .toBeGreaterThanOrEqual(options.requireStressCards + 4);
    }
    if (options.requireQueueExhaustion === true) {
      expect(value.result.termination).toMatchObject({ reason: "queue-exhausted", complete: true });
      expect(value.result.termination.remainingFrontierEntries ?? 0).toBe(0);
      expect(value.result.termination.remainingCandidateActions ?? 0).toBe(0);
      expect(value.result.statistics.pendingStates).toBe(0);
      expect(report.rootOnly.counts.unsupportedSelects, `${name}: safe root SELECT actions`).toBe(0);
      expect(report.verifiedLocal.counts.unsupportedSelects, `${name}: safe local SELECT actions`).toBe(0);
    }
    if (value.result.termination.reason === "max-actions" || value.result.termination.reason === "max-duration") {
      expect(value.result.termination.complete).toBe(false);
      expect(value.result.termination.remainingFrontierEntries ?? 0).toBeGreaterThan(0);
    }
  }
  // For these deterministic, explicitly seeded fixtures the non-opportunistic
  // traversal order and physical input limits are intentionally identical.
  // Lock in the observed parity after the local-path-length guard: a future
  // optimization that silently spends the last action budget on longer local
  // paths must fail this test, even though both runs are correctly *partial*.
  for (const field of ["screens", "focus", "actions", "transitions", "findings"] as const) {
    expect(local.graph[field], `${name}: observed ${field} parity`).toEqual(baseline.graph[field]);
  }
  expect(local.result.termination.reason).toBe(baseline.result.termination.reason);
  expect(local.result.termination.remainingFrontierEntries)
    .toBe(baseline.result.termination.remainingFrontierEntries);
  expect(local.result.termination.remainingCandidateActions)
    .toBe(baseline.result.termination.remainingCandidateActions);
}

test("Deep A/B: multi-route Northstar overlays and profile picker", async ({ baseURL }, testInfo) => {
  test.setTimeout(270_000);
  if (baseURL === undefined) throw new Error("Northstar fixture URL is required");
  await compareScenario(testInfo, baseURL, "northstar-semantic-alternate", "/?routeVariant=semantic-alternate", true);
});

test("Deep A/B: Northstar 240-card carousel plus alternate routes", async ({ baseURL }, testInfo) => {
  test.setTimeout(270_000);
  if (baseURL === undefined) throw new Error("Northstar fixture URL is required");
  await compareScenario(testInfo, baseURL, "northstar-stress-240", "/?routeVariant=semantic-alternate&carouselSize=240", true);
});

test("Deep A/B: complex profile-on-launch and nested route overlays", async ({ baseURL }, testInfo) => {
  test.setTimeout(220_000);
  if (baseURL === undefined) throw new Error("Northstar fixture URL is required");
  await compareScenario(testInfo, baseURL, "profile-route-overlay", "/deep-profile-route.html", true, {
    budgets: { maxActions: 125, maxStates: 35, maxDepth: 8, maxDurationMs: 85_000 },
    actions: ["DOWN", "SELECT", "BACK"],
    requireProfile: true,
  });
});

test("Deep A/B: finite multi-route carousel exhausts the entire safe frontier with exact parity", async ({ baseURL }, testInfo) => {
  test.setTimeout(540_000);
  if (baseURL === undefined) throw new Error("Northstar fixture URL is required");
  await compareScenario(testInfo, baseURL, "finite-complete-8", "/deep-profile-route.html?stressCards=8", true, {
    budgets: { maxActions: 1_800, maxStates: 100, maxDepth: 35, maxDurationMs: 220_000 },
    actions: ["DOWN", "SELECT", "BACK"],
    requireProfile: true,
    requireQueueExhaustion: true,
    requireStressCards: 8,
    artifactName: "deep-complex-complete-8.json",
  });
});
