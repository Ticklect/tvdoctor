import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";
import {
  compileIssueReplay,
  diagnoseNavigation,
  executeReplay,
  explore,
  PreparedStateDivergenceError,
  prepareStartup,
} from "../src/index.js";
import { PlaywrightWebDriver } from "@tvdoctor/driver-web";
import {
  buildTVDoctorReportV1,
  createArtifactStore,
  writeIssueEvidence,
  writeReportBundle,
} from "@tvdoctor/reporters";
import type { TVDoctorIssue } from "@tvdoctor/protocol";
import type { Observation, StateSnapshot, UiNodeSnapshot } from "@tvdoctor/protocol";
import type { WebDomNodeSnapshot } from "@tvdoctor/driver-web";

function requireBaseURL(baseURL: string | undefined): string {
  if (baseURL === undefined) throw new Error("The integration fixture URL is required.");
  return baseURL;
}

function focusedStableId(snapshot: StateSnapshot): string | null | undefined {
  return snapshot.focusedElement.status === "available"
    ? snapshot.focusedElement.value?.stableId
    : null;
}

function flattenSnapshotNodes(snapshot: {
  readonly uiTree: Observation<readonly WebDomNodeSnapshot[]>;
}): readonly WebDomNodeSnapshot[] {
  if (snapshot.uiTree.status !== "available") return [];
  const result: WebDomNodeSnapshot[] = [];
  const visit = (nodes: readonly WebDomNodeSnapshot[]): void => {
    for (const node of nodes) {
      result.push(node);
      visit(node.children);
    }
  };
  visit(snapshot.uiTree.value);
  return result;
}

function flattenReplayNodes(snapshot: StateSnapshot): readonly UiNodeSnapshot[] {
  if (snapshot.uiTree.status !== "available") return [];
  const result: UiNodeSnapshot[] = [];
  const visit = (nodes: readonly UiNodeSnapshot[]): void => {
    for (const node of nodes) {
      result.push(node);
      visit(node.children);
    }
  };
  visit(snapshot.uiTree.value);
  return result;
}

const STABLE_SETTLING = {
  strategy: "stable-snapshot",
  maxSnapshots: 3,
  pollIntervalMs: 20,
  requiredStableSnapshots: 2,
} as const;

test("identifies a deterministic local consent wall and remains fail-closed", async ({ baseURL }) => {
  const driver = new PlaywrightWebDriver();
  await driver.launch({ id: "consent-wall", launchUri: `${requireBaseURL(baseURL)}/consent-wall.html` });
  try {
    const result = await explore(driver, {
      profile: "quick",
      actions: ["RIGHT", "SELECT", "BACK"],
      budgets: {
        maxActions: 40,
        maxStates: 12,
        maxDepth: 3,
        maxDurationMs: 20_000,
      },
      settling: STABLE_SETTLING,
    });
    const diagnostics = diagnoseNavigation(result);
    expect(diagnostics.findings.map((finding) => finding.issue.rule))
      .toContain("remote.consent-wall");
    expect([
      "queue-exhausted",
      "replay-diverged",
      "max-duration",
      "max-actions",
    ]).toContain(result.termination.reason);
    expect(result.statistics.physicalActions).toBeLessThanOrEqual(40);
  } finally {
    await driver.close();
  }
});

test("startup preparation records consent, selects a reproducible path, and fails closed on drift", async ({ baseURL }) => {
  const fixtureUrl = `${requireBaseURL(baseURL)}/consent-wall.html`;
  const stability = {
    maxSnapshots: 4,
    requiredStableSnapshots: 2,
    pollIntervalMs: 25,
    timeoutMs: 5_000,
  };

  const observer = new PlaywrightWebDriver();
  await observer.launch({ id: "consent-observe", launchUri: fixtureUrl });
  try {
    const observed = await prepareStartup(observer, {
      policy: { kind: "observe" },
      resetStrategy: "reload",
      stability,
    });
    expect(observed.status).toBe("setup-blocker");
    expect(observed.blockers[0]).toMatchObject({ kind: "consent-wall" });
    expect(observed.controls.map((control) => control.stableId)).toEqual([
      "reject-consent",
      "accept-consent",
    ]);
  } finally {
    await observer.close();
  }

  for (const [actions, choice] of [
    [["RIGHT", "SELECT"], "accepted"],
    [["SELECT"], "rejected"],
  ] as const) {
    const driver = new PlaywrightWebDriver();
    await driver.launch({ id: `consent-${choice}`, launchUri: fixtureUrl });
    try {
      const prepared = await prepareStartup(driver, {
        policy: { kind: "remote-sequence", actions },
        resetStrategy: "reload",
        stability,
      });
      expect(prepared.status).toBe("ready");
      expect(prepared.blockers).toHaveLength(1);
      await expect(focusedStableId(await driver.snapshot())).toBe("catalogue-home");

      await driver.getPage().evaluate(() => sessionStorage.clear());
      await expect(prepared.restoreToPreparedState?.()).rejects.toBeInstanceOf(
        PreparedStateDivergenceError,
      );
    } finally {
      await driver.close();
    }
  }
});

