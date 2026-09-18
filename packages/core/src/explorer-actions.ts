import type { RemoteKey, StateSnapshot, TVDoctorDriver } from "@tvdoctor/protocol";

import {
  pressAndObserve,
  type NormalisedActionSettlingOptions,
  type SettledActionObservation,
} from "./action-settling.js";
import type {
  ExplorationActionContext,
  ExplorationObservedActionContext,
  ExplorationTermination,
} from "./explorer-contracts.js";
import type { QueueEntry } from "./explorer-frontier.js";
import {
  DurationBudgetExceeded,
  incomplete,
} from "./explorer-restoration.js";

type DurationBudgetRunner = <T>(
  operation: (signal: AbortSignal) => Promise<T>,
) => Promise<T>;

export interface ExplorerActionHooksInput {
  readonly actionOrder: readonly RemoteKey[];
  readonly actionsForState: ((
    context: ExplorationActionContext,
  ) => readonly RemoteKey[] | Promise<readonly RemoteKey[]>) | undefined;
  readonly onActionObserved: ((
    context: ExplorationObservedActionContext,
  ) => void | Promise<void>) | undefined;
  readonly withinDurationBudget: DurationBudgetRunner;
}

export interface ExplorerActionHooks {
  readonly actionsForState: (
    entry: QueueEntry,
    signalAborted: () => boolean,
  ) => Promise<ExplorerStateActionResult>;
  readonly onActionObserved: (
    entry: QueueEntry,
    key: RemoteKey,
    beforeSnapshot: StateSnapshot,
    afterSnapshot: StateSnapshot,
    signalAborted: () => boolean,
  ) => Promise<ExplorationTermination | null>;
}

export type ExplorerStateActionResult =
  | { readonly status: "selected"; readonly actions: readonly RemoteKey[] }
  | { readonly status: "stop"; readonly termination: ExplorationTermination };

export type ExplorerActionExecutionResult =
  | { readonly status: "observed"; readonly observation: SettledActionObservation }
  | { readonly status: "unsettled" }
  | { readonly status: "stop"; readonly termination: ExplorationTermination };

export interface ExplorerActionExecutionInput {
  readonly driver: TVDoctorDriver;
  readonly key: RemoteKey;
  readonly settling: NormalisedActionSettlingOptions;
  readonly allowUnsettledActions: boolean;
  readonly withinDurationBudget: DurationBudgetRunner;
  readonly signalAborted: () => boolean;
  readonly clearLiveState: () => void;
  readonly onSettlingObservation: (snapshotsObserved: number, settled: boolean) => void;
}

function hookFailure(error: unknown, signalAborted: () => boolean): ExplorationTermination {
  if (signalAborted()) return incomplete("interrupted");
  if (error instanceof DurationBudgetExceeded) return incomplete("max-duration");
  return incomplete(
    "driver-error",
    (error instanceof Error ? error.message : String(error)).slice(0, 512),
  );
}

export function createExplorerActionHooks(input: ExplorerActionHooksInput): ExplorerActionHooks {
  const configured = new Set<RemoteKey>(input.actionOrder);
  return {
    actionsForState: async (entry, signalAborted) => {
      try {
        const selected = input.actionsForState === undefined
          ? input.actionOrder
          : await input.withinDurationBudget(() => Promise.resolve(input.actionsForState?.({
            screenStateId: entry.state.screenStateId,
            focusStateId: entry.state.id,
            snapshot: entry.state.representativeSnapshot,
            defaultActions: input.actionOrder,
          }) ?? []));
        if (!Array.isArray(selected)) {
          throw new TypeError("actionsForState must return an array of configured actions.");
        }
        if (selected.some((key) => !configured.has(key)) || new Set(selected).size !== selected.length) {
          throw new TypeError("actionsForState must return a duplicate-free subset of configured actions.");
        }
        return { status: "selected", actions: [...selected] };
      } catch (error) {
        return { status: "stop", termination: hookFailure(error, signalAborted) };
      }
    },
    onActionObserved: async (entry, key, beforeSnapshot, afterSnapshot, signalAborted) => {
      if (input.onActionObserved === undefined) return null;
      try {
        await input.withinDurationBudget(() => Promise.resolve(input.onActionObserved?.({
          screenStateId: entry.state.screenStateId,
          focusStateId: entry.state.id,
          key,
          beforeSnapshot,
          afterSnapshot,
        })));
        return null;
      } catch (error) {
        return hookFailure(error, signalAborted);
      }
    },
  };
}

export async function executeExplorerAction(
  input: ExplorerActionExecutionInput,
): Promise<ExplorerActionExecutionResult> {
  let observation: SettledActionObservation;
  try {
    observation = await input.withinDurationBudget((signal) => pressAndObserve(input.driver, input.key, {
      ...input.settling,
      allowUnsettledActions: input.allowUnsettledActions,
      signal,
    }));
    input.onSettlingObservation(observation.snapshotsObserved, observation.settled);
  } catch (error) {
    input.clearLiveState();
    if (input.signalAborted()) return { status: "stop", termination: incomplete("interrupted") };
    if (error instanceof DurationBudgetExceeded) {
      return { status: "stop", termination: incomplete("max-duration") };
    }
    return {
      status: "stop",
      termination: incomplete("driver-error", error instanceof Error ? error.message : String(error)),
    };
  }
  if (!observation.settled) {
    input.clearLiveState();
    return input.allowUnsettledActions
      ? { status: "unsettled" }
      : { status: "stop", termination: incomplete("settling-exhausted") };
  }
  return { status: "observed", observation };
}
