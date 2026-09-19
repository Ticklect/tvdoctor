import type { StateSnapshot, TVDoctorDriver } from "@tvdoctor/protocol";

import {
  pressAndObserve,
  type NormalisedActionSettlingOptions,
} from "./action-settling.js";
import { PreparedStateDivergenceError } from "./errors.js";
import type {
  RestorationFailureSubtype,
  RestorationRejectionReason,
  ExplorationTermination,
  ExplorationTerminationReason,
} from "./explorer-contracts.js";
import {
  restorationStateDiagnostic,
  type PendingRestorationDiagnostic,
} from "./explorer-restoration-diagnostics.js";
import type { QueueEntry } from "./explorer-frontier.js";
import type { ComputedSnapshotFingerprint } from "./fingerprint.js";
import { snapshotDifference, type InternalFocusState } from "./explorer-state.js";

export interface RestoreSuccess {
  readonly status: "ok";
  readonly snapshot: StateSnapshot;
}

export interface RestoreStop {
  readonly status: "stop";
  readonly termination: ExplorationTermination;
}

export interface RestoreSkip {
  readonly status: "skip";
  readonly termination: ExplorationTermination;
}

export type RestoreResult = RestoreSuccess | RestoreStop | RestoreSkip;

export class DurationBudgetExceeded extends Error {
  constructor() {
    super("The exploration duration budget was exhausted during a driver call.");
    this.name = "DurationBudgetExceeded";
  }
}

export function incomplete(
  reason: Exclude<ExplorationTerminationReason, "queue-exhausted">,
  detail?: string,
  restoration?: {
    readonly subtype: RestorationFailureSubtype;
    readonly rejectionReason: RestorationRejectionReason;
  },
): ExplorationTermination {
  return {
    reason,
    complete: false,
    ...(detail === undefined ? {} : { detail: detail.replace(/\s+/gu, " ").slice(0, 500) }),
    ...(restoration === undefined ? {} : {
      restorationSubtype: restoration.subtype,
      restorationRejectionReason: restoration.rejectionReason,
    }),
  };
}

interface ExplorerRestorationContext {
  readonly restoreAndCapture: (signal: AbortSignal) => Promise<StateSnapshot>;
  readonly withinDurationBudget: <T>(operation: (signal: AbortSignal) => Promise<T>) => Promise<T>;
  readonly signalAborted: () => boolean;
  readonly monotonicNow: () => number;
  readonly durationSince: (startedAt: number) => number;
  readonly fingerprintSnapshot: (snapshot: StateSnapshot) => ComputedSnapshotFingerprint;
  readonly initialFingerprint: ComputedSnapshotFingerprint;
  readonly initialSnapshot: StateSnapshot;
  readonly stateByIdentity: ReadonlyMap<string, InternalFocusState>;
  readonly measuredDriver: TVDoctorDriver;
  readonly settling: NormalisedActionSettlingOptions;
  readonly workBudgetTermination: () => ExplorationTermination | null;
  readonly onRestorationStart: (replayLength: number) => void;
  readonly onResetDuration: (durationMs: number) => void;
  readonly onReplayAction: () => void;
  readonly onSettlingObservation: (snapshotsObserved: number, settled: boolean) => void;
  readonly onReplayDuration: (durationMs: number) => void;
  readonly onDiagnostic: (diagnostic: PendingRestorationDiagnostic) => void;
}

