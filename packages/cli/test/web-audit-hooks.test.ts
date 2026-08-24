import { describe, expect, test } from "vitest";

import { distinctVisibleSurfaceChange } from "@tvdoctor/pack-web";
import type { StateSnapshot, UiNodeSnapshot } from "@tvdoctor/protocol";

function uiNode(overrides: Partial<UiNodeSnapshot> = {}): UiNodeSnapshot {
  return {
    stableId: null,
    role: "paragraph",
    name: null,
    text: null,
    bounds: null,
    visible: true,
    enabled: true,
    focusable: false,
    focused: false,
    modal: false,
    selectionState: null,
    valueNow: null,
    children: [],
    ...overrides,
  };
}

function snapshot(nodes: readonly UiNodeSnapshot[]): StateSnapshot {
  return {
    capturedAt: new Date(0).toISOString(),
    location: { status: "available", value: "https://fixture.test/search" },
    focusedElement: {
      status: "available",
      value: null,
      reason: undefined,
    } as StateSnapshot["focusedElement"],
    uiTree: { status: "available", value: nodes },
  };
}

describe("distinctVisibleSurfaceChange", () => {
  test("detects newly added visible informational content", () => {
    const before = snapshot([uiNode({ stableId: "search-query", role: "textbox", name: "Query" })]);
    const after = snapshot([
      uiNode({ stableId: "search-query", role: "textbox", name: "Query" }),
      uiNode({ role: "paragraph", text: "Pointer submit received. Live results were already current." }),
    ]);
    expect(distinctVisibleSurfaceChange(before, after)).toContain("pointer submit received");
  });

  test("returns null when the visible surface is unchanged", () => {
    const nodes = [uiNode({ stableId: "search-query", role: "textbox", name: "Query" })];
    expect(distinctVisibleSurfaceChange(snapshot(nodes), snapshot(nodes))).toBeNull();
  });

  test("ignores invisible additions and unavailable trees", () => {
    const before = snapshot([]);
    const after = snapshot([uiNode({ visible: false, text: "hidden note" })]);
    expect(distinctVisibleSurfaceChange(before, after)).toBeNull();
    const unavailable = {
      capturedAt: new Date(0).toISOString(),
      location: { status: "unavailable" as const, reason: "closed" },
      focusedElement: { status: "unavailable" as const, reason: "closed" },
      uiTree: { status: "unavailable" as const, reason: "closed" },
    };
    expect(distinctVisibleSurfaceChange(unavailable, unavailable)).toBeNull();
  });
});
