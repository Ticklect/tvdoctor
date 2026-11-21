import {
  availableObservation,
  unavailableObservation,
  type StateSnapshot,
  type UiNodeSnapshot,
} from "@tvdoctor/protocol";
import { describe, expect, it } from "vitest";

import { fingerprintSnapshot } from "../src/index.js";
import { computeSnapshotFingerprint } from "../src/fingerprint.js";

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
  it("distinguishes numbered episodes on a recycled focus target without a stable ID", () => {
    const base = snapshot({
      location: "https://example.test/episodes",
      focusId: "control-left",
      focusName: "Episode 1",
      volatileText: "Same details template",
    });
    const episode = (name: string): StateSnapshot => ({
      ...base,
      focusedElement: availableObservation({
        stableId: "",
        role: "button",
        name,
        bounds: { x: 100, y: 100, width: 160, height: 64 },
      }),
    });
    expect(fingerprintSnapshot(episode("Episode 1")).stateValue)
      .not.toBe(fingerprintSnapshot(episode("Episode 2")).stateValue);
    expect(fingerprintSnapshot(episode("Episode 1 00:01")).stateValue)
      .toBe(fingerprintSnapshot(episode("Episode 1 00:02")).stateValue);
  });
  it("distinguishes numbered episodes on a recycled focus target with the same stable slot ID", () => {
    const base = snapshot({
      location: "https://example.test/episodes",
      focusId: "recycled-slot-1",
      focusName: "Episode 1",
      volatileText: "Recommendations",
    });
    const episode = (name: string): StateSnapshot => {
      const slot = control("recycled-slot-1", name, true, 100);
      return {
        ...base,
        focusedElement: availableObservation({
          stableId: "recycled-slot-1",
          role: "button",
          name,
          bounds: { x: 100, y: 100, width: 160, height: 64 },
        }),
        uiTree: availableObservation([{
          ...control("episode-list", "Episodes", false, 0),
          role: "list",
          focusable: false,
          children: [slot, control("recycled-slot-2", "Other Episode", false, 300)],
        }]),
      };
    };
    const first = fingerprintSnapshot(episode("Episode 1"));
    const second = fingerprintSnapshot(episode("Episode 2"));
    expect(first.screen.value).toBe(second.screen.value);
    expect(first.focus.value).not.toBe(second.focus.value);
    expect(first.stateValue).not.toBe(second.stateValue);
    expect(fingerprintSnapshot(episode("Episode 1 00:01")).focus.value)
      .toBe(fingerprintSnapshot(episode("Episode 1 00:02")).focus.value);
  });
  it("separates numeric web resource routes even when their controls match", () => {
    const first = fingerprintSnapshot(snapshot({
      location: "https://example.test/title/123?clock=12:01",
      focusId: "control-left",
      focusName: "Play",
      volatileText: "Movie A",
    }));
    const second = fingerprintSnapshot(snapshot({
      location: "https://example.test/title/456?clock=12:02",
      focusId: "control-left",
      focusName: "Play",
      volatileText: "Movie B",
    }));
    expect(first.screen.value).not.toBe(second.screen.value);
    expect(first.stateValue).not.toBe(second.stateValue);
    const firstWithNewClock = fingerprintSnapshot(snapshot({
      location: "https://example.test/title/123?clock=13:59",
      focusId: "control-left",
      focusName: "Play",
      volatileText: "Movie A has loaded",
    }));
    expect(firstWithNewClock.screen.value).toBe(first.screen.value);
  });

  it("separates resource query IDs while ignoring incidental tracking values", () => {
    const make = (location: string) => fingerprintSnapshot(snapshot({
      location,
      focusId: "control-left",
      focusName: "Play",
      volatileText: "A title can change asynchronously",
    }));
    expect(make("https://example.test/watch?video=12").screen.value)
      .not.toBe(make("https://example.test/watch?video=13").screen.value);
    expect(make("https://example.test/watch?video=12&tracking=one").screen.value)
      .toBe(make("https://example.test/watch?video=12&tracking=two").screen.value);
  });
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

  it("distinguishes a material button mode even with the same stable focus ID, but not playback time", () => {
    const player = (name: string): StateSnapshot => snapshot({
      location: "app://player?time=00:15",
      focusId: "player-toggle",
      focusName: name,
      volatileText: "Playing 00:15",
      extraNode: { ...control("player-toggle", name, true, 500), name },
    });
    const playing = fingerprintSnapshot(player("Play 01:15"));
    const playingLater = fingerprintSnapshot(player("Play 01:16"));
    const paused = fingerprintSnapshot(player("Pause 01:16"));

    expect(playing.stateValue).toBe(playingLater.stateValue);
    expect(playing.screen.value).toBe(playingLater.screen.value);
    expect(playing.focus.value).toBe(playingLater.focus.value);
    expect(paused.stateValue).not.toBe(playing.stateValue);
    expect(paused.screen.signals).toContain("action-mode");
    expect(paused.focus.signals).toContain("action-mode");
  });

  it("preserves explicit toggle and choice states without depending on focus movement", () => {
    const toggle = (role: string, selectionState: "on" | "off" | "mixed"): StateSnapshot => snapshot({
      location: "app://settings",
      focusId: "control-left",
      focusName: "Settings",
      volatileText: "Stable",
      extraNode: { ...control("captions-choice", "Closed captions", false, 500), role, selectionState },
    });
    for (const role of ["switch", "checkbox", "radio", "tab", "button"]) {
      const off = fingerprintSnapshot(toggle(role, "off"));
      const on = fingerprintSnapshot(toggle(role, "on"));
      expect(on.screen.value, role).not.toBe(off.screen.value);
      expect(on.focus.value, role).toBe(off.focus.value);
      expect(on.stateValue, role).not.toBe(off.stateValue);
      expect(on.screen.signals).toContain("selection-state");
    }
  });

  it("distinguishes explicit navigation query and hash routes, not incidental clock or fragment data", () => {
    const at = (location: string) => fingerprintSnapshot(snapshot({
      location,
      focusId: "control-left",
      focusName: "Left",
      volatileText: "Clock 10:15",
    }));
    expect(at("app://home?tab=settings").screen.value).not.toBe(at("app://home?tab=player").screen.value);
    expect(at("app://home?page=1").screen.value).not.toBe(at("app://home?page=2").screen.value);
    expect(at("app://home?route=account").screen.value).not.toBe(at("app://home?route=search").screen.value);
    expect(at("app://home#/settings").screen.value).not.toBe(at("app://home#/player").screen.value);
    expect(at("app://home#/player/12?tab=details&t=00:10").screen.value)
      .not.toBe(at("app://home#/player/12?tab=chapters&t=00:11").screen.value);
    expect(at("app://home#/player/12?tab=details&t=00:10").screen.value)
      .toBe(at("app://home#/player/12?t=00:11&tab=details").screen.value);
    expect(at("app://home?tab=settings&clock=10:15").screen.value)
      .toBe(at("app://home?clock=10:16&tab=settings#frame-23").screen.value);
    expect(at("app://home?tab=settings&mode=edit").screen.value)
      .toBe(at("app://home?mode=edit&tab=settings").screen.value);
    expect(at("app://home?clock=10:15#frame-23").screen.value)
      .toBe(at("app://home?clock=10:16#frame-24").screen.value);
  });

  it("bounds parsing and identity length for 100k-character untrusted selectors without merging distinct suffixes", () => {
    const originalParser = globalThis.URLSearchParams;
    let largestParsedQuery = 0;
    globalThis.URLSearchParams = new Proxy(originalParser, {
      construct(target, args, newTarget) {
        if (typeof args[0] === "string") largestParsedQuery = Math.max(largestParsedQuery, args[0].length);
        return Reflect.construct(target, args, newTarget) as URLSearchParams;
      },
    });
    try {
      const payload = "x".repeat(100_000);
      const changedMiddle = `${payload.slice(0, 50_000)}y${payload.slice(50_001)}`;
      const at = (query: string) => computeSnapshotFingerprint(snapshot({
        location: `app://home?tab=settings&payload=${query}`,
        focusId: "control-left",
        focusName: "Left",
        volatileText: "Clock 10:15",
      }));
      const original = at(payload);
      const identical = at(payload);
      const changed = at(changedMiddle);
      const hashRoute = computeSnapshotFingerprint(snapshot({
        location: `app://home#/settings?tab=details&payload=${payload}`,
        focusId: "control-left",
        focusName: "Left",
        volatileText: "Stable",
      }));

      expect(original.stateIdentity).toBe(identical.stateIdentity);
      expect(changed.stateIdentity).not.toBe(original.stateIdentity);
      expect(original.screenIdentity).toContain("!oversized:");
      expect(hashRoute.screenIdentity).toContain("!oversized:");
      expect(original.screenIdentity.length).toBeLessThan(1_000);
      expect(hashRoute.screenIdentity.length).toBeLessThan(1_000);
      expect(largestParsedQuery).toBeLessThanOrEqual(4_096);
    } finally {
      globalThis.URLSearchParams = originalParser;
    }
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

  it("keeps duplicate accessible labels distinct when stable focus IDs differ", () => {
    const first = snapshot({
      location: "app://catalog",
      focusId: "catalog-card-alpha",
      focusName: "Watch",
      volatileText: "Stable",
    });
    const second = {
      ...first,
      focusedElement: availableObservation({
        stableId: "catalog-card-beta",
        role: "button",
        name: "Watch",
        bounds: { x: 300, y: 100, width: 160, height: 64 },
      }),
    } satisfies StateSnapshot;

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

  it("does not split virtualised collection rebindings when card selection and labels change", () => {
    const collection = (selected: number, labels: readonly string[]): StateSnapshot => {
      const base = snapshot({
        location: "app://catalog",
        focusId: "movie-1",
        focusName: labels[0] ?? "Movie",
        volatileText: "Rotating recommendations",
      });
      const children = labels.map((label, index) => ({
        ...control(`movie-${String(index + 1)}`, label, index === 0, 100 + index * 180),
        selectionState: index === selected ? "on" as const : "off" as const,
      }));
      return {
        ...base,
        uiTree: availableObservation([{
          ...control("movie-rail", "Rail", false, 0),
          role: "list",
          focusable: false,
          children,
        }]),
      };
    };
    const first = fingerprintSnapshot(collection(0, ["Movie A", "Movie B"]));
    const rebound = fingerprintSnapshot(collection(1, ["Movie C", "Movie D"]));
    expect(first.screen.value).toBe(rebound.screen.value);
  });

  it("retains material choices inside static settings lists, including repeated row wrappers", () => {
    const settings = (captions: "on" | "off", autoplay: "on" | "off"): StateSnapshot => {
      const base = snapshot({
        location: "app://settings",
        focusId: "control-left",
        focusName: "Settings",
        volatileText: "Stable",
      });
      const rows = [
        { id: "row-1", controlId: "captions-switch", name: "Captions", selection: captions },
        { id: "row-2", controlId: "autoplay-switch", name: "Autoplay", selection: autoplay },
      ];
      return {
        ...base,
        uiTree: availableObservation([{
          ...control("settings-list", "Settings", false, 0),
          role: "list",
          focusable: false,
          children: rows.map((row, index) => ({
            ...control(row.id, row.name, false, index * 120),
            role: "group",
            focusable: false,
            children: [{
              ...control(row.controlId, row.name, false, index * 120),
              role: "switch",
              selectionState: row.selection,
            }],
          })),
        }]),
      };
    };
    const bothOff = fingerprintSnapshot(settings("off", "off"));
    const captionsOn = fingerprintSnapshot(settings("on", "off"));
    const autoplayOn = fingerprintSnapshot(settings("off", "on"));

    expect(captionsOn.screen.value).not.toBe(bothOff.screen.value);
    expect(autoplayOn.screen.value).not.toBe(bothOff.screen.value);
    expect(captionsOn.screen.value).not.toBe(autoplayOn.screen.value);
    expect(captionsOn.focus.value).toBe(bothOff.focus.value);
    expect(captionsOn.screen.signals).toContain("selection-state");
  });

  it("lowers identity confidence when a large UI tree exceeds the fingerprint observation limit", () => {
    const base = snapshot({
      location: "app://catalog",
      focusId: "control-left",
      focusName: "Left",
      volatileText: "Stable",
    });
    const root = {
      ...control("large-menu", "Menu", false, 0),
      focusable: false,
      children: Array.from({ length: 2_100 }, (_, index) => control(`action-${String(index)}`, "Action", false, index)),
    };
    const result = fingerprintSnapshot({ ...base, uiTree: availableObservation([root]) });
    expect(result.screen.signals).toContain("truncated");
    expect(result.screen.confidence).not.toBe("high");
    expect(result.confidence).not.toBe("high");
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
