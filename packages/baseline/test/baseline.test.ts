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
  renderComparisonJson,
  renderComparisonMarkdown,
  renderNavigationGraphMermaid,
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

  it("redacts credential URIs and expanded secret names from persisted baselines", () => {
    const hostileInventory = inventory({
      screens: [
        {
          key: "home",
          label: "dsn=postgres://dbuser:DB_PASSWORD@db.example.test/private?sslmode=require",
        },
        { key: "details", label: "github_pat=PAT_CANARY" },
      ],
      focusTargets: [
        { key: "hero", screenKey: "home", role: "button", name: "private_key=PRIVATE_KEY_CANARY" },
        { key: "back", screenKey: "details", role: "button", name: "aws_access_key_id=ACCESS_KEY_CANARY" },
      ],
      latencies: [{ key: "launch", operation: "credentials=CREDENTIAL_CANARY", measuredMs: 500 }],
    });
    const baseline = createBaseline(report("sensitive"), hostileInventory, {
      createdAt: "2026-08-22T11:00:00.000Z",
      targetId: "cache:redis://CACHE_USER:CACHE_PASSWORD@cache.example.test/0?token=QUERY_CANARY",
    });
    const rendered = renderBaselineJson(baseline);

    for (const sentinel of [
      "DB_PASSWORD",
      "sslmode=require",
      "PAT_CANARY",
      "PRIVATE_KEY_CANARY",
      "ACCESS_KEY_CANARY",
      "CREDENTIAL_CANARY",
      "CACHE_USER",
      "CACHE_PASSWORD",
      "QUERY_CANARY",
    ]) {
      expect(rendered).not.toContain(sentinel);
    }
    expect(rendered).toContain("postgres://db.example.test/private");
    expect(rendered).toContain("redis://cache.example.test/0");
    expect(rendered).toContain("[REDACTED]");
  });

  it("sanitises comparison JSON and Markdown at the renderer boundary", () => {
    const baseline = createBaseline(report("baseline"), inventory(), {
      createdAt: "2026-08-22T11:00:00.000Z",
    });
    const comparison = compareBaseline(baseline, report("current"), inventory());
    const hostileComparison = {
      ...comparison,
      baselineRunId: "baseline-\u202egithub_pat=RUN_PAT_CANARY",
      changes: {
        ...comparison.changes,
        screensAdded: [{
          key: "search",
          label: "\u001b[31m[click](https://user:pass@example.test/app?token=URL_CANARY#frag)\u001b[0m | private_key=MARKDOWN_PRIVATE_CANARY",
        }],
        focusAdded: [{
          key: "query",
          screenKey: "search",
          role: "textbox",
          name: "dsn=postgres://dbuser:DB_COMPARE_CANARY@db.example.test/private?sslmode=require",
        }],
      },
    };
    const json = renderComparisonJson(hostileComparison);
    const markdown = renderComparisonMarkdown(hostileComparison);

    for (const output of [json, markdown]) {
      for (const sentinel of [
        "RUN_PAT_CANARY",
        "user:pass",
        "URL_CANARY",
        "frag",
        "MARKDOWN_PRIVATE_CANARY",
        "dbuser",
        "DB_COMPARE_CANARY",
        "sslmode=require",
      ]) {
        expect(output).not.toContain(sentinel);
      }
      expect(output).not.toContain("\u001b");
      expect(output).not.toContain("\u202e");
    }
    expect(markdown).not.toContain("[click](https://");
    expect(markdown).toContain("\\[click\\]");
    expect(markdown).toContain("postgres://db.example.test/private");
  });

  it("proves the clean -> one new HIGH -> restored lifecycle", () => {
    const baseline = createBaseline(report("clean"), inventory(), {
      createdAt: "2026-08-22T11:00:00.000Z",
    });
    const regressed = compareBaseline(baseline, report("regressed", [issue("new-high")]), inventory());
    expect(regressed).toMatchObject({ status: "regressed", shouldFail: true, blockers: [] });
    expect(regressed.changes.newIssues).toEqual([expect.objectContaining({ id: "new-high", severity: "high" })]);
    expect(regressed.changes.resolvedIssues).toEqual([]);
    expect(regressed.changes.unchangedIssues).toEqual([]);

    const regressionBaseline = createBaseline(report("regression-baseline", [issue("new-high")]), inventory(), {
      createdAt: "2026-08-22T11:01:00.000Z",
    });
    const restored = compareBaseline(regressionBaseline, report("restored"), inventory());
    expect(restored).toMatchObject({ status: "changed", shouldFail: false, blockers: [] });
    expect(restored.changes.newIssues).toEqual([]);
    expect(restored.changes.resolvedIssues).toEqual([expect.objectContaining({ id: "new-high" })]);
    expect(restored.changes.unchangedIssues).toEqual([]);

    const cleanAgain = compareBaseline(baseline, report("clean-again"), inventory());
    expect(cleanAgain).toMatchObject({ status: "identical", shouldFail: false, blockers: [], changes: {
      newIssues: [],
      resolvedIssues: [],
      unchangedIssues: [],
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

  it("fails closed when sanitisation removes a current semantic identifier", () => {
    const baseline = createBaseline(report("baseline"), inventory(), {
      createdAt: "2026-08-22T11:00:00.000Z",
    });
    const comparison = compareBaseline(baseline, report("current", [issue("\u202e")]), inventory());

    expect(comparison).toMatchObject({ status: "failed-closed", shouldFail: true });
    expect(comparison.blockers.map((blocker) => blocker.code)).toContain("current-report-partial");
  });

  it("fails closed when redaction collapses distinct current issue identities", () => {
    const baseline = createBaseline(report("baseline"), inventory(), {
      createdAt: "2026-08-22T11:00:00.000Z",
    });
    const comparison = compareBaseline(baseline, report("current", [
      issue("github_pat=PAT_ONE"),
      issue("github_pat=PAT_TWO"),
    ]), inventory());

    expect(comparison).toMatchObject({ status: "failed-closed", shouldFail: true });
    expect(comparison.blockers.map((blocker) => blocker.code)).toContain("current-report-partial");
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
    expect(ordered.changes.unchangedIssues.map((entry) => entry.id)).toEqual(["known-a", "known-b"]);
    expect(shuffled.changes.unchangedIssues.map((entry) => entry.id)).toEqual(["known-a", "known-b"]);
  });

  it("renders navigation-first comparison categories and an evidence-backed graph", () => {
    const baseline = createBaseline(
      report("baseline", [issue("known")]),
      inventory(),
      { createdAt: "2026-08-22T11:00:00Z" },
    );
    const current = inventory({
      screens: [{ key: "home", label: "Home" }, { key: "details", label: "Details" }],
      focusTargets: [
        { key: "hero", screenKey: "home", role: "button", name: "Play" },
        { key: "back", screenKey: "details", role: "button", name: "Back" },
      ],
      transitions: [{
        key: "home/hero:SELECT",
        fromScreenKey: "home",
        fromFocusKey: "hero",
        action: "DOWN",
        toScreenKey: "details",
        toFocusKey: "back",
      }],
    });
    const comparison = compareBaseline(baseline, report("current", [issue("known"), issue("introduced")]), current);
    const markdown = renderComparisonMarkdown(comparison);

    expect(comparison.changes.unchangedIssues.map((entry) => entry.id)).toEqual(["known"]);
    expect(markdown).toContain("| Introduced | 1 |");
    expect(markdown).toContain("| Unchanged | 1 |");
    expect(markdown).toContain("### Changed directional transitions");
    expect(markdown).toContain("**SELECT** was `home/hero` → `details/back`; now **DOWN**");

    const graph = renderNavigationGraphMermaid(baseline);
    expect(graph).toContain("flowchart LR");
    expect(graph).toContain('home · Play (button)');
    expect(graph).toContain('-- "SELECT" -->');
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

  it("fails closed for phantom focus endpoints and nondeterministic source/action edges", () => {
    const baselineReport = report("clean");
    const phantomFocus = inventory({
      transitions: [{
        key: "home/hero:SELECT",
        fromScreenKey: "home",
        fromFocusKey: "hero",
        action: "SELECT",
        toScreenKey: "details",
        toFocusKey: "missing-focus",
      }],
    });
    expect(() => createBaseline(baselineReport, phantomFocus))
      .toThrow(/unknown destination focus target/iu);

    const semanticDuplicate = inventory({
      transitions: [
        {
          key: "edge-a",
          fromScreenKey: "home",
          fromFocusKey: "hero",
          action: "SELECT",
          toScreenKey: "details",
          toFocusKey: "back",
        },
        {
          key: "edge-b",
          fromScreenKey: "home",
          fromFocusKey: "hero",
          action: "SELECT",
          toScreenKey: "home",
          toFocusKey: "hero",
        },
      ],
    });
    expect(() => createBaseline(baselineReport, semanticDuplicate))
      .toThrow(/transitions by source\/action contains duplicate identity/iu);

    const baseline = createBaseline(baselineReport, inventory(), { createdAt: "2026-08-22T11:00:00Z" });
    const comparison = compareBaseline(baseline, report("current"), phantomFocus);
    expect(comparison).toMatchObject({ status: "failed-closed", shouldFail: true });
    expect(comparison.blockers.map((blocker) => blocker.code)).toContain("current-inventory-partial");
  });
});
