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
