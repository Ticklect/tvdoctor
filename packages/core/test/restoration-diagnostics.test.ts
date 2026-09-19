import { availableObservation, type RemoteKey, type StateSnapshot } from "@tvdoctor/protocol";
import { describe, expect, it } from "vitest";

import { computeSnapshotFingerprint } from "../src/fingerprint.js";
import {
  MAX_RESTORATION_DIAGNOSTICS,
  MAX_RESTORATION_HISTORY,
  RestorationDiagnosticRecorder,
  restorationStateDiagnostic,
} from "../src/explorer-restoration-diagnostics.js";

describe("restoration diagnostics", () => {
  it("keeps canonical focus identity separate from the compact focus fingerprint", () => {
    const snapshot: StateSnapshot = {
      capturedAt: "2026-09-19T10:00:00.000Z",
      location: availableObservation("app://home"),
      focusedElement: availableObservation({ stableId: "play-button", role: "button" }),
      uiTree: availableObservation([]),
    };
    const fingerprint = computeSnapshotFingerprint(snapshot);
    const diagnostic = restorationStateDiagnostic(snapshot, fingerprint);

    expect(diagnostic.focusIdentity).toBe(fingerprint.focusIdentity);
    expect(diagnostic.focusFingerprint).toBe(fingerprint.fingerprint.focus.value);
    expect(diagnostic.focusIdentity).not.toBe(diagnostic.focusFingerprint);
  });

  it("captures bounded lifecycle, focus ancestry, stable IDs, and actionable structure without counting disabled controls", () => {
    const snapshot = {
      capturedAt: "2026-09-19T10:01:00.000Z",
      location: availableObservation("android://org.example.tv/org.example.tv.MainActivity"),
      focusedElement: availableObservation({ stableId: "play", role: "button", name: "Play" }),
      uiTree: availableObservation([{
        stableId: "root",
        role: "group",
        name: "Home",
        text: null,
        bounds: null,
        visible: true,
        enabled: true,
        focusable: false,
        focused: false,
        modal: false,
        selectionState: null,
        valueNow: null,
        children: [{
          stableId: "play",
          role: "button",
          name: "Play",
          text: null,
          bounds: null,
          visible: true,
          enabled: true,
          focusable: true,
          focused: true,
          modal: false,
          selectionState: null,
          valueNow: null,
          clickable: true,
          children: [],
        }, {
          stableId: "disabled",
          role: "button",
          name: "Disabled",
          text: null,
          bounds: null,
          visible: true,
          enabled: false,
          focusable: true,
          focused: false,
          modal: false,
          selectionState: null,
          valueNow: null,
          clickable: true,
          children: [],
        }],
      }]),
      restorationContext: {
        platform: "android-tv",
        applicationId: "org.example.tv",
        processId: 321,
        processGeneration: 2,
        processIdentitySource: "last-launch-or-reset-metadata",
        activity: "org.example.tv.MainActivity",
        activityGeneration: null,
        activityGenerationObservable: false,
        rootIdentity: "window-9",
        rootIdentitySource: "accessibility-window-id",
        windowId: 9,
        windowGeneration: 4,
        observationSequence: 17,
        observerStructureFingerprint: "observer-structure",
        observerStateFingerprint: "observer-state",
      },
    } as StateSnapshot & { readonly restorationContext: Record<string, unknown> };

    const diagnostic = restorationStateDiagnostic(snapshot);

    expect(diagnostic).toMatchObject({
      capturedAt: snapshot.capturedAt,
      focusedStableId: "play",
      stableIdentifiers: ["disabled", "play", "root"],
      visibleNodeCount: 3,
      actionableNodeCount: 1,
      platform: "android-tv",
      applicationId: "org.example.tv",
      processId: 321,
      processGeneration: 2,
      processIdentitySource: "last-launch-or-reset-metadata",
      activity: "org.example.tv.MainActivity",
      activityGeneration: null,
      activityGenerationObservable: false,
      rootIdentity: "window-9",
      rootIdentitySource: "accessibility-window-id",
      windowId: 9,
      windowGeneration: 4,
      observationSequence: 17,
      observerStructureFingerprint: "observer-structure",
      observerStateFingerprint: "observer-state",
    });
    expect(diagnostic.focusedPath).toEqual(["root|group|Home", "play|button|Play"]);
    expect(diagnostic.visibleStructureFingerprint).toMatch(/^visible-/u);
    expect(diagnostic.actionableNodeFingerprint).toMatch(/^actionable-/u);
    expect(diagnostic.navigationStructureFingerprint).toMatch(/^navigation-/u);
  });

  it("bounds retained attempts/history while keeping exact counters and retry numbers", () => {
    const recorder = new RestorationDiagnosticRecorder();
    const history = Array.from({ length: MAX_RESTORATION_HISTORY + 4 }, (_, index) => ({
      capturedAt: `2026-09-19T10:00:${String(index).padStart(2, "0")}.000Z`,
      stateFingerprint: `state-${String(index)}`,
      screenFingerprint: `screen-${String(index)}`,
      focusFingerprint: `focus-${String(index)}`,
      focusIdentity: `focus-${String(index)}`,
    }));
    const actionHistory: RemoteKey[] = Array.from(
      { length: MAX_RESTORATION_HISTORY + 4 },
      (_, index) => index % 2 === 0 ? "LEFT" : "RIGHT",
    );

    for (let index = 0; index < MAX_RESTORATION_DIAGNOSTICS + 6; index += 1) {
      recorder.record({
        restorationCycleNumber: index + 1,
        traversalDepth: index % 4,
        destinationStateId: "focus-0007",
        strategy: "verified-local-path",
        status: index % 2 === 0 ? "success" : "failed",
        elapsedMs: index,
        actionHistory,
        history,
        ...(index % 2 === 0 ? {} : {
          subtype: "navigation-diverged" as const,
          rejectionReason: "local-path-edge-diverged" as const,
        }),
      });
    }

    expect(recorder.attempts).toBe(MAX_RESTORATION_DIAGNOSTICS + 6);
    expect(recorder.successes).toBe(35);
    expect(recorder.failures).toBe(35);

    const retained = recorder.snapshot();
    expect(retained).toHaveLength(MAX_RESTORATION_DIAGNOSTICS);
    expect(retained[0]).toMatchObject({
      attemptNumber: 1,
      retryNumber: 0,
      restorationCycleNumber: 1,
      successfulRestorationsBeforeAttempt: 0,
      traversalDepth: 0,
    });
    expect(retained.at(-1)).toMatchObject({
      attemptNumber: MAX_RESTORATION_DIAGNOSTICS,
      retryNumber: MAX_RESTORATION_DIAGNOSTICS - 1,
      restorationCycleNumber: MAX_RESTORATION_DIAGNOSTICS,
      successfulRestorationsBeforeAttempt: 32,
    });
    expect(retained[0]?.history).toHaveLength(MAX_RESTORATION_HISTORY);
    expect(retained[0]?.history[0]?.stateFingerprint).toBe("state-4");
    expect(retained[0]?.history.at(-1)?.stateFingerprint).toBe("state-19");
    expect(retained[0]?.actionHistory).toHaveLength(MAX_RESTORATION_HISTORY);
    expect(retained[0]?.actionHistory[0]).toBe("LEFT");
    expect(retained[0]?.actionHistory.at(-1)).toBe("RIGHT");
  });
});
