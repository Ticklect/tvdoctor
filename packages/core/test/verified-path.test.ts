import { describe, expect, it } from "vitest";

import { findShortestVerifiedPath } from "../src/verified-path.js";
import type { VerifiedStateEdge } from "../src/verified-path.js";

describe("findShortestVerifiedPath", () => {
  const edge = (
    fromIdentity: string,
    toIdentity: string,
    key: VerifiedStateEdge["key"],
    expandable = true,
  ): VerifiedStateEdge => ({ fromIdentity, toIdentity, key, expandable });

  it("returns an empty path when the exact live state is already the target", () => {
    expect(findShortestVerifiedPath([], "A", "A", ["UP", "RIGHT"])).toEqual([]);
  });

  it("chooses the shortest reusable path and ignores boundary edges", () => {
    const edges = [
      edge("A", "B", "RIGHT"),
      edge("B", "D", "RIGHT"),
      edge("A", "C", "DOWN"),
      edge("C", "E", "RIGHT"),
      edge("E", "D", "UP"),
      edge("A", "D", "SELECT", false),
    ];

    expect(findShortestVerifiedPath(edges, "A", "D", ["UP", "RIGHT", "DOWN", "SELECT"]))
      .toEqual([edges[0], edges[1]]);
  });

  it("uses action order then stable destination identity to break equal-length ties", () => {
    const edges = [
      edge("A", "C", "RIGHT"),
      edge("C", "D", "UP"),
      edge("A", "B", "UP"),
      edge("B", "D", "RIGHT"),
    ];

    expect(findShortestVerifiedPath(edges, "A", "D", ["UP", "RIGHT"]))
      .toEqual([edges[2], edges[3]]);

    const sameKey = [
      edge("A", "C", "RIGHT"),
      edge("C", "D", "UP"),
      edge("A", "B", "RIGHT"),
      edge("B", "D", "UP"),
    ];
    expect(findShortestVerifiedPath(sameKey, "A", "D", ["RIGHT", "UP"]))
      .toEqual([sameKey[2], sameKey[3]]);
  });

  it("terminates cycles and returns null when no reusable path reaches the target", () => {
    const edges = [edge("A", "B", "RIGHT"), edge("B", "A", "LEFT")];
    expect(findShortestVerifiedPath(edges, "A", "Z", ["RIGHT", "LEFT"])).toBeNull();
  });
});