test("supports same-origin iframe traversal, observation, report evidence, and replay", async ({ baseURL }, testInfo) => {
  const fixtureUrl = `${requireBaseURL(baseURL)}/iframe-parent.html`;
  const driver = new PlaywrightWebDriver();
  await driver.launch({ id: "iframe-parent", launchUri: fixtureUrl });

  let insideFrame;
  try {
    expect(focusedStableId(await driver.snapshot())).toBe("parent-control");
    await driver.press("RIGHT");
    insideFrame = await driver.snapshot();
    expect(focusedStableId(insideFrame)).toBe("child-first");

    const nodes = flattenSnapshotNodes(insideFrame);
    const frame = nodes.find((node) => node.tagName === "iframe");
    expect(frame?.attributes["data-tv-frame"]).toBe("same-origin");
    expect(nodes.some((node) => node.stableId === "child-second")).toBe(true);

    await driver.press("LEFT");
    expect(focusedStableId(await driver.snapshot())).toBe("parent-control");
  } finally {
    await driver.close();
  }

  const issue: TVDoctorIssue = {
    id: "TVDOCTOR-NAV-IFRAME-SAME-ORIGIN",
    rule: "remote.frame-focus",
    title: "Same-origin frame focus regression",
    description: "Controlled regression model: RIGHT remains on the parent instead of entering the frame.",
    severity: "info",
    confidence: "deterministic",
    pack: "navigation",
    screen: "iframe-parent",
    expected: "Focus enters child-first.",
    observed: "Focus remained on parent-control.",
    transition: {
      fromElement: "parent-control",
      action: "RIGHT",
      expectedElement: "child-first",
      observedElement: "parent-control",
    },
    evidence: [],
    reproduction: {
      status: "available",
      resetStrategy: "reload",
      originalSequence: [{ key: "RIGHT", repeat: 1 }],
      minimizedSequence: null,
      confidence: "deterministic",
      artifact: null,
    },
  };

  const compiled = compileIssueReplay(issue);
  if (compiled.status !== "compiled") throw new Error(compiled.reason.message);
  const replayDriver = new PlaywrightWebDriver();
  await replayDriver.launch({ id: "iframe-replay", launchUri: fixtureUrl });
  try {
    const replay = await executeReplay(replayDriver, compiled.plan);
    expect(replay.status).toBe("fixed");
    const afterSnapshot = replay.evidence.afterSnapshot;
    if (afterSnapshot === null) throw new Error("Replay omitted its after snapshot.");
    expect(focusedStableId(afterSnapshot)).toBe("child-first");
    expect(flattenReplayNodes(afterSnapshot).map((node) => node.stableId))
      .toContain("child-second");
  } finally {
    await replayDriver.close();
  }

  const outputRoot = testInfo.outputPath("iframe-report");
  const store = await createArtifactStore(outputRoot);
  const evidenceValue = JSON.parse(JSON.stringify({
    before: insideFrame,
    after: insideFrame,
  }));
  const written = await writeIssueEvidence(store, {
    issueId: issue.id,
    artifacts: [
      {
        slot: "ui-excerpt",
        capture: { status: "available", format: "json" as const, value: evidenceValue },
      },
      ...([{
        slot: "replay" as const,
        capture: {
          status: "available" as const,
          format: "text" as const,
          text: `${JSON.stringify(compiled.plan.replay, null, 2)}\n`,
          mediaType: "text/yaml",
        },
      }]),
    ],
  });
  const excerptText = await readFile(join(outputRoot, "evidence", issue.id, "ui-excerpt.json"), "utf8");
  expect(excerptText).toContain("child-second");
  const replayPath = written.pathsBySlot.replay;
  expect(replayPath).toBeDefined();

  const startedAt = new Date();
  const report = buildTVDoctorReportV1({
    run: {
      id: "iframe-regression",
      tvdoctorVersion: "0.0.0",
      mode: "quick",
      status: "completed",
      startedAt: startedAt.toISOString(),
      completedAt: startedAt.toISOString(),
      durationMs: 0,
    },
    target: {
      name: "iframe-fixture",
      platform: "web",
      location: fixtureUrl,
      environment: { browser: "chromium" },
    },
    coverage: {
      screenStatesDiscovered: 2,
      focusStatesDiscovered: 2,
      transitionsTested: 1,
      actionsSent: 1,
      capabilitiesObserved: ["remote-input", "ui-tree"],
      packs: [{ pack: "navigation", status: "completed" }],
      budget: {
        maxActions: 10,
        maxStates: 10,
        maxDepth: 2,
        maxDurationMs: 10_000,
        maxRepetitiveItems: 1,
        exhausted: [],
      },
    },
    issues: [{
      ...issue,
      evidence: [{
        kind: "verified-fact",
        summary: "Observed same-origin boundary and nested controls.",
        source: "PlaywrightWebDriver",
        artifact: written.pathsBySlot["ui-excerpt"] ?? "",
      }],
      reproduction: {
        status: "available",
        resetStrategy: "reload",
        originalSequence: [{ key: "RIGHT", repeat: 1 }],
        minimizedSequence: null,
        confidence: "deterministic",
        artifact: replayPath ?? null,
      },
    }],
    artifacts: written.descriptors,
    replays: [compiled.plan.replay],
  });
  expect(report.schemaVersion).toBe("tvdoctor.report/v1");
  const bundle = await writeReportBundle(store, report);
  expect(bundle.reportJson.byteLength).toBeGreaterThan(0);
});

