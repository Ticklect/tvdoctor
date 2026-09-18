import { describe, expect, it } from "vitest";
import { REMOTE_KEYS, type Observation } from "@tvdoctor/protocol";
import type {
  AndroidStateSnapshot,
  AndroidUiNodeSnapshot,
} from "@tvdoctor/driver-android";
import {
  ANDROID_EXPLORATION_BUDGETS,
  decideAndroidActions,
} from "../src/android-action-policy.js";

const TARGET_PACKAGE = "org.example.tv";

function node(label: string | null, overrides: Partial<AndroidUiNodeSnapshot> = {}): AndroidUiNodeSnapshot {
  return {
    stableId: "root/focused",
    role: "button",
    name: label,
    text: null,
    bounds: { x: 100, y: 100, width: 300, height: 80 },
    visible: true,
    enabled: true,
    focusable: true,
    focused: true,
    modal: false,
    selectionState: null,
    valueNow: null,
    className: "android.widget.Button",
    packageName: TARGET_PACKAGE,
    clickable: true,
    scrollable: false,
    selected: false,
    children: [],
    ...overrides,
  };
}

function snapshot(
  focusedNode: AndroidUiNodeSnapshot,
  overrides: Partial<AndroidStateSnapshot> = {},
): AndroidStateSnapshot {
  return {
    capturedAt: "2026-09-18T17:00:00.000Z",
    location: {
      status: "available",
      value: "android://" + TARGET_PACKAGE + "/.MainActivity",
    },
    focusedElement: {
      status: "available",
      value: {
        ...(focusedNode.stableId === null ? {} : { stableId: focusedNode.stableId }),
        ...(focusedNode.role === null ? {} : { role: focusedNode.role }),
        ...(focusedNode.name ?? focusedNode.text) === null
          ? {}
          : { name: focusedNode.name ?? focusedNode.text ?? "" },
        ...(focusedNode.bounds === null ? {} : { bounds: focusedNode.bounds }),
      },
    },
    uiTree: { status: "available", value: [focusedNode] },
    device: { status: "unavailable", reason: "not needed by action policy" },
    app: {
      status: "available",
      value: {
        packageName: TARGET_PACKAGE,
        component: ".MainActivity",
        pid: 101,
        versionName: "1.0.0",
        versionCode: 1,
      },
    },
    hierarchyMetadata: {
      status: "available",
      value: {
        targetWindowActive: true,
        capturedNodeCount: 1,
        maxNodeCount: 4_096,
        maxDepth: 0,
        truncated: false,
      },
    },
    ...overrides,
  };
}

function mediaSession(
  value: { readonly packageName: string; readonly active: boolean; readonly playbackState: string | null } | null,
): Observation<{ readonly packageName: string; readonly active: boolean; readonly playbackState: string | null }> {
  return value === null
    ? { status: "unavailable", reason: "no target media session" }
    : { status: "available", value };
}

function decisions(options: {
  readonly strategy?: "adaptive" | "brute-force";
  readonly focusedNode?: AndroidUiNodeSnapshot;
  readonly snapshotOverrides?: Partial<AndroidStateSnapshot>;
  readonly media?: ReturnType<typeof mediaSession>;
  readonly authorisedActionIds?: ReadonlySet<string>;
  readonly screenStateId?: string;
} = {}) {
  const focusedNode = options.focusedNode ?? node("Open details");
  return decideAndroidActions({
    strategy: options.strategy ?? "adaptive",
    snapshot: snapshot(focusedNode, options.snapshotOverrides),
    screenStateId: options.screenStateId ?? "screen-1",
    targetPackage: TARGET_PACKAGE,
    mediaSession: options.media ?? mediaSession(null),
    authorisedActionIds: options.authorisedActionIds ?? new Set(),
  });
}

