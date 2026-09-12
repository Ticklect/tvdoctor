import type { RemoteKey } from "@tvdoctor/protocol";
import { describe, expect, it } from "vitest";

import { takeFrontier, type QueueEntry } from "../src/explorer-frontier.js";

const ACTION_ORDER: readonly RemoteKey[] = ["UP", "RIGHT", "DOWN", "LEFT", "SELECT", "BACK"];
const ACTION_RANK = new Map(ACTION_ORDER.map((key, index) => [key, index]));

function entry(
  id: string,
  priority: number,
  sequence: readonly RemoteKey[],
  insertionOrder: number,
): QueueEntry {
  return {
    state: { id, frontierPriority: priority } as QueueEntry["state"],
    sequence,
    checkpoints: [],
    insertionOrder,
  };
}

function id(value: QueueEntry | undefined): string | undefined {
  return value?.state.id;
}

describe("explorer frontier", () => {
  it("preserves exact breadth-first insertion order across interleaved pushes", () => {
    const first = entry("first", 0, [], 0);
    const second = entry("second", 0, ["UP"], 1);
    const third = entry("third", 0, ["RIGHT"], 2);
    const fourth = entry("fourth", 0, ["DOWN"], 3);
    const frontier = [first, second, third];

    expect(id(takeFrontier(frontier, "breadth-first", ACTION_RANK))).toBe("first");
    frontier.push(fourth);
    expect(id(takeFrontier(frontier, "breadth-first", ACTION_RANK))).toBe("second");
    expect(id(takeFrontier(frontier, "breadth-first", ACTION_RANK))).toBe("third");
    expect(id(takeFrontier(frontier, "breadth-first", ACTION_RANK))).toBe("fourth");
    expect(frontier).toEqual([]);
  });

  it("preserves priority, depth, action-order, and insertion-order tie breaking", () => {
    const frontier = [
      entry("low-priority", 1, [], 0),
      entry("deep", 0, ["UP", "UP"], 1),
      entry("left", 0, ["LEFT"], 2),
      entry("right-late", 0, ["RIGHT"], 4),
      entry("right-early", 0, ["RIGHT"], 3),
    ];

    expect(id(takeFrontier(frontier, "priority", ACTION_RANK))).toBe("right-early");
    expect(id(takeFrontier(frontier, "priority", ACTION_RANK))).toBe("right-late");
    expect(id(takeFrontier(frontier, "priority", ACTION_RANK))).toBe("left");
    expect(id(takeFrontier(frontier, "priority", ACTION_RANK))).toBe("deep");
    expect(id(takeFrontier(frontier, "priority", ACTION_RANK))).toBe("low-priority");
  });

  it("incorporates newly appended priority work without rebuilding the pending set", () => {
    const first = entry("first", 1, ["DOWN"], 0);
    const second = entry("second", 1, ["LEFT"], 1);
    const urgent = entry("urgent", 0, ["BACK"], 2);
    const frontier = [first, second];

    expect(id(takeFrontier(frontier, "priority", ACTION_RANK))).toBe("first");
    frontier.push(urgent);
    expect(id(takeFrontier(frontier, "priority", ACTION_RANK))).toBe("urgent");
    expect(frontier.map((candidate) => candidate.state.id)).toEqual(["second"]);
  });

  it("does not depend on Array.shift or Array.splice for dequeue", () => {
    const breadthFirst = [entry("one", 0, [], 0), entry("two", 0, ["UP"], 1)];
    Object.defineProperty(breadthFirst, "shift", {
      value: () => { throw new Error("shift must not be used"); },
    });
    expect(id(takeFrontier(breadthFirst, "breadth-first", ACTION_RANK))).toBe("one");

    const priority = [entry("one", 1, [], 0), entry("two", 0, ["UP"], 1)];
    Object.defineProperty(priority, "splice", {
      value: () => { throw new Error("splice must not be used"); },
    });
    expect(id(takeFrontier(priority, "priority", ACTION_RANK))).toBe("two");
  });
});
