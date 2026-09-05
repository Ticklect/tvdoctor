import {
  availableObservation,
  unavailableObservation,
  type StateSnapshot,
  type UiNodeSnapshot,
} from "@tvdoctor/protocol";
import { describe, expect, it } from "vitest";

import { fingerprintSnapshot } from "../src/index.js";

function control(
  stableId: string,
  name: string,
  focused: boolean,
  x: number,
): UiNodeSnapshot {
  return {
    stableId,
    role: "button",
    name,
    text: name,
    bounds: { x, y: 100, width: 160, height: 64 },
    visible: true,
    enabled: true,
    focusable: true,
    focused,
    modal: false,
    selectionState: null,
    valueNow: null,
    children: [],
  };
}

function snapshot(options: {
  readonly location: string;
  readonly focusId: string;
  readonly focusName: string;
  readonly volatileText: string;
  readonly extraNode?: UiNodeSnapshot;
}): StateSnapshot {
  const left = control("control-left", "Left", options.focusId === "control-left", 100);
  const right = control("control-right", "Right", options.focusId === "control-right", 300);
  const children = options.extraNode === undefined ? [left, right] : [left, right, options.extraNode];
  return {
    capturedAt: "2026-08-20T12:00:00.000Z",
    location: availableObservation(options.location),
    focusedElement: availableObservation({
      stableId: options.focusId,
      role: "button",
      name: options.focusName,
      bounds: options.focusId === "control-left"
        ? { x: 100, y: 100, width: 160, height: 64 }
        : { x: 300, y: 100, width: 160, height: 64 },
    }),
    uiTree: availableObservation([
      {
        stableId: "catalog-screen-91",
        role: "main",
        name: "Rotating recommendation",
        text: options.volatileText,
        bounds: { x: 0, y: 0, width: 1280, height: 720 },
        visible: true,
        enabled: true,
        focusable: false,
        focused: false,
        modal: false,
        selectionState: null,
        valueNow: null,
        children,
      },
    ]),
  };
}

