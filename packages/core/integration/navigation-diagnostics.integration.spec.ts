import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type {
  ActionResult,
  RemoteKey,
  StateSnapshot,
} from "@tvdoctor/protocol";
import { PlaywrightWebDriver } from "@tvdoctor/driver-web";
import {
  diagnoseNavigation,
  explore,
  fingerprintSnapshot,
  type ExplorationActionAttempt,
  type ExplorationResult,
  type FocusState,
  type FocusTransition,
  type NavigationDiagnosticFinding,
  type ScreenState,
  type ScreenTransition,
} from "../src/index.js";

interface TraceSource {
  readonly sequence: readonly RemoteKey[];
  readonly expectedFocus: string;
  readonly actions: readonly RemoteKey[];
}

interface MutableScreenState {
  readonly id: string;
  readonly fingerprint: ScreenState["fingerprint"];
  readonly firstSeenDepth: number;
  readonly discoveredBy: readonly RemoteKey[];
  readonly representativeSnapshot: StateSnapshot;
  readonly focusStateIds: string[];
}

interface FixtureDefect {
  readonly id: string;
  readonly expectedRule: string;
  readonly target: string;
}

interface FixtureManifest {
  readonly defects: readonly FixtureDefect[];
}

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureManifestPath = resolve(
  packageDirectory,
  "../../../fixtures/broken-streaming-web/seeded-defects.json",
);
const DIRECTIONS = ["UP", "RIGHT", "DOWN", "LEFT"] as const;
const ALL_REMOTE_KEYS = ["UP", "RIGHT", "DOWN", "LEFT", "SELECT", "BACK"] as const;
const HOME_EXPLORATION_BUDGETS = {
  maxActions: 260,
  maxStates: 40,
  maxDepth: 8,
  maxDurationMs: 120_000,
} as const;
const MILESTONE_4_DEFECT_IDS = [
  "fixture-home-more-info-unreachable",
  "fixture-profile-focus-trap",
  "fixture-carousel-right-jump",
  "fixture-details-back-wrong-screen",
  "fixture-caption-text-colour-remote-unreachable",
] as const;

function requireBaseURL(baseURL: string | undefined): string {
  if (baseURL === undefined) throw new Error("The integration fixture URL is required.");
  return baseURL;
}

function focusedStableId(snapshot: StateSnapshot): string | null {
  const focus = snapshot.focusedElement;
  return focus.status === "available" ? focus.value?.stableId ?? null : null;
}

function stateId(prefix: string, index: number): string {
  return `${prefix}-${String(index).padStart(4, "0")}`;
}

function createFixtureDriver(): PlaywrightWebDriver {
  return new PlaywrightWebDriver({
    settle: {
      noResponseGraceMs: 15,
      quietWindowMs: 20,
      timeoutMs: 2_500,
    },
  });
}

async function exploreHomeDirections(fixtureUrl: string): Promise<ExplorationResult> {
  const driver = createFixtureDriver();
  await driver.launch({ id: "northstar-m4-home-exploration", launchUri: fixtureUrl });
  try {
    return await explore(driver, {
      actions: DIRECTIONS,
      budgets: HOME_EXPLORATION_BUDGETS,
    });
  } finally {
    await driver.close();
  }
}

/**
 * Capture a bounded real-driver trace for a context that generic root discovery
 * is not required to reach until the semantic streaming work in Milestone 6.
 * The returned graph is intentionally incomplete and must never be described as
 * a queue-exhausted exploration.
 */
