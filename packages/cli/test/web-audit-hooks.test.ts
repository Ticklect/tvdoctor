import { describe, expect, test } from "vitest";

import { distinctVisibleSurfaceChange } from "@tvdoctor/pack-web";
import type { StateSnapshot, UiNodeSnapshot } from "@tvdoctor/protocol";
import {
  createStreamingAuditPointerProbe,
  createWebAuditHooks,
} from "../src/web-audit-hooks.js";

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

describe("web audit hook privacy", () => {
  const targetNode = uiNode({
    stableId: "target-control",
    role: "button",
    name: "Target",
    visible: true,
    enabled: true,
    focusable: true,
    focused: true,
  });
  const targetSnapshot = snapshot([targetNode]);
  const descriptor = {
    stableId: "target-control",
    role: "button",
    name: "Target",
    bounds: null,
    visible: true,
    enabled: true,
    focusable: true,
    selectionState: null,
    valueNow: null,
  } as const;
  const privateFailure = "spawn C:\\Users\\alice\\chromium.exe --remote-debugging-port=0 cwd=/home/alice/private";
  const isolatedDriver = () => ({
    launch: async () => { throw new Error(privateFailure); },
    close: async () => undefined,
  }) as never;

  test("does not return raw local diagnostics from isolated web pointer or focus probes", async () => {
    const hooks = createWebAuditHooks({
      target: "https://fixture.test/app",
      driver: {} as never,
      createDriver: isolatedDriver,
    });
    const pointer = await hooks.pointerProbe?.probe({
      kind: "search-submit",
      element: descriptor,
      snapshot: targetSnapshot,
      surfaceSequence: [],
    });
    const focus = await hooks.webFocusVisibility?.probe({
      element: descriptor,
      snapshot: targetSnapshot,
      focusSequence: [],
    });

    expect(pointer).toEqual({ status: "error", detail: "Isolated pointer proof failed safely." });
    expect(focus).toEqual({ status: "error", detail: "Isolated focus proof failed safely." });
    expect(JSON.stringify([pointer, focus])).not.toContain("C:\\Users\\alice");
    expect(JSON.stringify([pointer, focus])).not.toContain("/home/alice/private");
    expect(JSON.stringify([pointer, focus])).not.toContain("--remote-debugging-port");
  });

  test("does not return raw local diagnostics from the isolated streaming pointer probe", async () => {
    const probe = createStreamingAuditPointerProbe("https://fixture.test/app", isolatedDriver);
    const result = await probe.probe({
      kind: "player-volume-control",
      element: descriptor,
      snapshot: targetSnapshot,
      surfaceSequence: [],
    });

    expect(result).toEqual({ status: "error", detail: "Isolated streaming pointer proof failed safely." });
    expect(JSON.stringify(result)).not.toContain("C:\\Users\\alice");
    expect(JSON.stringify(result)).not.toContain("/home/alice/private");
    expect(JSON.stringify(result)).not.toContain("--remote-debugging-port");
  });
});