describe("Android action policy", () => {
  it("keeps TAB and HOME out of all automatic Android traversal strategies", () => {
    const media = mediaSession({
      packageName: TARGET_PACKAGE,
      active: true,
      playbackState: "playing",
    });
    expect(decisions({ media }).map((entry) => entry.key)).not.toContain("TAB");
    expect(decisions({ media }).map((entry) => entry.key)).not.toContain("HOME");
    expect(decisions({ strategy: "brute-force", media }).map((entry) => entry.key)).toEqual(
      REMOTE_KEYS.filter((key) => key !== "TAB" && key !== "HOME"),
    );
  });

  it("adds only explicit media keys when target playback is eligible", () => {
    const result = decisions({
      media: mediaSession({
        packageName: TARGET_PACKAGE,
        active: true,
        playbackState: "playing",
      }),
    });
    expect(result.map((entry) => entry.key)).toEqual([
      "UP",
      "DOWN",
      "LEFT",
      "RIGHT",
      "SELECT",
      "BACK",
      "PLAY_PAUSE",
      "PLAY",
      "PAUSE",
      "STOP",
      "NEXT",
      "PREVIOUS",
      "REWIND",
      "FAST_FORWARD",
    ]);
  });

  it("does not add media keys for a different package session", () => {
    const result = decisions({
      media: mediaSession({
        packageName: "org.other.player",
        active: true,
        playbackState: "playing",
      }),
    });
    expect(result.map((entry) => entry.key)).toEqual([
      "UP",
      "DOWN",
      "LEFT",
      "RIGHT",
      "SELECT",
      "BACK",
    ]);
  });

  it("uses player UI semantics as bounded media evidence", () => {
    const player = node("Player", {
      role: "region",
      clickable: false,
      children: [node("Play", { focused: false, stableId: "root/play" })],
    });
    expect(decisions({ focusedNode: player }).map((entry) => entry.key)).toContain("PLAY_PAUSE");
  });

  it("never schedules HOME automatically", () => {
    expect(decisions().some((entry) => entry.key === "HOME")).toBe(false);
  });

  it("fails closed when the current accessibility window is foreign", () => {
    const result = decisions({
      snapshotOverrides: {
        hierarchyMetadata: {
          status: "available",
          value: {
            targetWindowActive: false,
            capturedNodeCount: 0,
            maxNodeCount: 4_096,
            maxDepth: 0,
            truncated: false,
          },
        },
      },
    });
    expect(result.every((entry) => entry.disposition === "inaccessible")).toBe(true);
  });

  it("does not accept a package-name prefix as target ownership", () => {
    const result = decisions({
      snapshotOverrides: {
        location: {
          status: "available",
          value: "android://" + TARGET_PACKAGE + ".evil/.MainActivity",
        },
      },
    });
    expect(result.every((entry) => entry.disposition === "inaccessible")).toBe(true);
  });

  it.each([
    ["Sign in", "risky-activation"],
    ["Subscribe", "risky-activation"],
    ["Delete account", "risky-activation"],
    ["Display in grid", "persistent-toggle"],
    ["Add to favorites", "persistent-mutation"],
  ])("gates SELECT for %s", (label, reasonCode) => {
    expect(decisions({ focusedNode: node(label) }).find((entry) => entry.key === "SELECT")).toMatchObject({
      disposition: "operator-gated",
      reasonCode,
    });
  });

  it("gates a focused row containing a persistent checkbox", () => {
    const select = decisions({
      focusedNode: node("Folder: Alarms", {
        className: "android.view.ViewGroup",
        children: [node(null, {
          stableId: "root/focused/checkbox",
          role: "checkbox",
          className: "android.widget.CheckBox",
          focusable: false,
          focused: false,
          selectionState: "off",
        })],
      }),
    }).find((entry) => entry.key === "SELECT");
    expect(select).toMatchObject({
      disposition: "operator-gated",
      reasonCode: "persistent-toggle",
    });
  });

  it("gates ambiguous SELECT and permits only the exact authorised action id", () => {
    const ambiguous = decisions({
      focusedNode: node(null, { role: null, stableId: null }),
    }).find((entry) => entry.key === "SELECT");
    expect(ambiguous).toMatchObject({
      disposition: "operator-gated",
      reasonCode: "ambiguous-activation",
    });

    const risky = decisions({ focusedNode: node("Subscribe") }).find((entry) => entry.key === "SELECT");
    const authorised = decisions({
      focusedNode: node("Subscribe"),
      authorisedActionIds: new Set([risky?.actionId ?? "missing"]),
    }).find((entry) => entry.key === "SELECT");
    expect(authorised).toMatchObject({
      actionId: risky?.actionId,
      disposition: "automatic",
      reasonCode: "explicitly-authorised",
    });

    const differentControl = decisions({
      focusedNode: node("Buy", { stableId: "root/buy" }),
      authorisedActionIds: new Set([risky?.actionId ?? "missing"]),
    }).find((entry) => entry.key === "SELECT");
    expect(differentControl?.disposition).toBe("operator-gated");

    const differentState = decisions({
      focusedNode: node("Subscribe"),
      screenStateId: "screen-2",
      authorisedActionIds: new Set([risky?.actionId ?? "missing"]),
    }).find((entry) => entry.key === "SELECT");
    expect(differentState?.disposition).toBe("operator-gated");
  });

  it("does not gate a favorites navigation tab as persistent data mutation", () => {
    const select = decisions({
      focusedNode: node("Favorites", {
        stableId: "root/favorites-tab",
        role: "tab",
      }),
    }).find((entry) => entry.key === "SELECT");
    expect(select).toMatchObject({
      disposition: "automatic",
      reasonCode: "safe-target-action",
    });
  });

  it("retains the branch strategy budgets", () => {
    expect(ANDROID_EXPLORATION_BUDGETS["brute-force"].deep).toEqual({
      maxActions: 25_000,
      maxStates: 2_500,
      maxDepth: 64,
      maxDurationMs: 3_600_000,
    });
  });
});
