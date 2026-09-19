import type { RemoteKey } from "@tvdoctor/protocol";

import type { ExplorationFrontierStrategy, ExplorationTermination } from "./explorer-contracts.js";
import type { InternalFocusState, RepetitionGroup } from "./explorer-state.js";

export interface QueueEntry {
  readonly state: InternalFocusState;
  readonly sequence: readonly RemoteKey[];
  /** Exact semantic state expected after each corresponding replay action. */
  readonly checkpoints: readonly string[];
  readonly insertionOrder: number;
  /** Already-selected sibling actions still awaiting expansion for this state. */
  readonly remainingActions?: readonly RemoteKey[];
}

export function scheduleDestinationFrontier(input: {
  readonly frontier: QueueEntry[];
  readonly state: InternalFocusState;
  readonly sequence: readonly RemoteKey[];
  readonly checkpoints: readonly string[];
  readonly insertionOrder: number;
  readonly repetitionGroup: RepetitionGroup | undefined;
  readonly maxExpandedRepresentativesPerGroup: number;
  readonly markDeferred: (stateIdentity: string) => void;
}): { readonly insertionOrder: number; readonly queueSize: number } {
  if (input.state.scheduled) {
    return { insertionOrder: input.insertionOrder, queueSize: input.frontier.length };
  }
  if (input.repetitionGroup !== undefined
    && input.repetitionGroup.expandedRepresentatives >= input.maxExpandedRepresentativesPerGroup) {
    input.markDeferred(input.state.identity);
    return { insertionOrder: input.insertionOrder, queueSize: input.frontier.length };
  }
  input.state.scheduled = true;
  if (input.repetitionGroup !== undefined) input.repetitionGroup.expandedRepresentatives += 1;
  input.frontier.push({
    state: input.state,
    sequence: input.sequence,
    checkpoints: input.checkpoints,
    insertionOrder: input.insertionOrder,
  });
  return { insertionOrder: input.insertionOrder + 1, queueSize: input.frontier.length };
}

export function scheduleFrontierContinuation(input: {
  readonly frontier: QueueEntry[];
  readonly entry: QueueEntry;
  readonly stateActionOrder: readonly RemoteKey[];
  readonly stateActionIndex: number;
  readonly insertionOrder: number;
  readonly restorationEnabled: boolean;
  readonly replayable: boolean;
  readonly expandable: boolean;
  readonly observedIdentity: string;
}): {
  readonly remainingActions: readonly RemoteKey[];
  readonly yieldToLiveDestination: boolean;
  readonly insertionOrder: number;
  readonly queueSize: number;
} {
  const remainingActions = input.stateActionOrder.slice(input.stateActionIndex + 1);
  const yieldToLiveDestination = input.restorationEnabled
    && remainingActions.length >= 2
    && input.replayable
    && input.expandable
    && input.observedIdentity !== input.entry.state.identity
    && input.frontier.some((candidate) => candidate.state.identity === input.observedIdentity);
  if (!yieldToLiveDestination) {
    return {
      remainingActions,
      yieldToLiveDestination: false,
      insertionOrder: input.insertionOrder,
      queueSize: input.frontier.length,
    };
  }
  input.frontier.push({
    state: input.entry.state,
    sequence: input.entry.sequence,
    checkpoints: input.entry.checkpoints,
    insertionOrder: input.insertionOrder,
    remainingActions,
  });
  return {
    remainingActions,
    yieldToLiveDestination: true,
    insertionOrder: input.insertionOrder + 1,
    queueSize: input.frontier.length,
  };
}

export function remainingFrontierCandidateActions(
  frontier: readonly QueueEntry[],
  maxDepth: number,
  defaultActionCount: number,
): number {
  return frontier.reduce((total, entry) => (
    entry.sequence.length >= maxDepth
      ? total
      : total + (entry.remainingActions?.length ?? defaultActionCount)
  ), 0);
}

export function annotateFrontierTermination(
  termination: ExplorationTermination,
  frontier: readonly QueueEntry[],
  maxDepth: number,
  defaultActionCount: number,
): ExplorationTermination {
  const safetyLimited = termination.reason === "max-actions"
    || termination.reason === "max-states"
    || termination.reason === "max-depth"
    || termination.reason === "max-duration";
  if (!safetyLimited || frontier.length === 0) return termination;
  return {
    ...termination,
    remainingFrontierEntries: frontier.length,
    remainingCandidateActions: remainingFrontierCandidateActions(
      frontier, maxDepth, defaultActionCount,
    ),
    detail: `Bounded-incomplete: ${String(frontier.length)} frontier entries remain after ${termination.reason}.`,
  };
}

export function takePreferredFrontierWithCount(
  frontier: QueueEntry[],
  frontierStrategy: ExplorationFrontierStrategy,
  actionRank: ReadonlyMap<RemoteKey, number>,
  preferredIdentity: string | null,
): { readonly entry: QueueEntry | undefined; readonly pendingStates: number } {
  return {
    entry: takePreferredFrontier(frontier, frontierStrategy, actionRank, preferredIdentity),
    pendingStates: frontier.length,
  };
}

function compareSequences(
  left: readonly RemoteKey[],
  right: readonly RemoteKey[],
  actionRank: ReadonlyMap<RemoteKey, number>,
): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftKey = left[index];
    const rightKey = right[index];
    if (leftKey === undefined || rightKey === undefined) break;
    const difference = (actionRank.get(leftKey) ?? Number.MAX_SAFE_INTEGER)
      - (actionRank.get(rightKey) ?? Number.MAX_SAFE_INTEGER);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

export function takeFrontier(
  frontier: QueueEntry[],
  frontierStrategy: ExplorationFrontierStrategy,
  actionRank: ReadonlyMap<RemoteKey, number>,
): QueueEntry | undefined {
  if (frontierStrategy === "breadth-first") return frontier.shift();
  let bestIndex = 0;
  for (let index = 1; index < frontier.length; index += 1) {
    const candidate = frontier[index];
    const best = frontier[bestIndex];
    if (candidate === undefined || best === undefined) continue;
    const priorityDifference = candidate.state.frontierPriority - best.state.frontierPriority;
    const depthDifference = candidate.sequence.length - best.sequence.length;
    const sequenceDifference = compareSequences(candidate.sequence, best.sequence, actionRank);
    if (priorityDifference < 0
      || (priorityDifference === 0 && depthDifference < 0)
      || (priorityDifference === 0 && depthDifference === 0 && sequenceDifference < 0)
      || (priorityDifference === 0
        && depthDifference === 0
        && sequenceDifference === 0
        && candidate.insertionOrder < best.insertionOrder)) {
      bestIndex = index;
    }
  }
  return frontier.splice(bestIndex, 1)[0];
}

export function takePreferredFrontier(
  frontier: QueueEntry[],
  frontierStrategy: ExplorationFrontierStrategy,
  actionRank: ReadonlyMap<RemoteKey, number>,
  preferredIdentity: string | null,
): QueueEntry | undefined {
  if (preferredIdentity !== null) {
    const preferredIndex = frontier.findIndex((entry) => entry.state.identity === preferredIdentity);
    if (preferredIndex >= 0) return frontier.splice(preferredIndex, 1)[0];
  }
  return takeFrontier(frontier, frontierStrategy, actionRank);
}
