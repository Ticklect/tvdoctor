import { expect, test } from "@playwright/test";
import type {
  FocusState,
  ExplorationResult,
  ScreenState,
} from "../src/index.js";
import { explore } from "../src/index.js";
import { PlaywrightWebDriver } from "@tvdoctor/driver-web";
import type { UiNodeSnapshot } from "@tvdoctor/protocol";

const ACTIONS = ["RIGHT", "SELECT", "DOWN", "LEFT", "UP", "BACK"] as const;
const BUDGETS = {
  maxActions: 96,
  maxStates: 40,
  maxDepth: 4,
  maxDurationMs: 120_000,
} as const;

function requireBaseURL(baseURL: string | undefined): string {
  if (baseURL === undefined) throw new Error("The integration fixture URL is required.");
  return baseURL;
}

function stableIds(nodes: readonly UiNodeSnapshot[]): readonly string[] {
  return nodes.flatMap((node) => [
    ...(node.stableId === null ? [] : [node.stableId]),
    ...stableIds(node.children),
  ]);
}

function screenContains(state: ScreenState, stableId: string): boolean {
  const tree = state.representativeSnapshot.uiTree;
  return tree.status === "available" && stableIds(tree.value).includes(stableId);
}

function focusId(state: FocusState): string | null {
  const focus = state.representativeSnapshot.focusedElement;
  return focus.status === "available" ? focus.value?.stableId ?? null : null;
}

function canonicalGraph(result: ExplorationResult): {
  readonly screens: readonly string[];
  readonly focusStates: readonly string[];
  readonly transitions: readonly string[];
} {
  const focusById = new Map(result.graph.focus.states.map((state) => [state.id, state.stateFingerprint]));
  const transitions = [
    ...result.graph.focus.transitions.map((edge) => (
      `${focusById.get(edge.fromFocusStateId)}|${edge.key}|${edge.actionResult.outcome}|${focusById.get(edge.toFocusStateId)}`
    )),
    ...result.graph.screens.transitions.map((edge) => (
      `${focusById.get(edge.fromFocusStateId)}|${edge.key}|${edge.actionResult.outcome}|${focusById.get(edge.toFocusStateId)}`
    )),
  ].sort();
  return {
    screens: result.graph.screens.states.map((state) => state.fingerprint.value).sort(),
    focusStates: result.graph.focus.states.map((state) => state.stateFingerprint).sort(),
    transitions,
  };
}

async function runFixtureExploration(fixtureUrl: string): Promise<ExplorationResult> {
  const driver = new PlaywrightWebDriver({
    settle: {
      noResponseGraceMs: 15,
      quietWindowMs: 20,
      timeoutMs: 2_500,
    },
  });
  await driver.launch({ id: "northstar-m3", launchUri: fixtureUrl });
  try {
    return await explore(driver, { actions: ACTIONS, budgets: BUDGETS });
  } finally {
    await driver.close();
  }
}

test("bounded exploration terminates, emits separate graphs, and repeats consistently", async ({ baseURL }) => {
  const fixtureUrl = requireBaseURL(baseURL);
  const [first, second] = await Promise.all([
    runFixtureExploration(fixtureUrl),
    runFixtureExploration(fixtureUrl),
  ]);

  for (const result of [first, second]) {
    expect(result.termination).toEqual({ reason: "max-actions", complete: false });
    expect(result.statistics).toMatchObject({
      physicalActions: BUDGETS.maxActions,
    });
    expect(result.statistics.screenStates).toBeGreaterThanOrEqual(5);
    expect(result.statistics.screenStates).toBeLessThanOrEqual(6);
    expect(result.statistics.focusStates).toBeGreaterThanOrEqual(14);
    expect(result.statistics.focusStates).toBeLessThanOrEqual(18);
    expect(result.statistics.visitedStates).toBeLessThanOrEqual(BUDGETS.maxStates);
    expect(result.statistics.elapsedMs).toBeLessThan(BUDGETS.maxDurationMs);
    expect(Math.max(...result.graph.focus.states.map((state) => state.firstSeenDepth))).toBeLessThanOrEqual(
      BUDGETS.maxDepth,
    );

    for (const anchor of [
      "hero-watch",
      "search-query",
      "details-play",
      "player-play-pause",
      "profile-primary",
    ]) {
      expect(result.graph.screens.states.some((state) => screenContains(state, anchor)), anchor).toBe(true);
      expect(result.graph.focus.states.some((state) => focusId(state) === anchor), anchor).toBe(true);
    }

    const focusById = new Map(result.graph.focus.states.map((state) => [state.id, focusId(state)]));
    const allTransitions = [...result.graph.focus.transitions, ...result.graph.screens.transitions];
    const hasEdge = (from: string, key: string, to: string): boolean => allTransitions.some((edge) => (
      focusById.get(edge.fromFocusStateId) === from
      && edge.key === key
      && focusById.get(edge.toFocusStateId) === to
    ));
    expect(hasEdge("home-nav-home", "RIGHT", "hero-watch")).toBe(true);
    expect(hasEdge("hero-watch", "SELECT", "details-play")).toBe(true);
    expect(hasEdge("details-play", "SELECT", "player-play-pause")).toBe(true);
    expect(hasEdge("home-nav-library", "SELECT", "profile-primary")).toBe(true);

    const expandedPairs = result.graph.actions.map((attempt) => (
      `${attempt.fromFocusStateId}|${attempt.key}`
    ));
    expect(new Set(expandedPairs).size).toBe(expandedPairs.length);
    expect(result.graph.focus.transitions.some((edge) => edge.fromFocusStateId === edge.toFocusStateId)).toBe(true);
  }

  expect(canonicalGraph(second)).toEqual(canonicalGraph(first));
});
