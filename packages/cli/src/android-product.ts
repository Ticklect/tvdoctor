import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, constants, readFile, stat, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import {
  EXPLORATION_BUDGET_PROFILES,
  compileIssueReplay,
  diagnoseNavigation,
  explore,
  type ExplorationActionContext,
  type ExplorationBudgets,
  type ExplorationObservedActionContext,
  type ExplorationProgress,
  type ExplorationResult,
  type RestorationStateDiagnostic,
} from "@tvdoctor/core";
import {
  AndroidTvDriver,
  resolveAdbExecutable,
} from "@tvdoctor/driver-android";
import type {
  AndroidDeviceMetadata,
  AndroidScreenshotFingerprint,
  AndroidStateSnapshot,
  AndroidUiNodeSnapshot,
} from "@tvdoctor/driver-android";
import {
  NAVIGATION_KEYS,
  REMOTE_KEYS,
  type ArtifactDescriptor,
  type CoverageBudget,
  type RemoteKey,
  type StateSnapshot,
} from "@tvdoctor/protocol";
import {
  buildTVDoctorReportV1,
  sanitiseEvidenceJson,
  stableJson,
  type JsonValue,
} from "@tvdoctor/reporters";
import { CLI_VERSION } from "./version.js";
import { reserveAuditOutput } from "./node-audit.js";
import { writeReportBundle } from "@tvdoctor/reporters";
import {
  decideAndroidActions,
  type AndroidActionDecision,
} from "./android-action-policy.js";
import {
  buildAndroidCoverageLedger,
  hasIncompleteSafeCoverage,
  serialiseAndroidCoverageLedger,
  type AndroidCoverageEntryInput,
  type AndroidCoverageEvidence,
  type AndroidCoverageLedger,
} from "./android-coverage-ledger.js";
import {
  buildAndroidRestorationBenchmarkEvidence,
  type AndroidRestorationBenchmarkMode,
} from "./android-restoration-benchmark.js";

const execFileAsync = promisify(execFile);

export const ANDROID_EXPLORATION_BUDGETS: Readonly<Record<
  AndroidScanOptions["mode"],
  ExplorationBudgets
>> = {
  quick: {
    ...EXPLORATION_BUDGET_PROFILES.quick,
    maxDurationMs: 720_000,
  },
  deep: EXPLORATION_BUDGET_PROFILES.deep,
};

export const ANDROID_ACTION_SETTLING = {
  strategy: "stable-snapshot",
  maxSnapshots: 6,
  requiredStableSnapshots: 3,
  pollIntervalMs: 250,
  keyOverrides: {
    SELECT: { maxSnapshots: 14, requiredStableSnapshots: 7 },
    BACK: { maxSnapshots: 14, requiredStableSnapshots: 7 },
  },
} as const;

// Android TV apps that render through WebView can expose a short-lived loading
// tree before their real Home surface is ready. Keep launch/reset observations
// stable long enough to avoid treating that transient tree as the root state.
export const ANDROID_LAUNCH_SETTLING = {
  resetStableWindowMs: 2_000,
  resetSettleTimeoutMs: 20_000,
} as const;

export const ANDROID_LAUNCH_WARMUP_MS = 8_000;
const ANDROID_TRAVERSAL_STRATEGY = "adaptive" as const;
const ANDROID_AUTOMATIC_ACTIONS = REMOTE_KEYS.filter((key) => key !== "TAB" && key !== "HOME");
export const ANDROID_TRAVERSAL_RESTORATION = {
  restorationMode: "verified-local",
  allowRootRestorationFallback: true,
  refreshVisibleSelfLoops: false,
  replayActions: ["UP", "DOWN", "LEFT", "RIGHT", "SELECT"],
  // Replay must use the same observable-stability proof as discovery. Some TV
  // apps acknowledge SELECT before a delayed Activity/window transition begins;
  // trusting only the driver's first settled snapshot can verify the checkpoint
  // against the old Activity and falsely report replay divergence.
  replaySettling: ANDROID_ACTION_SETTLING,
} as const;

export const ANDROID_TRAVERSAL_VERIFIED_LIVE_ONLY = {
  ...ANDROID_TRAVERSAL_RESTORATION,
  restorationMode: "verified-live-only",
  allowRootRestorationFallback: false,
} as const;

function androidSnapshotBelongsToTarget(snapshot: AndroidStateSnapshot, packageName: string): boolean {
  return snapshot.location.status === "available"
    && snapshot.location.value.startsWith(`android://${packageName}/`);
}

export async function restoreAndroidTargetForFinalEvidence(
  driver: Pick<AndroidTvDriver, "snapshot" | "reset">,
  packageName: string,
  waitForWarmup: () => Promise<void> = async () => {
    await new Promise<void>((resolveWarmup) => setTimeout(resolveWarmup, ANDROID_LAUNCH_WARMUP_MS));
  },
): Promise<AndroidStateSnapshot> {
  let snapshot = await driver.snapshot();
  if (!androidSnapshotBelongsToTarget(snapshot, packageName)) {
    await driver.reset("relaunch");
    await waitForWarmup();
    snapshot = await driver.snapshot();
  }
  if (!androidSnapshotBelongsToTarget(snapshot, packageName)) {
    throw new Error(`Android scan ended outside ${packageName}.`);
  }
  return snapshot;
}

export function createAndroidTraversalRootRestorer(
  driver: Pick<AndroidTvDriver, "reset" | "snapshot">,
  packageName: string,
  preparedInitialSnapshot: AndroidStateSnapshot,
): (options?: { readonly signal?: AbortSignal }) => Promise<AndroidStateSnapshot> {
  let initialPreparedStateAvailable = true;
  return async (options): Promise<AndroidStateSnapshot> => {
    if (initialPreparedStateAvailable) {
      initialPreparedStateAvailable = false;
      return preparedInitialSnapshot;
    }
    await driver.reset("relaunch", options);
    const snapshot = await driver.snapshot(options);
    if (!androidSnapshotBelongsToTarget(snapshot, packageName)) {
      throw new Error(`Android root restoration ended outside ${packageName}.`);
    }
    return snapshot;
  };
}

interface AndroidLocationIdentity {
  readonly packageName: string;
  readonly activity: string;
}

function parseAndroidLocation(location: string | undefined): AndroidLocationIdentity | null {
  if (location === undefined) return null;
  const match = /^android:\/\/([^/]+)\/(.+)$/u.exec(location);
  if (match === null) return null;
  const packageName = match[1];
  const activity = match[2];
  if (packageName === undefined || activity === undefined) return null;
  return { packageName, activity };
}

function restorationFailureClass(
  diagnostic: NonNullable<ExplorationResult["restorationDiagnostics"]>[number],
  currentPackage: string | null,
  targetPackage: string,
): string | null {
  if (currentPackage !== null && currentPackage !== targetPackage) return "restoration-external-surface";
  if (diagnostic.subtype === "state-not-found") return "restoration-state-not-found";
  if (diagnostic.subtype === "timeout") return "restoration-timeout";
  if (diagnostic.subtype === "navigation-diverged") return "restoration-navigation-diverged";
  if (diagnostic.subtype === "strategy-exhausted") return "restoration-strategy-exhausted";
  if (diagnostic.subtype === "interrupted") return "restoration-interrupted";
  if (diagnostic.subtype === "operation-failed") return "restoration-operation-failed";
  const rejectionReason = diagnostic.rejectionReason;
  if (rejectionReason === undefined) return null;
  if (rejectionReason.includes("not-found")) return "restoration-state-not-found";
  if (rejectionReason.includes("unsettled") || rejectionReason.includes("duration-budget")) {
    return "restoration-timeout";
  }
  if (rejectionReason.includes("diverged") || rejectionReason.includes("rejected")) {
    return "restoration-navigation-diverged";
  }
  if (rejectionReason === "unsafe-root-replay"
    || rejectionReason === "root-fallback-disabled"
    || rejectionReason === "no-restoration-strategy") {
    return "restoration-strategy-exhausted";
  }
  if (rejectionReason === "interrupted") return "restoration-interrupted";
  return "restoration-operation-failed";
}

function restorationProcessRestarted(
  diagnostic: NonNullable<ExplorationResult["restorationDiagnostics"]>[number],
): boolean | null {
  const cachedProcessIdentity = diagnostic.before?.processIdentitySource === "last-launch-or-reset-metadata"
    || diagnostic.after?.processIdentitySource === "last-launch-or-reset-metadata";
  const beforeGeneration = diagnostic.before?.processGeneration;
  const afterGeneration = diagnostic.after?.processGeneration;
  if (!cachedProcessIdentity
    && beforeGeneration !== undefined && beforeGeneration !== null
    && afterGeneration !== undefined && afterGeneration !== null) {
    return beforeGeneration !== afterGeneration;
  }
  const beforePid = diagnostic.before?.processId;
  const afterPid = diagnostic.after?.processId;
  if (!cachedProcessIdentity
    && beforePid !== undefined && beforePid !== null && afterPid !== undefined && afterPid !== null) {
    return beforePid !== afterPid;
  }
  if (diagnostic.strategy !== "root-replay") return null;
  if (diagnostic.rejectionReason === "unsafe-root-replay") return false;
  if (diagnostic.status === "success") return true;
  if (diagnostic.rejectionReason === "root-state-diverged"
    || diagnostic.rejectionReason === "replay-action-error"
    || diagnostic.rejectionReason === "replay-action-rejected"
    || diagnostic.rejectionReason === "replay-checkpoint-diverged"
    || diagnostic.rejectionReason === "destination-state-not-found"
    || diagnostic.rejectionReason === "settling-exhausted"
    || diagnostic.rejectionReason === "action-budget-exhausted") return true;
  return null;
}

