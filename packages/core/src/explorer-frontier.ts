import type { RemoteKey } from "@tvdoctor/protocol";

import type { ExplorationFrontierStrategy } from "./explorer-contracts.js";
import type { InternalFocusState } from "./explorer-state.js";

export interface QueueEntry {
  readonly state: InternalFocusState;
  readonly sequence: readonly RemoteKey[];
  /** Exact semantic state expected after each corresponding replay action. */
  readonly checkpoints: readonly string[];
  readonly insertionOrder: number;
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
