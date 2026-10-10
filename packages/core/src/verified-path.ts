import type { RemoteKey } from "@tvdoctor/protocol";

export interface VerifiedStateEdge {
  readonly fromIdentity: string;
  readonly toIdentity: string;
  readonly key: RemoteKey;
  readonly expandable: boolean;
}

/**
 * Verified local edges are discovered monotonically. Maintain outgoing edges
 * in the exact order used by the original shortest-path search, so repeated
 * queries do not rebuild and sort the entire discovered graph.
 *
 * This index owns only search metadata. It never bypasses live observations,
 * replay checkpoints, destination verification or restoration budgets.
 */
export class IncrementalVerifiedPathIndex {
  readonly #outgoing = new Map<string, VerifiedStateEdge[]>();
  readonly #actionRank: ReadonlyMap<RemoteKey, number>;

  constructor(actionOrder: readonly RemoteKey[]) {
    this.#actionRank = new Map(actionOrder.map((key, index) => [key, index]));
  }

  add(edge: VerifiedStateEdge): void {
    if (!edge.expandable) return;
    const list = this.#outgoing.get(edge.fromIdentity);
    if (list === undefined) {
      this.#outgoing.set(edge.fromIdentity, [edge]);
      return;
    }
    // Insert after equal elements, matching Array.sort's stable tie ordering.
    let lower = 0;
    let upper = list.length;
    while (lower < upper) {
      const middle = (lower + upper) >>> 1;
      const candidate = list[middle];
      if (candidate !== undefined && compareEdges(candidate, edge, this.#actionRank) <= 0) {
        lower = middle + 1;
      } else {
        upper = middle;
      }
    }
    list.splice(lower, 0, edge);
  }

  find(fromIdentity: string, toIdentity: string): readonly VerifiedStateEdge[] | null {
    return findPathInSortedAdjacency(this.#outgoing, fromIdentity, toIdentity);
  }
}

function compareEdges(
  left: VerifiedStateEdge,
  right: VerifiedStateEdge,
  actionRank: ReadonlyMap<RemoteKey, number>,
): number {
  const actionDifference = (actionRank.get(left.key) ?? Number.MAX_SAFE_INTEGER)
    - (actionRank.get(right.key) ?? Number.MAX_SAFE_INTEGER);
  if (actionDifference !== 0) return actionDifference;
  const destinationDifference = left.toIdentity === right.toIdentity
    ? 0
    : left.toIdentity < right.toIdentity ? -1 : 1;
  if (destinationDifference !== 0) return destinationDifference;
  return left.fromIdentity === right.fromIdentity
    ? 0
    : left.fromIdentity < right.fromIdentity ? -1 : 1;
}

/**
 * Finds one deterministic shortest path through previously verified expandable
 * transitions. The BFS retains only one predecessor per identity, so cyclic
 * graphs remain bounded by the number of known identities rather than paths.
 */
export function findShortestVerifiedPath(
  edges: readonly VerifiedStateEdge[],
  fromIdentity: string,
  toIdentity: string,
  actionOrder: readonly RemoteKey[],
): readonly VerifiedStateEdge[] | null {
  if (fromIdentity === toIdentity) return [];

  const actionRank = new Map(actionOrder.map((key, index) => [key, index]));
  const outgoing = new Map<string, VerifiedStateEdge[]>();
  for (const edge of edges) {
    if (!edge.expandable) continue;
    const list = outgoing.get(edge.fromIdentity) ?? [];
    list.push(edge);
    outgoing.set(edge.fromIdentity, list);
  }
  for (const list of outgoing.values()) list.sort((left, right) => compareEdges(left, right, actionRank));

  return findPathInSortedAdjacency(outgoing, fromIdentity, toIdentity);
}

function findPathInSortedAdjacency(
  outgoing: ReadonlyMap<string, readonly VerifiedStateEdge[]>,
  fromIdentity: string,
  toIdentity: string,
): readonly VerifiedStateEdge[] | null {
  if (fromIdentity === toIdentity) return [];
  const queue = [fromIdentity];
  const visited = new Set([fromIdentity]);
  const predecessor = new Map<string, VerifiedStateEdge>();
  let cursor = 0;
  while (cursor < queue.length) {
    const current = queue[cursor];
    cursor += 1;
    if (current === undefined) break;
    for (const edge of outgoing.get(current) ?? []) {
      if (visited.has(edge.toIdentity)) continue;
      visited.add(edge.toIdentity);
      predecessor.set(edge.toIdentity, edge);
      if (edge.toIdentity === toIdentity) {
        const path: VerifiedStateEdge[] = [];
        let identity = toIdentity;
        while (identity !== fromIdentity) {
          const step = predecessor.get(identity);
          if (step === undefined) return null;
          path.push(step);
          identity = step.fromIdentity;
        }
        return path.reverse();
      }
      queue.push(edge.toIdentity);
    }
  }
  return null;
}
