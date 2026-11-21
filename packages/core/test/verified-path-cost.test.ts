import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";

import {
  findShortestVerifiedPath,
  IncrementalVerifiedPathIndex,
  type VerifiedStateEdge,
} from "../src/verified-path.js";

const SIZE = 540;
const ACTION_ORDER = ["UP", "DOWN", "LEFT", "RIGHT", "SELECT"] as const;

function identity(index: number): string {
  return `view-${String(index).padStart(4, "0")}`;
}

function generatedEdges(index: number): VerifiedStateEdge[] {
  return [
    { fromIdentity: identity(index), toIdentity: identity((index + SIZE - 1) % SIZE), key: "UP", expandable: true },
    { fromIdentity: identity(index), toIdentity: identity((index + 1) % SIZE), key: "DOWN", expandable: true },
    { fromIdentity: identity(index), toIdentity: identity((index + SIZE - 7) % SIZE), key: "LEFT", expandable: true },
    { fromIdentity: identity(index), toIdentity: identity((index + 23) % SIZE), key: "RIGHT", expandable: true },
    { fromIdentity: identity(index), toIdentity: identity((index + 47) % SIZE), key: "SELECT", expandable: false },
  ];
}

function request(index: number): readonly [string, string] {
  return [identity((index * 13 + 53) % SIZE), identity((index * 37 + 211) % SIZE)];
}

function profileRebuiltAdjacency(): { readonly stableMs: number; readonly growthMs: number; readonly checksum: number } {
  const allEdges = Array.from({ length: SIZE }, (_, index) => generatedEdges(index)).flat();
  let checksum = 0;
  const stableStarted = performance.now();
  for (let index = 0; index < SIZE; index += 1) {
    const [source, destination] = request(index);
    const path = findShortestVerifiedPath(allEdges, source, destination, ACTION_ORDER);
    checksum += path?.length ?? 0;
  }
  const stableMs = performance.now() - stableStarted;

  const growingEdges: VerifiedStateEdge[] = [];
  const growthStarted = performance.now();
  for (let index = 0; index < SIZE; index += 1) {
    growingEdges.push(...generatedEdges(index));
    const [source, destination] = request(index);
    const path = findShortestVerifiedPath(growingEdges, source, destination, ACTION_ORDER);
    checksum += path?.length ?? 0;
  }
  return { stableMs, growthMs: performance.now() - growthStarted, checksum };
}

function profileIndexedAdjacency(): { readonly stableMs: number; readonly growthMs: number; readonly checksum: number } {
  const allEdges = Array.from({ length: SIZE }, (_, index) => generatedEdges(index)).flat();
  const stableIndex = new IncrementalVerifiedPathIndex(ACTION_ORDER);
  for (const edge of allEdges) stableIndex.add(edge);
  let checksum = 0;
  const stableStarted = performance.now();
  for (let index = 0; index < SIZE; index += 1) {
    const [source, destination] = request(index);
    const path = stableIndex.find(source, destination);
    checksum += path?.length ?? 0;
  }
  const stableMs = performance.now() - stableStarted;

  const growingIndex = new IncrementalVerifiedPathIndex(ACTION_ORDER);
  const growthStarted = performance.now();
  for (let index = 0; index < SIZE; index += 1) {
    for (const edge of generatedEdges(index)) growingIndex.add(edge);
    const [source, destination] = request(index);
    const path = growingIndex.find(source, destination);
    checksum += path?.length ?? 0;
  }
  return { stableMs, growthMs: performance.now() - growthStarted, checksum };
}

describe("540-state verified path search profiling", () => {
  it("matches the old shortest-path algorithm at every graph-growth checkpoint", () => {
    const indexed = new IncrementalVerifiedPathIndex(ACTION_ORDER);
    const allEdges: VerifiedStateEdge[] = [];
    for (let index = 0; index < SIZE; index += 1) {
      for (const edge of generatedEdges(index)) {
        allEdges.push(edge);
        indexed.add(edge);
      }
      const sourceAndTarget = [request(index), request(index + 113), request(index + 271)] as const;
      for (const [source, destination] of sourceAndTarget) {
        expect(indexed.find(source, destination)).toEqual(
          findShortestVerifiedPath(allEdges, source, destination, ACTION_ORDER),
        );
      }
      expect(indexed.find(identity(index), identity(index))).toEqual([]);
      expect(indexed.find("missing", identity(index))).toBeNull();
    }
  });

  it("profiles rebuilding vs incremental adjacency without using clock time as correctness", () => {
    // Alternate baseline/candidate order to avoid systematically granting the
    // candidate the hotter JIT and caches; no timing threshold is asserted.
    const timings = Array.from({ length: 5 }, (_, iteration) => {
      if (iteration % 2 === 0) {
        return { baseline: profileRebuiltAdjacency(), indexed: profileIndexedAdjacency() };
      }
      const indexed = profileIndexedAdjacency();
      return { baseline: profileRebuiltAdjacency(), indexed };
    });
    expect(new Set(timings.flatMap((item) => [item.baseline.checksum, item.indexed.checksum])).size).toBe(1);
    const median = (items: number[]) => items.sort((a, b) => a - b)[Math.floor(items.length / 2)] ?? 0;
    const baselineStable = median(timings.map((item) => item.baseline.stableMs));
    const indexedStable = median(timings.map((item) => item.indexed.stableMs));
    const baselineGrowth = median(timings.map((item) => item.baseline.growthMs));
    const indexedGrowth = median(timings.map((item) => item.indexed.growthMs));
    console.info(JSON.stringify({
      fixture: "540-state-2700-edge-path-search",
      stableQueries: SIZE,
      growthQueries: SIZE,
      trials: timings.length,
      baselineStableMedianMs: +baselineStable.toFixed(2),
      indexedStableMedianMs: +indexedStable.toFixed(2),
      stableRelativeSavingPct: +((1 - indexedStable / baselineStable) * 100).toFixed(1),
      baselineGrowthMedianMs: +baselineGrowth.toFixed(2),
      indexedGrowthMedianMs: +indexedGrowth.toFixed(2),
      growthRelativeSavingPct: +((1 - indexedGrowth / baselineGrowth) * 100).toFixed(1),
      checksum: timings[0]?.baseline.checksum,
    }));
  });
});
