import { describe, expect, it } from "vitest";
import { createNavigationFocusGraphV2, explore } from "@tvdoctor/core";
import type {
  Capability,
  RemoteKey,
  StateSnapshot,
  TVDoctorDriver,
  UiNodeSnapshot,
} from "@tvdoctor/protocol";

import type { AuditRunProducts } from "../src/node-audit-contracts.js";
import {
  navigationCoverageComplete,
  navigationInventory,
} from "../src/node-audit-navigation.js";
import {
  exhaustedBudgets,
  packCoverage,
  partialRunDetails,
} from "../src/node-audit-selection.js";

function node(stableId: string, focused: boolean, children: readonly UiNodeSnapshot[] = [], x = 100): UiNodeSnapshot {
  return {
    stableId,
    role: children.length === 0 ? "button" : "list",
    name: stableId,
    text: stableId,
    bounds: children.length === 0 ? { x, y: 200, width: 180, height: 72 } : null,
    visible: true,
    enabled: true,
    focusable: children.length === 0,
    focused,
    modal: false,
    selectionState: null,
    valueNow: null,
    children,
  };
}

function snapshot(position: number, count: number): StateSnapshot {
  return {
    capturedAt: "2026-10-08T12:00:00.000Z",
    location: { status: "available", value: "app://carousel" },
    focusedElement: {
      status: "available",
      value: {
        stableId: `card-${String(position + 1)}`,
        role: "button",
        name: `Card ${String(position + 1)}`,
        bounds: { x: 100 + position * 196, y: 200, width: 180, height: 72 },
      },
    },
    uiTree: {
      status: "available",
      value: [node("carousel", false, Array.from({ length: count }, (_, index) => (
        node(`card-${String(index + 1)}`, index === position, [], 100 + index * 196)
      )))],
    },
  };
}

async function exploreCarousel(compress: boolean) {
  let position = 0;
  const size = 8;
  const driver: TVDoctorDriver = {
    async capabilities(): Promise<ReadonlySet<Capability>> {
      return new Set(["remote-input", "ui-tree"]);
    },
    async press(key: RemoteKey) {
      if (key === "RIGHT") position = Math.min(position + 1, size - 1);
      return { key, outcome: "applied" as const, timing: { inputSentAtMs: 1 } };
    },
    async snapshot() {
      return snapshot(position, size);
    },
    async reset() {
      position = 0;
    },
  };
  return await explore(driver, {
    profile: "quick",
    actions: ["RIGHT"],
    monotonicNow: () => 0,
    repetitionCompression: {
      enabled: compress,
      maxRepresentativesPerGroup: 1,
      maxExpandedRepresentativesPerGroup: 1,
    },
  });
}

describe("web deferred navigation coverage", () => {
  it("marks real queue-exhausted repeated carousel exploration partial across graph, inventory, pack, and report inputs", async () => {
    const navigation = await exploreCarousel(true);
    expect(navigation.termination).toMatchObject({ reason: "queue-exhausted", complete: true });
    expect(navigation.statistics.deferredStates).toBeGreaterThan(0);

    const products: AuditRunProducts = { navigation, navigationFindings: [], streaming: null, web: null };
    const selected = new Set(["navigation"]);
    expect(createNavigationFocusGraphV2(navigation).coverage).toBe("partial");
    expect(navigationCoverageComplete(navigation)).toBe(false);
    expect(navigationInventory(navigation, null).status).toBe("partial");
    const packs = packCoverage(products, selected);
    expect(packs).toEqual([{ pack: "navigation", status: "partial" }]);
    expect(packs.some((pack) => pack.status !== "completed")).toBe(true);
    expect(exhaustedBudgets(products, selected)).toEqual(["repetitive-items"]);
    expect(partialRunDetails(products, selected, 0)).toEqual([
      `BOUNDED-INCOMPLETE: navigation deferred ${String(navigation.statistics.deferredStates)} repetition-compressed focus state; this coverage remains untested.`,
    ]);
    expect(exhaustedBudgets(products, new Set(["layout"]))).toEqual([]);
    expect(partialRunDetails(products, new Set(["layout"]), 0)).toEqual([]);
  });

  it("keeps an actually complete uncompressed traversal complete", async () => {
    const navigation = await exploreCarousel(false);
    const products: AuditRunProducts = { navigation, navigationFindings: [], streaming: null, web: null };
    expect(navigation.termination.complete).toBe(true);
    expect(navigation.statistics.deferredStates ?? 0).toBe(0);
    expect(navigationCoverageComplete(navigation)).toBe(true);
    expect(navigationInventory(navigation, null).status).toBe("complete");
    expect(packCoverage(products, new Set(["navigation"]))).toEqual([
      { pack: "navigation", status: "completed" },
    ]);
    expect(exhaustedBudgets(products, new Set(["navigation"]))).toEqual([]);
    expect(partialRunDetails(products, new Set(["navigation"]), 0)).toEqual([]);
  });
  it("explains incomplete observation when the frontier is empty", async () => {
    const scanned = await exploreCarousel(false);
    const navigation = {
      ...scanned,
      termination: {
        reason: "queue-exhausted" as const,
        complete: false,
        detail: "UI-tree enumeration truncated; unobserved controls may remain.",
      },
    };
    const products: AuditRunProducts = { navigation, navigationFindings: [], streaming: null, web: null };
    expect(packCoverage(products, new Set(["navigation"]))).toEqual([
      { pack: "navigation", status: "partial" },
    ]);
    expect(partialRunDetails(products, new Set(["navigation"]), 0)).toEqual([
      "SAFE-FRONTIER-COMPLETE: known runnable navigation queue exhausted; full coverage remains unverified: UI-tree enumeration truncated; unobserved controls may remain.",
    ]);
  });
});