type RestorationStateEvidence = NonNullable<
  NonNullable<ExplorationResult["restorationDiagnostics"]>[number]["expected"]
>;

const IDENTITY_DIMENSIONS = [
  "location",
  "stateFingerprint",
  "screenFingerprint",
  "focusFingerprint",
  "focusIdentity",
  "focusedStableId",
] as const;

const STRUCTURAL_DIAGNOSTIC_DIMENSIONS = [
  "focusedPath",
  "stableIdentifiers",
  "visibleStructureFingerprint",
  "actionableNodeFingerprint",
  "navigationStructureFingerprint",
  "visibleNodeCount",
  "actionableNodeCount",
  "observerStructureFingerprint",
  "observerStateFingerprint",
] as const;

const LIFECYCLE_DIMENSIONS = [
  "applicationId",
  "processId",
  "processGeneration",
  "activity",
  "activityGeneration",
  "rootIdentity",
  "windowId",
  "windowGeneration",
] as const;

function differingDimensions(
  expected: RestorationStateEvidence | undefined,
  observed: RestorationStateEvidence | undefined,
  dimensions: readonly (keyof RestorationStateEvidence)[],
): readonly string[] {
  if (expected === undefined || observed === undefined) return [];
  return dimensions.filter((dimension) => {
    const left = expected[dimension];
    const right = observed[dimension];
    if (left === undefined && right === undefined) return false;
    return JSON.stringify(left) !== JSON.stringify(right);
  });
}

function restorationTaxonomyCategory(
  diagnostic: NonNullable<ExplorationResult["restorationDiagnostics"]>[number],
  currentPackage: string | null,
  targetPackage: string,
): string | null {
  if (diagnostic.status !== "failed") return null;
  if (currentPackage !== null && currentPackage !== targetPackage) return "application-or-system-surface";
  if (diagnostic.subtype === "state-not-found") return "state-not-found";
  if (diagnostic.subtype === "timeout") return "asynchronous-ui-timing-or-timeout";
  if (diagnostic.subtype === "interrupted") return "interrupted";
  if (diagnostic.subtype === "strategy-exhausted") return "strategy-exhausted";
  if (diagnostic.subtype === "operation-failed") return "restoration-operation-error";

  const expected = diagnostic.expected;
  const observed = diagnostic.after;
  if (expected === undefined || observed === undefined) return "unknown";
  const identityDiff = differingDimensions(expected, observed, IDENTITY_DIMENSIONS);
  const structuralDiff = differingDimensions(expected, observed, STRUCTURAL_DIAGNOSTIC_DIMENSIONS);
  const lifecycleDiff = differingDimensions(expected, observed, LIFECYCLE_DIMENSIONS);
  const navigationChanged = structuralDiff.includes("actionableNodeFingerprint")
    || structuralDiff.includes("navigationStructureFingerprint");
  const locationChanged = identityDiff.includes("location") || lifecycleDiff.includes("activity");
  const focusChanged = identityDiff.includes("focusFingerprint")
    || identityDiff.includes("focusIdentity")
    || identityDiff.includes("focusedStableId");
  const visibleOnly = identityDiff.length > 0 && identityDiff.every((dimension) => (
    dimension === "stateFingerprint"
    || dimension === "screenFingerprint"
  )) && structuralDiff.every((dimension) => (
    dimension === "visibleStructureFingerprint"
    || dimension === "visibleNodeCount"
    || dimension === "observerStructureFingerprint"
    || dimension === "observerStateFingerprint"
  ));

  if (locationChanged) return "genuine-navigation-state-change";
  if (navigationChanged) return "structurally-meaningful-divergence";
  if (focusChanged && identityDiff.every((dimension) => (
    dimension === "stateFingerprint"
    || dimension === "focusFingerprint"
    || dimension === "focusIdentity"
    || dimension === "focusedStableId"
  ))) return "focus-only-divergence";
  if (visibleOnly) return "presentation-structure-divergence-with-equivalent-observed-navigation-surface";
  if (lifecycleDiff.includes("processGeneration") || lifecycleDiff.includes("processId")) {
    return "process-replacement-with-state-divergence";
  }
  if (lifecycleDiff.includes("rootIdentity") || lifecycleDiff.includes("windowId")
    || lifecycleDiff.includes("windowGeneration")) return "root-or-window-replacement-with-state-divergence";
  if (diagnostic.subtype === "navigation-diverged") return "replay-navigation-divergence";
  return "unknown";
}

function observedTraversalImpact(
  expected: RestorationStateEvidence | undefined,
  observed: RestorationStateEvidence | undefined,
): {
  readonly observedNavigationSurfaceEquivalent: boolean | null;
  readonly behaviorallyEquivalent: boolean | null;
  readonly traversalWouldMateriallyDiffer: boolean | null;
} {
  if (expected === undefined || observed === undefined) {
    return {
      observedNavigationSurfaceEquivalent: null,
      behaviorallyEquivalent: null,
      traversalWouldMateriallyDiffer: null,
    };
  }
  const required = [
    expected.location,
    observed.location,
    expected.focusFingerprint,
    observed.focusFingerprint,
    expected.actionableNodeFingerprint,
    observed.actionableNodeFingerprint,
    expected.navigationStructureFingerprint,
    observed.navigationStructureFingerprint,
  ];
  if (required.some((value) => value === undefined)) {
    return {
      observedNavigationSurfaceEquivalent: null,
      behaviorallyEquivalent: null,
      traversalWouldMateriallyDiffer: null,
    };
  }
  const equivalent = expected.location === observed.location
    && expected.focusFingerprint === observed.focusFingerprint
    && expected.actionableNodeFingerprint === observed.actionableNodeFingerprint
    && expected.navigationStructureFingerprint === observed.navigationStructureFingerprint;
  return {
    observedNavigationSurfaceEquivalent: equivalent,
    behaviorallyEquivalent: equivalent ? null : false,
    traversalWouldMateriallyDiffer: equivalent ? null : true,
  };
}

function restorationResilienceMetrics(
  result: ExplorationResult,
  targetPackage: string,
  diagnostics: readonly NonNullable<ExplorationResult["restorationDiagnostics"]>[number][],
): JsonValue {
  const cycles = new Map<number, { depth: number; success: boolean; failures: number }>();
  const failureCounts = new Map<string, number>();
  for (const diagnostic of diagnostics) {
    const cycle = cycles.get(diagnostic.restorationCycleNumber) ?? {
      depth: diagnostic.traversalDepth,
      success: false,
      failures: 0,
    };
    cycle.success ||= diagnostic.status === "success";
    if (diagnostic.status === "failed") cycle.failures += 1;
    cycles.set(diagnostic.restorationCycleNumber, cycle);
    if (diagnostic.status === "failed") {
      const current = parseAndroidLocation((diagnostic.after ?? diagnostic.before)?.location);
      const category = restorationTaxonomyCategory(diagnostic, current?.packageName ?? null, targetPackage);
      const key = category ?? "unknown";
      failureCounts.set(key, (failureCounts.get(key) ?? 0) + 1);
    }
  }
  const cycleValues = [...cycles.entries()].sort(([left], [right]) => left - right);
  const summarise = (values: readonly { success: boolean }[]) => ({
    attempts: values.length,
    successes: values.filter((value) => value.success).length,
    failures: values.filter((value) => !value.success).length,
    successRate: values.length === 0 ? null : values.filter((value) => value.success).length / values.length,
  });
  const depths = new Map<number, { success: boolean }[]>();
  for (const [, cycle] of cycleValues) {
    const values = depths.get(cycle.depth) ?? [];
    values.push({ success: cycle.success });
    depths.set(cycle.depth, values);
  }
  const successfulCycles = cycleValues.filter(([, cycle]) => cycle.success);
  const retryAttemptValues = {
    first: diagnostics.filter((diagnostic) => diagnostic.retryNumber === 0)
      .map((diagnostic) => ({ success: diagnostic.status === "success" })),
    second: diagnostics.filter((diagnostic) => diagnostic.retryNumber === 1)
      .map((diagnostic) => ({ success: diagnostic.status === "success" })),
    thirdAndLater: diagnostics.filter((diagnostic) => diagnostic.retryNumber >= 2)
      .map((diagnostic) => ({ success: diagnostic.status === "success" })),
  };
  const strategies = new Map<string, { success: boolean }[]>();
  for (const diagnostic of diagnostics) {
    const values = strategies.get(diagnostic.strategy) ?? [];
    values.push({ success: diagnostic.status === "success" });
    strategies.set(diagnostic.strategy, values);
  }
  const totalAttempts = result.statistics.restorationAttempts ?? diagnostics.length;
  const totalSuccesses = result.statistics.restorationSuccesses
    ?? diagnostics.filter((diagnostic) => diagnostic.status === "success").length;
  const totalFailures = result.statistics.restorationFailures
    ?? diagnostics.filter((diagnostic) => diagnostic.status === "failed").length;
  const diagnosticsComplete = diagnostics.length >= totalAttempts;
  const successfulWindowReplacements = diagnostics.filter((diagnostic) => (
    diagnostic.status === "success"
    && differingDimensions(diagnostic.expected, diagnostic.after, ["rootIdentity", "windowId", "windowGeneration"]).length > 0
  )).length;
  const successfulProcessReplacements = diagnostics.filter((diagnostic) => (
    diagnostic.status === "success" && restorationProcessRestarted(diagnostic) === true
  )).length;
  const processReplacementEvidenceComplete = diagnosticsComplete && diagnostics.every((diagnostic) => (
    diagnostic.strategy === "root-replay"
    || (diagnostic.before?.processIdentitySource !== "last-launch-or-reset-metadata"
      && diagnostic.after?.processIdentitySource !== "last-launch-or-reset-metadata")
  ));
  return JSON.parse(JSON.stringify({
    strategyAttempts: {
      attempts: totalAttempts,
      successes: totalSuccesses,
      failures: totalFailures,
      successRate: totalAttempts === 0 ? null : totalSuccesses / totalAttempts,
    },
    retainedDiagnosticAttempts: diagnostics.length,
    diagnosticsComplete,
    metricsDerivedFromRetainedDiagnosticsAreComplete: diagnosticsComplete,
    restorationCycles: summarise(cycleValues.map(([, cycle]) => cycle)),
    byTraversalDepth: Object.fromEntries([...depths.entries()]
      .sort(([left], [right]) => left - right)
      .map(([depth, values]) => [String(depth), summarise(values)])),
    byRestorationOrdinal: {
      first: summarise(cycleValues.slice(0, 1).map(([, cycle]) => cycle)),
      second: summarise(cycleValues.slice(1, 2).map(([, cycle]) => cycle)),
      thirdAndLater: summarise(cycleValues.slice(2).map(([, cycle]) => cycle)),
    },
    byRestorationCycleOrdinal: {
      first: summarise(cycleValues.slice(0, 1).map(([, cycle]) => cycle)),
      second: summarise(cycleValues.slice(1, 2).map(([, cycle]) => cycle)),
      thirdAndLater: summarise(cycleValues.slice(2).map(([, cycle]) => cycle)),
    },
    byStrategyAttemptOrdinal: {
      first: summarise(retryAttemptValues.first),
      second: summarise(retryAttemptValues.second),
      thirdAndLater: summarise(retryAttemptValues.thirdAndLater),
    },
    byRetryOrdinal: {
      first: summarise(retryAttemptValues.first),
      second: summarise(retryAttemptValues.second),
      thirdAndLater: summarise(retryAttemptValues.thirdAndLater),
    },
    byStrategy: Object.fromEntries([...strategies.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([strategy, values]) => [strategy, summarise(values)])),
    deepestSuccessfullyRestoredCheckpoint: successfulCycles.length === 0
      ? null
      : Math.max(...successfulCycles.map(([, cycle]) => cycle.depth)),
    successfulRestorationCyclesInTraversal: successfulCycles.length,
    multipleSuccessfulRestorations: successfulCycles.length > 1,
    scansWithMultipleSuccessfulRestorations: successfulCycles.length > 1 ? 1 : 0,
    recoveryAfterProcessReplacement: {
      successes: successfulProcessReplacements,
      status: !diagnosticsComplete
        ? "partial-retained-diagnostics"
        : processReplacementEvidenceComplete
          ? "observed-or-operation-inferred"
          : "partial-cached-process-identity",
    },
    recoveryAfterRootOrWindowReplacement: {
      successes: successfulWindowReplacements,
      status: diagnosticsComplete ? "observed" : "partial-retained-diagnostics",
    },
    recoveryAfterActivityRecreation: {
      successes: null,
      status: "activity-instance-generation-not-observable-in-generic-accessibility-snapshots",
    },
    failureCountByTaxonomy: Object.fromEntries([...failureCounts.entries()].sort(([left], [right]) => left.localeCompare(right))),
  })) as JsonValue;
}

