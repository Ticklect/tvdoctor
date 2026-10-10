import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ExplorationResult,
  NavigationFocusGraphV2,
} from "@tvdoctor/core";
import { createNavigationFocusGraphV2 } from "@tvdoctor/core";
import type { StateSnapshot } from "@tvdoctor/protocol";
import { createArtifactStore } from "@tvdoctor/reporters";
import { afterEach, describe, expect, it } from "vitest";

import {
  NAVIGATION_GRAPH_JSON_PATH,
  NAVIGATION_GRAPH_MARKDOWN_PATH,
  renderNavigationFocusGraphMermaid,
  renderNavigationFocusGraphMarkdown,
  writeNavigationGraphArtifacts,
} from "../src/navigation-graph-output.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => {
    await rm(path, { recursive: true, force: true });
  }));
});

function snapshot(name: string): StateSnapshot {
  return {
    capturedAt: "2026-09-18T20:00:00.000Z",
    location: { status: "available", value: "app://home" },
    focusedElement: {
      status: "available",
      value: { stableId: name.toLowerCase(), role: "button", name },
    },
    uiTree: { status: "available", value: [] },
  };
}

function explorationResult(): ExplorationResult {
  const first = snapshot("Play");
  const second = snapshot("Settings");
  return {
    graph: {
      screens: {
        states: [{
          id: "screen-home",
          fingerprint: { value: "screen-fingerprint-home", confidence: "high", signals: ["stable-identifiers"] },
          firstSeenDepth: 0,
          discoveredBy: [],
          representativeSnapshot: first,
          focusStateIds: ["focus-play", "focus-settings"],
        }],
        transitions: [],
      },
      focus: {
        states: [
          {
            id: "focus-play",
            screenStateId: "screen-home",
            fingerprint: { value: "focus-fingerprint-play", confidence: "high", signals: ["stable-identifiers"] },
            stateFingerprint: "state-focus-play",
            confidence: "high",
            firstSeenDepth: 0,
            discoveredBy: [],
            representativeSnapshot: first,
          },
          {
            id: "focus-settings",
            screenStateId: "screen-home",
            fingerprint: { value: "focus-fingerprint-settings", confidence: "high", signals: ["stable-identifiers"] },
            stateFingerprint: "state-focus-settings",
            confidence: "high",
            firstSeenDepth: 1,
            discoveredBy: ["RIGHT"],
            representativeSnapshot: second,
          },
        ],
        transitions: [],
      },
      actions: [{
        id: "action-1",
        fromScreenStateId: "screen-home",
        fromFocusStateId: "focus-play",
        toScreenStateId: "screen-home",
        toFocusStateId: "focus-settings",
        key: "RIGHT",
        actionSequence: ["RIGHT"],
        actionResult: {
          key: "RIGHT",
          outcome: "applied",
          timing: { inputSentAtMs: 1 },
        },
        beforeSnapshot: first,
        afterSnapshot: second,
        observedFingerprint: {
          screen: { value: "screen-fingerprint-home", confidence: "high", signals: ["stable-identifiers"] },
          focus: { value: "focus-fingerprint-settings", confidence: "high", signals: ["stable-identifiers"] },
          stateValue: "state-focus-settings",
          confidence: "high",
        },
      }],
    },
    termination: { reason: "queue-exhausted", complete: true },
    budgets: { maxActions: 10, maxStates: 10, maxDepth: 4, maxDurationMs: 10_000 },
    actionOrder: ["UP", "DOWN", "LEFT", "RIGHT", "SELECT", "BACK"],
    statistics: {
      physicalActions: 1,
      explorationActions: 1,
      replayActions: 0,
      resetCount: 0,
      replayRestorations: 0,
      visitedStates: 2,
      screenStates: 1,
      focusStates: 2,
      maximumQueueSize: 1,
      pendingStates: 0,
      elapsedMs: 1,
      averagePathDepth: 0.5,
      maximumPathDepth: 1,
      averageReplayLength: 0,
      maximumReplayLength: 0,
      timings: {
        resetMs: 0,
        pathReplayMs: 0,
        driverPressMs: 0,
        actionDispatchMs: 0,
        focusSettlingMs: 0,
        screenSettlingMs: 0,
        snapshotCaptureMs: 0,
        semanticNormalizationMs: 0,
        graphBookkeepingMs: 0,
      },
    },
  };
}

