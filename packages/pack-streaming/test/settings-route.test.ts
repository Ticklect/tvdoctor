import {
  availableObservation,
  type ActionResult,
  type Capability,
  type RemoteKey,
  type StateSnapshot,
  type TVDoctorDriver,
  type UiNodeSnapshot,
} from "@tvdoctor/protocol";
import { describe, expect, it } from "vitest";

import { discoverStreamingSettingsRoute } from "../src/index.js";

type Screen = "details" | "home" | "player" | "settings";

function node(
  stableId: string,
  role: string,
  name: string,
  focused: boolean,
  children: readonly UiNodeSnapshot[] = [],
  modal = false,
): UiNodeSnapshot {
  return {
    stableId,
    role,
    name,
    text: name,
    bounds: { x: 0, y: 0, width: 100, height: 40 },
    visible: true,
    enabled: true,
    focusable: role === "button",
    focused,
    modal,
    selectionState: null,
    valueNow: null,
    children,
  };
}

function snapshot(screen: Screen, focus: string): StateSnapshot {
  const controls: readonly UiNodeSnapshot[] = screen === "home"
    ? [node("safe-content", "button", "Sunrise movie details", focus === "safe-content")]
    : screen === "details"
      ? [node("details-play", "button", "Play", focus === "details-play")]
      : screen === "player"
        ? [
            node("player-pause", "button", "Pause", focus === "player-pause"),
            node("player-settings", "button", "Settings", focus === "player-settings"),
          ]
        : [
            node("settings-captions", "button", "Captions Off", focus === "settings-captions"),
            node("settings-audio", "button", "Audio English", focus === "settings-audio"),
          ];
  const root = screen === "settings"
    ? node("settings-dialog", "dialog", "Player settings", false, controls, true)
    : node(
        `${screen}-surface`,
        "main",
        screen === "player" ? "Player controls" : screen === "details" ? "Movie details" : "Catalogue",
        false,
        controls,
      );
  const focused = controls.find((candidate) => candidate.focused === true) ?? null;
  return {
    capturedAt: "2026-09-13T00:00:00.000Z",
    location: availableObservation(`https://example.test/${screen}`),
    focusedElement: availableObservation(focused === null ? null : {
      ...(focused.stableId == null ? {} : { stableId: focused.stableId }),
      ...(focused.role == null ? {} : { role: focused.role }),
      ...(focused.name == null ? {} : { name: focused.name }),
      ...(focused.bounds == null ? {} : { bounds: focused.bounds }),
    }),
    uiTree: availableObservation([root]),
  };
}

class SettingsRouteDriver implements TVDoctorDriver {
  screen: Screen = "home";
  focus = "safe-content";
  settingsOpens = true;
  readonly selected: string[] = [];

  async capabilities(): Promise<ReadonlySet<Capability>> {
    return new Set(["remote-input", "ui-tree"]);
  }

  async press(key: RemoteKey): Promise<ActionResult> {
    if (this.screen === "player" && key === "RIGHT") this.focus = "player-settings";
    if (this.screen === "player" && key === "LEFT") this.focus = "player-pause";
    if (key === "SELECT") {
      this.selected.push(this.focus);
      if (this.screen === "home" && this.focus === "safe-content") {
        this.screen = "details";
        this.focus = "details-play";
      } else if (this.screen === "details" && this.focus === "details-play") {
        this.screen = "player";
        this.focus = "player-pause";
      } else if (this.screen === "player" && this.focus === "player-settings" && this.settingsOpens) {
        this.screen = "settings";
        this.focus = "settings-captions";
      }
    }
    return { key, outcome: "applied", timing: { inputSentAtMs: 1 } };
  }

  async snapshot(): Promise<StateSnapshot> {
    return snapshot(this.screen, this.focus);
  }

  async reset(): Promise<void> {
    this.screen = "home";
    this.focus = "safe-content";
  }
}

describe("bounded Player Settings discovery", () => {
  it("returns the exact confirmed Settings route without entering caption submenus", async () => {
    const driver = new SettingsRouteDriver();
    const result = await discoverStreamingSettingsRoute(driver, {
      budgets: { maxActions: 100, maxStates: 30, maxLocalDepth: 4, maxLocalStates: 12, maxDurationMs: 10_000 },
    });

    expect(result.status).toBe("found");
    expect(result.sequence).toEqual(["SELECT", "SELECT", "RIGHT", "SELECT"]);
    expect(new Set(driver.selected)).toEqual(new Set(["safe-content", "details-play", "player-settings"]));
    expect(driver.selected).not.toContain("settings-captions");
  });

  it("returns unavailable when Settings activation does not open a distinct captions-bearing surface", async () => {
    const driver = new SettingsRouteDriver();
    driver.settingsOpens = false;
    const result = await discoverStreamingSettingsRoute(driver, {
      budgets: { maxActions: 100, maxStates: 30, maxLocalDepth: 4, maxLocalStates: 12, maxDurationMs: 10_000 },
    });

    expect(result.status).toBe("unavailable");
    expect(result.sequence).toBeNull();
    expect(driver.selected).not.toContain("settings-captions");
  });
});