test("degrades gracefully at a deterministic local cross-origin iframe boundary", async ({ baseURL }) => {
  const driver = new PlaywrightWebDriver();
  await driver.launch({
    id: "iframe-cross-origin",
    launchUri: `${requireBaseURL(baseURL)}/iframe-cross-origin-parent.html`,
  });
  try {
    expect(focusedStableId(await driver.snapshot())).toBe("parent-control");
    await driver.press("RIGHT");
    const snapshot = await driver.snapshot();
    expect(focusedStableId(snapshot)).toBe("parent-control");
    const nodes = flattenSnapshotNodes(snapshot);
    const frame = nodes.find((node) => node.tagName === "iframe");
    expect(frame?.attributes["data-tv-frame"]).toBe("cross-origin");
    expect(nodes.some((node) => node.name === "Inaccessible control")).toBe(false);
  } finally {
    await driver.close();
  }
});

test("stays bounded and observes navigation through a continuously replaced rail", async ({ baseURL }) => {
  const driver = new PlaywrightWebDriver({
    settle: { ambientChurnEscape: true },
  });
  await driver.launch({ id: "dynamic-rail", launchUri: `${requireBaseURL(baseURL)}/dynamic-rail.html` });
  try {
    const result = await explore(driver, {
      profile: "quick",
      actions: ["RIGHT", "LEFT"],
      budgets: {
        maxActions: 100,
        maxStates: 10,
        maxDepth: 7,
        maxDurationMs: 25_000,
      },
      settling: STABLE_SETTLING,
    });

    const focusIds = result.graph.focus.states.map((state) => (
      state.representativeSnapshot.focusedElement.status === "available"
        ? state.representativeSnapshot.focusedElement.value?.stableId
        : undefined
    ));
    expect(result.statistics.elapsedMs).toBeLessThan(25_000);
    expect(focusIds).toEqual(expect.arrayContaining([
      "rail-0",
    ]));
    expect(result.statistics.compressedStates).toBeGreaterThan(0);
    expect(result.termination).toMatchObject({ complete: true });
  } finally {
    await driver.close();
  }
});

test("settles meaningful navigation on raw ambient DOM mutation without full timeouts", async ({ baseURL }) => {
  const driver = new PlaywrightWebDriver({
    settle: { ambientChurnEscape: true },
  });
  await driver.launch({
    id: "ambient-noise",
    launchUri: `${requireBaseURL(baseURL)}/ambient-churn.html`,
  });
  try {
    const result = await explore(driver, {
      profile: "quick",
      actions: ["RIGHT", "LEFT"],
      budgets: {
        maxActions: 30,
        maxStates: 5,
        maxDepth: 2,
        maxDurationMs: 15_000,
      },
      settling: STABLE_SETTLING,
    });

    expect(result.termination).toEqual({ reason: "queue-exhausted", complete: true });
    expect(result.statistics.elapsedMs).toBeLessThan(15_000);
    const focusedIds = result.graph.focus.states.map((state) => (
      state.representativeSnapshot.focusedElement.status === "available"
        ? state.representativeSnapshot.focusedElement.value?.stableId
        : null
    ));
    expect(focusedIds).toContain("churn-left");
    expect(focusedIds).toContain("churn-right");
  } finally {
    await driver.close();
  }
});

test("fails closed when lazy-loaded structural churn prevents a stable baseline", async ({ baseURL }) => {
  const driver = new PlaywrightWebDriver({
    settle: { ambientChurnEscape: true },
  });
  await driver.launch({
    id: "ambient-lazy",
    launchUri: `${requireBaseURL(baseURL)}/ambient-churn.html?lazy=true`,
  });
  try {
    const result = await explore(driver, {
      profile: "quick",
      actions: ["RIGHT"],
      budgets: {
        maxActions: 6,
        maxStates: 4,
        maxDepth: 2,
        maxDurationMs: 12_000,
      },
      settling: STABLE_SETTLING,
    });

    expect(result.statistics.physicalActions).toBeLessThanOrEqual(6);
    expect(result.statistics.elapsedMs).toBeLessThan(12_000);
    expect(result.termination.complete).toBe(false);
    expect([
      "settling-exhausted",
      "replay-diverged",
      "max-depth",
      "max-duration",
      "max-actions",
    ]).toContain(result.termination.reason);
  } finally {
    await driver.close();
  }
});
