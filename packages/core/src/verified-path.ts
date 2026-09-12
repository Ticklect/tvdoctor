import type { RemoteKey } from "@tvdoctor/protocol";

export interface VerifiedStateEdge {
  readonly fromIdentity: string;
  readonly key: RemoteKey;
  readonly toIdentity: string;
  readonly expandable: boolean;
}

/**
 * Finds the shortest path composed only of previously observed exact state
 * transitions. The configured action order is the deterministic tie-breaker.
 */
export function findShortestVerifiedPath(
  edges: readonly VerifiedStateEdge[],
  fromIdentity: string,
  toIdentity: string,
  actionOrder: readonly RemoteKey[],
): readonly VerifiedStateEdge[] | null {
  if (fromIdentity === toIdentity) return [];
  const actionRank = new Map(actionOrder.map((key, index) => [key, index]));
  const adjacency = new Map<string, VerifiedStateEdge[]>();
  for (const edge of edges) {
    if (!edge.expandable) continue;
    const outgoing = adjacency.get(edge.fromIdentity) ?? [];
    outgoing.push(edge);
    adjacency.set(edge.fromIdentity, outgoing);
  }
  for (const outgoing of adjacency.values()) {
    outgoing.sort((left, right) => (
      (actionRank.get(left.key) ?? Number.MAX_SAFE_INTEGER)
        - (actionRank.get(right.key) ?? Number.MAX_SAFE_INTEGER)
      || left.toIdentity.localeCompare(right.toIdentity)
    ));
  }

  const queue: { readonly identity: string; readonly path: readonly VerifiedStateEdge[] }[] = [{
    identity: fromIdentity,
    path: [],
  }];
  const visited = new Set<string>([fromIdentity]);
  let head = 0;
  while (head < queue.length) {
    const current = queue[head];
    head += 1;
    if (current === undefined) break;
    for (const edge of adjacency.get(current.identity) ?? []) {
      if (visited.has(edge.toIdentity)) continue;
      const path = [...current.path, edge];
      if (edge.toIdentity === toIdentity) return path;
      visited.add(edge.toIdentity);
      queue.push({ identity: edge.toIdentity, path });
    }
  }
  return null;
}