function compactRestorationStateEvidence(
  state: RestorationStateDiagnostic | undefined,
): JsonValue | null {
  if (state === undefined) return null;
  return JSON.parse(JSON.stringify({
    capturedAt: state.capturedAt,
    stateFingerprint: state.stateFingerprint,
    screenFingerprint: state.screenFingerprint,
    focusFingerprint: state.focusFingerprint,
    focusIdentity: state.focusIdentity ?? null,
    location: state.location ?? null,
    focusedStableId: state.focusedStableId ?? null,
    focusedPath: state.focusedPath?.slice(-8) ?? [],
    stableIdentifiers: state.stableIdentifiers?.slice(0, 8) ?? [],
    visibleStructureFingerprint: state.visibleStructureFingerprint ?? null,
    actionableNodeFingerprint: state.actionableNodeFingerprint ?? null,
    navigationStructureFingerprint: state.navigationStructureFingerprint ?? null,
    visibleNodeCount: state.visibleNodeCount ?? null,
    actionableNodeCount: state.actionableNodeCount ?? null,
    platform: state.platform ?? null,
    applicationId: state.applicationId ?? null,
    processId: state.processId ?? null,
    processGeneration: state.processGeneration ?? null,
    processIdentitySource: state.processIdentitySource ?? null,
    activity: state.activity ?? null,
    activityGeneration: state.activityGeneration ?? null,
    activityGenerationObservable: state.activityGenerationObservable ?? null,
    rootIdentity: state.rootIdentity ?? null,
    rootIdentitySource: state.rootIdentitySource ?? null,
    windowId: state.windowId ?? null,
    windowGeneration: state.windowGeneration ?? null,
    observationSequence: state.observationSequence ?? null,
    observerStructureFingerprint: state.observerStructureFingerprint ?? null,
    observerStateFingerprint: state.observerStateFingerprint ?? null,
  })) as JsonValue;
}

export function buildAndroidExplorationEvidence(
  result: ExplorationResult,
  targetPackage: string,
  coverageLedger: AndroidCoverageLedger | null,
  finalTargetValidationError: string | null,
  scanId = "android-scan",
): JsonValue {
  const focusStatesById = new Map(result.graph.focus.states.map((state) => [state.id, state]));
  const focusStateIdsByFingerprint = new Map(
    result.graph.focus.states.map((state) => [state.stateFingerprint, state.id]),
  );
  const restorationDiagnostics = (result.restorationDiagnostics ?? []).map((diagnostic) => {
    const expectedState = focusStatesById.get(diagnostic.destinationStateId);
    const expectedLocation = expectedState?.representativeSnapshot.location.status === "available"
      ? expectedState.representativeSnapshot.location.value
      : undefined;
    const expected = parseAndroidLocation(expectedLocation);
    const currentEvidence = diagnostic.after ?? diagnostic.before;
    const current = parseAndroidLocation(currentEvidence?.location);
    const before = parseAndroidLocation(diagnostic.before?.location);
    const after = parseAndroidLocation(diagnostic.after?.location);
    const identityDifferences = differingDimensions(diagnostic.expected, currentEvidence, IDENTITY_DIMENSIONS);
    const lifecycleDifferences = differingDimensions(diagnostic.expected, currentEvidence, LIFECYCLE_DIMENSIONS);
    const traversalImpact = observedTraversalImpact(diagnostic.expected, currentEvidence);
    const detailedFailure = diagnostic.status === "failed";
    if (!detailedFailure) {
      return {
        applicationPackage: targetPackage,
        scanId,
        attemptNumber: diagnostic.attemptNumber,
        retryNumber: diagnostic.retryNumber,
        restorationCycleNumber: diagnostic.restorationCycleNumber,
        successfulRestorationsBeforeAttempt: diagnostic.successfulRestorationsBeforeAttempt,
        traversalDepth: diagnostic.traversalDepth,
        intendedDestinationStateId: diagnostic.destinationStateId,
        strategy: diagnostic.strategy,
        status: diagnostic.status,
        elapsedMs: diagnostic.elapsedMs,
        actionHistory: diagnostic.actionHistory,
        processRestarted: restorationProcessRestarted(diagnostic),
        lifecycleDifferences,
        currentPackage: current?.packageName ?? null,
        currentActivity: current?.activity ?? null,
        stateAfter: compactRestorationStateEvidence(diagnostic.after),
        behaviorallyEquivalent: true,
        traversalWouldMateriallyDiffer: null,
      };
    }
    return {
      applicationPackage: targetPackage,
      scanId,
      attemptNumber: diagnostic.attemptNumber,
      retryNumber: diagnostic.retryNumber,
      restorationCycleNumber: diagnostic.restorationCycleNumber,
      successfulRestorationsBeforeAttempt: diagnostic.successfulRestorationsBeforeAttempt,
      traversalDepth: diagnostic.traversalDepth,
      sourceStateId: diagnostic.before === undefined
        ? null
        : focusStateIdsByFingerprint.get(diagnostic.before.stateFingerprint) ?? null,
      intendedDestinationStateId: diagnostic.destinationStateId,
      strategy: diagnostic.strategy,
      status: diagnostic.status,
      elapsedMs: diagnostic.elapsedMs,
      actionHistory: diagnostic.actionHistory,
      processRestarted: restorationProcessRestarted(diagnostic),
      foregroundPackageChanged: before !== null && after !== null
        ? before.packageName !== after.packageName
        : null,
      currentPackage: current?.packageName ?? null,
      currentActivity: current?.activity ?? null,
      expectedPackage: expected?.packageName ?? null,
      expectedActivity: expected?.activity ?? null,
      currentFocus: currentEvidence === undefined ? null : {
        focusFingerprint: currentEvidence.focusFingerprint,
        focusIdentity: currentEvidence.focusIdentity ?? null,
        stateFingerprint: currentEvidence.stateFingerprint,
      },
      expectedState: expectedState === undefined ? null : {
        stateFingerprint: expectedState.stateFingerprint,
        focusFingerprint: expectedState.fingerprint.value,
        focusConfidence: expectedState.confidence,
      },
      expectedCheckpoint: compactRestorationStateEvidence(diagnostic.expected),
      stateBefore: compactRestorationStateEvidence(diagnostic.before),
      stateAfter: compactRestorationStateEvidence(diagnostic.after),
      observedHistory: diagnostic.history.slice(-4).map((state) => compactRestorationStateEvidence(state)),
      identityDifferences,
      structuralDiagnosticDifferences: differingDimensions(
        diagnostic.expected,
        currentEvidence,
        STRUCTURAL_DIAGNOSTIC_DIMENSIONS,
      ),
      lifecycleDifferences,
      observedNavigationSurfaceEquivalent: traversalImpact.observedNavigationSurfaceEquivalent,
      behaviorallyEquivalent: traversalImpact.behaviorallyEquivalent,
      behavioralEquivalenceScope: traversalImpact.behaviorallyEquivalent === false
        ? "observed navigation surface differs"
        : "unknown; subsequent behavior was not executed after a failed checkpoint",
      traversalWouldMateriallyDiffer: traversalImpact.traversalWouldMateriallyDiffer,
      reachabilityFingerprint: null,
      reachabilityEvidenceStatus: "not-observable-from-a-single-restored-snapshot",
      navigationReachabilityEvidence: "actionable ancestry fingerprint is retained separately; full future reachability is not inferred",
      failureSubtype: diagnostic.subtype ?? null,
      rejectionReason: diagnostic.rejectionReason ?? null,
      failureClass: restorationFailureClass(diagnostic, current?.packageName ?? null, targetPackage),
      taxonomyCategory: restorationTaxonomyCategory(
        diagnostic,
        current?.packageName ?? null,
        targetPackage,
      ),
    };
  });
  const successfulActions = result.graph.actions.filter((attempt) => (
    attempt.actionResult.outcome === "applied"
  )).length;
  return JSON.parse(JSON.stringify({
    scanId,
    applicationPackage: targetPackage,
    termination: result.termination,
    finalTargetValidation: finalTargetValidationError === null
      ? { status: "verified" }
      : { status: "failed", detail: finalTargetValidationError },
    budgets: result.budgets,
    actionOrder: result.actionOrder,
    statistics: result.statistics,
    completionEvidence: {
      uniqueDiscoveredStates: result.statistics.focusStates,
      uniqueDiscoveredScreens: result.statistics.screenStates,
      physicalActionsAttempted: result.statistics.physicalActions,
      successfulActions,
      uniqueTransitions: result.graph.focus.transitions.length + result.graph.screens.transitions.length,
      restorationAttempts: result.statistics.restorationAttempts ?? 0,
      restorationSuccesses: result.statistics.restorationSuccesses ?? 0,
      restorationFailures: result.statistics.restorationFailures ?? 0,
      repeatedStateObservations: result.statistics.repeatedStates ?? 0,
      duplicateStatesCollapsed: result.statistics.compressedStates ?? 0,
      deferredStates: result.statistics.deferredStates ?? 0,
      skippedOrUnavailableActions: coverageLedger === null ? null : {
        operatorGated: coverageLedger.counts["operator-gated"],
        inaccessible: coverageLedger.counts.inaccessible,
        failed: coverageLedger.counts.failed,
        remainingSafeFrontier: coverageLedger.remainingSafeFrontier,
      },
      totalScanDurationMs: result.statistics.elapsedMs,
      driverErrorTermination: result.termination.reason === "driver-error",
      appCrashCount: null,
      appCrashCountStatus: "not-collected",
    },
    restorationResilience: restorationResilienceMetrics(result, targetPackage, result.restorationDiagnostics ?? []),
    restorationDiagnostics,
  })) as JsonValue;
}

