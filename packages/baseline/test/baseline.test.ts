import { describe, expect, it } from "vitest";
import { parseTVDoctorReportV1 } from "@tvdoctor/protocol";
import type { TVDoctorIssue, TVDoctorReportV1 } from "@tvdoctor/protocol";
import {
  BASELINE_SCHEMA_VERSION_V1,
  compareBaseline,
  createBaseline,
  defaultTargetId,
  parseBaseline,
  renderBaselineJson,
  type BaselineObservationInventory,
} from "../src/index.js";

function issue(id: string, severity: TVDoctorIssue["severity"] = "high"): TVDoctorIssue {
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
    evidence: [{ kind: "deterministic-failure", summary: "Observed by the controlled fixture.", source: null, artifact: null }],
    reproduction: { status: "unavailable", reason: "Comparison-only fixture issue." },
  };
}

function report(
  runId: string,
  issues: readonly TVDoctorIssue[] = [],
  overrides: Partial<TVDoctorReportV1> = {},
): TVDoctorReportV1 {
  return {
    schemaVersion: "tvdoctor.report/v1",
    run: {
      id: runId,
      tvdoctorVersion: "0.1.0",
      mode: "standard",
      status: "completed",
      startedAt: "2026-08-22T10:00:00.000Z",
      completedAt: "2026-08-22T10:00:01.000Z",
      durationMs: 1_000,
    },
    target: {
      name: "Fixture",
      platform: "web",
      location: "http://127.0.0.1:4173/?regression=off",
      environment: {},
    },
    coverage: {
      screenStatesDiscovered: 2,
      focusStatesDiscovered: 2,
      transitionsTested: 1,
      actionsSent: 1,
      capabilitiesObserved: ["remote-input", "ui-tree", "performance"],
      packs: [{ pack: "navigation", status: "completed" }],
      budget: {
        maxActions: 100,
        maxStates: 50,
        maxDepth: 8,
        maxDurationMs: 30_000,
        maxRepetitiveItems: 12,
        exhausted: [],
      },
    },
    issues,
    artifacts: [],
    replays: [],
    ...overrides,
  };
}

function inventory(overrides: Partial<BaselineObservationInventory> = {}): BaselineObservationInventory {
  return {
    status: "complete",
    screens: [
      { key: "home", label: "Home" },
      { key: "details", label: "Details" },
    ],
    focusTargets: [
      { key: "hero", screenKey: "home", role: "button", name: "Play" },
      { key: "back", screenKey: "details", role: "button", name: "Back" },
    ],
    transitions: [{
      key: "home/hero:SELECT",
      fromScreenKey: "home",
      fromFocusKey: "hero",
      action: "SELECT",
      toScreenKey: "details",
      toFocusKey: "back",
    }],
    latencies: [{ key: "launch", operation: "Launch to stable Home", measuredMs: 500 }],
    ...overrides,
  };
}

