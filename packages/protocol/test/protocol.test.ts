import { describe, expect, it } from "vitest";

import {
  CAPABILITIES,
  REMOTE_KEYS,
  availableObservation,
  isCapability,
  isRemoteKey,
  unavailableObservation,
} from "../src/index.js";
import type {
  ScreenshotArtifact,
  StateSnapshot,
  TVDoctorDriver,
  UiNodeSnapshot,
} from "../src/index.js";

describe("platform-neutral protocol", () => {
  it("exposes only the initial deterministic remote action set", () => {
    expect(REMOTE_KEYS).toEqual([
      "UP",
      "DOWN",
      "LEFT",
      "RIGHT",
      "SELECT",
      "BACK",
    ]);
    expect(isRemoteKey("SELECT")).toBe(true);
    expect(isRemoteKey("CLICK")).toBe(false);
  });

  it("recognises declared driver capabilities", () => {
    expect(CAPABILITIES).toContain("remote-input");
    expect(isCapability("screenshot")).toBe(true);
    expect(isCapability("dom-only-assumption")).toBe(false);
  });

  it("keeps unavailable observations distinct from observed values", () => {
    expect(availableObservation(null)).toEqual({
      status: "available",
      value: null,
    });
    expect(unavailableObservation("driver has no accessibility tree")).toEqual({
      status: "unavailable",
      reason: "driver has no accessibility tree",
    });
  });

  it("serializes a generic UI hierarchy without platform-specific objects", () => {
    const button: UiNodeSnapshot = {
      stableId: "play-button",
      role: "button",
      name: "Play",
      text: "Play",
      bounds: { x: 120, y: 240, width: 320, height: 96 },
      visible: true,
      enabled: true,
      focusable: true,
      focused: true,
      modal: false,
      selectionState: "on",
      valueNow: null,
      children: [],
    };
    const snapshot: StateSnapshot = {
      capturedAt: "2026-08-19T20:00:00.000Z",
      location: availableObservation("fixture://details"),
      focusedElement: availableObservation({
        stableId: "play-button",
        role: "button",
        name: "Play",
        bounds: { x: 120, y: 240, width: 320, height: 96 },
      }),
      uiTree: availableObservation([
        {
          stableId: null,
          role: "application",
          name: "Northstar",
          text: null,
          bounds: null,
          visible: true,
          enabled: true,
          focusable: false,
          focused: false,
          modal: false,
          selectionState: null,
          valueNow: null,
          children: [button],
        },
      ]),
    };

    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(button.selectionState).toBe("on");
    expect(button.valueNow).toBeNull();
  });

  it("requires unavailable UI trees to carry a reason", () => {
    const snapshot: StateSnapshot = {
      capturedAt: "2026-08-19T20:00:00.000Z",
      location: unavailableObservation("driver has no location observation"),
      focusedElement: unavailableObservation(
        "driver cannot observe the focused element",
      ),
      uiTree: unavailableObservation("driver does not expose a UI hierarchy"),
    };

    expect(snapshot.uiTree).toEqual({
      status: "unavailable",
      reason: "driver does not expose a UI hierarchy",
    });
  });

  it("keeps screenshot capture optional and its artifact JSON-friendly", () => {
    const driverWithoutScreenshot: TVDoctorDriver = {
      async capabilities() {
        return new Set(["remote-input"]);
      },
      async press(key) {
        return {
          key,
          outcome: "applied",
          timing: { inputSentAtMs: 1 },
        };
      },
      async snapshot() {
        return {
          capturedAt: "2026-08-19T20:00:00.000Z",
          location: unavailableObservation("location is not observable"),
          focusedElement: unavailableObservation("focus is not observable"),
          uiTree: unavailableObservation("UI hierarchy is not observable"),
        };
      },
    };
    const artifact: ScreenshotArtifact = {
      path: "artifacts/screenshots/details.png",
      mediaType: "image/png",
      width: 1920,
      height: 1080,
      capturedAt: "2026-08-19T20:00:00.000Z",
    };

    expect(driverWithoutScreenshot.captureScreenshot).toBeUndefined();
    expect(JSON.parse(JSON.stringify(artifact))).toEqual(artifact);
  });
});