async function fileArtifact(
  outputRoot: string,
  path: string,
  id: string,
  kind: "report",
  mediaType: string,
): Promise<ArtifactDescriptor> {
  const data = await readFile(path);
  const metadata = await stat(path);
  return {
    id,
    kind,
    status: "available",
    path: relative(outputRoot, path).split(sep).join("/"),
    mediaType,
    byteLength: metadata.size,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}
export interface AndroidPreflightDevice {
  readonly serial: string;
  readonly state: string;
  readonly online: boolean;
  readonly model: string | null;
  readonly manufacturer: string | null;
  readonly apiLevel: number | null;
  readonly supportedAbis: readonly string[];
  readonly isTelevision: boolean | null;
  readonly detail: string | null;
}

export interface AndroidPreflightResult {
  readonly available: boolean;
  readonly adbPath: string | null;
  readonly message: string;
  readonly devices: readonly AndroidPreflightDevice[];
}

export interface ApkMetadata {
  readonly path: string;
  readonly packageName: string | null;
  readonly versionName: string | null;
  readonly launchableActivities: readonly string[];
  readonly leanbackActivity: string | null;
  readonly supportedAbis: readonly string[];
  readonly minSdk: number | null;
  readonly targetSdk: number | null;
  readonly label: string | null;
}

export interface ApkCompatibility {
  readonly compatible: boolean;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
}

export interface ApkInspectionDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly runTool?: (
    command: string,
    arguments_: readonly string[],
  ) => Promise<{ readonly stdout: string; readonly stderr: string }>;
  readonly toolCommands?: readonly string[];
  readonly exists?: (path: string) => Promise<boolean>;
}

interface BuildToolsCandidate {
  readonly directory: string;
  readonly name: string;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function firstMatch(value: string, pattern: RegExp): string | null {
  return pattern.exec(value)?.[1] ?? null;
}

function optionalNumber(value: string | null): number | null {
  if (value === null || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normaliseComponents(values: readonly string[], packageName: string): readonly string[] {
  return [...new Set(values)].map((value) => {
    if (value.startsWith(`${packageName}/`)) return value.slice(packageName.length + 1);
    if (value.startsWith(`${packageName}.`)) return `.${value.slice(packageName.length + 1)}`;
    return value.startsWith(".") ? value : `.${value}`;
  });
}

function parseBadging(output: string, apkPath: string): ApkMetadata {
  const packageLine = firstMatch(output, /^package: name='([^']+)'/mu);
  const version = firstMatch(output, /versionName='([^']*)'/u);
  const launchables = [...output.matchAll(/^launchable-activity: name='([^']+)'/gimu)]
    .map((match) => match[1] ?? "")
    .filter((value) => value.length > 0);
  const leanbacks = [...output.matchAll(/^leanback-launchable-activity:\s*name='([^']+)'/gimu)]
    .map((match) => match[1] ?? "")
    .filter((value) => value.length > 0);
  const abis = [...output.matchAll(/^native-code:\s*(.+)$/gimu)]
    .flatMap((match) => (match[1] ?? "").split(/\s+/u))
    .map((value) => value.replaceAll("'", ""))
    .filter((value) => value.length > 0);
  return {
    path: apkPath,
    packageName: packageLine,
    versionName: version,
    launchableActivities: normaliseComponents(launchables, packageLine ?? ""),
    leanbackActivity: leanbacks.length === 0
      ? null
      : normaliseComponents(leanbacks, packageLine ?? "")[0] ?? null,
    supportedAbis: [...new Set(abis)],
    minSdk: optionalNumber(
      firstMatch(output, /\bsdkVersion:'(\d+)'/u)
      ?? firstMatch(output, /\bminSdkVersion:'(\d+)'/u),
    ),
    targetSdk: optionalNumber(firstMatch(output, /\btargetSdkVersion:'(\d+)'/u)),
    label: firstMatch(output, /^application-label:'([^']*)'/mu),
  };
}

