import { describe, expect, it } from "vitest";
import {
  ANDROID_COVERAGE_LEDGER_SCHEMA,
  ANDROID_MAX_COVERAGE_ENTRIES,
  buildAndroidCoverageLedger,
  hasIncompleteSafeCoverage,
  serialiseAndroidCoverageLedger,
  type AndroidCoverageDisposition,
  type AndroidCoverageEntryInput,
} from "../src/android-coverage-ledger.js";

const DISPOSITIONS: readonly AndroidCoverageDisposition[] = [
  "exercised",
  "verified-state-reuse",
  "boundary-restored",
  "operator-gated",
  "inaccessible",
  "failed",
];

function entry(
  index: number,
  disposition: AndroidCoverageDisposition = "exercised",
): AndroidCoverageEntryInput {
  return {
    entryId: `entry-${String(index).padStart(6, "0")}`,
    actionId: `action-${String(index).padStart(6, "0")}`,
    screenStateId: `screen-${String(index % 3)}`,
    focusStateId: `focus-${String(index % 5)}`,
    action: index % 2 === 0 ? "RIGHT" : "SELECT",
    disposition,
    reasonCode: `${disposition}-reason`,
    detail: `${disposition} detail`,
    sourcePackage: "org.example.tv",
    destinationPackage: index % 2 === 0 ? "org.example.tv" : null,
    evidence: {
      accessibility: "available",
      screenshot: "not-collected",
      media: "unavailable",
    },
    ...(disposition === "verified-state-reuse"
      ? {
          restoration: {
            method: "live-state" as const,
            exactMatch: true,
            fellBack: false,
          },
        }
      : {}),
  };
}

function build(entries: readonly AndroidCoverageEntryInput[], remainingSafeFrontier = 0) {
  return buildAndroidCoverageLedger({
    strategy: "adaptive",
    targetPackage: "org.example.tv",
    budgets: { maxActions: 300, maxStates: 75, maxDepth: 8, maxDurationMs: 720_000 },
    entries,
    remainingSafeFrontier,
  });
}

describe("Android coverage ledger", () => {
  it("orders every disposition deterministically and sanitises persisted strings", () => {
    const hostile = DISPOSITIONS.map((disposition, index) => ({
      ...entry(index, disposition),
      entryId: `entry-${String(index)}\u0000\u001b`,
      actionId: `action-${String(index)}\u007f`,
      reasonCode: `reason\n${"r".repeat(700)}`,
      detail: `<script>bad()</script>\r\n${"d".repeat(700)}`,
      sourcePackage: `org.example.tv\u0000${"x".repeat(300)}`,
    })).reverse();

    const ledger = build(hostile);
    expect(ledger).toMatchObject({
      schema: ANDROID_COVERAGE_LEDGER_SCHEMA,
      strategy: "adaptive",
      targetPackage: "org.example.tv",
      truncatedEntries: 0,
      remainingSafeFrontier: 0,
      counts: {
        exercised: 1,
        "verified-state-reuse": 1,
        "boundary-restored": 1,
        "operator-gated": 1,
        inaccessible: 1,
        failed: 1,
      },
    });
    expect(ledger.entries.map((candidate) => candidate.entryId)).toEqual([
      "entry-0", "entry-1", "entry-2", "entry-3", "entry-4", "entry-5",
    ]);
    expect(ledger.entries.every((candidate) => (
      candidate.entryId.length <= 256
      && candidate.actionId.length <= 256
      && candidate.reasonCode.length <= 512
      && candidate.detail.length <= 512
      && (candidate.sourcePackage?.length ?? 0) <= 256
      // eslint-disable-next-line no-control-regex -- persisted entries must be free of control characters.
      && !/[\u0000-\u001f\u007f-\u009f]/u.test(JSON.stringify(candidate))
    ))).toBe(true);
    expect(ledger.entries[0]?.detail).toContain("<script>bad()</script>");

    const permuted = build([...hostile].reverse());
    expect(serialiseAndroidCoverageLedger(permuted)).toBe(serialiseAndroidCoverageLedger(ledger));
    expect(serialiseAndroidCoverageLedger(ledger)).toMatch(/^\{"budgets":/u);
  });

  it("caps entries, reports deterministic truncation, and counts retained entries", () => {
    const entries = Array.from(
      { length: ANDROID_MAX_COVERAGE_ENTRIES + 2 },
      (_, index) => entry(index, index % 2 === 0 ? "exercised" : "operator-gated"),
    );
    const ledger = build(entries, 3);

    expect(ledger.entries).toHaveLength(ANDROID_MAX_COVERAGE_ENTRIES);
    expect(ledger.truncatedEntries).toBe(2);
    expect(ledger.remainingSafeFrontier).toBe(3);
    expect(ledger.counts.exercised + ledger.counts["operator-gated"])
      .toBe(ANDROID_MAX_COVERAGE_ENTRIES);
  });

  it("treats operator gating as declared exclusion but all unaccounted safe work as partial", () => {
    const gatedOnly = build([entry(1, "operator-gated")]);
    expect(hasIncompleteSafeCoverage(gatedOnly)).toBe(false);
    expect(hasIncompleteSafeCoverage({ ...gatedOnly, remainingSafeFrontier: 1 })).toBe(true);
    expect(hasIncompleteSafeCoverage({ ...gatedOnly, truncatedEntries: 1 })).toBe(true);
    expect(hasIncompleteSafeCoverage(build([entry(1, "inaccessible")]))).toBe(true);
    expect(hasIncompleteSafeCoverage(build([entry(1, "failed")]))).toBe(true);
  });

  it.each([
    ["maxActions", Number.NaN],
    ["maxStates", Number.POSITIVE_INFINITY],
    ["maxDepth", -1],
    ["maxDurationMs", 1.5],
  ] as const)("rejects invalid %s budget values", (name, value) => {
    expect(() => buildAndroidCoverageLedger({
      strategy: "adaptive",
      targetPackage: "org.example.tv",
      budgets: {
        maxActions: 300,
        maxStates: 75,
        maxDepth: 8,
        maxDurationMs: 720_000,
        [name]: value,
      },
      entries: [],
      remainingSafeFrontier: 0,
    })).toThrow(name);
  });

  it("rejects invalid strategy, frontier, entry enums, and restoration metadata", () => {
    expect(() => buildAndroidCoverageLedger({
      strategy: "random" as never,
      targetPackage: "org.example.tv",
      budgets: { maxActions: 300, maxStates: 75, maxDepth: 8, maxDurationMs: 720_000 },
      entries: [],
      remainingSafeFrontier: 0,
    })).toThrow(/strategy/u);
    expect(() => build([], Number.POSITIVE_INFINITY)).toThrow(/remainingSafeFrontier/u);
    expect(() => build([{ ...entry(1), disposition: "ignored" as never }])).toThrow(/disposition/u);
    expect(() => build([{
      ...entry(1),
      evidence: { ...entry(1).evidence, screenshot: "unknown" as never },
    }])).toThrow(/evidence/u);
    expect(() => build([{
      ...entry(1),
      restoration: {
        method: "verified-local" as never,
        exactMatch: true,
        fellBack: false,
      },
    }])).toThrow(/restoration/u);
  });
});
