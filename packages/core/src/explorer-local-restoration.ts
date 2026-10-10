import type { ActionOutcome, RemoteKey, StateSnapshot, TVDoctorDriver } from "@tvdoctor/protocol";

import {
  pressAndObserve,
  type NormalisedActionSettlingOptions,
} from "./action-settling.js";
import type {
  ExplorationTermination,
  RestorationFailureSubtype,
  RestorationRejectionReason,
} from "./explorer-contracts.js";
import {
  restorationStateDiagnostic,
  type PendingRestorationDiagnostic,
} from "./explorer-restoration-diagnostics.js";
import type { QueueEntry } from "./explorer-frontier.js";
import type { ComputedSnapshotFingerprint } from "./fingerprint.js";
import {
  DurationBudgetExceeded,
  incomplete,
  type RestoreResult,
} from "./explorer-restoration.js";
import {
  IncrementalVerifiedPathIndex,
  type VerifiedStateEdge,
} from "./verified-path.js";

const SAFE_LOCAL_RESTORATION_KEYS = new Set<RemoteKey>(["UP", "DOWN", "LEFT", "RIGHT"]);

interface VerifiedLocalRestorationContext {
  readonly enabled: boolean;
  readonly allowPathRestoration: boolean;
  readonly allowRootRestorationFallback: boolean;
  readonly refreshVisibleSelfLoops: boolean;
  readonly actionOrder: readonly RemoteKey[];
  readonly rootReplayActions: ReadonlySet<RemoteKey>;
  readonly initialSnapshot: StateSnapshot;
  readonly initialIdentity: string;
  readonly measuredDriver: TVDoctorDriver;
  readonly settling: NormalisedActionSettlingOptions;
  readonly rootRestore: (
    entry: QueueEntry,
    beforeSnapshot: StateSnapshot | undefined,
    restorationCycleNumber: number,
  ) => Promise<RestoreResult>;
  readonly workBudgetTermination: () => ExplorationTermination | null;
  readonly withinDurationBudget: <T>(operation: (signal: AbortSignal) => Promise<T>) => Promise<T>;
  readonly signalAborted: () => boolean;
  readonly fingerprintSnapshot: (snapshot: StateSnapshot) => ComputedSnapshotFingerprint;
  readonly stateByIdentity: ReadonlyMap<string, { readonly representativeSnapshot: StateSnapshot }>;
  readonly monotonicNow: () => number;
  readonly durationSince: (startedAt: number) => number;
  readonly onReplayAction: () => void;
  readonly onSettlingObservation: (snapshotsObserved: number, settled: boolean) => void;
  readonly onReplayDuration: (durationMs: number) => void;
  readonly onStateReuse: () => void;
  readonly onPathRestoration: () => void;
  readonly onFallback: () => void;
  readonly onDiagnostic: (diagnostic: PendingRestorationDiagnostic) => void;
}

export interface VerifiedLocalRestorer {
  readonly restore: (entry: QueueEntry) => Promise<RestoreResult>;
  readonly clearLive: () => void;
  readonly observeAfterAction: (
    snapshot: StateSnapshot,
    identity: string,
    entry: QueueEntry,
    expandable: boolean,
    hasPendingWork: boolean,
    outcome: ActionOutcome,
  ) => Promise<ExplorationTermination | null>;
  readonly recordEdge: (edge: VerifiedStateEdge) => void;
  readonly liveIdentity: () => string | null;
  /** Total queued-branch restoration cycles, including cycles that fail before an exploration action. */
  readonly cycleCount: () => number;
}

