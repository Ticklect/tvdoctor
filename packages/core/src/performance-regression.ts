export interface CoverageTermination {
  readonly reason: string;
  readonly complete: boolean;
}

export interface CoverageSignatureInput {
  readonly screenIdentities: readonly string[];
  readonly stateIdentities: readonly string[];
  readonly findingIds?: readonly string[];
  readonly declaredExclusions?: readonly string[];
  readonly termination: CoverageTermination;
  readonly remainingSafeFrontier: number;
  readonly restorationFailures: number;
}

export interface CoverageSignature {
  readonly screenIdentities: readonly string[];
  readonly stateIdentities: readonly string[];
  readonly findingIds: readonly string[];
  readonly declaredExclusions: readonly string[];
  readonly termination: CoverageTermination;
  readonly remainingSafeFrontier: number;
  readonly restorationFailures: number;
}

export interface PerformanceMetrics {
  readonly wallTimeMs: number;
  readonly physicalActions: number;
  readonly replayActions: number;
  readonly resetCount: number;
  readonly settlingPolls: number;
  readonly snapshots: number;
  readonly observerBytes: number;
  readonly observerFullStates: number;
  readonly observerIncrementalStates: number;
}

export interface PerformanceCoverageSample {
  readonly coverage: CoverageSignature;
  readonly metrics: PerformanceMetrics;
}

export interface PerformanceRegressionResult {
  readonly accepted: boolean;
  readonly coverageEquivalent: boolean;
  readonly coverageDifferences: readonly string[];
  readonly deterministicWorkRegression: boolean;
  readonly metricDelta: Readonly<Record<keyof PerformanceMetrics, number>>;
}

function stableSet(values: readonly string[] | undefined): readonly string[] {
  return [...new Set(values ?? [])].sort((left, right) => left.localeCompare(right));
}

function boundedCount(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

export function createCoverageSignature(input: CoverageSignatureInput): CoverageSignature {
  if (input.termination.reason.trim().length === 0) {
    throw new TypeError("termination.reason must not be empty.");
  }
  return {
    screenIdentities: stableSet(input.screenIdentities),
    stateIdentities: stableSet(input.stateIdentities),
    findingIds: stableSet(input.findingIds),
    declaredExclusions: stableSet(input.declaredExclusions),
    termination: { ...input.termination },
    remainingSafeFrontier: boundedCount(input.remainingSafeFrontier, "remainingSafeFrontier"),
    restorationFailures: boundedCount(input.restorationFailures, "restorationFailures"),
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function coverageDifferences(
  baseline: CoverageSignature,
  candidate: CoverageSignature,
): readonly string[] {
  const differences: string[] = [];
  if (!sameStrings(baseline.screenIdentities, candidate.screenIdentities)) {
    differences.push("screen identities changed");
  }
  if (!sameStrings(baseline.stateIdentities, candidate.stateIdentities)) {
    differences.push("state identities changed");
  }
  if (!sameStrings(baseline.findingIds, candidate.findingIds)) {
    differences.push("finding identities changed");
  }
  if (!sameStrings(baseline.declaredExclusions, candidate.declaredExclusions)) {
    differences.push("declared exclusion identities changed");
  }
  if (
    baseline.termination.complete !== candidate.termination.complete
    || baseline.termination.reason !== candidate.termination.reason
  ) {
    differences.push("termination status changed");
  }
  if (baseline.remainingSafeFrontier !== candidate.remainingSafeFrontier) {
    differences.push("remaining safe frontier changed");
  }
  if (baseline.restorationFailures !== candidate.restorationFailures) {
    differences.push("restoration failure count changed");
  }
  return differences;
}

const METRIC_KEYS = [
  "wallTimeMs",
  "physicalActions",
  "replayActions",
  "resetCount",
  "settlingPolls",
  "snapshots",
  "observerBytes",
  "observerFullStates",
  "observerIncrementalStates",
] as const satisfies readonly (keyof PerformanceMetrics)[];

const DETERMINISTIC_WORK_KEYS = [
  "physicalActions",
  "replayActions",
  "resetCount",
  "settlingPolls",
  "snapshots",
] as const satisfies readonly (keyof PerformanceMetrics)[];

function metricDelta(
  baseline: PerformanceMetrics,
  candidate: PerformanceMetrics,
): Readonly<Record<keyof PerformanceMetrics, number>> {
  return Object.fromEntries(METRIC_KEYS.map((key) => [
    key,
    candidate[key] - baseline[key],
  ])) as Readonly<Record<keyof PerformanceMetrics, number>>;
}

/**
 * Coverage is the hard gate. Performance is considered only when the semantic
 * signatures match exactly. The first deterministic-work guard is deliberately
 * coarse: a candidate must not increase every primary work counter while being
 * presented as a performance improvement. Wall-clock timing remains report data,
 * not a flaky CI threshold.
 */
export function evaluatePerformanceRegression(
  baseline: PerformanceCoverageSample,
  candidate: PerformanceCoverageSample,
): PerformanceRegressionResult {
  const differences = coverageDifferences(baseline.coverage, candidate.coverage);
  const delta = metricDelta(baseline.metrics, candidate.metrics);
  const deterministicWorkRegression = DETERMINISTIC_WORK_KEYS.every((key) => delta[key] > 0);
  const coverageEquivalent = differences.length === 0;
  return {
    accepted: coverageEquivalent && !deterministicWorkRegression,
    coverageEquivalent,
    coverageDifferences: differences,
    deterministicWorkRegression,
    metricDelta: delta,
  };
}
