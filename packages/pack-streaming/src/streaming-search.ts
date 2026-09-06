import type { RemoteKey, StateSnapshot, UiNodeSnapshot } from "@tvdoctor/protocol";
import {
  describeStreamingElement,
  focusedCandidate,
  focusedEntry,
  nodeMatchesStreamingDescriptor,
  rankSemanticCandidates,
  semanticStateIdentity,
  uniqueDescriptorEntry,
  type RankedSemanticCandidate,
  type StreamingSemanticTarget,
} from "./semantics.js";
import type { StreamingElementDescriptor } from "./types.js";
import type { StreamingSession } from "./streaming-runtime.js";

const DIRECTIONAL_KEYS: readonly RemoteKey[] = ["UP", "RIGHT", "DOWN", "LEFT"];

export interface SearchResult {
  readonly status: "found" | "not-found";
  readonly sequence: readonly RemoteKey[];
  readonly snapshot: StateSnapshot;
  readonly candidate: RankedSemanticCandidate | null;
  readonly complete: boolean;
  readonly reason: "complete" | "max-local-depth" | "max-local-states";
  readonly detail: string;
}

export interface ExpandedState {
  readonly path: readonly RemoteKey[];
  readonly snapshot: StateSnapshot;
  readonly focused: StreamingElementDescriptor | null;
}

export interface ExpansionResult {
  readonly states: readonly ExpandedState[];
  readonly complete: boolean;
  readonly reason: "complete" | "focus-unobservable" | "max-local-depth" | "max-local-states";
  readonly expandedStates: number;
}

export function focusDescriptor(snapshot: StateSnapshot): StreamingElementDescriptor | null {
  const entry = focusedEntry(snapshot);
  return entry === null ? null : describeStreamingElement(entry.node);
}

function targetDirectionOrder(
  snapshot: StateSnapshot,
  target: RankedSemanticCandidate | undefined,
): readonly RemoteKey[] {
  const focused = focusedEntry(snapshot)?.node.bounds;
  const desired = target?.node.bounds;
  if (focused === null || focused === undefined || desired === null || desired === undefined) {
    return DIRECTIONAL_KEYS;
  }
  const horizontal = desired.x + desired.width / 2 - (focused.x + focused.width / 2);
  const vertical = desired.y + desired.height / 2 - (focused.y + focused.height / 2);
  const primary: RemoteKey = Math.abs(horizontal) >= Math.abs(vertical)
    ? horizontal >= 0 ? "RIGHT" : "LEFT"
    : vertical >= 0 ? "DOWN" : "UP";
  return [primary, ...DIRECTIONAL_KEYS.filter((key) => key !== primary)];
}

export async function findSemanticTarget(
  session: StreamingSession,
  prefix: readonly RemoteKey[],
  target: StreamingSemanticTarget,
): Promise<SearchResult> {
  const queue: RemoteKey[][] = [[]];
  const visited = new Set<string>();
  let index = 0;
  let depthLimited = false;
  let expandedStates = 0;
  let lastSnapshot = await session.restoreAndReplay(prefix, "discovery");
  let visibleCandidate = rankSemanticCandidates(lastSnapshot, target)[0] ?? null;

  while (index < queue.length) {
    const suffix = queue[index];
    index += 1;
    if (suffix === undefined) break;
    const snapshot = suffix.length === 0
      ? lastSnapshot
      : await session.restoreAndReplay([...prefix, ...suffix], "discovery");
    lastSnapshot = snapshot;
    const rankedCandidates = rankSemanticCandidates(snapshot, target);
    visibleCandidate ??= rankedCandidates[0] ?? null;
    const identity = semanticStateIdentity(snapshot) ?? `unobservable:${String(index)}`;
    if (visited.has(identity)) continue;
    visited.add(identity);
    const focused = focusedCandidate(snapshot, target);
    if (focused !== null) {
      return {
        status: "found",
        sequence: [...prefix, ...suffix],
        snapshot,
        candidate: focused,
        complete: true,
        reason: "complete",
        detail: `A safe ${target} control was reached using semantic D-pad discovery.`,
      };
    }
    if (suffix.length >= session.budgets.maxLocalDepth) {
      depthLimited = true;
      continue;
    }
    if (expandedStates >= session.budgets.maxLocalStates) {
      return {
        status: "not-found",
        sequence: prefix,
        snapshot,
        candidate: visibleCandidate,
        complete: false,
        reason: "max-local-states",
        detail: `The ${target} search expanded exactly ${String(expandedStates)} unique states and reached its local-state budget.`,
      };
    }
    expandedStates += 1;
    const order = targetDirectionOrder(snapshot, visibleCandidate ?? undefined);
    for (const key of order) queue.push([...suffix, key]);
  }
  return {
    status: "not-found",
    sequence: prefix,
    snapshot: lastSnapshot,
    candidate: visibleCandidate,
    complete: !depthLimited,
    reason: depthLimited ? "max-local-depth" : "complete",
    detail: depthLimited
      ? `The ${target} search reached its local-depth budget.`
      : `No reachable safe ${target} control was found after bounded local expansion.`,
  };
}

