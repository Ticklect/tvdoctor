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

interface FrontierRuntimeState {
  readonly strategy: ExplorationFrontierStrategy;
  readonly actionRank: ReadonlyMap<RemoteKey, number>;
  readonly arrayIndex: Map<QueueEntry, number>;
  fifo: QueueEntry[];
  fifoHead: number;
  readonly heap: QueueEntry[];
  syncedLength: number;
}

const RUNTIME_BY_FRONTIER = new WeakMap<QueueEntry[], FrontierRuntimeState>();

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

function compareEntries(
  left: QueueEntry,
  right: QueueEntry,
  actionRank: ReadonlyMap<RemoteKey, number>,
): number {
  const priorityDifference = left.state.frontierPriority - right.state.frontierPriority;
  if (priorityDifference !== 0) return priorityDifference;
  const depthDifference = left.sequence.length - right.sequence.length;
  if (depthDifference !== 0) return depthDifference;
  const sequenceDifference = compareSequences(left.sequence, right.sequence, actionRank);
  if (sequenceDifference !== 0) return sequenceDifference;
  return left.insertionOrder - right.insertionOrder;
}

function heapPush(
  heap: QueueEntry[],
  entry: QueueEntry,
  actionRank: ReadonlyMap<RemoteKey, number>,
): void {
  let index = heap.length;
  heap.push(entry);
  while (index > 0) {
    const parentIndex = Math.floor((index - 1) / 2);
    const parent = heap[parentIndex];
    const current = heap[index];
    if (parent === undefined || current === undefined
      || compareEntries(parent, current, actionRank) <= 0) break;
    heap[parentIndex] = current;
    heap[index] = parent;
    index = parentIndex;
  }
}

function heapPop(
  heap: QueueEntry[],
  actionRank: ReadonlyMap<RemoteKey, number>,
): QueueEntry | undefined {
  const first = heap[0];
  const last = heap.pop();
  if (first === undefined || last === undefined) return first;
  if (heap.length === 0) return first;
  heap[0] = last;
  let index = 0;
  while (true) {
    const leftIndex = index * 2 + 1;
    const rightIndex = leftIndex + 1;
    let bestIndex = index;
    const best = heap[bestIndex];
    const left = heap[leftIndex];
    const right = heap[rightIndex];
    if (best === undefined) break;
    if (left !== undefined && compareEntries(left, heap[bestIndex] ?? left, actionRank) < 0) {
      bestIndex = leftIndex;
    }
    if (right !== undefined && compareEntries(right, heap[bestIndex] ?? right, actionRank) < 0) {
      bestIndex = rightIndex;
    }
    if (bestIndex === index) break;
    const current = heap[index];
    const replacement = heap[bestIndex];
    if (current === undefined || replacement === undefined) break;
    heap[index] = replacement;
    heap[bestIndex] = current;
    index = bestIndex;
  }
  return first;
}

function addRuntimeEntry(state: FrontierRuntimeState, entry: QueueEntry): void {
  if (state.strategy === "breadth-first") state.fifo.push(entry);
  else heapPush(state.heap, entry, state.actionRank);
}

function createRuntimeState(
  frontier: QueueEntry[],
  strategy: ExplorationFrontierStrategy,
  actionRank: ReadonlyMap<RemoteKey, number>,
): FrontierRuntimeState {
  const state: FrontierRuntimeState = {
    strategy,
    actionRank,
    arrayIndex: new Map(),
    fifo: [],
    fifoHead: 0,
    heap: [],
    syncedLength: frontier.length,
  };
  for (const [index, entry] of frontier.entries()) {
    state.arrayIndex.set(entry, index);
    addRuntimeEntry(state, entry);
  }
  return state;
}

function runtimeState(
  frontier: QueueEntry[],
  strategy: ExplorationFrontierStrategy,
  actionRank: ReadonlyMap<RemoteKey, number>,
): FrontierRuntimeState {
  let state = RUNTIME_BY_FRONTIER.get(frontier);
  if (state === undefined || state.strategy !== strategy || state.actionRank !== actionRank
    || frontier.length < state.syncedLength) {
    state = createRuntimeState(frontier, strategy, actionRank);
    RUNTIME_BY_FRONTIER.set(frontier, state);
  }
  for (let index = state.syncedLength; index < frontier.length; index += 1) {
    const entry = frontier[index];
    if (entry === undefined) continue;
    state.arrayIndex.set(entry, index);
    addRuntimeEntry(state, entry);
  }
  state.syncedLength = frontier.length;
  return state;
}

function removeFromFrontier(
  frontier: QueueEntry[],
  state: FrontierRuntimeState,
  selected: QueueEntry,
): boolean {
  const selectedIndex = state.arrayIndex.get(selected);
  if (selectedIndex === undefined) return false;
  const lastIndex = frontier.length - 1;
  const last = frontier[lastIndex];
  if (selectedIndex !== lastIndex && last !== undefined) {
    frontier[selectedIndex] = last;
    state.arrayIndex.set(last, selectedIndex);
  }
  frontier.pop();
  state.arrayIndex.delete(selected);
  state.syncedLength = frontier.length;
  return true;
}

function takeBreadthFirst(
  frontier: QueueEntry[],
  state: FrontierRuntimeState,
): QueueEntry | undefined {
  while (state.fifoHead < state.fifo.length) {
    const selected = state.fifo[state.fifoHead];
    state.fifoHead += 1;
    if (selected !== undefined && removeFromFrontier(frontier, state, selected)) {
      if (state.fifoHead > 1_024 && state.fifoHead * 2 > state.fifo.length) {
        state.fifo = state.fifo.slice(state.fifoHead);
        state.fifoHead = 0;
      }
      return selected;
    }
  }
  return undefined;
}

function takePriority(
  frontier: QueueEntry[],
  state: FrontierRuntimeState,
): QueueEntry | undefined {
  while (state.heap.length > 0) {
    const selected = heapPop(state.heap, state.actionRank);
    if (selected !== undefined && removeFromFrontier(frontier, state, selected)) return selected;
  }
  return undefined;
}

export function takeFrontier(
  frontier: QueueEntry[],
  frontierStrategy: ExplorationFrontierStrategy,
  actionRank: ReadonlyMap<RemoteKey, number>,
): QueueEntry | undefined {
  const state = runtimeState(frontier, frontierStrategy, actionRank);
  return frontierStrategy === "breadth-first"
    ? takeBreadthFirst(frontier, state)
    : takePriority(frontier, state);
}