export function createVerifiedLocalRestorer(
  context: VerifiedLocalRestorationContext,
): VerifiedLocalRestorer {
  let trustedLiveSnapshot: StateSnapshot | null = context.initialSnapshot;
  let trustedLiveIdentity: string | null = context.initialIdentity;
  let restorationCycleNumber = 0;
  const verifiedPaths = new IncrementalVerifiedPathIndex(context.actionOrder);
  const verifiedEdgeKeys = new Set<string>();

  const clearLive = (): void => {
    trustedLiveSnapshot = null;
    trustedLiveIdentity = null;
  };
  const observeLive = (snapshot: StateSnapshot, identity: string): void => {
    trustedLiveSnapshot = snapshot;
    trustedLiveIdentity = identity;
  };
  const recordEdge = (edge: VerifiedStateEdge): void => {
    if (!context.enabled || !context.allowPathRestoration || !SAFE_LOCAL_RESTORATION_KEYS.has(edge.key)) return;
    const key = `${edge.fromIdentity}\u001f${edge.key}\u001f${edge.toIdentity}`;
    if (verifiedEdgeKeys.has(key)) return;
    verifiedEdgeKeys.add(key);
    verifiedPaths.add(edge);
  };
  const liveIdentity = (): string | null => trustedLiveIdentity;
  const cycleCount = (): number => restorationCycleNumber;

  const rootRestore = async (entry: QueueEntry, cycleNumber: number): Promise<RestoreResult> => {
    const startedAt = context.monotonicNow();
    const before = trustedLiveSnapshot === null
      ? undefined
      : restorationStateDiagnostic(trustedLiveSnapshot);
    const unsafeKey = context.enabled
      ? entry.sequence.find((key) => !context.rootReplayActions.has(key))
      : undefined;
    const expected = restorationStateDiagnostic(entry.state.representativeSnapshot);
    if (unsafeKey !== undefined) {
      context.onDiagnostic({
        restorationCycleNumber: cycleNumber,
        traversalDepth: entry.state.firstSeenDepth,
        destinationStateId: entry.state.id,
        strategy: "root-replay",
        status: "failed",
        elapsedMs: context.durationSince(startedAt),
        actionHistory: entry.sequence,
        ...(before === undefined ? {} : { before }),
        expected,
        history: before === undefined ? [] : [before],
        subtype: "strategy-exhausted",
        rejectionReason: "unsafe-root-replay",
      });
      clearLive();
      return {
        status: "skip",
        termination: incomplete(
          "restoration-unavailable",
          `Unsafe root replay requires ${unsafeKey}; the queued branch was not reconstructed without a verified live state.`,
          { subtype: "strategy-exhausted", rejectionReason: "unsafe-root-replay" },
        ),
      };
    }
    const result = await context.rootRestore(entry, trustedLiveSnapshot ?? undefined, cycleNumber);
    if (result.status === "ok") {
      const fingerprint = context.fingerprintSnapshot(result.snapshot);
      observeLive(result.snapshot, fingerprint.stateIdentity);
    } else {
      clearLive();
    }
    return result;
  };

  /**
   * An absent local route is a cache miss, not evidence that restoration failed.
   * Count a fallback only when a safe root replay is actually attempted, and
   * honour the no-root policy even after a previously trusted live state drifts.
   */
  const fallbackToRoot = async (
    entry: QueueEntry,
    cycleNumber: number,
    attemptedAlternative: boolean,
  ): Promise<RestoreResult> => {
    if (!context.allowRootRestorationFallback) {
      const startedAt = context.monotonicNow();
      const before = trustedLiveSnapshot === null
        ? undefined
        : restorationStateDiagnostic(trustedLiveSnapshot);
      context.onDiagnostic({
        restorationCycleNumber: cycleNumber,
        traversalDepth: entry.state.firstSeenDepth,
        destinationStateId: entry.state.id,
        strategy: "root-replay",
        status: "failed",
        elapsedMs: context.durationSince(startedAt),
        actionHistory: entry.sequence,
        ...(before === undefined ? {} : { before }),
        expected: restorationStateDiagnostic(entry.state.representativeSnapshot),
        history: before === undefined ? [] : [before],
        subtype: "strategy-exhausted",
        rejectionReason: "root-fallback-disabled",
      });
      clearLive();
      return {
        status: "skip",
        termination: incomplete(
          "restoration-unavailable",
          "The queued branch could not be restored from the current verified live state without a root relaunch.",
          { subtype: "strategy-exhausted", rejectionReason: "root-fallback-disabled" },
        ),
      };
    }
    if (attemptedAlternative
      && entry.sequence.every((key) => context.rootReplayActions.has(key))) {
      context.onFallback();
    }
    return rootRestore(entry, cycleNumber);
  };

  const restore = async (entry: QueueEntry): Promise<RestoreResult> => {
    const cycleNumber = ++restorationCycleNumber;
    const expected = restorationStateDiagnostic(entry.state.representativeSnapshot);
    if (!context.enabled) return rootRestore(entry, cycleNumber);
    if (trustedLiveSnapshot !== null && trustedLiveIdentity === entry.state.identity) {
      const startedAt = context.monotonicNow();
      const before = restorationStateDiagnostic(trustedLiveSnapshot);
      let freshSnapshot: StateSnapshot;
      try {
        freshSnapshot = await context.withinDurationBudget(
          (signal) => context.measuredDriver.snapshot({ signal }),
        );
      } catch (error) {
        const interrupted = context.signalAborted();
        const timedOut = error instanceof DurationBudgetExceeded;
        context.onDiagnostic({
          restorationCycleNumber: cycleNumber,
          traversalDepth: entry.state.firstSeenDepth,
          destinationStateId: entry.state.id,
          strategy: "verified-live-state",
          status: "failed",
          elapsedMs: context.durationSince(startedAt),
          actionHistory: [],
          before,
          expected,
          history: [before],
          subtype: interrupted ? "interrupted" : timedOut ? "timeout" : "operation-failed",
          rejectionReason: interrupted ? "interrupted" : timedOut
            ? "duration-budget-exhausted" : "local-path-action-error",
        });
        clearLive();
        if (interrupted || timedOut) {
          return {
            status: "stop",
            termination: incomplete(
              interrupted ? "interrupted" : "max-duration",
              undefined,
              {
                subtype: interrupted ? "interrupted" : "timeout",
                rejectionReason: interrupted ? "interrupted" : "duration-budget-exhausted",
              },
            ),
          };
        }
        return fallbackToRoot(entry, cycleNumber, true);
      }
      const observed = context.fingerprintSnapshot(freshSnapshot);
      const after = restorationStateDiagnostic(freshSnapshot, observed);
      if (observed.stateIdentity === entry.state.identity) {
        context.onDiagnostic({
          restorationCycleNumber: cycleNumber,
          traversalDepth: entry.state.firstSeenDepth,
          destinationStateId: entry.state.id,
          strategy: "verified-live-state",
          status: "success",
          elapsedMs: context.durationSince(startedAt),
          actionHistory: [],
          before,
          after,
          expected,
          history: [before, after],
        });
        observeLive(freshSnapshot, observed.stateIdentity);
        context.onStateReuse();
        return { status: "ok", snapshot: freshSnapshot };
      }
      context.onDiagnostic({
        restorationCycleNumber: cycleNumber,
        traversalDepth: entry.state.firstSeenDepth,
        destinationStateId: entry.state.id,
        strategy: "verified-live-state",
        status: "failed",
        elapsedMs: context.durationSince(startedAt),
        actionHistory: [],
        before,
        after,
        expected,
        history: [before, after],
        subtype: "navigation-diverged",
        rejectionReason: "local-path-edge-diverged",
      });
      clearLive();
      return fallbackToRoot(entry, cycleNumber, true);
    }

    if (context.allowPathRestoration && trustedLiveIdentity !== null) {
      const localStartedAt = context.monotonicNow();
      const localBefore = trustedLiveSnapshot === null
        ? undefined
        : restorationStateDiagnostic(trustedLiveSnapshot);
      const history = localBefore === undefined ? [] : [localBefore];
      const actionHistory: RemoteKey[] = [];
      let localAfterSnapshot = trustedLiveSnapshot;
      const recordLocalFailure = (
        subtype: RestorationFailureSubtype,
        rejectionReason: RestorationRejectionReason,
        expectedSnapshot: StateSnapshot = entry.state.representativeSnapshot,
      ): void => {
        const after = localAfterSnapshot === null
          ? undefined
          : restorationStateDiagnostic(localAfterSnapshot);
        context.onDiagnostic({
          restorationCycleNumber: cycleNumber,
          traversalDepth: entry.state.firstSeenDepth,
          destinationStateId: entry.state.id,
          strategy: "verified-local-path",
          status: "failed",
          elapsedMs: context.durationSince(localStartedAt),
          actionHistory,
          ...(localBefore === undefined ? {} : { before: localBefore }),
          ...(after === undefined ? {} : { after }),
          expected: restorationStateDiagnostic(expectedSnapshot),
          history,
          subtype,
          rejectionReason,
        });
      };
      const path = verifiedPaths.find(trustedLiveIdentity, entry.state.identity);
      // Prefer local reconstruction only when it cannot consume *more remote
      // inputs* than the proven root path. Reset latency and keypress cost vary
      // per device, but spending extra keys can prematurely hit Deep's strict
      // physical-action budget and lose reachable frontier. If root replay is
      // unsafe or explicitly disabled, retain the local path as the only route.
      const rootReplayPermitted = context.allowRootRestorationFallback
        && entry.sequence.every((key) => context.rootReplayActions.has(key));
      const worthwhilePath = path !== null && path.length > 0
        && (!rootReplayPermitted || path.length <= entry.sequence.length);
      // A disconnected/longer verified path is a route-selection miss, not a
      // failed restoration. Root reconstruction remains the next strategy.
      if (worthwhilePath && path !== null) {
        const startedAt = context.monotonicNow();
        let failure: {
          readonly subtype: RestorationFailureSubtype;
          readonly rejectionReason: RestorationRejectionReason;
          readonly expectedSnapshot?: StateSnapshot;
        } | null = null;
        try {
          for (const edge of path) {
            const budgetTermination = context.workBudgetTermination();
            if (budgetTermination !== null) {
              let restoration: {
                readonly subtype: RestorationFailureSubtype;
                readonly rejectionReason: RestorationRejectionReason;
              };
              if (budgetTermination.reason === "max-duration") {
                restoration = { subtype: "timeout", rejectionReason: "duration-budget-exhausted" };
              } else if (budgetTermination.reason === "interrupted") {
                restoration = { subtype: "interrupted", rejectionReason: "interrupted" };
              } else {
                restoration = { subtype: "strategy-exhausted", rejectionReason: "action-budget-exhausted" };
              }
              recordLocalFailure(restoration.subtype, restoration.rejectionReason);
              clearLive();
              return {
                status: "stop",
                termination: {
                  ...budgetTermination,
                  restorationSubtype: restoration.subtype,
                  restorationRejectionReason: restoration.rejectionReason,
                },
              };
            }
            actionHistory.push(edge.key);
            context.onReplayAction();
            let observation: Awaited<ReturnType<typeof pressAndObserve>>;
            try {
              observation = await context.withinDurationBudget((signal) => pressAndObserve(
                context.measuredDriver,
                edge.key,
                { ...context.settling, signal },
              ));
            } catch (error) {
              if (context.signalAborted()) {
                recordLocalFailure("interrupted", "interrupted");
                clearLive();
                return {
                  status: "stop",
                  termination: incomplete(
                    "interrupted",
                    undefined,
                    { subtype: "interrupted", rejectionReason: "interrupted" },
                  ),
                };
              }
              if (error instanceof DurationBudgetExceeded) {
                recordLocalFailure("timeout", "duration-budget-exhausted");
                clearLive();
                return {
                  status: "stop",
                  termination: incomplete(
                    "max-duration",
                    undefined,
                    { subtype: "timeout", rejectionReason: "duration-budget-exhausted" },
                  ),
                };
              }
              const expectedSnapshot = context.stateByIdentity.get(edge.toIdentity)?.representativeSnapshot;
              failure = {
                subtype: "operation-failed",
                rejectionReason: "local-path-action-error",
                ...(expectedSnapshot === undefined ? {} : { expectedSnapshot }),
              };
              break;
            }
            context.onSettlingObservation(observation.snapshotsObserved, observation.settled);
            localAfterSnapshot = observation.snapshot;
            if (!observation.settled) {
              history.push(restorationStateDiagnostic(observation.snapshot));
              const expectedSnapshot = context.stateByIdentity.get(edge.toIdentity)?.representativeSnapshot;
              failure = {
                subtype: "timeout",
                rejectionReason: "local-path-unsettled",
                ...(expectedSnapshot === undefined ? {} : { expectedSnapshot }),
              };
              break;
            }
            if (observation.actionResult.key !== edge.key
              || observation.actionResult.outcome !== "applied") {
              history.push(restorationStateDiagnostic(observation.snapshot));
              const expectedSnapshot = context.stateByIdentity.get(edge.toIdentity)?.representativeSnapshot;
              failure = {
                subtype: "navigation-diverged",
                rejectionReason: "local-path-action-rejected",
                ...(expectedSnapshot === undefined ? {} : { expectedSnapshot }),
              };
              break;
            }
            const observed = context.fingerprintSnapshot(observation.snapshot);
            observeLive(observation.snapshot, observed.stateIdentity);
            history.push(restorationStateDiagnostic(observation.snapshot, observed));
            if (observed.stateIdentity !== edge.toIdentity) {
              const expectedSnapshot = context.stateByIdentity.get(edge.toIdentity)?.representativeSnapshot;
              failure = {
                subtype: "navigation-diverged",
                rejectionReason: "local-path-edge-diverged",
                ...(expectedSnapshot === undefined ? {} : { expectedSnapshot }),
              };
              break;
            }
          }
        } finally {
          context.onReplayDuration(context.durationSince(startedAt));
        }
        if (failure === null && trustedLiveSnapshot !== null && trustedLiveIdentity === entry.state.identity) {
          const after = restorationStateDiagnostic(trustedLiveSnapshot);
          context.onDiagnostic({
            restorationCycleNumber: cycleNumber,
            traversalDepth: entry.state.firstSeenDepth,
            destinationStateId: entry.state.id,
            strategy: "verified-local-path",
            status: "success",
            elapsedMs: context.durationSince(localStartedAt),
            actionHistory,
            ...(localBefore === undefined ? {} : { before: localBefore }),
            after,
            expected,
            history,
          });
          context.onPathRestoration();
          return { status: "ok", snapshot: trustedLiveSnapshot };
        }
        if (failure === null) {
          recordLocalFailure("state-not-found", "destination-state-not-found");
        } else {
          recordLocalFailure(
            failure.subtype,
            failure.rejectionReason,
            failure.expectedSnapshot ?? entry.state.representativeSnapshot,
          );
        }
        clearLive();
        return fallbackToRoot(entry, cycleNumber, true);
      }
      if (path === null) return fallbackToRoot(entry, cycleNumber, true);
    }
    return fallbackToRoot(entry, cycleNumber, false);
  };

  const observeAfterAction = async (
    snapshot: StateSnapshot,
    identity: string,
    entry: QueueEntry,
    expandable: boolean,
    hasPendingWork: boolean,
    outcome: ActionOutcome,
  ): Promise<ExplorationTermination | null> => {
    if (!expandable) {
      clearLive();
      return null;
    }
    observeLive(snapshot, identity);
    const visibleSelfLoop = identity === entry.state.identity;
    const safelyRefreshable = entry.sequence.every((key) => context.rootReplayActions.has(key));
    if (!context.enabled
      || !context.refreshVisibleSelfLoops
      || !visibleSelfLoop
      || !hasPendingWork
      // Unsupported keys were never applied; they cannot create the hidden
      // action history that requires a fresh root before the next sibling.
      || outcome === "unsupported"
      || !safelyRefreshable) return null;
    clearLive();
    const refreshed = await rootRestore(entry, ++restorationCycleNumber);
    return refreshed.status === "ok" ? null : refreshed.termination;
  };

  return { restore, clearLive, observeAfterAction, recordEdge, liveIdentity, cycleCount };
}