export function createExplorerRestorer(
  context: ExplorerRestorationContext,
): (entry: QueueEntry, beforeSnapshot: StateSnapshot | undefined, restorationCycleNumber: number) => Promise<RestoreResult> {
  return async (
    entry: QueueEntry,
    beforeSnapshot: StateSnapshot | undefined,
    restorationCycleNumber: number,
  ): Promise<RestoreResult> => {
    let resetSnapshot: StateSnapshot;
    const attemptStartedAt = context.monotonicNow();
    const history: ReturnType<typeof restorationStateDiagnostic>[] = [];
    const before = beforeSnapshot === undefined
      ? undefined
      : restorationStateDiagnostic(beforeSnapshot);
    const destinationExpected = restorationStateDiagnostic(entry.state.representativeSnapshot);
    if (before !== undefined) history.push(before);
    const recordFailure = (
      subtype: RestorationFailureSubtype,
      rejectionReason: RestorationRejectionReason,
      afterSnapshot?: StateSnapshot,
      expectedSnapshot: StateSnapshot = entry.state.representativeSnapshot,
    ): void => {
      context.onDiagnostic({
        restorationCycleNumber,
        traversalDepth: entry.state.firstSeenDepth,
        destinationStateId: entry.state.id,
        strategy: "root-replay",
        status: "failed",
        elapsedMs: context.durationSince(attemptStartedAt),
        actionHistory: entry.sequence,
        ...(before === undefined ? {} : { before }),
        ...(afterSnapshot === undefined ? {} : {
          after: restorationStateDiagnostic(afterSnapshot),
        }),
        expected: restorationStateDiagnostic(expectedSnapshot),
        history,
        subtype,
        rejectionReason,
      });
    };
    const recordSuccess = (snapshot: StateSnapshot): void => {
      const after = restorationStateDiagnostic(snapshot);
      context.onDiagnostic({
        restorationCycleNumber,
        traversalDepth: entry.state.firstSeenDepth,
        destinationStateId: entry.state.id,
        strategy: "root-replay",
        status: "success",
        elapsedMs: context.durationSince(attemptStartedAt),
        actionHistory: entry.sequence,
        ...(before === undefined ? {} : { before }),
        after,
        expected: destinationExpected,
        history,
      });
    };
    context.onRestorationStart(entry.sequence.length);
    const resetStartedAt = context.monotonicNow();
    try {
      resetSnapshot = await context.withinDurationBudget(context.restoreAndCapture);
    } catch (error) {
      if (context.signalAborted()) {
        recordFailure("interrupted", "interrupted");
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
        recordFailure("timeout", "duration-budget-exhausted");
        return {
          status: "stop",
          termination: incomplete(
            "max-duration",
            undefined,
            { subtype: "timeout", rejectionReason: "duration-budget-exhausted" },
          ),
        };
      }
      if (error instanceof PreparedStateDivergenceError) {
        recordFailure("navigation-diverged", "prepared-state-diverged");
        return {
          status: "stop",
          termination: incomplete(
            "prepared-state-diverged",
            undefined,
            { subtype: "navigation-diverged", rejectionReason: "prepared-state-diverged" },
          ),
        };
      }
      recordFailure("operation-failed", "root-restoration-error");
      return {
        status: "stop",
        termination: incomplete(
          "restoration-failed",
          error instanceof Error ? error.message : String(error),
          { subtype: "operation-failed", rejectionReason: "root-restoration-error" },
        ),
      };
    } finally {
      context.onResetDuration(context.durationSince(resetStartedAt));
    }
    const resetFingerprint = context.fingerprintSnapshot(resetSnapshot);
    history.push(restorationStateDiagnostic(resetSnapshot, resetFingerprint));
    if (resetFingerprint.stateIdentity !== context.initialFingerprint.stateIdentity) {
      recordFailure("navigation-diverged", "root-state-diverged", resetSnapshot, context.initialSnapshot);
      return {
        status: "stop",
        termination: incomplete(
          "replay-diverged",
          `Root restoration produced ${resetFingerprint.fingerprint.stateValue}; expected ${context.initialFingerprint.fingerprint.stateValue} before replaying [${entry.sequence.join(", ")}]. ${snapshotDifference(context.initialSnapshot, resetSnapshot)}`,
          { subtype: "navigation-diverged", rejectionReason: "root-state-diverged" },
        ),
      };
    }

    let currentSnapshot = resetSnapshot;
    const replayStartedAt = context.monotonicNow();
    try {
      for (const [index, key] of entry.sequence.entries()) {
        const budgetTermination = context.workBudgetTermination();
        if (budgetTermination !== null) {
          if (budgetTermination.reason === "max-duration") {
            recordFailure("timeout", "duration-budget-exhausted", currentSnapshot);
            return {
              status: "stop",
              termination: {
                ...budgetTermination,
                restorationSubtype: "timeout",
                restorationRejectionReason: "duration-budget-exhausted",
              },
            };
          } else if (budgetTermination.reason === "interrupted") {
            recordFailure("interrupted", "interrupted", currentSnapshot);
            return {
              status: "stop",
              termination: {
                ...budgetTermination,
                restorationSubtype: "interrupted",
                restorationRejectionReason: "interrupted",
              },
            };
          } else {
            recordFailure("strategy-exhausted", "action-budget-exhausted", currentSnapshot);
            return {
              status: "stop",
              termination: {
                ...budgetTermination,
                restorationSubtype: "strategy-exhausted",
                restorationRejectionReason: "action-budget-exhausted",
              },
            };
          }
        }
        context.onReplayAction();
        try {
          const observation = await context.withinDurationBudget(
            (signal) => pressAndObserve(context.measuredDriver, key, {
              ...context.settling,
              signal,
            }),
          );
          context.onSettlingObservation(observation.snapshotsObserved, observation.settled);
          if (!observation.settled) {
            recordFailure("timeout", "settling-exhausted", observation.snapshot);
            return {
              status: "stop",
              termination: incomplete(
                "settling-exhausted",
                undefined,
                { subtype: "timeout", rejectionReason: "settling-exhausted" },
              ),
            };
          }
          currentSnapshot = observation.snapshot;
          const observedFingerprint = context.fingerprintSnapshot(currentSnapshot);
          history.push(restorationStateDiagnostic(currentSnapshot, observedFingerprint));
          if (observation.actionResult.key !== key || observation.actionResult.outcome !== "applied") {
            recordFailure("navigation-diverged", "replay-action-rejected", currentSnapshot);
            return {
              status: "stop",
              termination: incomplete(
                "replay-diverged",
                `Replay action ${String(index + 1)}/${String(entry.sequence.length)} (${key}) returned ${observation.actionResult.key}/${observation.actionResult.outcome} for [${entry.sequence.join(", ")}].`,
                { subtype: "navigation-diverged", rejectionReason: "replay-action-rejected" },
              ),
            };
          }
          const expectedCheckpoint = entry.checkpoints[index];
          const observedCheckpoint = observedFingerprint;
          if (expectedCheckpoint === undefined
            || observedCheckpoint.stateIdentity !== expectedCheckpoint) {
            const expectedState = expectedCheckpoint === undefined
              ? undefined
              : context.stateByIdentity.get(expectedCheckpoint);
            const expectedValue = expectedState?.fingerprint.fingerprint.stateValue
              ?? (expectedCheckpoint === undefined ? "a recorded checkpoint" : "the recorded checkpoint");
            const difference = expectedState === undefined
              ? ""
              : ` ${snapshotDifference(expectedState.representativeSnapshot, currentSnapshot)}`;
            recordFailure(
              "navigation-diverged",
              "replay-checkpoint-diverged",
              currentSnapshot,
              expectedState?.representativeSnapshot ?? entry.state.representativeSnapshot,
            );
            return {
              status: "stop",
              termination: incomplete(
                "replay-diverged",
                `Replay checkpoint ${String(index + 1)}/${String(entry.sequence.length)} after ${key} produced ${observedCheckpoint.fingerprint.stateValue}; expected ${expectedValue} for [${entry.sequence.join(", ")}].${difference}`,
                { subtype: "navigation-diverged", rejectionReason: "replay-checkpoint-diverged" },
              ),
            };
          }
        } catch (error) {
          if (context.signalAborted()) {
            recordFailure("interrupted", "interrupted", currentSnapshot);
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
            recordFailure("timeout", "duration-budget-exhausted", currentSnapshot);
            return {
              status: "stop",
              termination: incomplete(
                "max-duration",
                undefined,
                { subtype: "timeout", rejectionReason: "duration-budget-exhausted" },
              ),
            };
          }
          recordFailure("operation-failed", "replay-action-error", currentSnapshot);
          return {
            status: "stop",
            termination: incomplete(
              "driver-error",
              error instanceof Error ? error.message : String(error),
              { subtype: "operation-failed", rejectionReason: "replay-action-error" },
            ),
          };
        }
      }
    } finally {
      context.onReplayDuration(context.durationSince(replayStartedAt));
    }

    const restoredFingerprint = context.fingerprintSnapshot(currentSnapshot);
    if (restoredFingerprint.stateIdentity !== entry.state.identity) {
      recordFailure("state-not-found", "destination-state-not-found", currentSnapshot);
      return {
        status: "stop",
        termination: incomplete(
          "replay-diverged",
          `Replay completed at ${restoredFingerprint.fingerprint.stateValue}; expected ${entry.state.fingerprint.fingerprint.stateValue} for [${entry.sequence.join(", ")}]. ${snapshotDifference(entry.state.representativeSnapshot, currentSnapshot)}`,
          { subtype: "state-not-found", rejectionReason: "destination-state-not-found" },
        ),
      };
    }
    recordSuccess(currentSnapshot);
    return { status: "ok", snapshot: currentSnapshot };
  };
}