export async function findExactTarget(
  session: StreamingSession,
  prefix: readonly RemoteKey[],
  descriptor: StreamingElementDescriptor,
): Promise<SearchResult> {
  const queue: RemoteKey[][] = [[]];
  const visited = new Set<string>();
  let index = 0;
  let depthLimited = false;
  let expandedStates = 0;
  let lastSnapshot = await session.restoreAndReplay(prefix, "probe");

  while (index < queue.length) {
    const suffix = queue[index];
    index += 1;
    if (suffix === undefined) break;
    const snapshot = suffix.length === 0
      ? lastSnapshot
      : await session.restoreAndReplay([...prefix, ...suffix], "probe");
    lastSnapshot = snapshot;
    const identity = semanticStateIdentity(snapshot) ?? `unobservable:${String(index)}`;
    if (visited.has(identity)) continue;
    visited.add(identity);
    const entry = uniqueDescriptorEntry(snapshot, descriptor);
    const focused = focusedEntry(snapshot);
    if (entry !== null && focused !== null && entry.node === focused.node) {
      return {
        status: "found",
        sequence: [...prefix, ...suffix],
        snapshot,
        candidate: {
          ...entry,
          score: 0,
          descriptor: describeStreamingElement(entry.node),
        },
        complete: true,
        reason: "complete",
        detail: "The exact previously observed control was restored by local D-pad discovery.",
      };
    }
    if (suffix.length >= session.budgets.maxLocalDepth) {
      depthLimited = true;
      continue;
    }
    if (expandedStates >= session.budgets.maxLocalStates) {
      return {
        status: "not-found",
        sequence: prefix,
        snapshot,
        candidate: null,
        complete: false,
        reason: "max-local-states",
        detail: `Exact-control restoration expanded exactly ${String(expandedStates)} unique states and reached its local-state budget.`,
      };
    }
    expandedStates += 1;
    for (const key of DIRECTIONAL_KEYS) queue.push([...suffix, key]);
  }
  return {
    status: "not-found",
    sequence: prefix,
    snapshot: lastSnapshot,
    candidate: null,
    complete: !depthLimited,
    reason: depthLimited ? "max-local-depth" : "complete",
    detail: depthLimited
      ? "Exact-control restoration reached its local-depth budget."
      : "The exact previously observed control was not remotely reachable.",
  };
}

export async function expandSurface(
  session: StreamingSession,
  prefix: readonly RemoteKey[],
): Promise<ExpansionResult> {
  const queue: RemoteKey[][] = [[]];
  const visited = new Set<string>();
  const states: ExpandedState[] = [];
  let index = 0;
  let depthLimited = false;
  let expandedStates = 0;

  while (index < queue.length) {
    const suffix = queue[index];
    index += 1;
    if (suffix === undefined) break;
    const snapshot = await session.restoreAndReplay([...prefix, ...suffix], "discovery");
    const identity = semanticStateIdentity(snapshot) ?? `unobservable:${String(index)}`;
    if (visited.has(identity)) continue;
    visited.add(identity);
    const focused = focusDescriptor(snapshot);
    states.push({
      path: [...prefix, ...suffix],
      snapshot,
      focused,
    });
    if (focused === null) {
      return { states, complete: false, reason: "focus-unobservable", expandedStates };
    }
    if (suffix.length >= session.budgets.maxLocalDepth) {
      depthLimited = true;
      continue;
    }
    if (expandedStates >= session.budgets.maxLocalStates) {
      return { states, complete: false, reason: "max-local-states", expandedStates };
    }
    expandedStates += 1;
    for (const key of DIRECTIONAL_KEYS) queue.push([...suffix, key]);
  }
  return {
    states,
    complete: !depthLimited,
    reason: depthLimited ? "max-local-depth" : "complete",
    expandedStates,
  };
}

export function nodeMatchesDescriptor(node: UiNodeSnapshot, descriptor: StreamingElementDescriptor): boolean {
  return nodeMatchesStreamingDescriptor(node, descriptor);
}

export function descriptorFromSnapshot(
  snapshot: StateSnapshot,
  descriptor: StreamingElementDescriptor,
): StreamingElementDescriptor | null {
  const entry = uniqueDescriptorEntry(snapshot, descriptor);
  return entry === null ? null : describeStreamingElement(entry.node);
}
