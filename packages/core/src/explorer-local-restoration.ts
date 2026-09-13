import type { RemoteKey, StateSnapshot, TVDoctorDriver } from "@tvdoctor/protocol";

import {
  pressAndObserve,
  type NormalisedActionSettlingOptions,
} from "./action-settling.js";
import type { ExplorationTermination } from "./explorer-contracts.js";
import type { QueueEntry } from "./explorer-frontier.js";
import {
  DurationBudgetExceeded,
  incomplete,
  type RestoreResult,
} from "./explorer-restoration.js";
import type { ComputedSnapshotFingerprint } from "./fingerprint.js";
import {
  findShortestVerifiedPath,
  type VerifiedStateEdge,
} from "./verified-path.js";

interface VerifiedLocalRestorerContext {
  readonly enabled: boolean;
  readonly actionOrder: readonly RemoteKey[];
  readonly initialSnapshot: StateSnapshot;
  readonly initialIdentity: string;
  readonly measuredDriver: TVDoctorDriver;
  readonly settling: NormalisedActionSettlingOptions;
  readonly rootRestore: (entry: QueueEntry) => Promise<RestoreResult>;
  readonly workBudgetTermination: () => ExplorationTermination | null;
  readonly withinDurationBudget: <T>(operation: (signal: AbortSignal) => Promise<T>) => Promise<T>;
  readonly signalAborted: () => boolean;
  readonly fingerprintSnapshot: (snapshot: StateSnapshot) => ComputedSnapshotFingerprint;
  readonly monotonicNow: () => number;
  readonly durationSince: (startedAt: number) => number;
  readonly onReplayAction: () => void;
  readonly onSettlingObservation: (snapshotsObserved: number, settled: boolean) => void;
  readonly onReplayDuration: (durationMs: number) => void;
  readonly onStateReuse: () => void;
  readonly onPathRestoration: () => void;
  readonly onFallback: () => void;
}

export interface VerifiedLocalRestorer {
  readonly restore: (entry: QueueEntry) => Promise<RestoreResult>;
  readonly clearLive: () => void;
  readonly observeLive: (snapshot: StateSnapshot, identity: string) => void;
  readonly recordEdge: (edge: VerifiedStateEdge) => void;
}

export function createVerifiedLocalRestorer(
  context: VerifiedLocalRestorerContext,
): VerifiedLocalRestorer {
  let trustedLiveSnapshot: StateSnapshot | null = context.initialSnapshot;
  let trustedLiveIdentity: string | null = context.initialIdentity;
  const verifiedEdges: VerifiedStateEdge[] = [];
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
    if (!context.enabled || !edge.expandable) return;
    const key = `${edge.fromIdentity}\u001f${edge.key}\u001f${edge.toIdentity}`;
    if (verifiedEdgeKeys.has(key)) return;
    verifiedEdgeKeys.add(key);
    verifiedEdges.push(edge);
  };

  const restore = async (entry: QueueEntry): Promise<RestoreResult> => {
    if (!context.enabled) return await context.rootRestore(entry);
    if (trustedLiveSnapshot !== null && trustedLiveIdentity === entry.state.identity) {
      context.onStateReuse();
      return { status: "ok", snapshot: trustedLiveSnapshot };
    }

    if (trustedLiveIdentity !== null) {
      const localPath = findShortestVerifiedPath(
        verifiedEdges,
        trustedLiveIdentity,
        entry.state.identity,
        context.actionOrder,
      );
      if (localPath !== null && localPath.length > 0) {
        const startedAt = context.monotonicNow();
        let localFailure = false;
        try {
          for (const edge of localPath) {
            const budgetTermination = context.workBudgetTermination();
            if (budgetTermination !== null) {
              clearLive();
              return { status: "stop", termination: budgetTermination };
            }
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
                clearLive();
                return { status: "stop", termination: incomplete("interrupted") };
              }
              if (error instanceof DurationBudgetExceeded) {
                clearLive();
                return { status: "stop", termination: incomplete("max-duration") };
              }
              localFailure = true;
              break;
            }
            context.onSettlingObservation(observation.snapshotsObserved, observation.settled);
            if (!observation.settled
              || observation.actionResult.key !== edge.key
              || observation.actionResult.outcome !== "applied") {
              localFailure = true;
              break;
            }
            const observed = context.fingerprintSnapshot(observation.snapshot);
            observeLive(observation.snapshot, observed.stateIdentity);
            if (observed.stateIdentity !== edge.toIdentity) {
              localFailure = true;
              break;
            }
          }
        } finally {
          context.onReplayDuration(context.durationSince(startedAt));
        }
        if (!localFailure
          && trustedLiveSnapshot !== null
          && trustedLiveIdentity === entry.state.identity) {
          context.onPathRestoration();
          return { status: "ok", snapshot: trustedLiveSnapshot };
        }
        clearLive();
        context.onFallback();
      }
    }

    const result = await context.rootRestore(entry);
    if (result.status === "ok") {
      const fingerprint = context.fingerprintSnapshot(result.snapshot);
      observeLive(result.snapshot, fingerprint.stateIdentity);
    } else {
      clearLive();
    }
    return result;
  };

  return { restore, clearLive, observeLive, recordEdge };
}