describe("semantic baselines", () => {
  it("creates, validates, and renders a deterministic versioned baseline", () => {
    const baseline = createBaseline(report("clean"), inventory(), {
      createdAt: "2026-08-22T11:00:00Z",
    });

    expect(baseline.schemaVersion).toBe(BASELINE_SCHEMA_VERSION_V1);
    expect(baseline.targetId).toBe("web:http://127.0.0.1:4173/");
    expect(parseBaseline(JSON.parse(renderBaselineJson(baseline)))).toEqual(baseline);
    expect(renderBaselineJson(baseline)).toBe(renderBaselineJson(baseline));
    expect(defaultTargetId("web", "https://example.test/app?secret=no#state"))
      .toBe("web:https://example.test/app");
  });

  it("redacts target-controlled inventory text before baseline persistence", () => {
    const baseline = createBaseline(report("sanitised"), inventory({
      screens: [
        { key: "home", label: "https://example.test/app?query=QUERY_CANARY#FRAGMENT_CANARY" },
        { key: "details", label: "Authorization: Bearer BEARER_CANARY" },
      ],
      focusTargets: [
        { key: "hero", screenKey: "home", role: "button", name: "cookie: COOKIE_CANARY" },
        { key: "back", screenKey: "details", role: "button", name: "sessionToken=SESSION_CANARY" },
      ],
      latencies: [{ key: "launch", operation: "Basic BASIC_CANARY", measuredMs: 500 }],
    }), { createdAt: "2026-08-22T11:00:00.000Z" });
    const rendered = renderBaselineJson(baseline);

    for (const sentinel of [
      "QUERY_CANARY",
      "FRAGMENT_CANARY",
      "BEARER_CANARY",
      "BASIC_CANARY",
      "COOKIE_CANARY",
      "SESSION_CANARY",
    ]) {
      expect(rendered).not.toContain(sentinel);
    }
    expect(rendered).toContain("[REDACTED]");
  });

  it("proves the clean -> one new HIGH -> restored lifecycle", () => {
    const baseline = createBaseline(report("clean"), inventory(), {
      createdAt: "2026-08-22T11:00:00.000Z",
    });
    const regressed = compareBaseline(baseline, report("regressed", [issue("new-high")]), inventory());
    expect(regressed).toMatchObject({ status: "regressed", shouldFail: true, blockers: [] });
    expect(regressed.changes.newIssues).toEqual([expect.objectContaining({ id: "new-high", severity: "high" })]);
    expect(regressed.changes.resolvedIssues).toEqual([]);

    const regressionBaseline = createBaseline(report("regression-baseline", [issue("new-high")]), inventory(), {
      createdAt: "2026-08-22T11:01:00.000Z",
    });
    const restored = compareBaseline(regressionBaseline, report("restored"), inventory());
    expect(restored).toMatchObject({ status: "changed", shouldFail: false, blockers: [] });
    expect(restored.changes.newIssues).toEqual([]);
    expect(restored.changes.resolvedIssues).toEqual([expect.objectContaining({ id: "new-high" })]);

    const cleanAgain = compareBaseline(baseline, report("clean-again"), inventory());
    expect(cleanAgain).toMatchObject({ status: "identical", shouldFail: false, blockers: [], changes: {
      newIssues: [],
      resolvedIssues: [],
    } });
  });

  it("classifies screen, focus, transition, and latency regressions", () => {
    const baseline = createBaseline(report("before"), inventory(), {
      createdAt: "2026-08-22T11:00:00.000Z",
    });
    const current = inventory({
      screens: [{ key: "home", label: "Home" }, { key: "search", label: "Search" }],
      focusTargets: [
        { key: "hero", screenKey: "home", role: "button", name: "Play" },
        { key: "query", screenKey: "search", role: "textbox", name: "Search" },
      ],
      transitions: [{
        key: "home/hero:SELECT",
        fromScreenKey: "home",
        fromFocusKey: "hero",
        action: "SELECT",
        toScreenKey: "search",
        toFocusKey: "query",
      }],
      latencies: [{ key: "launch", operation: "Launch to stable Home", measuredMs: 750 }],
    });
    const comparison = compareBaseline(baseline, report("after"), current);

    expect(comparison.status).toBe("regressed");
    expect(comparison.changes.screensRemoved.map((entry) => entry.key)).toEqual(["details"]);
    expect(comparison.changes.screensAdded.map((entry) => entry.key)).toEqual(["search"]);
    expect(comparison.changes.focusRemoved.map((entry) => entry.key)).toEqual(["back"]);
    expect(comparison.changes.transitionsChanged).toHaveLength(1);
    expect(comparison.changes.latencyRegressions).toEqual([
      expect.objectContaining({ key: "launch", baselineMs: 500, currentMs: 750, increaseMs: 250, ratio: 1.5 }),
    ]);
  });

  it.each([
    {
      name: "partial report",
      currentReport: report("partial", [], { run: { ...report("x").run, id: "partial", status: "partial" } }),
      currentInventory: inventory(),
      code: "current-report-partial",
    },
    {
      name: "partial inventory",
      currentReport: report("partial-inventory"),
      currentInventory: inventory({ status: "partial" }),
      code: "current-inventory-partial",
    },
    {
      name: "lower capability coverage",
      currentReport: report("lower", [], { coverage: {
        ...report("x").coverage,
        capabilitiesObserved: ["remote-input", "ui-tree"],
      } }),
      currentInventory: inventory(),
      code: "capability-missing",
    },
    {
      name: "missing latency observation",
      currentReport: report("missing-latency"),
      currentInventory: inventory({ latencies: [] }),
      code: "observation-missing",
    },
  ])("fails closed for $name", ({ currentReport, currentInventory, code }) => {
    const baseline = createBaseline(report("baseline"), inventory(), {
      createdAt: "2026-08-22T11:00:00.000Z",
    });
    const comparison = compareBaseline(baseline, currentReport, currentInventory);
    expect(comparison).toMatchObject({ status: "failed-closed", shouldFail: true, changes: {
      newIssues: [],
      resolvedIssues: [],
    } });
    expect(comparison.blockers.map((blocker) => blocker.code)).toContain(code);
  });

  it("rejects partial baselines and incompatible schema input", () => {
    expect(() => createBaseline(report("bad"), inventory({ status: "partial" }))).toThrow(/complete/iu);
    const comparison = compareBaseline({ schemaVersion: "tvdoctor.baseline/v0" }, report("current"), inventory());
    expect(comparison).toMatchObject({ status: "failed-closed", shouldFail: true });
    expect(comparison.blockers[0]?.code).toBe("baseline-invalid");
  });

  it("rejects duplicate issue IDs at the report-validation layer before comparison", () => {
    const duplicated = [issue("new-high"), issue("new-high")];
    expect(() => parseTVDoctorReportV1(report("dupes", duplicated))).toThrow(/duplicate issue id/u);
  });

  it("produces the same comparison result regardless of input issue ordering", () => {
    const baseline = createBaseline(
      report("baseline", [issue("known-a"), issue("known-b")]),
      inventory(),
      { createdAt: "2026-08-22T11:00:00Z" },
    );
    const ordered = compareBaseline(baseline, report("ordered", [issue("known-a"), issue("new-c"), issue("known-b")]), inventory());
    const shuffled = compareBaseline(baseline, report("shuffled", [issue("new-c"), issue("known-b"), issue("known-a")]), inventory());

    expect(ordered.status).toBe(shuffled.status);
    expect(ordered.changes.newIssues.map((entry) => entry.id)).toEqual(["new-c"]);
    expect(shuffled.changes.newIssues.map((entry) => entry.id)).toEqual(["new-c"]);
    expect(ordered.changes.resolvedIssues).toEqual([]);
    expect(shuffled.changes.resolvedIssues).toEqual([]);
  });

  it("models focus loss as a missing transition rather than an invalid empty key", () => {
    // A transition whose toFocusKey is an empty string is invalid per schema.
    // The baseline library must reject such input (fail closed) instead of
    // treating the absence of focus as a valid semantic destination.
    const badInventory = inventory({
      transitions: [{
        key: "home/hero:SELECT",
        fromScreenKey: "home",
        fromFocusKey: "hero",
        action: "SELECT",
        toScreenKey: "home",
        toFocusKey: "",
      }],
    });
    const baseline = createBaseline(report("clean"), inventory(), { createdAt: "2026-08-22T11:00:00Z" });
    const comparison = compareBaseline(baseline, report("current"), badInventory);
    expect(comparison.status).toBe("failed-closed");
    expect(comparison.shouldFail).toBe(true);
    expect(comparison.blockers.length).toBeGreaterThan(0);
  });
});
