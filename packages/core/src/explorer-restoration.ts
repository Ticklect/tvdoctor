import type { StateSnapshot, TVDoctorDriver } from "@tvdoctor/protocol";

import {
  pressAndObserve,
  type NormalisedActionSettlingOptions,
} from "./action-settling.js";
import { PreparedStateDivergenceError } from "./errors.js";
import type {
  ExplorationTermination,
  ExplorationTerminationReason,
} from "./explorer-contracts.js";
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

export type RestoreResult = RestoreSuccess | RestoreStop;

export class DurationBudgetExceeded extends Error {
  constructor() {
    super("The exploration duration budget was exhausted during a driver call.");
    this.name = "DurationBudgetExceeded";
  }
}

export function incomplete(
  reason: Exclude<ExplorationTerminationReason, "queue-exhausted">,
  detail?: string,
): ExplorationTermination {
  return {
    reason,
    complete: false,
    ...(detail === undefined ? {} : { detail: detail.replace(/\s+/gu, " ").slice(0, 500) }),
  };
}

interface ExplorerRestorationContext {
  readonly restoreAndCapture: () => Promise<StateSnapshot>;
  readonly withinDurationBudget: <T>(operation: () => Promise<T>) => Promise<T>;
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
}

export function createExplorerRestorer(
  context: ExplorerRestorationContext,
): (entry: QueueEntry) => Promise<RestoreResult> {
  return async (entry: QueueEntry): Promise<RestoreResult> => {
    let resetSnapshot: StateSnapshot;
    context.onRestorationStart(entry.sequence.length);
    const resetStartedAt = context.monotonicNow();
    try {
      resetSnapshot = await context.withinDurationBudget(context.restoreAndCapture);
    } catch (error) {
      if (context.signalAborted()) {
        return { status: "stop", termination: incomplete("interrupted") };
      }
      if (error instanceof DurationBudgetExceeded) {
        return { status: "stop", termination: incomplete("max-duration") };
      }
      if (error instanceof PreparedStateDivergenceError) {
        return { status: "stop", termination: incomplete("prepared-state-diverged") };
      }
      return {
        status: "stop",
        termination: incomplete(
          "restoration-failed",
          error instanceof Error ? error.message : String(error),
        ),
      };
    } finally {
      context.onResetDuration(context.durationSince(resetStartedAt));
    }
    const resetFingerprint = context.fingerprintSnapshot(resetSnapshot);
    if (resetFingerprint.stateIdentity !== context.initialFingerprint.stateIdentity) {
      return {
        status: "stop",
        termination: incomplete(
          "replay-diverged",
          `Root restoration produced ${resetFingerprint.fingerprint.stateValue}; expected ${context.initialFingerprint.fingerprint.stateValue} before replaying [${entry.sequence.join(", ")}]. ${snapshotDifference(context.initialSnapshot, resetSnapshot)}`,
        ),
      };
    }

    let currentSnapshot = resetSnapshot;
    const replayStartedAt = context.monotonicNow();
    try {
      for (const [index, key] of entry.sequence.entries()) {
        const budgetTermination = context.workBudgetTermination();
        if (budgetTermination !== null) return { status: "stop", termination: budgetTermination };
        context.onReplayAction();
        try {
          const observation = await context.withinDurationBudget(
            () => pressAndObserve(context.measuredDriver, key, context.settling),
          );
          context.onSettlingObservation(observation.snapshotsObserved, observation.settled);
          if (!observation.settled) {
            return { status: "stop", termination: incomplete("settling-exhausted") };
          }
          currentSnapshot = observation.snapshot;
          if (observation.actionResult.key !== key || observation.actionResult.outcome !== "applied") {
            return {
              status: "stop",
              termination: incomplete(
                "replay-diverged",
                `Replay action ${String(index + 1)}/${String(entry.sequence.length)} (${key}) returned ${observation.actionResult.key}/${observation.actionResult.outcome} for [${entry.sequence.join(", ")}].`,
              ),
            };
          }
          const expectedCheckpoint = entry.checkpoints[index];
          const observedCheckpoint = context.fingerprintSnapshot(currentSnapshot);
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
            return {
              status: "stop",
              termination: incomplete(
                "replay-diverged",
                `Replay checkpoint ${String(index + 1)}/${String(entry.sequence.length)} after ${key} produced ${observedCheckpoint.fingerprint.stateValue}; expected ${expectedValue} for [${entry.sequence.join(", ")}].${difference}`,
              ),
            };
          }
        } catch (error) {
          if (context.signalAborted()) {
            return { status: "stop", termination: incomplete("interrupted") };
          }
          if (error instanceof DurationBudgetExceeded) {
            return { status: "stop", termination: incomplete("max-duration") };
          }
          return {
            status: "stop",
            termination: incomplete(
              "driver-error",
              error instanceof Error ? error.message : String(error),
            ),
          };
        }
      }
    } finally {
      context.onReplayDuration(context.durationSince(replayStartedAt));
    }

    const restoredFingerprint = context.fingerprintSnapshot(currentSnapshot);
    if (restoredFingerprint.stateIdentity !== entry.state.identity) {
      return {
        status: "stop",
        termination: incomplete(
          "replay-diverged",
          `Replay completed at ${restoredFingerprint.fingerprint.stateValue}; expected ${entry.state.fingerprint.fingerprint.stateValue} for [${entry.sequence.join(", ")}]. ${snapshotDifference(entry.state.representativeSnapshot, currentSnapshot)}`,
        ),
      };
    }
    return { status: "ok", snapshot: currentSnapshot };
  };
}
