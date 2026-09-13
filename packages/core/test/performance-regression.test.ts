import { describe, expect, it } from "vitest";

import {
  createCoverageSignature,
  evaluatePerformanceRegression,
  type PerformanceCoverageSample,
} from "../src/performance-regression.js";

function sample(overrides: Partial<PerformanceCoverageSample> = {}): PerformanceCoverageSample {
  return {
    coverage: createCoverageSignature({
      screenIdentities: ["screen-home", "screen-player"],
      stateIdentities: ["state-home-card-1", "state-player-play"],
      findingIds: ["finding-focus-trap"],
      declaredExclusions: ["operator-gated:purchase"],
      termination: { reason: "queue-exhausted", complete: true },
      remainingSafeFrontier: 0,
      restorationFailures: 0,
    }),
    metrics: {
      wallTimeMs: 1_000,
      physicalActions: 100,
      replayActions: 40,
      resetCount: 10,
      settlingPolls: 80,
      snapshots: 120,
      observerBytes: 50_000,
      observerFullStates: 20,
      observerIncrementalStates: 80,
    },
    ...overrides,
  };
}

describe("performance + coverage regression gate", () => {
  it("rejects a faster candidate when semantic coverage is lower", () => {
    const baseline = sample();
    const candidate = sample({
      coverage: createCoverageSignature({
        screenIdentities: ["screen-home", "screen-player"],
        stateIdentities: ["state-home-card-1"],
        findingIds: [],
        declaredExclusions: ["operator-gated:purchase"],
        termination: { reason: "queue-exhausted", complete: true },
        remainingSafeFrontier: 0,
        restorationFailures: 0,
      }),
      metrics: { ...baseline.metrics, wallTimeMs: 500, physicalActions: 50 },
    });

    const result = evaluatePerformanceRegression(baseline, candidate);

    expect(result.accepted).toBe(false);
    expect(result.coverageEquivalent).toBe(false);
    expect(result.coverageDifferences).toEqual(expect.arrayContaining([
      expect.stringContaining("state"),
      expect.stringContaining("finding"),
    ]));
  });

  it("accepts lower deterministic work only after exact semantic coverage passes", () => {
    const baseline = sample();
    const candidate = sample({
      coverage: createCoverageSignature({
        // Deliberately shuffled: set semantics must remain deterministic.
        screenIdentities: ["screen-player", "screen-home"],
        stateIdentities: ["state-player-play", "state-home-card-1"],
        findingIds: ["finding-focus-trap"],
        declaredExclusions: ["operator-gated:purchase"],
        termination: { reason: "queue-exhausted", complete: true },
        remainingSafeFrontier: 0,
        restorationFailures: 0,
      }),
      metrics: {
        ...baseline.metrics,
        wallTimeMs: 620,
        physicalActions: 72,
        replayActions: 16,
        resetCount: 4,
        settlingPolls: 12,
        snapshots: 50,
      },
    });

    const result = evaluatePerformanceRegression(baseline, candidate);

    expect(result).toMatchObject({
      accepted: true,
      coverageEquivalent: true,
      deterministicWorkRegression: false,
    });
    expect(result.metricDelta.physicalActions).toBe(-28);
    expect(result.metricDelta.wallTimeMs).toBe(-380);
  });

  it("rejects completion, frontier, exclusion, or restoration-safety regressions", () => {
    const baseline = sample();
    const candidate = sample({
      coverage: createCoverageSignature({
        screenIdentities: ["screen-home", "screen-player"],
        stateIdentities: ["state-home-card-1", "state-player-play"],
        findingIds: ["finding-focus-trap"],
        declaredExclusions: [],
        termination: { reason: "max-actions", complete: false },
        remainingSafeFrontier: 3,
        restorationFailures: 1,
      }),
    });

    const result = evaluatePerformanceRegression(baseline, candidate);

    expect(result.accepted).toBe(false);
    expect(result.coverageDifferences.join("\n")).toMatch(/termination|frontier|exclusion|restoration/iu);
  });
});
