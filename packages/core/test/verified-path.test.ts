import type { RemoteKey } from "@tvdoctor/protocol";
import { describe, expect, it } from "vitest";

import { findShortestVerifiedPath, type VerifiedStateEdge } from "../src/verified-path.js";

const ACTION_ORDER: readonly RemoteKey[] = ["UP", "RIGHT", "DOWN", "LEFT", "SELECT", "BACK"];

function edge(
  fromIdentity: string,
  key: RemoteKey,
  toIdentity: string,
  expandable = true,
): VerifiedStateEdge {
  return { fromIdentity, key, toIdentity, expandable };
}

describe("verified local path selection", () => {
  it("returns an empty path for an already restored state", () => {
    expect(findShortestVerifiedPath([], "a", "a", ACTION_ORDER)).toEqual([]);
  });

  it("chooses the shortest verified route and breaks ties by configured action order", () => {
    const edges = [
      edge("root", "DOWN", "lower"),
      edge("lower", "RIGHT", "target"),
      edge("root", "UP", "upper"),
      edge("upper", "LEFT", "target"),
      edge("root", "RIGHT", "detour"),
      edge("detour", "RIGHT", "far"),
      edge("far", "DOWN", "target"),
    ];

    expect(findShortestVerifiedPath(edges, "root", "target", ACTION_ORDER)).toEqual([
      edge("root", "UP", "upper"),
      edge("upper", "LEFT", "target"),
    ]);
  });

  it("terminates on cycles and never uses non-expandable edges", () => {
    const edges = [
      edge("a", "RIGHT", "b"),
      edge("b", "LEFT", "a"),
      edge("b", "DOWN", "target", false),
    ];

    expect(findShortestVerifiedPath(edges, "a", "target", ACTION_ORDER)).toBeNull();
  });

  it("returns null when no verified route exists", () => {
    expect(findShortestVerifiedPath([edge("a", "RIGHT", "b")], "b", "a", ACTION_ORDER)).toBeNull();
  });
});