function buildToolsCandidates(sdkRoot: string): readonly BuildToolsCandidate[] {
  const executableNames = process.platform === "win32"
    ? ["aapt2.exe", "aapt.exe"]
    : ["aapt2", "aapt"];
  try {
    const versions = readdirSync(join(sdkRoot, "build-tools"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
    return versions.flatMap((version) => executableNames.map((name) => ({
      directory: join(sdkRoot, "build-tools", version),
      name,
    })));
  } catch {
    return [];
  }
}

async function inspectWithAapt(
  apkPath: string,
  dependencies: ApkInspectionDependencies,
): Promise<ApkMetadata> {
  const runTool = dependencies.runTool ?? (async (command, arguments_) => {
    const result = await execFileAsync(command, [...arguments_].map((argument) => argument.replaceAll("\\", "/")), {
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  });
  const injectedCommands = dependencies.toolCommands;
  const candidates = injectedCommands === undefined ? (() => {
    const environment = dependencies.environment ?? process.env;
    let sdkRoot = environment["ANDROID_SDK_ROOT"] ?? environment["ANDROID_HOME"];
    if (sdkRoot === undefined && process.platform === "win32" && environment["LOCALAPPDATA"] !== undefined) {
      sdkRoot = join(environment["LOCALAPPDATA"], "Android", "Sdk");
    }
    if (sdkRoot === undefined || sdkRoot.trim().length === 0) {
      throw new Error("APK inspection requires ANDROID_SDK_ROOT or ANDROID_HOME.");
    }
    return buildToolsCandidates(sdkRoot);
  })() : injectedCommands.map((path) => ({
    directory: dirname(path),
    name: basename(path),
  }));
  for (const candidate of candidates) {
    const command = join(candidate.directory, candidate.name);
    if (!(await (dependencies.exists ?? pathExists)(command))) continue;
    try {
      const output = await runTool(command, ["dump", "badging", apkPath]);
      return parseBadging(`${output.stdout}\n${output.stderr}`, apkPath);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      if (!/ENOENT|EACCES/iu.test(raw)) {
        throw new Error("TVDoctor could not read this APK. Verify that the file is a valid Android application package.", { cause: error });
      }
    }
  }
  throw new Error("No usable aapt/aapt2 installation was found in Android SDK build-tools.");
}

export async function inspectApk(
  apkPath: string,
  dependencies: ApkInspectionDependencies = {},
): Promise<ApkMetadata> {
  if (!/\.apk$/iu.test(apkPath)) throw new Error("Select a file with an .apk extension.");
  return await inspectWithAapt(apkPath, dependencies);
}

export function checkApkCompatibility(
  apk: Pick<ApkMetadata, "minSdk" | "supportedAbis">,
  device: Pick<AndroidPreflightDevice, "apiLevel" | "supportedAbis">,
): ApkCompatibility {
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (apk.minSdk !== null && device.apiLevel !== null && apk.minSdk > device.apiLevel) {
    blockers.push(
      `The APK requires Android API ${String(apk.minSdk)}, but this device provides API ${String(device.apiLevel)}.`,
    );
  }
  if (apk.supportedAbis.length > 0 && device.supportedAbis.length > 0) {
    const overlap = apk.supportedAbis.filter((abi) => device.supportedAbis.includes(abi));
    if (overlap.length === 0) {
      blockers.push(
        `APK architectures (${apk.supportedAbis.join(", ")}) do not overlap the device architectures (${device.supportedAbis.join(", ")}).`,
      );
    }
  } else {
    warnings.push("Architecture compatibility could not be fully verified; installation will still be checked by ADB.");
  }
  return { compatible: blockers.length === 0, blockers, warnings };
}

function friendlyDeviceError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/command not found|enoent|not recognized|cannot run program|createprocess/iu.test(raw)) {
    return "Android platform-tools (ADB) was not found.";
  }
  if (/unauthorized|offline|device not found|no devices|did not become ready/iu.test(raw)) {
    return "This Android device did not authorize or come online in time.";
  }
  return raw.split(/\r?\n/u, 1)[0] ?? "Android device information was unavailable.";
}

export interface AndroidPreflightDriver {
  listDevices(): Promise<readonly { readonly serial: string; readonly state: string; readonly model: string | null }[]>;
  getDeviceMetadata(refresh: boolean): Promise<AndroidDeviceMetadata>;
  close(): Promise<void> | void;
}

export interface AndroidPreflightDependencies {
  readonly createDriver?: (options: { readonly adbPath: string; readonly serial?: string }) => AndroidPreflightDriver;
}

export async function androidPreflight(
  explicitAdbPath?: string,
  dependencies: AndroidPreflightDependencies = {},
): Promise<AndroidPreflightResult> {
  let adbPath: string;
  try {
    const environment = process.env;
    const sdkRoot = environment["ANDROID_SDK_ROOT"] ?? environment["ANDROID_HOME"];
    const executable = process.platform === "win32" ? "adb.exe" : "adb";
    const windowsSdk = environment["LOCALAPPDATA"] === undefined
      ? null
      : join(environment["LOCALAPPDATA"], "Android", "Sdk", "platform-tools", executable);
    if (explicitAdbPath !== undefined && await pathExists(explicitAdbPath)) {
      adbPath = explicitAdbPath;
    } else if (sdkRoot !== undefined && await pathExists(join(sdkRoot, "platform-tools", executable))) {
      adbPath = join(sdkRoot, "platform-tools", executable);
    } else if (process.platform === "win32" && windowsSdk !== null && await pathExists(windowsSdk)) {
      adbPath = windowsSdk;
    } else {
      adbPath = await resolveAdbExecutable(undefined);
    }
  } catch {
    adbPath = explicitAdbPath ?? "adb";
  }
  const createDriver = dependencies.createDriver
    ?? ((options: { readonly adbPath: string; readonly serial?: string }) => new AndroidTvDriver(options));
  const driver = createDriver({ adbPath });
  try {
    const entries = await driver.listDevices();
    const onlineEntries = entries.filter((entry) => entry.state === "device");
    const devices: AndroidPreflightDevice[] = [];
    for (const entry of entries) {
      if (entry.state !== "device") {
        devices.push({
          serial: entry.serial,
          state: entry.state,
          online: false,
          model: entry.model,
          manufacturer: null,
          apiLevel: null,
          supportedAbis: [],
          isTelevision: null,
          detail: entry.state === "offline"
            ? "Offline. Wake or reconnect the device."
            : entry.state === "unauthorized"
              ? "Unauthorized. Accept the USB debugging prompt on the device."
              : "Not ready for testing.",
        });
        continue;
      }
      const metadataDriver = createDriver({ adbPath, serial: entry.serial });
      try {
        const metadata: AndroidDeviceMetadata = await metadataDriver.getDeviceMetadata(true);
        devices.push({
          serial: metadata.serial,
          state: entry.state,
          online: true,
          model: metadata.model,
          manufacturer: metadata.manufacturer,
          apiLevel: metadata.sdkLevel,
          supportedAbis: metadata.supportedAbis,
          isTelevision: metadata.isTelevision,
          detail: null,
        });
      } catch (error) {
        devices.push({
          serial: entry.serial,
          state: entry.state,
          online: false,
          model: entry.model,
          manufacturer: null,
          apiLevel: null,
          supportedAbis: [],
          isTelevision: null,
          detail: friendlyDeviceError(error),
        });
      } finally {
        await metadataDriver.close();
      }
    }
    return {
      available: true,
      adbPath,
      message: onlineEntries.length === 0
        ? "ADB is available, but no online Android devices were found."
        : `Found ${String(onlineEntries.length)} online Android device${onlineEntries.length === 1 ? "" : "s"}.`,
      devices,
    };
  } catch (error) {
    return {
      available: false,
      adbPath: null,
      message: friendlyDeviceError(error),
      devices: [],
    };
  } finally {
    await driver.close();
  }
}

export interface AndroidScanOptions {
  readonly adbPath?: string;
  readonly serial: string;
  readonly apkPath: string;
  readonly mode: "quick" | "deep";
  readonly outputPath: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: AndroidScanProgress) => void;
  readonly onSetupScreen?: (
    detection: AndroidSetupDetection,
  ) => Promise<"select-highlighted" | "press-back" | "leave-unchanged">;
}

interface AndroidRestorationBenchmarkScanOptions extends AndroidScanOptions {
  readonly restorationMode: AndroidRestorationBenchmarkMode;
  readonly launchComponent?: string;
}

interface AndroidScanExecutionOptions extends AndroidScanOptions {
  readonly restorationBenchmark?: {
    readonly mode: AndroidRestorationBenchmarkMode;
    readonly launchComponent?: string;
  };
}

export interface AndroidScanProgress {
  readonly elapsedSeconds: number;
  readonly screens: number;
  readonly states: number;
  readonly actions: number;
  readonly findings: number;
  readonly currentActivityLabel: string | null;
}

export interface AndroidScanResult {
  readonly status: "completed" | "partial" | "failed" | "setup-blocker";
  readonly issueCount: number;
  readonly highestSeverity: "critical" | "high" | "medium" | "low" | "info" | null;
  readonly reportPath: string | null;
  readonly details: readonly string[];
}

export interface AndroidSetupControl {
  readonly label: string;
  readonly focused: boolean;
}

export interface AndroidSetupDetection {
  readonly kind: string;
  readonly heading: string;
  readonly controls: readonly AndroidSetupControl[];
}

function flattenAndroidNodes(
  nodes: readonly AndroidUiNodeSnapshot[],
): readonly AndroidUiNodeSnapshot[] {
  const result: AndroidUiNodeSnapshot[] = [];
  const pending = [...nodes];
  while (pending.length > 0 && result.length < 2_048) {
    const node = pending.shift();
    if (node === undefined) break;
    result.push(node);
    pending.push(...node.children);
  }
  return result;
}

interface AndroidPolicyStateRecord {
  readonly screenStateId: string;
  readonly focusStateId: string;
  readonly snapshot: AndroidStateSnapshot;
  readonly decisions: readonly AndroidActionDecision[];
  readonly evidence: AndroidCoverageEvidence;
  readonly visualOutcomes: ReadonlyMap<RemoteKey, "changed" | "stable" | "unavailable">;
  readonly reusedActionIds: ReadonlyMap<string, string>;
}

export interface AndroidTraversalPolicyRecorder {
  readonly actionsForState: (context: ExplorationActionContext) => Promise<readonly RemoteKey[]>;
  readonly onActionObserved: (context: ExplorationObservedActionContext) => Promise<void>;
  readonly records: readonly AndroidPolicyStateRecord[];
}

const ANDROID_DPAD_DIRECTIONS = ["UP", "DOWN", "LEFT", "RIGHT"] as const;

function observedPackage(snapshot: StateSnapshot): string | null {
  if (snapshot.location.status !== "available") return null;
  const match = /^(?:android|android-app):\/\/([^/]+)/u.exec(snapshot.location.value);
  if (match?.[1] === undefined) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function accessibilityIsSparse(snapshot: StateSnapshot): boolean {
  if (snapshot.uiTree.status !== "available") return true;
  const nodes = flattenAndroidNodes(snapshot.uiTree.value as readonly AndroidUiNodeSnapshot[]);
  const observedFocusedId = snapshot.focusedElement.status === "available"
    ? snapshot.focusedElement.value?.stableId
    : undefined;
  const focused = nodes.find((node) => node.focused === true)
    ?? nodes.find((node) => observedFocusedId !== undefined && node.stableId === observedFocusedId);
  return focused === undefined
    || [focused.name, focused.text, focused.role]
      .every((value) => value === null || value.trim().length === 0);
}

function adaptiveDirectionalKeys(
  snapshot: AndroidStateSnapshot,
): readonly (typeof ANDROID_DPAD_DIRECTIONS)[number][] {
  if (snapshot.uiTree.status !== "available") return ANDROID_DPAD_DIRECTIONS;
  const nodes = flattenAndroidNodes(snapshot.uiTree.value);
  const observedFocusedId = snapshot.focusedElement.status === "available"
    ? snapshot.focusedElement.value?.stableId
    : undefined;
  const focused = nodes.find((node) => node.focused === true)
    ?? nodes.find((node) => observedFocusedId !== undefined && node.stableId === observedFocusedId);
  if (focused?.bounds === null || focused?.bounds === undefined) return ANDROID_DPAD_DIRECTIONS;
  const candidates = nodes.filter((node) => node !== focused
    && node.visible !== false
    && node.enabled !== false
    && node.focusable === true
    && node.bounds !== null);
  if (candidates.length === 0) return ANDROID_DPAD_DIRECTIONS;
  const focusedX = focused.bounds.x + focused.bounds.width / 2;
  const focusedY = focused.bounds.y + focused.bounds.height / 2;
  const available = new Set<(typeof ANDROID_DPAD_DIRECTIONS)[number]>();
  for (const candidate of candidates) {
    if (candidate.bounds === null) continue;
    const candidateX = candidate.bounds.x + candidate.bounds.width / 2;
    const candidateY = candidate.bounds.y + candidate.bounds.height / 2;
    if (candidateY < focusedY) available.add("UP");
    if (candidateY > focusedY) available.add("DOWN");
    if (candidateX < focusedX) available.add("LEFT");
    if (candidateX > focusedX) available.add("RIGHT");
  }
  return ANDROID_DPAD_DIRECTIONS.filter((key) => available.has(key));
}

function adaptiveDecisionRank(key: RemoteKey): number {
  if (!NAVIGATION_KEYS.includes(key as (typeof NAVIGATION_KEYS)[number])) return 1;
  return 0;
}

export function createAndroidTraversalPolicyRecorder(input: {
  readonly driver: Pick<AndroidTvDriver, "getActiveMediaSession" | "captureScreenshotFingerprint">;
  readonly targetPackage: string;
  readonly authorisedActionIds?: ReadonlySet<string>;
}): AndroidTraversalPolicyRecorder {
  const records: AndroidPolicyStateRecord[] = [];
  let rootScreenStateId: string | null = null;
  const adaptiveScreenBacks = new Set<string>();
  const adaptiveMediaActions = new Map<RemoteKey, string>();
  const visualBaselines = new Map<string, AndroidScreenshotFingerprint>();
  const recordsByFocus = new Map<string, AndroidPolicyStateRecord>();
  return {
    records,
    onActionObserved: async (context) => {
      const baseline = visualBaselines.get(context.focusStateId);
      const record = recordsByFocus.get(context.focusStateId);
      if (baseline === undefined || record === undefined) return;
      if (observedPackage(context.afterSnapshot) !== input.targetPackage) return;
      const observed = await input.driver.captureScreenshotFingerprint();
      const outcome = observed.status !== "available" || observed.value.visuallyBlank
        ? "unavailable"
        : observed.value.sha256 === baseline.sha256 ? "stable" : "changed";
      (record.visualOutcomes as Map<RemoteKey, "changed" | "stable" | "unavailable">)
        .set(context.key, outcome);
    },
    actionsForState: async (context) => {
      const snapshot = context.snapshot as AndroidStateSnapshot;
      rootScreenStateId ??= context.screenStateId;
      const mediaSession = await input.driver.getActiveMediaSession(input.targetPackage);
      let screenshot: AndroidCoverageEvidence["screenshot"] = "not-collected";
      const sparseAccessibility = accessibilityIsSparse(snapshot);
      let visualEvidenceUsable = true;
      if (sparseAccessibility) {
        const fingerprint = await input.driver.captureScreenshotFingerprint();
        screenshot = fingerprint.status === "available" ? "available" : "unavailable";
        visualEvidenceUsable = fingerprint.status === "available" && !fingerprint.value.visuallyBlank;
        if (visualEvidenceUsable && fingerprint.status === "available") {
          visualBaselines.set(context.focusStateId, fingerprint.value);
        }
      }
      const policyDecisions = decideAndroidActions({
        strategy: ANDROID_TRAVERSAL_STRATEGY,
        snapshot,
        screenStateId: context.screenStateId,
        targetPackage: input.targetPackage,
        mediaSession,
        authorisedActionIds: input.authorisedActionIds ?? new Set(),
      });
      const evidenceDecisions: readonly AndroidActionDecision[] = sparseAccessibility && !visualEvidenceUsable
        ? policyDecisions.map((decision) => ({
            ...decision,
            disposition: "inaccessible",
            reasonCode: "semantic-and-visual-evidence-unavailable",
            detail: "Accessibility semantics and a usable screenshot fingerprint were both unavailable.",
          }))
        : policyDecisions.map((decision) => decision.key === "BACK"
          && context.screenStateId === rootScreenStateId
          ? {
              ...decision,
              disposition: "operator-gated",
              reasonCode: "root-back-boundary",
              detail: "BACK from the prepared root screen may leave the target app for the Android launcher, so it is not sent automatically.",
            }
          : decision);
      const adaptiveDirections = new Set(adaptiveDirectionalKeys(snapshot));
      const reusedActionIds = new Map<string, string>();
      const decisions = evidenceDecisions.filter((decision) => {
        if (decision.disposition !== "automatic" && decision.disposition !== "target-boundary") {
          return true;
        }
        if (ANDROID_DPAD_DIRECTIONS.includes(
          decision.key as (typeof ANDROID_DPAD_DIRECTIONS)[number],
        )) {
          return adaptiveDirections.has(decision.key as (typeof ANDROID_DPAD_DIRECTIONS)[number]);
        }
        if (decision.key === "BACK") {
          if (adaptiveScreenBacks.has(context.screenStateId)) {
            reusedActionIds.set(decision.actionId, "equivalent-screen-back-probe");
          } else {
            adaptiveScreenBacks.add(context.screenStateId);
          }
          return true;
        }
        const mediaAction = !NAVIGATION_KEYS.includes(
          decision.key as (typeof NAVIGATION_KEYS)[number],
        );
        if (!mediaAction) return true;
        const coveredBy = adaptiveMediaActions.get(decision.key);
        if (coveredBy !== undefined) {
          reusedActionIds.set(decision.actionId, coveredBy);
        } else {
          adaptiveMediaActions.set(decision.key, decision.actionId);
        }
        return true;
      }).map((decision, index) => ({ decision, index }))
        .sort((left, right) => (
          adaptiveDecisionRank(left.decision.key) - adaptiveDecisionRank(right.decision.key)
          || left.index - right.index
        ))
        .map(({ decision }) => decision);
      const record: AndroidPolicyStateRecord = {
        screenStateId: context.screenStateId,
        focusStateId: context.focusStateId,
        snapshot,
        decisions,
        visualOutcomes: new Map(),
        reusedActionIds,
        evidence: {
          accessibility: snapshot.uiTree.status === "available" ? "available" : "unavailable",
          screenshot,
          media: mediaSession.status === "available" ? "available" : "unavailable",
        },
      };
      records.push(record);
      recordsByFocus.set(context.focusStateId, record);
      return decisions
        .filter((decision) => decision.disposition === "automatic"
          || decision.disposition === "target-boundary")
        .filter((decision) => !reusedActionIds.has(decision.actionId))
        .map((decision) => decision.key);
    },
  };
}

export function buildAndroidTraversalLedger(input: {
  readonly targetPackage: string;
  readonly records: readonly AndroidPolicyStateRecord[];
  readonly result: ExplorationResult;
  readonly finalTargetValidated: boolean;
}): AndroidCoverageLedger {
  const attempts = new Map(input.result.graph.actions.map((attempt) => [
    `${attempt.fromFocusStateId}\u0000${attempt.key}`,
    attempt,
  ]));
  const entries: AndroidCoverageEntryInput[] = [];
  let unattemptedSafeActions = 0;
  for (const record of input.records) {
    for (const decision of record.decisions) {
      const attempt = attempts.get(`${record.focusStateId}\u0000${decision.key}`);
      const reusedBy = record.reusedActionIds.get(decision.actionId);
      if (attempt === undefined && reusedBy !== undefined) {
        entries.push({
          entryId: `coverage:${record.focusStateId}:${decision.actionId}`,
          actionId: decision.actionId,
          screenStateId: record.screenStateId,
          focusStateId: record.focusStateId,
          action: decision.key,
          disposition: "verified-state-reuse",
          reasonCode: "equivalent-safe-action-reuse",
          detail: reusedBy.startsWith("equivalent-screen-") || reusedBy.startsWith("equivalent-activity-")
            ? `Equivalent Android state coverage reused: ${reusedBy}.`
            : `The same target-owned media-session action was already exercised as ${reusedBy}.`,
          sourcePackage: observedPackage(record.snapshot),
          destinationPackage: observedPackage(record.snapshot),
          evidence: record.evidence,
        });
        continue;
      }
      if (attempt === undefined
        && (decision.disposition === "automatic" || decision.disposition === "target-boundary")) {
        unattemptedSafeActions += 1;
        continue;
      }
      if (attempt === undefined) {
        entries.push({
          entryId: `coverage:${record.focusStateId}:${decision.actionId}`,
          actionId: decision.actionId,
          screenStateId: record.screenStateId,
          focusStateId: record.focusStateId,
          action: decision.key,
          disposition: decision.disposition === "operator-gated" ? "operator-gated" : "inaccessible",
          reasonCode: decision.reasonCode,
          detail: decision.detail,
          sourcePackage: observedPackage(record.snapshot),
          destinationPackage: null,
          evidence: record.evidence,
        });
        continue;
      }
      const destinationPackage = observedPackage(attempt.afterSnapshot);
      const boundary = decision.disposition === "target-boundary"
        || destinationPackage !== null && destinationPackage !== input.targetPackage;
      const failed = attempt.actionResult.outcome !== "applied"
        || (boundary && !input.finalTargetValidated);
      const visualOutcome = record.visualOutcomes.get(decision.key);
      const visualUnavailable = visualOutcome === "unavailable"
        && record.evidence.accessibility === "unavailable";
      entries.push({
        entryId: `coverage:${record.focusStateId}:${decision.actionId}`,
        actionId: decision.actionId,
        screenStateId: record.screenStateId,
        focusStateId: record.focusStateId,
        action: decision.key,
        disposition: failed
          ? "failed"
          : visualUnavailable
            ? "inaccessible"
            : boundary ? "boundary-restored" : "exercised",
        reasonCode: failed
          ? boundary && !input.finalTargetValidated
            ? "boundary-restoration-failed"
            : `action-${attempt.actionResult.outcome}`
          : visualUnavailable
            ? "post-action-visual-evidence-unavailable"
            : visualOutcome === undefined ? decision.reasonCode : `${decision.reasonCode}-visual-${visualOutcome}`,
        detail: failed
          ? boundary && !input.finalTargetValidated
            ? "The target package could not be re-established after boundary traversal."
            : attempt.actionResult.message ?? "The action did not produce conclusive coverage."
          : visualUnavailable
            ? "The sparse target state was visible before input, but post-action visual evidence was unavailable."
            : visualOutcome === undefined
              ? decision.detail
              : `${decision.detail} Post-action visual fingerprint was ${visualOutcome}.`,
        sourcePackage: observedPackage(attempt.beforeSnapshot),
        destinationPackage,
        evidence: record.evidence,
      });
    }
  }
  return buildAndroidCoverageLedger({
    strategy: ANDROID_TRAVERSAL_STRATEGY,
    targetPackage: input.targetPackage,
    budgets: input.result.budgets,
    entries,
    remainingSafeFrontier: unattemptedSafeActions
      + (input.result.termination.remainingCandidateActions ?? 0)
      + (input.result.statistics.deferredStates ?? 0),
  });
}

export function classifyAndroidStartup(
  snapshot: AndroidStateSnapshot,
): AndroidSetupDetection | null {
  if (snapshot.uiTree.status !== "available") return null;
  const nodes = flattenAndroidNodes(snapshot.uiTree.value);
  const text = nodes.flatMap((node) => [node.name, node.text])
    .filter((value): value is string => value !== null)
    .join(" ")
    .replace(/\s+/gu, " ")
    .toLowerCase();
  const packages = [...new Set(nodes.map((node) => node.packageName).filter((value): value is string => value !== null))];
  const locationOwner = snapshot.location.status === "available"
    ? /^android:\/\/([^/]+)/u.exec(snapshot.location.value)?.[1] ?? null
    : null;
  const isPermissionUi = packages.some((value) => /(?:permissioncontroller|packageinstaller)/iu.test(value))
    || (locationOwner !== null && /(?:permissioncontroller|packageinstaller)/iu.test(locationOwner))
    || /\b(?:allow .* to (?:access|take pictures|record audio)|runtime permission|system permission)\b/u.test(text);
  let kind: string | null = null;
  if (isPermissionUi) kind = "system permission";
  else if (/\b(?:sign in|log in|login|account linking|choose account)\b/u.test(text)) kind = "login";
  else if (/\b(?:welcome|onboarding|get started|set up|setup)\b/u.test(text)) kind = "onboarding";
  else if (/\b(?:region|country|language)\s+(?:selection|choice)\b/u.test(text)) kind = "region selection";
  if (kind === null) return null;
  const controls = nodes
    .filter((node) => node.visible !== false && node.enabled !== false
      && (node.clickable === true || node.focused === true))
    .map((node) => ({
      label: (node.name ?? node.text ?? "Unnamed control").replace(/\s+/gu, " ").trim(),
      focused: node.focused === true,
    }))
    .filter((control, index, all) => control.label.length > 0
      && all.findIndex((candidate) => candidate.label === control.label) === index)
    .slice(0, 5);
  const headingNode = nodes.find((node) => node.visible !== false
    && (node.name ?? node.text ?? "").trim().length > 0);
  const fallbackHeading = kind.replace(/^./u, (character) => character.toUpperCase());
  return {
    kind,
    heading: (headingNode?.name ?? headingNode?.text ?? fallbackHeading).replace(/\s+/gu, " ").trim(),
    controls,
  };
}

async function runAndroidScan(options: AndroidScanExecutionOptions): Promise<AndroidScanResult> {
  const startedAtMs = performance.now();
  const startedAt = new Date();
  const runId = `android-${startedAt.getTime().toString(36)}`;
  let latestFindings = 0;
  let latestProgress: ExplorationProgress | null = null;
  let latestActivityLabel: string | null = null;
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  let selectedPackage: string | null = null;
  const driver = new AndroidTvDriver({
    ...(options.adbPath === undefined ? {} : { adbPath: options.adbPath }),
    serial: options.serial,
    ...ANDROID_LAUNCH_SETTLING,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  try {
    const apk = await inspectApk(options.apkPath);
    if (apk.packageName === null) throw new Error("TVDoctor could not determine the APK package name.");
    const packageName = apk.packageName;
    selectedPackage = packageName;
    const component = options.restorationBenchmark?.launchComponent
      ?? apk.leanbackActivity
      ?? apk.launchableActivities.at(0)
      ?? null;
    await driver.getDeviceMetadata(true);
    await driver.install(options.apkPath);
    await driver.launch({
      id: packageName,
      ...(component === null ? {} : { launchUri: component }),
    });
    await new Promise<void>((resolveWarmup) => setTimeout(resolveWarmup, ANDROID_LAUNCH_WARMUP_MS));
    const initial = await driver.snapshot();
    let preparedSnapshot = initial;
    latestActivityLabel = initial.location.status === "available" ? initial.location.value : null;
    if (initial.uiTree.status !== "available") throw new Error("Android observer UI state was unavailable after launch.");
    let setup = classifyAndroidStartup(initial);
    if (setup !== null && options.onSetupScreen !== undefined) {
      const decision = await options.onSetupScreen(setup);
      if (decision === "leave-unchanged") {
        return {
          status: "setup-blocker",
          issueCount: 0,
          highestSeverity: null,
          reportPath: null,
          details: [
            `The scan was not started because TVDoctor found a ${setup.kind} screen.`,
            "No application state or permissions were changed.",
          ],
        };
      }
      const setupKey = decision === "select-highlighted" ? "SELECT" : "BACK";
      const setupIsExternal = initial.location.status === "available"
        && !initial.location.value.startsWith(`android://${packageName}/`);
      const setupAction = setupIsExternal
        ? await driver.pressSystemSetup(setupKey)
        : await driver.press(setupKey);
      if (setupAction.outcome !== "applied") {
        throw new Error(`TVDoctor could not safely operate the ${setup.kind} screen: ${setupAction.message ?? setupAction.outcome}.`);
      }
      const observed = await driver.snapshot();
      preparedSnapshot = observed;
      setup = classifyAndroidStartup(observed);
      if (setup !== null) throw new Error(`TVDoctor could not safely clear the ${setup.kind} screen.`);
    } else if (setup !== null) {
      return {
        status: "setup-blocker",
        issueCount: 0,
        highestSeverity: null,
        reportPath: null,
        details: [
          `The scan was not started because TVDoctor found a ${setup.kind} screen.`,
          "Automation policy was observation-only.",
        ],
      };
    }

    const outputRoot = resolve(options.outputPath);
    const store = await reserveAuditOutput(options.outputPath);
    const beforeScreenshotPath = join(outputRoot, "before-screenshot.png");
    await driver.captureScreenshot(beforeScreenshotPath);
    const runArtifacts: ArtifactDescriptor[] = [];
    try {
      runArtifacts.push(await fileArtifact(
        outputRoot,
        beforeScreenshotPath,
        "run:before-screenshot",
        "report",
        "image/png",
      ));
    } catch {
      // A screenshot is supplementary evidence and must not invalidate navigation results.
    }

    const policyRecorder = createAndroidTraversalPolicyRecorder({
      driver,
      targetPackage: packageName,
    });
    const restoreInitialSnapshot = createAndroidTraversalRootRestorer(driver, packageName, preparedSnapshot);
    const explorationPromise = explore(driver, {
      profile: options.mode,
      budgets: ANDROID_EXPLORATION_BUDGETS[options.mode],
      actions: ANDROID_AUTOMATIC_ACTIONS,
      settling: ANDROID_ACTION_SETTLING,
      ...(options.restorationBenchmark?.mode === "verified-live-only"
        ? ANDROID_TRAVERSAL_VERIFIED_LIVE_ONLY
        : ANDROID_TRAVERSAL_RESTORATION),
      actionsForState: policyRecorder.actionsForState,
      onActionObserved: policyRecorder.onActionObserved,
      restoreInitialSnapshot,
      shouldExpand: (snapshot) => {
        latestActivityLabel = snapshot.location.status === "available" ? snapshot.location.value : null;
        return snapshot.location.status === "available"
          && snapshot.location.value.startsWith(`android://${packageName}/`);
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onProgress: (progress) => {
        latestProgress = progress;
      },
    });
    if (options.onProgress !== undefined) {
      progressTimer = setInterval(() => {
        options.onProgress?.({
          elapsedSeconds: Math.floor((performance.now() - startedAtMs) / 1_000),
          screens: latestProgress?.screenStates ?? 0,
          states: latestProgress?.focusStates ?? 0,
          actions: latestProgress?.physicalActions ?? 0,
          findings: latestFindings,
          currentActivityLabel: latestActivityLabel,
        });
      }, 500);
    }
    const result = await explorationPromise;
    const findings = diagnoseNavigation(result).findings;
    latestFindings = findings.length;
    const issues = findings.map((finding) => finding.issue);
    const validateFinalTarget = async (): Promise<string | null> => {
      try {
        await restoreAndroidTargetForFinalEvidence(driver, packageName);
        return null;
      } catch (error) {
        return (error instanceof Error ? error.message : String(error))
          .replace(/\s+/gu, " ")
          .slice(0, 500);
      }
    };
    let finalTargetValidationError = await validateFinalTarget();
    if (finalTargetValidationError === null) try {
      const afterScreenshotPath = join(outputRoot, "after-screenshot.png");
      await driver.captureScreenshot(afterScreenshotPath);
      runArtifacts.push(await fileArtifact(
        outputRoot,
        afterScreenshotPath,
        "run:after-screenshot",
        "report",
        "image/png",
      ));
    } catch {
      // Preserve navigation coverage even if the final visual capture fails.
    }
    try {
      const logs = sanitiseEvidenceJson(
        JSON.parse(JSON.stringify(await driver.getLogs())) as JsonValue,
      );
      const logText = `${stableJson(logs)}\n`;
      const logPath = join(outputRoot, "logcat.json");
      await writeFile(logPath, logText);
      runArtifacts.push(await fileArtifact(
        outputRoot,
        logPath,
        "run:logcat",
        "report",
        "application/json",
      ));
    } catch {
      // Log capture is supplementary; the scan result remains authoritative.
    }
    if (finalTargetValidationError === null) {
      finalTargetValidationError = await validateFinalTarget();
    }
    let coverageLedger: AndroidCoverageLedger | null = null;
    let coverageLedgerFailure: string | null = null;
    try {
      coverageLedger = buildAndroidTraversalLedger({
        targetPackage: packageName,
        records: policyRecorder.records,
        result,
        finalTargetValidated: finalTargetValidationError === null,
      });
      const ledgerPath = join(outputRoot, "android-coverage-ledger.json");
      await writeFile(ledgerPath, `${serialiseAndroidCoverageLedger(coverageLedger)}\n`);
      runArtifacts.push(await fileArtifact(
        outputRoot,
        ledgerPath,
        "run:android-coverage-ledger",
        "report",
        "application/json",
      ));
    } catch (error) {
      coverageLedgerFailure = (error instanceof Error ? error.message : String(error))
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, 500) || "Android coverage ledger persistence failed.";
      runArtifacts.push({
        id: "run:android-coverage-ledger",
        kind: "report",
        status: "failed",
        reason: coverageLedgerFailure,
      });
    }
    const completedAt = new Date();
    const complete = result.termination.complete
      && finalTargetValidationError === null
      && coverageLedger !== null
      && !hasIncompleteSafeCoverage(coverageLedger);
    const exhausted: CoverageBudget[] = [];
    if (!complete) {
      if (result.termination.reason === "max-actions") exhausted.push("actions");
      if (result.termination.reason === "max-states") exhausted.push("states");
      if (result.termination.reason === "max-depth") exhausted.push("depth");
      if (result.termination.reason === "max-duration") exhausted.push("duration");
    }
    try {
      const explorationEvidence = sanitiseEvidenceJson(buildAndroidExplorationEvidence(
        result,
        packageName,
        coverageLedger,
        finalTargetValidationError,
        runId,
      ));
      const explorationPath = join(outputRoot, "android-exploration.json");
      await writeFile(explorationPath, `${stableJson(explorationEvidence)}\n`);
      runArtifacts.push(await fileArtifact(
        outputRoot,
        explorationPath,
        "run:android-exploration",
        "report",
        "application/json",
      ));
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error))
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, 500) || "Android exploration diagnostics persistence failed.";
      runArtifacts.push({
        id: "run:android-exploration",
        kind: "report",
        status: "failed",
        reason,
      });
    }
    if (options.restorationBenchmark !== undefined) {
      const benchmarkPath = join(outputRoot, "android-restoration-product-value.json");
      const benchmarkEvidence = sanitiseEvidenceJson(buildAndroidRestorationBenchmarkEvidence(
        result,
        packageName,
        options.restorationBenchmark.mode,
        policyRecorder.records.map((record) => ({
          focusStateId: record.focusStateId,
          safeActions: record.decisions
            .filter((decision) => decision.disposition === "automatic" || decision.disposition === "target-boundary")
            .map((decision) => decision.key),
          reusedSafeActions: record.decisions
            .filter((decision) => record.reusedActionIds.has(decision.actionId))
            .map((decision) => decision.key),
        })),
      ));
      await writeFile(benchmarkPath, `${stableJson(benchmarkEvidence)}\n`);
      runArtifacts.push(await fileArtifact(
        outputRoot,
        benchmarkPath,
        "run:android-restoration-product-value",
        "report",
        "application/json",
      ));
    }
    try {
      const actionProfiles = result.graph.actions.map((action) => ({
        id: action.id,
        key: action.key,
        outcome: action.actionResult.outcome,
        timing: action.actionResult.timing,
      }));
      const totals = actionProfiles.flatMap((action) => {
        const total = action.timing.profile?.totalMs;
        return total === undefined ? [] : [total];
      }).sort((left, right) => left - right);
      const percentile = (fraction: number): number | null => {
        if (totals.length === 0) return null;
        return totals[Math.min(totals.length - 1, Math.max(0, Math.ceil(totals.length * fraction) - 1))] ?? null;
      };
      const performanceEvidence = sanitiseEvidenceJson(JSON.parse(JSON.stringify({
        architecture: "android-observer-v2",
        count: totals.length,
        meanMs: totals.length === 0 ? null : totals.reduce((sum, value) => sum + value, 0) / totals.length,
        p50Ms: percentile(0.5),
        p90Ms: percentile(0.9),
        p95Ms: percentile(0.95),
        p99Ms: percentile(0.99),
        worstMs: totals.at(-1) ?? null,
        actions: actionProfiles,
        observer: driver.getObserverMetrics(),
      })) as JsonValue);
      const performancePath = join(outputRoot, "android-action-performance.json");
      await writeFile(performancePath, `${stableJson(performanceEvidence)}\n`);
      runArtifacts.push(await fileArtifact(
        outputRoot,
        performancePath,
        "run:android-action-performance",
        "report",
        "application/json",
      ));
    } catch {
      // Profiling evidence is supplementary and must never rewrite the run verdict.
    }
    const replays = issues.flatMap((issue) => {
      const compiled = compileIssueReplay(issue);
      return compiled.status === "compiled" ? [compiled.plan.replay] : [];
    });
    const report = buildTVDoctorReportV1({
      run: {
        id: `android-${startedAt.getTime().toString(36)}`,
        tvdoctorVersion: CLI_VERSION,
        mode: options.mode,
        status: complete ? "completed" : "partial",
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
      },
      target: {
        name: apk.label ?? apk.packageName,
        platform: "android-tv",
        location: options.serial,
        environment: {
          package: apk.packageName,
          version: apk.versionName ?? "unknown",
          architecture: apk.supportedAbis.join(", ") || "unknown",
          explorer: "experimental Android TV navigation audit",
          driver: "persistent TVDoctor observer v2",
        },
      },
      coverage: {
        screenStatesDiscovered: result.statistics.screenStates,
        focusStatesDiscovered: result.statistics.focusStates,
        transitionsTested: result.graph.actions.length,
        actionsSent: result.statistics.physicalActions,
        capabilitiesObserved: [...await driver.capabilities()],
        packs: [{ pack: "navigation", status: complete ? "completed" : "partial" }],
        budget: {
          maxActions: result.budgets.maxActions,
          maxStates: result.budgets.maxStates,
          maxDepth: result.budgets.maxDepth,
          maxDurationMs: result.budgets.maxDurationMs,
          maxRepetitiveItems: options.mode === "quick" ? 1 : 4,
          exhausted,
        },
      },
      issues,
      artifacts: runArtifacts,
      replays,
    });
    const bundle = await writeReportBundle(store, report);
    const severityOrder = ["critical", "high", "medium", "low", "info"] as const;
    return {
      status: report.run.status,
      issueCount: issues.length,
      highestSeverity: severityOrder.find((severity) => issues.some((issue) => issue.severity === severity)) ?? null,
      reportPath: bundle.reportJson.absolutePath,
      details: complete
        ? ["All reachable navigation work was exhausted."]
        : finalTargetValidationError !== null
          ? [`Final target-window validation failed: ${finalTargetValidationError}`]
          : coverageLedger !== null && hasIncompleteSafeCoverage(coverageLedger)
            ? ["The Android traversal retained incomplete safe coverage; see android-coverage-ledger.json."]
            : coverageLedgerFailure !== null
              ? [`Android coverage ledger failed: ${coverageLedgerFailure}`]
          : result.termination.reason === "interrupted"
          ? ["The scan was interrupted; completed coverage was retained in this partial report."]
        : [
          `Safety ceiling reached: ${result.termination.reason}. Unexplored work remained.`,
          ...(result.termination.detail === undefined ? [] : [result.termination.detail]),
        ],
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      issueCount: 0,
      highestSeverity: null,
      reportPath: null,
      details: [reason],
    };
  } finally {
    if (progressTimer !== undefined) clearInterval(progressTimer);
    const appPackage = selectedPackage ?? undefined;
    await driver.forceStop(appPackage ?? undefined).catch(() => undefined);
    await driver.close();
  }
}

export async function scanAndroidApk(options: AndroidScanOptions): Promise<AndroidScanResult> {
  return await runAndroidScan(options);
}

/** @internal Matched benchmark entry point; intentionally omitted from the package root exports. */
export async function scanAndroidApkForRestorationBenchmark(
  options: AndroidRestorationBenchmarkScanOptions,
): Promise<AndroidScanResult> {
  const {
    restorationMode,
    launchComponent,
    ...scanOptions
  } = options;
  return await runAndroidScan({
    ...scanOptions,
    restorationBenchmark: {
      mode: restorationMode,
      ...(launchComponent === undefined ? {} : { launchComponent }),
    },
  });
}