describe("state fingerprinting", () => {
  it("keeps structural ScreenState separate from volatile text and FocusState", () => {
    const first = fingerprintSnapshot(snapshot({
      location: "app://catalog/123?clock=12:01#frame-99",
      focusId: "control-left",
      focusName: "Movie 123",
      volatileText: "12:01 — featured Movie 123",
    }));
    const second = fingerprintSnapshot(snapshot({
      location: "app://catalog/456?clock=12:02#frame-100",
      focusId: "control-right",
      focusName: "Movie 456",
      volatileText: "12:02 — featured Movie 456",
    }));

    expect(first.screen.value).toBe(second.screen.value);
    expect(first.focus.value).not.toBe(second.focus.value);
    expect(first.stateValue).not.toBe(second.stateValue);
    expect(first.screen.confidence).toBe("high");
    expect(first.screen.signals).toEqual(expect.arrayContaining([
      "location",
      "ui-structure",
      "stable-identifiers",
      "roles",
      "geometry",
    ]));
  });

  it("changes ScreenState when the observable structure changes", () => {
    const base = fingerprintSnapshot(snapshot({
      location: "app://catalog",
      focusId: "control-left",
      focusName: "Left",
      volatileText: "First banner",
    }));
    const modal = fingerprintSnapshot(snapshot({
      location: "app://catalog",
      focusId: "control-left",
      focusName: "Left",
      volatileText: "Second banner",
      extraNode: control("dialog-confirm", "Confirm", false, 500),
    }));

    expect(base.screen.value).not.toBe(modal.screen.value);
  });

  it("treats enabled and modal observations as meaningful structural state", () => {
    const base = fingerprintSnapshot(snapshot({
      location: "app://catalog",
      focusId: "control-left",
      focusName: "Left",
      volatileText: "Stable",
      extraNode: control("dialog-confirm", "Confirm", false, 500),
    }));
    const disabled = fingerprintSnapshot(snapshot({
      location: "app://catalog",
      focusId: "control-left",
      focusName: "Left",
      volatileText: "Stable",
      extraNode: { ...control("dialog-confirm", "Confirm", false, 500), enabled: false },
    }));
    const modal = fingerprintSnapshot(snapshot({
      location: "app://catalog",
      focusId: "control-left",
      focusName: "Left",
      volatileText: "Stable",
      extraNode: {
        ...control("dialog-confirm", "Confirm", false, 500),
        role: "dialog",
        modal: true,
      },
    }));

    expect(disabled.screen.value).not.toBe(base.screen.value);
    expect(modal.screen.value).not.toBe(base.screen.value);
  });

  it("ignores transient enabled changes on explicitly non-focusable presentation nodes", () => {
    const label = {
      ...control("catalog-title", "Catalog", false, 500),
      role: "text",
      focusable: false,
    };
    const enabled = fingerprintSnapshot(snapshot({
      location: "app://catalog",
      focusId: "control-left",
      focusName: "Left",
      volatileText: "Stable",
      extraNode: label,
    }));
    const disabled = fingerprintSnapshot(snapshot({
      location: "app://catalog",
      focusId: "control-left",
      focusName: "Left",
      volatileText: "Stable",
      extraNode: { ...label, enabled: false },
    }));

    expect(disabled.screen.value).toBe(enabled.screen.value);
  });

  it("ignores presentation-only descendants of a focusable control", () => {
    const baseControl = control("catalog-card", "Catalog", false, 500);
    const decoration = {
      ...control("catalog-icon", "Icon", false, 500),
      role: "img",
      focusable: false,
    };
    const plain = fingerprintSnapshot(snapshot({
      location: "app://catalog",
      focusId: "control-left",
      focusName: "Left",
      volatileText: "Stable",
      extraNode: baseControl,
    }));
    const decorated = fingerprintSnapshot(snapshot({
      location: "app://catalog",
      focusId: "control-left",
      focusName: "Left",
      volatileText: "Stable",
      extraNode: { ...baseControl, children: [decoration] },
    }));
    const nestedControl = fingerprintSnapshot(snapshot({
      location: "app://catalog",
      focusId: "control-left",
      focusName: "Left",
      volatileText: "Stable",
      extraNode: {
        ...baseControl,
        children: [{ ...decoration, children: [control("nested-action", "Action", false, 520)] }],
      },
    }));

    expect(decorated.screen.value).toBe(plain.screen.value);
    expect(nestedControl.screen.value).not.toBe(plain.screen.value);
  });

  it("does not split a stable focused control when only its live label changes", () => {
    const first = fingerprintSnapshot(snapshot({
      location: "app://player",
      focusId: "player-toggle",
      focusName: "Pause 01:15",
      volatileText: "01:15",
    }));
    const second = fingerprintSnapshot(snapshot({
      location: "app://player",
      focusId: "player-toggle",
      focusName: "Pause 01:16",
      volatileText: "01:16",
    }));

    expect(first.focus.value).toBe(second.focus.value);
    expect(first.focus.signals).not.toContain("focused-name");
  });

  it("ignores volatile selection and numeric-value observations in structural and focus identity", () => {
    const base = fingerprintSnapshot(snapshot({
      location: "app://player/settings",
      focusId: "control-left",
      focusName: "Captions",
      volatileText: "00:12",
      extraNode: {
        ...control("caption-opacity", "Opacity", false, 500),
        role: "slider",
        selectionState: "off",
        valueNow: 25,
      },
    }));
    const updated = fingerprintSnapshot(snapshot({
      location: "app://player/settings",
      focusId: "control-left",
      focusName: "Captions",
      volatileText: "00:13",
      extraNode: {
        ...control("caption-opacity", "Opacity", false, 500),
        role: "slider",
        selectionState: "on",
        valueNow: 75,
      },
    }));

    expect(updated.screen.value).toBe(base.screen.value);
    expect(updated.focus.value).toBe(base.focus.value);
    expect(updated.stateValue).toBe(base.stateValue);
  });

  it("preserves meaningful numeric stable IDs while ignoring focus geometry", () => {
    const first = snapshot({
      location: "app://catalog",
      focusId: "home-card-1",
      focusName: "One",
      volatileText: "Clock 12:01",
    });
    const moved = {
      ...first,
      focusedElement: availableObservation({
        stableId: "home-card-1",
        role: "button",
        name: "One",
        bounds: { x: 118, y: -420, width: 166, height: 66 },
      }),
    } satisfies StateSnapshot;
    const second = {
      ...first,
      focusedElement: availableObservation({
        stableId: "home-card-2",
        role: "button",
        name: "Two",
        bounds: { x: 300, y: 100, width: 160, height: 64 },
      }),
    } satisfies StateSnapshot;

    expect(fingerprintSnapshot(first).focus.value).toBe(fingerprintSnapshot(moved).focus.value);
    expect(fingerprintSnapshot(first).focus.value).not.toBe(fingerprintSnapshot(second).focus.value);
  });

  it("ignores live-region and progress nodes in structural identity", () => {
    const base = snapshot({
      location: "app://player",
      focusId: "control-left",
      focusName: "Left",
      volatileText: "00:01",
    });
    const withStatus = snapshot({
      location: "app://player",
      focusId: "control-left",
      focusName: "Left",
      volatileText: "00:02",
      extraNode: {
        ...control("fixture-toast", "Saved", false, 500),
        stableId: null,
        role: "status",
      },
    });

    expect(fingerprintSnapshot(base).screen.value).toBe(fingerprintSnapshot(withStatus).screen.value);
  });

  it("ignores explicitly invisible template state but preserves observable alternatives", () => {
    const base = fingerprintSnapshot(snapshot({
      location: "app://catalog",
      focusId: "control-left",
      focusName: "Left",
      volatileText: "Stable",
    }));
    const withHiddenTemplate = fingerprintSnapshot(snapshot({
      location: "app://catalog",
      focusId: "control-left",
      focusName: "Left",
      volatileText: "Stable",
      extraNode: {
        ...control("hidden-template", "Template", false, 500),
        visible: false,
      },
    }));
    const withHiddenDisabled = fingerprintSnapshot(snapshot({
      location: "app://catalog",
      focusId: "control-left",
      focusName: "Left",
      volatileText: "Stable",
      extraNode: {
        ...control("visible-disabled", "Template", false, 500),
        enabled: false,
      },
    }));

    expect(withHiddenTemplate.screen.value).toBe(base.screen.value);
    expect(withHiddenDisabled.screen.value).not.toBe(base.screen.value);
  });

  it("normalises virtualised collection membership without erasing item shape", () => {
    const collectionSnapshot = (
      ids: readonly string[],
      role = "button",
      enabled = true,
    ): StateSnapshot => {
      const base = snapshot({
        location: "app://catalog",
        focusId: ids[0] ?? "none",
        focusName: ids[0] ?? "None",
        volatileText: "Catalog",
      });
      return {
        ...base,
        uiTree: availableObservation([{
          stableId: "catalog-list",
          role: "list",
          name: "Catalog",
          text: null,
          bounds: { x: 0, y: 0, width: 1280, height: 720 },
          visible: true,
          enabled: true,
          focusable: false,
          focused: false,
          modal: false,
          selectionState: null,
          valueNow: null,
          children: ids.map((id, index) => ({
            ...control(id, id, index === 0, 100 + index * 180),
            role,
            enabled,
          })),
        }]),
      };
    };

    const first = fingerprintSnapshot(collectionSnapshot(["movie-1", "movie-2"]));
    const scrolled = fingerprintSnapshot(collectionSnapshot(["movie-2", "movie-3"]));
    const changedRole = fingerprintSnapshot(collectionSnapshot(["movie-2", "movie-3"], "checkbox"));
    const disabled = fingerprintSnapshot(collectionSnapshot(["movie-2", "movie-3"], "button", false));
    const empty = fingerprintSnapshot(collectionSnapshot([]));

    expect(scrolled.screen.value).toBe(first.screen.value);
    expect(changedRole.screen.value).not.toBe(first.screen.value);
    expect(disabled.screen.value).not.toBe(first.screen.value);
    expect(empty.screen.value).not.toBe(first.screen.value);
  });

  it("bounds focusable-descendant analysis on adversarially deep trees", () => {
    let descendant: UiNodeSnapshot = {
      ...control("deep-leaf", "Deep leaf", false, 500),
      focusable: false,
    };
    for (let depth = 0; depth < 10_000; depth += 1) {
      descendant = {
        ...control(`deep-${String(depth)}`, "Decoration", false, 500),
        focusable: false,
        children: [descendant],
      };
    }
    const deepSnapshot = snapshot({
      location: "app://deep",
      focusId: "control-left",
      focusName: "Left",
      volatileText: "Stable",
      extraNode: {
        ...control("focusable-container", "Container", false, 500),
        children: [descendant],
      },
    });

    expect(() => fingerprintSnapshot(deepSnapshot)).not.toThrow();
  });

  it("counts depth-truncated child visits against the total traversal budget", () => {
    let childReads = 0;
    const leaves = new Proxy(Array<UiNodeSnapshot>(5000).fill(control("leaf", "Leaf", false, 0)), {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/u.test(property)) childReads += 1;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    let root: UiNodeSnapshot = { ...control("wide", "Wide", false, 0), children: leaves };
    for (let depth = 0; depth < 63; depth += 1) {
      root = { ...control(`level-${String(depth)}`, "Level", false, 0), children: [root] };
    }
    const value = snapshot({ location: "app://bounded", focusId: "leaf", focusName: "Leaf", volatileText: "Stable" });
    fingerprintSnapshot({ ...value, uiTree: availableObservation([root]) });
    expect(childReads).toBeLessThanOrEqual(2048);
  });

  it("exposes low confidence instead of inventing unavailable signals", () => {
    const result = fingerprintSnapshot({
      capturedAt: "2026-08-20T12:00:00.000Z",
      location: unavailableObservation("location is not observable"),
      focusedElement: unavailableObservation("focus is not observable"),
      uiTree: unavailableObservation("hierarchy is not observable"),
    });

    expect(result.screen).toMatchObject({ confidence: "low", signals: ["unavailable"] });
    expect(result.focus).toMatchObject({ confidence: "low", signals: ["unavailable"] });
    expect(result.confidence).toBe("low");
  });
});
