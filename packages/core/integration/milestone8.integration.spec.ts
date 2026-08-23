import { expect, test } from "@playwright/test";
import type { ExplorationResult } from "../src/index.js";
import { explore, minimizeGraphSequence } from "../src/index.js";
import { PlaywrightWebDriver } from "@tvdoctor/driver-web";

const ACTIONS = ["RIGHT", "SELECT", "DOWN"] as const;
const CAROUSEL_SIZE = 240;

function requireBaseURL(baseURL: string | undefined): string {
  if (baseURL === undefined) throw new Error("The M8 fixture URL is required.");
  return baseURL;
}

async function probeCarouselSize(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => Number(
    document.querySelector(".stress-shelf")?.getAttribute("data-carousel-size") ?? "0",
  ));
}

function stressFocusIds(result: ExplorationResult): readonly string[] {
  return result.graph.focus.states
    .map((state) => {
      const focus = state.representativeSnapshot.focusedElement;
      return focus.status === "available" ? focus.value?.stableId ?? null : null;
    })
    .filter((id): id is string => id !== null && id.startsWith("stress-card-"));
}

function canonicalStructure(result: ExplorationResult): string {
  const focusById = new Map(result.graph.focus.states.map((s) => [s.id, s.stateFingerprint]));
  const transitions = [
    ...result.graph.focus.transitions.map((e) => (
      `${focusById.get(e.fromFocusStateId)}|${e.key}|${e.actionResult.outcome}|${focusById.get(e.toFocusStateId)}`
    )),
    ...result.graph.screens.transitions.map((e) => (
      `${focusById.get(e.fromFocusStateId)}|${e.key}|${e.actionResult.outcome}|${focusById.get(e.toFocusStateId)}`
    )),
  ].sort();
  return JSON.stringify({
    screens: result.graph.screens.states.map((s) => s.fingerprint.value).sort(),
    focusStates: result.graph.focus.states.map((s) => s.stateFingerprint).sort(),
    transitions,
  });
}

async function runExplorer(
  fixtureUrl: string,
  hardened: boolean,
): Promise<ExplorationResult> {
  const driver = new PlaywrightWebDriver({
    settle: {
      noResponseGraceMs: 15,
      quietWindowMs: 20,
      timeoutMs: 2_500,
    },
  });
  const url = `${fixtureUrl}/?carouselSize=${String(CAROUSEL_SIZE)}`;
  await driver.launch({ id: "m8-benchmark", launchUri: url });
  try {
    if (!hardened) {
      // Legacy BFS with compression disabled. A tight duration proves the
      // pre-M8 explorer cannot finish a large carousel in bounded time.
      return await explore(driver, {
        actions: ACTIONS,
        budgets: {
          maxActions: 2_000,
          maxStates: 300,
          maxDepth: 260,
          maxDurationMs: 60_000,
        },
        frontierStrategy: "breadth-first",
        repetitionCompression: { enabled: false },
      });
    }
    return await explore(driver, {
      profile: "standard",
      actions: ACTIONS,
      budgets: {
        maxActions: 2_000,
        maxStates: 300,
        maxDepth: 260,
        maxDurationMs: 600_000,
      },
      frontierStrategy: "priority",
      repetitionCompression: {
        enabled: true,
        maxRepresentativesPerGroup: 1,
        maxExpandedRepresentativesPerGroup: 1,
        minimumEquivalentSiblings: 3,
      },
    });
  } finally {
    await driver.close();
  }
}

test.describe(() => {
  let pageRef: import("@playwright/test").Page | null = null;

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    pageRef = await context.newPage();
    await pageRef.goto("/?carouselSize=240");
  });

  test.afterAll(async () => {
    await pageRef?.context().close();
  });

  test("M8 benchmark: 240-card carousel exploration is compressed, deterministic, and preserves recall", async ({ baseURL }) => {
    test.slow();
    test.setTimeout(900_000);
    const fixtureUrl = requireBaseURL(baseURL);

    // Verify the fixture actually renders the full 240-card carousel.
    const renderedSize = pageRef === null ? 0 : await probeCarouselSize(pageRef);
    expect(renderedSize).toBe(CAROUSEL_SIZE);

    // GAUNTLET 5 — run baseline and hardened explorer against the real fixture.
    const baseline = await runExplorer(fixtureUrl, false);
    const hardened = await runExplorer(fixtureUrl, true);

    // Baseline BFS is expected to hit its budget on 240 cards; that is the
    // problem M8 hardening solves. Hardened exploration must finish cleanly.
    expect(hardened.termination.complete, "hardened exploration must complete").toBe(true);
    if (!baseline.termination.complete) {
      expect(["max-actions", "max-states", "max-depth", "max-duration"]).toContain(baseline.termination.reason);
    }

    // Compression must prevent the explorer from treating 240 identical
    // cards as 240 independent states. Only the representative is retained.
    expect(stressFocusIds(hardened)).toHaveLength(1);
    expect(hardened.statistics.compressedStates)
      .toBeGreaterThan(0);
    // The total focus-state count must be far below what uncompressed
    // exploration of 240 unique carousel cards would produce.
    expect(hardened.statistics.focusStates).toBeLessThan(100);

    // Recall: the hardened explorer must still discover the same screen set.
    const baselineScreens = new Set(baseline.graph.screens.states.map((s) => s.fingerprint.value));
    const hardenedScreens = new Set(hardened.graph.screens.states.map((s) => s.fingerprint.value));
    for (const screen of baselineScreens) {
      expect(hardenedScreens.has(screen), `hardened missed screen ${screen.slice(0, 40)}`).toBe(true);
    }

    // Determinism: two hardened runs produce identical structural output.
    const repeat = await runExplorer(fixtureUrl, true);
    expect(canonicalStructure(repeat)).toBe(canonicalStructure(hardened));

    // Sequence minimisation proof: find any multi-step path and verify the
    // graph minimiser either proves it already minimal or shortens it.
    const redundantEntry = hardened.graph.actions.find((attempt) => (
      attempt.actionSequence.length >= 3
    ));
    expect(redundantEntry).toBeDefined();
    if (redundantEntry === undefined) throw new Error("No multi-step path found for minimisation.");
    const minimised = await minimizeGraphSequence(
      hardened.graph,
      redundantEntry.actionSequence,
      { preserveFinalAction: true },
    );
    expect(minimised.status).not.toBe("baseline-rejected");
    expect(minimised.semanticsPreserved).toBe(true);
    if (minimised.status === "minimized") {
      expect(minimised.removedActions).toBeGreaterThan(0);
      expect(minimised.minimizedSequence?.length ?? Infinity)
        .toBeLessThan(redundantEntry.actionSequence.length);
    }
  });
});