async function captureTargetedContextProbe(
  fixtureUrl: string,
  sources: readonly TraceSource[],
  actionOrder: readonly RemoteKey[],
): Promise<ExplorationResult> {
  const driver = createFixtureDriver();
  const startedAt = performance.now();
  let physicalActions = 0;
  let explorationActions = 0;
  const screens: MutableScreenState[] = [];
  const focusStates: FocusState[] = [];
  const attempts: ExplorationActionAttempt[] = [];
  const focusTransitions: FocusTransition[] = [];
  const screenTransitions: ScreenTransition[] = [];
  const screenByFingerprint = new Map<string, MutableScreenState>();
  const focusByFingerprint = new Map<string, FocusState>();

  const register = (snapshot: StateSnapshot, sequence: readonly RemoteKey[]): FocusState => {
    const fingerprint = fingerprintSnapshot(snapshot);
    const knownFocus = focusByFingerprint.get(fingerprint.stateValue);
    if (knownFocus !== undefined) return knownFocus;

    let screen = screenByFingerprint.get(fingerprint.screen.value);
    if (screen === undefined) {
      screen = {
        id: stateId("screen", screens.length + 1),
        fingerprint: fingerprint.screen,
        firstSeenDepth: sequence.length,
        discoveredBy: [...sequence],
        representativeSnapshot: snapshot,
        focusStateIds: [],
      };
      screens.push(screen);
      screenByFingerprint.set(fingerprint.screen.value, screen);
    }

    const focus: FocusState = {
      id: stateId("focus", focusStates.length + 1),
      screenStateId: screen.id,
      fingerprint: fingerprint.focus,
      stateFingerprint: fingerprint.stateValue,
      confidence: fingerprint.confidence,
      firstSeenDepth: sequence.length,
      discoveredBy: [...sequence],
      representativeSnapshot: snapshot,
    };
    focusStates.push(focus);
    screen.focusStateIds.push(focus.id);
    focusByFingerprint.set(fingerprint.stateValue, focus);
    return focus;
  };

  const replay = async (sequence: readonly RemoteKey[]): Promise<void> => {
    await driver.reset("reload");
    for (const key of sequence) {
      const result = await driver.press(key);
      physicalActions += 1;
      expect(result, `replay ${sequence.join(" ")}`).toMatchObject({ key, outcome: "applied" });
      await expect.poll(
        async () => focusedStableId(await driver.snapshot()),
        {
          message: `remote focus after replay ${sequence.join(" ")}`,
          timeout: 2_500,
        },
      ).not.toBeNull();
    }
  };

  await driver.launch({ id: "northstar-m4", launchUri: fixtureUrl });
  try {
    for (const source of sources) {
      for (const key of source.actions) {
        await replay(source.sequence);
        const beforeSnapshot = await driver.snapshot();
        expect(focusedStableId(beforeSnapshot), source.sequence.join(" ")).toBe(source.expectedFocus);
        const from = register(beforeSnapshot, source.sequence);
        const actionResult: ActionResult = await driver.press(key);
        physicalActions += 1;
        explorationActions += 1;
        expect(actionResult).toMatchObject({ key, outcome: "applied" });
        const afterSnapshot = await driver.snapshot();
        const actionSequence = [...source.sequence, key];
        const to = register(afterSnapshot, actionSequence);
        const attemptId = stateId("action", attempts.length + 1);
        const attempt: ExplorationActionAttempt = {
          id: attemptId,
          fromScreenStateId: from.screenStateId,
          fromFocusStateId: from.id,
          toScreenStateId: to.screenStateId,
          toFocusStateId: to.id,
          key,
          actionSequence,
          actionResult,
          beforeSnapshot,
          afterSnapshot,
          observedFingerprint: fingerprintSnapshot(afterSnapshot),
        };
        attempts.push(attempt);
        if (from.screenStateId === to.screenStateId) {
          focusTransitions.push({
            id: stateId("focus-transition", focusTransitions.length + 1),
            screenStateId: from.screenStateId,
            fromFocusStateId: from.id,
            toFocusStateId: to.id,
            key,
            actionSequence,
            actionResult,
            attemptId,
          });
        } else {
          screenTransitions.push({
            id: stateId("screen-transition", screenTransitions.length + 1),
            fromScreenStateId: from.screenStateId,
            toScreenStateId: to.screenStateId,
            fromFocusStateId: from.id,
            toFocusStateId: to.id,
            key,
            actionSequence,
            actionResult,
            attemptId,
          });
        }
      }
    }
  } finally {
    await driver.close();
  }

  const elapsedMs = performance.now() - startedAt;
  return {
    graph: {
      screens: {
        states: screens.map((screen): ScreenState => ({
          ...screen,
          focusStateIds: [...screen.focusStateIds],
        })),
        transitions: screenTransitions,
      },
      focus: { states: focusStates, transitions: focusTransitions },
      actions: attempts,
    },
    termination: { reason: "max-actions", complete: false },
    budgets: {
      maxActions: Math.max(physicalActions, 1),
      maxStates: Math.max(focusStates.length, 1),
      maxDepth: Math.max(...focusStates.map((state) => state.firstSeenDepth), 0),
      maxDurationMs: 150_000,
    },
    actionOrder,
    statistics: {
      physicalActions,
      explorationActions,
      replayActions: physicalActions - explorationActions,
      visitedStates: focusStates.length,
      screenStates: screens.length,
      focusStates: focusStates.length,
      maximumQueueSize: 0,
      elapsedMs,
    },
  };
}