describe("navigation graph artifacts", () => {
  it("writes stable JSON and readable Markdown descriptors from observed navigation only", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-navigation-graph-"));
    temporaryDirectories.push(root);
    const store = await createArtifactStore(root);

    const descriptors = await writeNavigationGraphArtifacts(store, explorationResult(), []);

    expect(descriptors).toMatchObject([
      { id: "run:navigation-graph-json", status: "available", path: NAVIGATION_GRAPH_JSON_PATH },
      { id: "run:navigation-graph-markdown", status: "available", path: NAVIGATION_GRAPH_MARKDOWN_PATH },
    ]);
    const graph = JSON.parse(await readFile(join(root, NAVIGATION_GRAPH_JSON_PATH), "utf8")) as NavigationFocusGraphV2;
    expect(graph).toMatchObject({
      schemaVersion: "tvdoctor.navigation-focus-graph/v2",
      coverage: "complete",
      configuredActions: ["UP", "DOWN", "LEFT", "RIGHT", "SELECT", "BACK"],
      coverageSummary: {
        observedScreens: 1,
        observedFocusTargets: 2,
        observedTransitions: 1,
        locallyCompleteFocusTargetKeys: [],
        frontier: {
          status: "complete",
          category: null,
          reason: "queue-exhausted",
          remainingFrontierEntries: 0,
          remainingCandidateActions: 0,
          deferredStates: 0,
        },
      },
      cycles: [],
    });
    expect(graph.focusTargets.find((target) => target.key === "state-focus-settings"))
      .toMatchObject({ shortestKnownPath: ["RIGHT"] });
    expect(graph.transitions).toHaveLength(1);
    expect(graph.transitions[0]).toMatchObject({
      action: "RIGHT",
      fromFocusTargetKey: "state-focus-play",
      toFocusTargetKey: "state-focus-settings",
      reproductionPath: ["RIGHT"],
    });
    const markdown = await readFile(join(root, NAVIGATION_GRAPH_MARKDOWN_PATH), "utf8");
    expect(markdown).toContain("## Screens and focus targets");
    expect(markdown).toContain("## Exploration coverage");
    expect(markdown).toContain("Locally complete focus targets: **0 / 2**");
    expect(markdown).toContain("## Quick focus routes");
    expect(markdown).toContain("name `Settings`");
    expect(markdown).toContain("## Quick navigation map");
    expect(markdown).toContain("```mermaid\nflowchart LR");
    expect(markdown).toContain('F0 -- "RIGHT" --> F1');
    expect(markdown).toContain("Shortest known path");
    expect(markdown).toContain("## Observed remote edges");
    expect(markdown).toContain("## Observed cycle analysis");
    expect(markdown).toContain("Cycles are observed graph structure, not automatically defects.");
    expect(markdown).toContain("**RIGHT**");
    expect(markdown).toContain("`RIGHT`");
    expect(markdown).toContain("Missing edges are not inferred.");
  });

  it("bounds enormous Markdown edge tables and maps while identifying the complete JSON source", () => {
    const graph = createNavigationFocusGraphV2(explorationResult());
    const edge = graph.transitions[0];
    expect(edge).toBeDefined();
    if (edge === undefined) return;
    const huge: NavigationFocusGraphV2 = {
      ...graph,
      transitions: Array.from({ length: 10_500 }, (_, index) => ({
        ...edge,
        key: `edge-${index}`,
      })),
    };
    const markdown = renderNavigationFocusGraphMarkdown(huge);
    expect(markdown).toContain("Some Markdown tables are limited");
    expect(markdown).toContain("Showing 10000 of 10500 observed edges");
    expect(markdown).toContain("navigation-graph.json contains every serialized observation");
    expect(markdown.match(/\| \*\*RIGHT\*\* \|/gu)).toHaveLength(10_000);
    const mermaid = renderNavigationFocusGraphMermaid(huge);
    expect(mermaid.match(/-- "RIGHT" -->/gu)).toHaveLength(120);
  });

  it("escapes UI labels before placing them in Mermaid nodes", () => {
    const graph = createNavigationFocusGraphV2(explorationResult());
    const firstTarget = graph.focusTargets[0];
    expect(firstTarget).toBeDefined();
    if (firstTarget === undefined) return;
    const hostileGraph: NavigationFocusGraphV2 = {
      ...graph,
      focusTargets: graph.focusTargets.map((target, index) => index === 0
        ? {
            ...target,
            observation: {
              status: "present" as const,
              element: {
                stableId: "hostile",
                role: "button",
                name: 'Play"]\nInjected["node',
                bounds: null,
              },
              reason: null,
              evidenceClassification: "verified-fact" as const,
            },
          }
        : target),
    };

    const mermaid = renderNavigationFocusGraphMermaid(hostileGraph);
    expect(mermaid).toContain("&quot;");
    expect(mermaid).toContain("&#91;");
    expect(mermaid).not.toContain('\nInjected["node');
  });

  it("describes only known deferred frontier work on a partial run", () => {
    const partial: ExplorationResult = {
      ...explorationResult(),
      termination: {
        reason: "max-actions",
        complete: false,
        remainingFrontierEntries: 4,
        remainingCandidateActions: 9,
      },
      statistics: {
        ...explorationResult().statistics,
        pendingStates: 4,
      },
    };
    const graph = createNavigationFocusGraphV2(partial);
    const markdown = renderNavigationFocusGraphMarkdown(graph);

    expect(markdown).toContain("Coverage: **PARTIAL**");
    expect(markdown).toContain("Known deferred frontier: **budget** (`max-actions`)");
    expect(markdown).toContain("4 queued entries / up to 9 candidate actions");
    expect(markdown).not.toContain("unknown app state");
  });

  it("labels heuristic problem annotations as unconfirmed and uses reference-candidate wording", () => {
    const markdown = renderNavigationFocusGraphMarkdown({
      schemaVersion: "tvdoctor.navigation-focus-graph/v1",
      coverage: "partial",
      configuredActions: ["DOWN"],
      screens: [{
        key: "screen-home",
        confidence: "high",
        firstSeenPath: [],
        focusTargetKeys: ["focus-a", "focus-b"],
      }],
      focusTargets: [],
      transitions: [],
      problems: [{
        kind: "unexpected-jump",
        issueId: "TVDOCTOR-NAV-HEURISTIC",
        rule: "remote.directional-coherence",
        evidenceClassification: "heuristic",
        evidenceKinds: ["heuristic-warning"],
        source: { screenKey: "screen-home", focusTargetKey: "focus-a", element: null },
        target: {
          screenKey: "screen-home",
          focusTargetKey: "focus-b",
          element: null,
          expectedElement: { stableId: "candidate", role: "button", name: "Candidate", bounds: null },
          observedElement: { stableId: "actual", role: "button", name: "Actual", bounds: null },
        },
        reproductionPath: ["DOWN", "DOWN"],
        locallyComplete: false,
      }],
    });

    expect(markdown).toContain("heuristic — not confirmed");
    expect(markdown).toContain("reference candidate");
    expect(markdown).not.toContain("expected ");
    expect(markdown).toContain("`DOWN` → `DOWN`");
  });
});