function findingTarget(finding: NavigationDiagnosticFinding): string | null {
  switch (finding.issue.rule) {
    case "remote.reachability":
      return finding.target.element?.stableId ?? null;
    case "remote.focus-trap":
    case "remote.unexpected-jump":
    case "remote.back-behaviour":
      return finding.source.element?.stableId ?? null;
    default:
      return finding.target.element?.stableId ?? finding.source.element?.stableId ?? null;
  }
}

function findingKey(finding: NavigationDiagnosticFinding): string {
  return `${finding.issue.rule}|${findingTarget(finding) ?? "<none>"}`;
}

function counts(values: readonly string[]): ReadonlyMap<string, number> {
  const result = new Map<string, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

/** Return every occurrence in `actual` beyond the multiplicity in `expected`. */
function multisetExcess(actual: readonly string[], expected: readonly string[]): readonly string[] {
  const remaining = new Map(counts(expected));
  const excess: string[] = [];
  for (const value of actual) {
    const available = remaining.get(value) ?? 0;
    if (available === 0) {
      excess.push(value);
    } else {
      remaining.set(value, available - 1);
    }
  }
  return excess.sort();
}

function requireFinding(
  findings: readonly NavigationDiagnosticFinding[],
  key: string,
): NavigationDiagnosticFinding {
  const matches = findings.filter((finding) => findingKey(finding) === key);
  expect(matches, key).toHaveLength(1);
  const finding = matches[0];
  if (finding === undefined) throw new Error(`Expected one finding for ${key}.`);
  return finding;
}

test("navigation diagnostics measure the five M4 seeds from a production Home crawl and explicit deep probes", async ({
  baseURL,
}, testInfo) => {
  const fixtureUrl = requireBaseURL(baseURL);
  const captionRoot = [
    "RIGHT",
    "SELECT",
    "SELECT",
    "RIGHT",
    "RIGHT",
    "SELECT",
    "DOWN",
    "DOWN",
    "DOWN",
    "SELECT",
  ] as const;
  const [home, profile, captions, back] = await Promise.all([
    exploreHomeDirections(fixtureUrl),
    captureTargetedContextProbe(fixtureUrl, [
      { sequence: ["DOWN", "DOWN"], expectedFocus: "home-nav-library", actions: ["SELECT"] },
      { sequence: ["DOWN", "DOWN", "SELECT"], expectedFocus: "profile-primary", actions: ALL_REMOTE_KEYS },
      { sequence: ["DOWN", "DOWN", "SELECT", "RIGHT"], expectedFocus: "profile-kids", actions: ALL_REMOTE_KEYS },
    ], ALL_REMOTE_KEYS),
    captureTargetedContextProbe(fixtureUrl, [
      { sequence: captionRoot, expectedFocus: "caption-font-size", actions: DIRECTIONS },
      { sequence: [...captionRoot, "DOWN"], expectedFocus: "caption-background-colour", actions: DIRECTIONS },
      { sequence: [...captionRoot, "DOWN", "DOWN"], expectedFocus: "caption-edge-style", actions: DIRECTIONS },
    ], DIRECTIONS),
    captureTargetedContextProbe(fixtureUrl, [
      { sequence: ["RIGHT"], expectedFocus: "hero-watch", actions: ["SELECT"] },
      { sequence: ["RIGHT", "SELECT"], expectedFocus: "details-play", actions: ["BACK"] },
    ], ["SELECT", "BACK"]),
  ]);

  const homeFindings = diagnoseNavigation(home).findings;
  const profileFindings = diagnoseNavigation(profile).findings;
  const captionFindings = diagnoseNavigation(captions).findings;
  const backFindings = diagnoseNavigation(back).findings;
  const findings = [
    ...homeFindings,
    ...profileFindings,
    ...captionFindings,
    ...backFindings,
  ];
  const manifest = JSON.parse(await readFile(fixtureManifestPath, "utf8")) as FixtureManifest;
  const expected = MILESTONE_4_DEFECT_IDS.map((id) => {
    const matches = manifest.defects.filter((defect) => defect.id === id);
    expect(matches, `manifest entry ${id}`).toHaveLength(1);
    const defect = matches[0];
    if (defect === undefined) throw new Error(`Missing manifest defect ${id}.`);
    return defect;
  });
  const expectedKeys = expected.map((defect) => `${defect.expectedRule}|${defect.target}`);
  const observedKeys = findings.map((finding) => findingKey(finding));
  const observedCounts = counts(observedKeys);
  const detected = expected.filter((defect) => (
    (observedCounts.get(`${defect.expectedRule}|${defect.target}`) ?? 0) > 0
  ));
  const missedKeys = multisetExcess(expectedKeys, observedKeys);
  const falsePositives = multisetExcess(observedKeys, expectedKeys);
  const duplicateFindings = [...observedCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => left.key.localeCompare(right.key));
  const measurement = {
    inScopeSeedCount: expected.length,
    detected: detected.map((defect) => defect.id).sort(),
    missed: missedKeys,
    falsePositives,
    duplicateFindings,
    outOfScopeSeedCount: manifest.defects.filter((defect) => (
      !MILESTONE_4_DEFECT_IDS.some((id) => id === defect.id)
    )).length,
    findings: findings.map((finding) => ({
      issueId: finding.issue.id,
      key: findingKey(finding),
      classification: finding.classification,
      confidence: finding.issue.confidence,
      evidenceKinds: finding.issue.evidence.map((evidence) => evidence.kind),
      reproduction: finding.issue.reproduction,
    })),
    capture: {
      home: {
        kind: "production-explorer",
        termination: home.termination,
        budgets: home.budgets,
        statistics: home.statistics,
      },
      profile: {
        kind: "targeted-context-probe",
        termination: profile.termination,
        statistics: profile.statistics,
      },
      captions: {
        kind: "targeted-context-probe",
        termination: captions.termination,
        statistics: captions.statistics,
      },
      back: {
        kind: "targeted-context-probe",
        termination: back.termination,
        statistics: back.statistics,
      },
      scopeNote: "Only Home directional coverage is discovered by the production explorer in this M4 gate. Profile, Caption Appearance, and Details/Back are real-driver targeted context probes; semantic root discovery belongs to M6.",
    },
  };
  await testInfo.attach("milestone-4-manifest-comparison.json", {
    body: Buffer.from(`${JSON.stringify(measurement, null, 2)}\n`, "utf8"),
    contentType: "application/json",
  });

  expect(expected.map((defect) => defect.id)).toEqual(MILESTONE_4_DEFECT_IDS);
  expect(home.termination).toEqual({ reason: "queue-exhausted", complete: true });
  expect(home.budgets).toEqual(HOME_EXPLORATION_BUDGETS);
  expect(home.statistics).toMatchObject({
    focusStates: 14,
    explorationActions: 56,
  });
  expect(home.statistics.physicalActions).toBeLessThanOrEqual(HOME_EXPLORATION_BUDGETS.maxActions);
  expect(home.statistics.elapsedMs).toBeLessThanOrEqual(HOME_EXPLORATION_BUDGETS.maxDurationMs);
  expect(homeFindings.map((finding) => findingKey(finding)).sort()).toEqual([
    "remote.reachability|hero-more-info",
    "remote.unexpected-jump|home-card-3",
  ]);
  for (const targetedProbe of [profile, captions, back]) {
    expect(targetedProbe.termination).toEqual({ reason: "max-actions", complete: false });
  }

  expect(measurement.detected).toHaveLength(5);
  expect(measurement.missed).toEqual([]);
  expect(measurement.falsePositives).toEqual([]);
  expect(measurement.duplicateFindings).toEqual([]);
  expect(measurement.outOfScopeSeedCount).toBe(8);
  expect([...observedKeys].sort()).toEqual([...expectedKeys].sort());

  const homeReachability = requireFinding(findings, "remote.reachability|hero-more-info");
  expect(homeReachability).toMatchObject({
    classification: "deterministic",
    issue: {
      rule: "remote.reachability",
      severity: "medium",
      confidence: "deterministic",
      expected: "RIGHT should reach hero-more-info.",
      observed: "RIGHT moved to hero-watch, skipping the candidate.",
      transition: {
        fromElement: "hero-watch",
        action: "RIGHT",
        expectedElement: "hero-more-info",
        observedElement: "hero-watch",
      },
      evidence: [{ kind: "deterministic-failure", artifact: null }],
      reproduction: {
        status: "available",
        resetStrategy: "reload",
        originalSequence: [{ key: "RIGHT", repeat: 2 }],
        minimizedSequence: null,
        confidence: "deterministic",
        artifact: null,
      },
    },
    source: {
      kind: "action-attempt",
      element: { stableId: "hero-watch" },
      actionSequence: ["RIGHT", "RIGHT"],
      locallyComplete: true,
    },
    target: {
      element: { stableId: "hero-more-info", role: "button" },
      expectedElement: { stableId: "hero-more-info" },
      observedElement: { stableId: "hero-watch" },
    },
  });

  const captionReachability = requireFinding(findings, "remote.reachability|caption-text-colour");
  expect(captionReachability).toMatchObject({
    classification: "deterministic",
    issue: {
      rule: "remote.reachability",
      severity: "medium",
      confidence: "deterministic",
      transition: {
        fromElement: "caption-font-size",
        action: "DOWN",
        expectedElement: "caption-text-colour",
        observedElement: "caption-background-colour",
      },
      evidence: [{ kind: "deterministic-failure", artifact: null }],
      reproduction: {
        status: "available",
        resetStrategy: "reload",
        originalSequence: [
          { key: "RIGHT", repeat: 1 },
          { key: "SELECT", repeat: 2 },
          { key: "RIGHT", repeat: 2 },
          { key: "SELECT", repeat: 1 },
          { key: "DOWN", repeat: 3 },
          { key: "SELECT", repeat: 1 },
          { key: "DOWN", repeat: 1 },
        ],
        minimizedSequence: null,
        confidence: "deterministic",
        artifact: null,
      },
    },
    source: {
      kind: "action-attempt",
      element: { stableId: "caption-font-size" },
      actionSequence: [...captionRoot, "DOWN"],
      locallyComplete: true,
    },
    target: {
      element: { stableId: "caption-text-colour", role: "button" },
      expectedElement: { stableId: "caption-text-colour" },
      observedElement: { stableId: "caption-background-colour" },
    },
  });

  const focusTrap = requireFinding(findings, "remote.focus-trap|profile-primary");
  expect(focusTrap).toMatchObject({
    classification: "deterministic",
    issue: {
      rule: "remote.focus-trap",
      severity: "high",
      confidence: "deterministic",
      transition: {
        fromElement: "profile-primary",
        action: "BACK",
        expectedElement: null,
        observedElement: "profile-primary",
      },
      evidence: [{
        kind: "deterministic-failure",
        summary: expect.stringContaining("complete local action coverage"),
        artifact: null,
      }],
      reproduction: {
        status: "available",
        resetStrategy: "reload",
        originalSequence: [
          { key: "DOWN", repeat: 2 },
          { key: "SELECT", repeat: 1 },
          { key: "BACK", repeat: 1 },
        ],
        minimizedSequence: null,
        confidence: "deterministic",
        artifact: null,
      },
    },
    source: {
      kind: "action-attempt",
      element: { stableId: "profile-primary" },
      locallyComplete: true,
    },
    target: {
      element: { role: "dialog" },
      expectedElement: null,
      observedElement: { stableId: "profile-primary" },
    },
  });

  const brokenBack = requireFinding(findings, "remote.back-behaviour|details-play");
  expect(brokenBack).toMatchObject({
    classification: "deterministic",
    issue: {
      rule: "remote.back-behaviour",
      severity: "high",
      confidence: "deterministic",
      transition: {
        fromElement: "details-play",
        action: "BACK",
        expectedElement: "hero-watch",
        observedElement: "search-query",
      },
      evidence: [{ kind: "deterministic-failure", artifact: null }],
      reproduction: {
        status: "available",
        resetStrategy: "reload",
        originalSequence: [
          { key: "RIGHT", repeat: 1 },
          { key: "SELECT", repeat: 1 },
          { key: "BACK", repeat: 1 },
        ],
        minimizedSequence: null,
        confidence: "deterministic",
        artifact: null,
      },
    },
    source: {
      kind: "action-pair",
      element: { stableId: "details-play" },
    },
    target: {
      element: { stableId: "search-query" },
      expectedElement: { stableId: "hero-watch" },
      observedElement: { stableId: "search-query" },
    },
  });

  const abnormalJump = requireFinding(findings, "remote.unexpected-jump|home-card-3");
  expect(abnormalJump).toMatchObject({
    classification: "heuristic",
    issue: {
      rule: "remote.unexpected-jump",
      severity: "medium",
      confidence: "heuristic",
      transition: {
        fromElement: "home-card-3",
        action: "RIGHT",
        expectedElement: "home-card-4",
        observedElement: "footer-privacy",
      },
      evidence: [{
        kind: "heuristic-warning",
        summary: expect.stringContaining("preferred candidate geometry"),
        artifact: null,
      }],
      reproduction: {
        status: "available",
        resetStrategy: "reload",
        minimizedSequence: null,
        confidence: "best-effort",
        artifact: null,
      },
    },
    source: {
      kind: "action-attempt",
      element: { stableId: "home-card-3" },
    },
    target: {
      element: { stableId: "footer-privacy" },
      expectedElement: { stableId: "home-card-4" },
      observedElement: { stableId: "footer-privacy" },
    },
  });

  const issueIds = findings.map((finding) => finding.issue.id);
  expect(new Set(issueIds).size).toBe(findings.length);
  for (const issueId of issueIds) {
    expect(issueId).toMatch(/^TVDOCTOR-NAV-[0-9A-F]{32}$/u);
  }

  for (const finding of findings) {
    expect(finding.issue.evidence, findingKey(finding)).toHaveLength(1);
    expect(finding.issue.evidence[0]?.source, findingKey(finding)).not.toBeNull();
    expect(finding.issue.reproduction.status, findingKey(finding)).toBe("available");
  }
});
