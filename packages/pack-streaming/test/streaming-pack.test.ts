import {
  availableObservation,
  unavailableObservation,
  type ActionResult,
  type FocusTarget,
  type RemoteKey,
  type StateSnapshot,
  type TVDoctorDriver,
  type UiNodeSnapshot,
} from "@tvdoctor/protocol";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_STREAMING_PACK_BUDGETS,
  STREAMING_STAGE_NAMES,
  STREAMING_UI_TREE_LIMITS,
  flattenUiTree,
  focusMatchesNode,
  isSafeStreamingCandidate,
  nodeMatchesStreamingDescriptor,
  playbackProgressObservation,
  rankSemanticCandidates,
  runStreamingPack,
  selectedCaptionTrack,
  semanticStateIdentity,
  type StreamingPackBudgets,
  type StreamingPackOptions,
  type StreamingPointerProbe,
} from "../src/index.js";

type Screen = "appearance" | "captions" | "details" | "home" | "player" | "settings";
type Variant = "conventional" | "variant";

interface FakeState {
  caption: "english" | "off" | "unexpected";
  ambiguousProgress: boolean;
  elapsed: number;
  focus: string;
  playing: boolean;
  rewindName: string;
  screen: Screen;
}

interface FakeDriverOptions {
  readonly ambiguousProgress?: boolean;
  readonly captionSelectionOutcome?: "ignored" | "unexpected" | "works";
  readonly rewindName?: string;
  readonly settingsOpens?: boolean;
}

interface ControlDefinition {
  readonly id: string;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly focusable?: boolean;
  readonly selected?: "off" | "on";
}

const bounds = (x: number, y: number, width = 180, height = 54) => ({
  x,
  y,
  width,
  height,
});

function node(
  values: Partial<UiNodeSnapshot> & Pick<UiNodeSnapshot, "role">,
  children: readonly UiNodeSnapshot[] = [],
): UiNodeSnapshot {
  return {
    stableId: null,
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
    children,
    ...values,
  };
}

function semanticSnapshot(
  roots: readonly UiNodeSnapshot[],
  focus: FocusTarget | null = null,
): StateSnapshot {
  return {
    capturedAt: "2026-01-01T00:00:00.000Z",
    location: availableObservation("https://example.invalid/semantic"),
    focusedElement: availableObservation(focus),
    uiTree: availableObservation(roots),
  };
}

function control(definition: ControlDefinition, state: FakeState): UiNodeSnapshot {
  const selectionState: UiNodeSnapshot["selectionState"] = definition.id === "player-toggle"
    ? state.playing ? "on" : "off"
    : definition.id === "captions-off"
      ? state.caption === "off" ? "on" : "off"
      : definition.id === "captions-english"
        ? state.caption === "english" ? "on" : state.caption === "unexpected" ? "mixed" : "off"
        : definition.selected ?? null;
  const name = definition.id === "player-toggle"
    ? state.playing ? "Pause" : "Play"
    : definition.name;
  return node({
    stableId: definition.id,
    role: "button",
    name,
    bounds: bounds(definition.x, definition.y),
    focusable: definition.focusable ?? true,
    focused: state.focus === definition.id,
    selectionState,
  });
}

function controlsFor(state: FakeState, variant: Variant): readonly ControlDefinition[] {
  switch (state.screen) {
    case "home":
      return [
        { id: "home-anchor", name: "Home", x: 20, y: 80 },
        { id: "subscribe-danger", name: "Subscribe and confirm purchase", x: 20, y: 150 },
        ...(variant === "variant" ? [{ id: "home-filler", name: "Featured", x: 250, y: 170 }] : []),
        { id: "safe-content", name: "Explore film", x: 360, y: 80 },
      ];
    case "details":
      return [
        { id: "details-play", name: "Play", x: 360, y: 400 },
        { id: "details-trailer", name: "Trailer", x: 570, y: 400 },
      ];
    case "player":
      return [
        { id: "player-rewind", name: state.rewindName, x: 200, y: 600 },
        { id: "player-toggle", name: "Pause", x: 400, y: 600 },
        { id: "player-forward", name: "Forward 10 seconds", x: 600, y: 600 },
        { id: "player-captions", name: "Captions CC", x: 800, y: 600 },
        { id: "player-settings", name: "Settings", x: 1000, y: 600 },
        { id: "player-volume", name: "Boost dialogue", x: 1200, y: 600, focusable: false },
      ];
    case "settings":
      return [
        { id: "settings-captions", name: "Captions Off", x: 1050, y: 180 },
        { id: "settings-audio", name: "Audio English 5.1", x: 1050, y: 250 },
        { id: "settings-quality", name: "Picture quality Auto", x: 1050, y: 320 },
      ];
    case "captions":
      return [
        { id: "captions-off", name: "Off Current selection", x: 920, y: 170 },
        { id: "captions-english", name: "English CC Closed captions", x: 920, y: 240 },
        { id: "captions-spanish", name: "Español Subtitles", x: 920, y: 310 },
        { id: "captions-appearance", name: "Appearance Font colour and background", x: 920, y: 380 },
      ];
    case "appearance":
      return [
        { id: "caption-font", name: "Font Size Medium", x: 920, y: 170 },
        { id: "caption-text-colour", name: "Text Colour Warm white", x: 920, y: 240, focusable: false },
        { id: "caption-background", name: "Background Colour Black", x: 920, y: 310 },
        { id: "caption-edge", name: "Edge Style Soft shadow", x: 920, y: 380 },
      ];
  }
}

function treeFor(state: FakeState, variant: Variant): readonly UiNodeSnapshot[] {
  const controls = controlsFor(state, variant).map((definition) => control(definition, state));
  const rootBounds = bounds(0, 0, 1280, 720);
  switch (state.screen) {
    case "home":
      return [node({ role: "document", bounds: rootBounds }, [
        node({ role: "main", name: "Home", bounds: rootBounds }, [
          node({ role: "heading", name: "Featured films" }),
          ...controls,
        ]),
      ])];
    case "details":
      return [node({ role: "document", bounds: rootBounds }, [
        node({ role: "main", name: "Film details", bounds: rootBounds }, [
          node({ role: "heading", name: "An original feature film" }),
          ...controls,
        ]),
      ])];
    case "player":
      return [node({ role: "document", bounds: rootBounds }, [
        node({ role: "main", name: "Playing an original feature film", bounds: rootBounds }, [
          node({ role: "section", name: "Player controls", bounds: bounds(0, 500, 1280, 220) }, [
            node({
              stableId: "player-position",
              role: "progressbar",
              name: "Playback position",
              bounds: bounds(100, 540, 1080, 14),
              valueNow: state.elapsed,
            }),
            ...(state.ambiguousProgress ? [node({
              stableId: "secondary-player-position",
              role: "progressbar",
              name: "Secondary playback position",
              bounds: bounds(100, 565, 1080, 14),
              valueNow: state.elapsed + 50,
            })] : []),
            ...controls,
          ]),
        ]),
      ])];
    case "settings":
      return [node({ role: "document", bounds: rootBounds }, [
        node({ role: "main", name: "Playing an original feature film", bounds: rootBounds }),
        node({ role: "dialog", name: "Player settings", modal: true, bounds: rootBounds }, [
          node({ role: "complementary", name: "While watching settings", bounds: bounds(1040, 80, 330, 560) }, controls),
        ]),
      ])];
    case "captions":
      return [node({ role: "document", bounds: rootBounds }, [
        node({ role: "dialog", name: "Captions", modal: true, bounds: rootBounds }, [
          node({ role: "heading", name: "Player settings Captions" }),
          ...controls,
        ]),
      ])];
    case "appearance":
      return [node({ role: "document", bounds: rootBounds }, [
        node({ role: "dialog", name: "Caption Appearance", modal: true, bounds: rootBounds }, [
          node({ role: "heading", name: "Captions Appearance" }),
          ...controls,
        ]),
      ])];
  }
}

const conventionalEdges: Readonly<Record<Screen, Readonly<Record<string, Partial<Record<RemoteKey, string>>>>>> = {
  home: {
    "home-anchor": { RIGHT: "safe-content", DOWN: "subscribe-danger" },
    "subscribe-danger": { UP: "home-anchor", RIGHT: "safe-content" },
    "safe-content": { LEFT: "home-anchor" },
  },
  details: {
    "details-play": { RIGHT: "details-trailer" },
    "details-trailer": { LEFT: "details-play" },
  },
  player: {
    "player-rewind": { RIGHT: "player-toggle" },
    "player-toggle": { LEFT: "player-rewind", RIGHT: "player-forward" },
    "player-forward": { LEFT: "player-toggle", RIGHT: "player-captions" },
    "player-captions": { LEFT: "player-forward", RIGHT: "player-settings" },
    "player-settings": { LEFT: "player-captions" },
  },
  settings: {
    "settings-captions": { DOWN: "settings-audio" },
    "settings-audio": { UP: "settings-captions", DOWN: "settings-quality" },
    "settings-quality": { UP: "settings-audio" },
  },
  captions: {
    "captions-off": { DOWN: "captions-english" },
    "captions-english": { UP: "captions-off", DOWN: "captions-spanish" },
    "captions-spanish": { UP: "captions-english", DOWN: "captions-appearance" },
    "captions-appearance": { UP: "captions-spanish" },
  },
  appearance: {
    "caption-font": { DOWN: "caption-background" },
    "caption-background": { UP: "caption-font", DOWN: "caption-edge" },
    "caption-edge": { UP: "caption-background" },
  },
};

const variantEdges: typeof conventionalEdges = {
  home: {
    "home-anchor": { DOWN: "home-filler" },
    "home-filler": { UP: "home-anchor", LEFT: "safe-content" },
    "safe-content": { RIGHT: "home-filler" },
    "subscribe-danger": {},
  },
  details: {
    "details-trailer": { DOWN: "details-play" },
    "details-play": { UP: "details-trailer" },
  },
  player: {
    "player-toggle": { DOWN: "player-forward" },
    "player-forward": { UP: "player-toggle", RIGHT: "player-rewind" },
    "player-rewind": { LEFT: "player-forward", DOWN: "player-captions" },
    "player-captions": { UP: "player-rewind", LEFT: "player-settings" },
    "player-settings": { RIGHT: "player-captions" },
  },
  settings: {
    "settings-audio": { UP: "settings-captions" },
    "settings-captions": { DOWN: "settings-audio" },
    "settings-quality": { UP: "settings-audio" },
  },
  captions: {
    "captions-off": { RIGHT: "captions-spanish" },
    "captions-spanish": { LEFT: "captions-off", DOWN: "captions-english" },
    "captions-english": { UP: "captions-spanish", LEFT: "captions-appearance" },
    "captions-appearance": { RIGHT: "captions-english" },
  },
  appearance: {
    "caption-edge": { LEFT: "caption-background" },
    "caption-background": { RIGHT: "caption-edge", UP: "caption-font" },
    "caption-font": { DOWN: "caption-background" },
  },
};

class StreamingFakeDriver implements TVDoctorDriver {
  private readonly variant: Variant;
  private readonly uiObservable: boolean;
  private readonly captionSelectionOutcome: "ignored" | "unexpected" | "works";
  private readonly options: FakeDriverOptions;
  readonly selectedIds: string[] = [];
  pressCount = 0;
  resetCount = 0;
  snapshotCount = 0;
  private state: FakeState;

  constructor(
    variant: Variant,
    uiObservable = true,
    captionSelectionWorks = false,
    options: FakeDriverOptions = {},
  ) {
    this.variant = variant;
    this.uiObservable = uiObservable;
    this.options = options;
    this.captionSelectionOutcome = options.captionSelectionOutcome
      ?? (captionSelectionWorks ? "works" : "ignored");
    this.state = this.initialState();
  }

  private initialState(): FakeState {
    return {
      ambiguousProgress: this.options.ambiguousProgress ?? false,
      caption: "off",
      elapsed: 100,
      focus: "home-anchor",
      playing: false,
      rewindName: this.options.rewindName ?? "Rewind 10 seconds",
      screen: "home",
    };
  }

  async capabilities() {
    return new Set(["remote-input", "ui-tree"] as const);
  }

  async reset(): Promise<void> {
    this.resetCount += 1;
    this.state = this.initialState();
  }

  async press(key: RemoteKey): Promise<ActionResult> {
    this.pressCount += 1;
    const inputSentAtMs = this.pressCount * 10;
    if (key === "SELECT") this.select();
    else if (key === "BACK") this.back();
    else {
      const edges = this.variant === "conventional" ? conventionalEdges : variantEdges;
      this.state.focus = edges[this.state.screen][this.state.focus]?.[key] ?? this.state.focus;
    }
    return {
      key,
      outcome: "applied",
      timing: {
        inputSentAtMs,
        firstResponseAtMs: inputSentAtMs + 4,
        focusSettledAtMs: inputSentAtMs + 8,
        screenSettledAtMs: inputSentAtMs + (this.state.screen === "settings" ? 1_400 : 12),
      },
    };
  }

  private select(): void {
    this.selectedIds.push(this.state.focus);
    switch (this.state.focus) {
      case "subscribe-danger":
        throw new Error("The destructive subscription control must never be selected.");
      case "safe-content":
        this.state.screen = "details";
        this.state.focus = this.variant === "conventional" ? "details-play" : "details-trailer";
        break;
      case "details-play":
        this.state.screen = "player";
        this.state.focus = "player-toggle";
        this.state.playing = true;
        break;
      case "player-toggle":
        this.state.playing = !this.state.playing;
        break;
      case "player-forward":
        this.state.elapsed += 10;
        break;
      case "player-rewind":
        this.state.elapsed += 10;
        break;
      case "player-settings":
        if (this.options.settingsOpens !== false) {
          this.state.screen = "settings";
          this.state.focus = this.variant === "conventional" ? "settings-captions" : "settings-audio";
        }
        break;
      case "settings-captions":
      case "player-captions":
        this.state.screen = "captions";
        this.state.focus = "captions-off";
        break;
      case "captions-off":
        this.state.caption = "off";
        break;
      case "captions-english":
        if (this.captionSelectionOutcome === "works") this.state.caption = "english";
        if (this.captionSelectionOutcome === "unexpected") this.state.caption = "unexpected";
        break;
      case "captions-appearance":
        this.state.screen = "appearance";
        this.state.focus = this.variant === "conventional" ? "caption-font" : "caption-edge";
        break;
      default:
        break;
    }
  }

  private back(): void {
    switch (this.state.screen) {
      case "appearance":
        this.state.screen = "captions";
        this.state.focus = "captions-appearance";
        break;
      case "captions":
        this.state.screen = "settings";
        this.state.focus = "settings-captions";
        break;
      case "settings":
        this.state.screen = "player";
        this.state.focus = "player-settings";
        break;
      case "player":
        this.state.screen = "details";
        this.state.focus = "details-play";
        break;
      case "details":
      case "home":
        break;
    }
  }

  async snapshot(): Promise<StateSnapshot> {
    this.snapshotCount += 1;
    const definitions = controlsFor(this.state, this.variant);
    const current = definitions.find((definition) => definition.id === this.state.focus);
    return {
      capturedAt: new Date(this.snapshotCount * 1_000).toISOString(),
      location: unavailableObservation("Route intentionally unavailable in semantic-pack tests."),
      focusedElement: availableObservation(current === undefined ? null : {
        stableId: current.id,
        role: "button",
        name: current.id === "player-toggle"
          ? this.state.playing ? "Pause" : "Play"
          : current.name,
        bounds: bounds(current.x, current.y),
      }),
      uiTree: this.uiObservable
        ? availableObservation(treeFor(this.state, this.variant))
        : unavailableObservation("Fake platform has no UI tree."),
    };
  }
}

const reachablePointer: StreamingPointerProbe = {
  async probe(request) {
    expect(request.surfaceSequence.length).toBeGreaterThan(0);
    return {
      status: "reachable",
      detail: `The isolated fake pointer activated ${request.kind}.`,
      observedChange: request.kind === "caption-text-colour"
        ? { property: "caption colour", before: "warm white", after: "soft gold" }
        : { property: "dialogue boost", before: "off", after: "on" },
    };
  },
};

describe("runStreamingPack", () => {
  it("completes the showcase journey, finds four deterministic defects, and replays Text Colour", async () => {
    const driver = new StreamingFakeDriver("conventional");
    const result = await runStreamingPack(driver, { pointerProbe: reachablePointer });
    expect(result.issues.map((issue) => issue.id)).toEqual([
      "TVDOCTOR-STREAM-446E4CCB9588B987D46DCCF9B8A6E09B",
      "TVDOCTOR-STREAM-E6630F42861E67BE113C6544F740E2F2",
      "TVDOCTOR-STREAM-A3CF65BCE3D499A07C8F14960385A88C",
      "TVDOCTOR-STREAM-E0054201CF3672C5F256058B2DB21671",
    ]);

    expect(result.status).toBe("complete");
    expect(result.termination).toMatchObject({ reason: "complete", complete: true });
    expect(result.stages).toHaveLength(17);
    expect(result.stages.map((stageResult) => stageResult.stage)).toEqual(STREAMING_STAGE_NAMES);
    expect(result.stages.find((stage) => stage.stage === "caption-text-colour")).toMatchObject({
      status: "failed",
    });
    expect(result.issues.map((issue) => issue.rule)).toEqual([
      "accessibility.pointer-only-control",
      "streaming.player-control",
      "streaming.captions",
      "remote.reachability",
    ]);
    expect(result.issues.every((issue) => issue.confidence === "deterministic")).toBe(true);
    const textIssue = result.issues.find((issue) => issue.rule === "remote.reachability");
    expect(textIssue?.description).toContain("pointer reachable");
    expect(textIssue?.reproduction.status).toBe("available");
    expect(textIssue?.reproduction.status === "available"
      ? textIssue.reproduction.originalSequence.at(-1)
      : null).toMatchObject({ key: "DOWN", repeat: 1 });
    expect(result.replays).toEqual(expect.arrayContaining([
      expect.objectContaining({ issueId: textIssue?.id, status: "reproduced" }),
      expect.objectContaining({
        issueId: result.issues.find((issue) => issue.rule === "accessibility.pointer-only-control")?.id,
        status: "reproduced",
      }),
    ]));
    expect(result.pointerProbes.map((record) => record.kind)).toEqual([
      "player-volume-control",
      "caption-text-colour",
    ]);
    expect(result.pointerProbes.every((record) => record.mainSessionRestored)).toBe(true);
    expect(result.volumeControl).toMatchObject({
      remotelyReachable: false,
      activation: "observed",
      element: { name: "Boost dialogue" },
    });
    expect(result.appearanceControls).toHaveLength(4);
    expect(result.appearanceControls.find((controlResult) => (
      controlResult.element.name?.includes("Text Colour")
    ))).toMatchObject({ remotelyReachable: false, exactSequence: null });
    expect(result.appearanceControls.filter((controlResult) => (
      controlResult.remotelyReachable
    ))).toHaveLength(3);
    expect(result.statistics.physicalActions).toBe(driver.pressCount);
    expect(result.statistics.replayActions).toBeGreaterThan(0);
    expect(result.statistics.resets).toBe(driver.resetCount);
    expect(driver.selectedIds).not.toContain("subscribe-danger");
  });

  it("discovers a semantically identical journey with unrelated directional routes", async () => {
    const conventional = await runStreamingPack(
      new StreamingFakeDriver("conventional"),
      { pointerProbe: reachablePointer },
    );
    const variantDriver = new StreamingFakeDriver("variant");
    const variant = await runStreamingPack(variantDriver, { pointerProbe: reachablePointer });

    expect(variant.status, JSON.stringify({
      termination: variant.termination,
      stages: variant.stages,
      issues: variant.issues.map((issue) => issue.rule),
      stats: variant.statistics,
    })).toBe("complete");
    expect(variant.issues.map((issue) => issue.rule).sort()).toEqual(
      conventional.issues.map((issue) => issue.rule).sort(),
    );
    expect(Object.fromEntries(variant.issues.map((issue) => [issue.rule, issue.id]))).toEqual(
      Object.fromEntries(conventional.issues.map((issue) => [issue.rule, issue.id])),
    );
    expect(variant.journeySequence).not.toEqual(conventional.journeySequence);
    expect(variant.stages.find((stage) => stage.stage === "content")?.sequence).toEqual([
      "DOWN",
      "LEFT",
    ]);
    const sequenceFor = (result: Awaited<ReturnType<typeof runStreamingPack>>, stageName: string) => (
      result.stages.find((stageResult) => stageResult.stage === stageName)?.sequence ?? []
    );
    const routeProfile = (result: Awaited<ReturnType<typeof runStreamingPack>>) => {
      const player = sequenceFor(result, "player");
      const captionsStage = sequenceFor(result, "captions");
      return [
        sequenceFor(result, "content"),
        sequenceFor(result, "settings").slice(player.length, -1),
        sequenceFor(result, "appearance").slice(captionsStage.length, -1),
      ];
    };
    const conventionalRoutes = routeProfile(conventional);
    const variantRoutes = routeProfile(variant);
    expect(variantRoutes.filter((route, index) => (
      JSON.stringify(route) !== JSON.stringify(conventionalRoutes[index])
    ))).toHaveLength(3);
    expect(variantDriver.selectedIds).not.toContain("subscribe-danger");
  });

  it("counts every press and stops exactly at the global physical-input budget", async () => {
    const driver = new StreamingFakeDriver("variant");
    const result = await runStreamingPack(driver, {
      budgets: { maxActions: 5 },
      pointerProbe: reachablePointer,
    });

    expect(result.status, JSON.stringify({
      termination: result.termination,
      stages: result.stages,
      stats: result.statistics,
    })).toBe("error");
    expect(result.termination.reason).toBe("max-actions");
    expect(result.statistics.physicalActions).toBe(5);
    expect(driver.pressCount).toBe(5);
    expect(result.stages.some((stage) => stage.status === "skipped")).toBe(true);
  });

  it("returns unobservable rather than a false failure when the UI tree is unavailable", async () => {
    const driver = new StreamingFakeDriver("conventional", false);
    const result = await runStreamingPack(driver);

    expect(result.status).toBe("unobservable");
    expect(result.termination).toMatchObject({
      reason: "ui-tree-unavailable",
      complete: false,
    });
    expect(result.issues).toEqual([]);
  });

  it("keeps remote proof conservative when the isolated pointer hook fails", async () => {
    const driver = new StreamingFakeDriver("conventional");
    const result = await runStreamingPack(driver, {
      pointerProbe: {
        async probe() {
          throw new Error("Pointer automation unavailable");
        },
      },
    });

    expect(result.status).toBe("partial");
    expect(result.termination.reason).toBe("journey-partial");
    expect(result.pointerProbes).toHaveLength(2);
    expect(result.pointerProbes.every((record) => (
      record.result.status === "error" && record.result.detail === "Pointer automation unavailable"
    ))).toBe(true);
    expect(result.issues.some((candidate) => (
      candidate.rule === "remote.reachability"
      || candidate.rule === "accessibility.pointer-only-control"
    ))).toBe(false);
    expect(result.replays).toEqual([]);
  });

  it("observes a working caption selection and restores the original track", async () => {
    const driver = new StreamingFakeDriver("conventional", true, true);
    const result = await runStreamingPack(driver, { pointerProbe: reachablePointer });

    expect(result.status, JSON.stringify({
      termination: result.termination,
      stages: result.stages,
      issues: result.issues.map((issue) => issue.rule),
      statistics: result.statistics,
    })).toBe("complete");
    expect(result.stages.find((stage) => stage.stage === "caption-selection")?.status).toBe("passed");
    expect(result.issues.some((issue) => issue.rule === "streaming.captions")).toBe(false);
    expect(driver.selectedIds.filter((id) => id === "captions-english")).toHaveLength(1);
    expect(driver.selectedIds.filter((id) => id === "captions-off").length).toBeGreaterThan(0);
  });

  it("does not bypass a self-looping Settings control through direct Player captions", async () => {
    const driver = new StreamingFakeDriver(
      "conventional",
      true,
      false,
      { settingsOpens: false },
    );
    const result = await runStreamingPack(driver, { pointerProbe: reachablePointer });

    expect(result.status).toBe("partial");
    expect(result.stages.find((stageResult) => stageResult.stage === "settings")).toMatchObject({
      status: "partial",
      detail: expect.stringContaining("no distinct semantic player-settings surface"),
    });
    expect(result.stages.find((stageResult) => stageResult.stage === "captions")?.status).toBe("skipped");
    expect(driver.selectedIds.filter((id) => id === "player-settings")).toHaveLength(1);
    expect(driver.selectedIds).not.toContain("player-captions");
  });

  it("withholds rewind classification when playback progress provenance is ambiguous", async () => {
    const driver = new StreamingFakeDriver(
      "conventional",
      true,
      false,
      { ambiguousProgress: true },
    );
    const result = await runStreamingPack(driver, { pointerProbe: reachablePointer });

    expect(result.stages.find((stageResult) => stageResult.stage === "seek-backward")).toMatchObject({
      status: "unobservable",
      detail: expect.stringContaining("uniquely correlated"),
    });
    expect(result.issues.some((issue) => issue.rule === "streaming.player-control")).toBe(false);
  });

  it("does not call an unexpected partial caption-state change the ignored-selection defect", async () => {
    const driver = new StreamingFakeDriver(
      "conventional",
      true,
      false,
      { captionSelectionOutcome: "unexpected" },
    );
    const result = await runStreamingPack(driver, { pointerProbe: reachablePointer });

    expect(result.status).toBe("partial");
    expect(result.stages.find((stageResult) => stageResult.stage === "caption-selection")).toMatchObject({
      status: "partial",
      detail: expect.stringContaining("not classified as the ignored-selection defect"),
    });
    expect(result.issues.some((issue) => issue.rule === "streaming.captions")).toBe(false);
  });

  it("keeps issue IDs route-stable but distinguishes changed semantic targets", async () => {
    const baseline = await runStreamingPack(
      new StreamingFakeDriver("conventional"),
      { pointerProbe: reachablePointer },
    );
    const alternateRoute = await runStreamingPack(
      new StreamingFakeDriver("variant"),
      { pointerProbe: reachablePointer },
    );
    const changedTarget = await runStreamingPack(
      new StreamingFakeDriver(
        "conventional",
        true,
        false,
        { rewindName: "Seek backward 30 seconds" },
      ),
      { pointerProbe: reachablePointer },
    );
    const issueFor = (result: Awaited<ReturnType<typeof runStreamingPack>>, rule: string) => (
      result.issues.find((issue) => issue.rule === rule)
    );

    expect(issueFor(alternateRoute, "streaming.player-control")?.id).toBe(
      issueFor(baseline, "streaming.player-control")?.id,
    );
    expect(issueFor(changedTarget, "streaming.player-control")?.id).not.toBe(
      issueFor(baseline, "streaming.player-control")?.id,
    );
  });
});

describe("streaming semantic hardening", () => {
  it("keeps checkpoint identity stable across bounds-only focus drift", () => {
    const snapshot = (
      name: string,
      role: string,
      stableId: string | null,
      geometry: ReturnType<typeof bounds>,
    ): StateSnapshot => {
      const focus: FocusTarget = {
        ...(stableId === null ? {} : { stableId }),
        role,
        name,
        bounds: geometry,
      };
      return semanticSnapshot([
        node({ role: "main", name: "Featured films" }, [
          node({
            stableId,
            role,
            name,
            bounds: geometry,
            focusable: true,
            focused: true,
          }),
        ]),
      ], focus);
    };

    const baselineBounds = bounds(240, 80, 220, 180);
    const driftedBounds = bounds(244, 76, 225, 176);
    const baseline = semanticStateIdentity(snapshot(
      "Open The Quiet Signal details",
      "button",
      "content-card",
      baselineBounds,
    ));
    expect(semanticStateIdentity(snapshot(
      "Open The Quiet Signal details",
      "button",
      "content-card",
      driftedBounds,
    )))
      .toBe(baseline);
    expect(semanticStateIdentity(snapshot(
      "Open A Different Film details",
      "button",
      "content-card",
      driftedBounds,
    )))
      .not.toBe(baseline);
    expect(semanticStateIdentity(snapshot(
      "Open The Quiet Signal details",
      "link",
      "content-card",
      driftedBounds,
    )))
      .not.toBe(baseline);
    expect(semanticStateIdentity(snapshot(
      "Open The Quiet Signal details",
      "button",
      "different-card",
      driftedBounds,
    ))).not.toBe(baseline);

    const withoutStableId = semanticStateIdentity(snapshot(
      "Open The Quiet Signal details",
      "button",
      null,
      baselineBounds,
    ));
    expect(semanticStateIdentity(snapshot(
      "Open The Quiet Signal details",
      "button",
      null,
      bounds(400, 80, 220, 180),
    ))).not.toBe(withoutStableId);
  });

  it("uses a positive content-action allowlist and recognises CC as a token", () => {
    const vote = node({
      stableId: "vote",
      role: "button",
      name: "Vote for this title",
      focusable: true,
    });
    const details = node({
      stableId: "details",
      role: "button",
      name: "Open The Quiet Signal details",
      focusable: true,
    });
    const titleOnly = node({
      stableId: "title-only",
      role: "button",
      name: "The Quiet Signal",
      focusable: true,
    });
    const addToWatchlist = node({
      stableId: "watchlist",
      role: "button",
      name: "Add to watchlist",
      focusable: true,
    });
    const home = semanticSnapshot([
      node({ role: "main", name: "Featured films" }, [
        vote,
        details,
        titleOnly,
        addToWatchlist,
      ]),
    ]);
    const cc = node({
      stableId: "cc-on",
      role: "button",
      name: "CC On",
      focusable: true,
    });
    const playerSettings = semanticSnapshot([
      node({ role: "dialog", name: "Player settings", modal: true }, [cc]),
    ]);

    expect(rankSemanticCandidates(home, "content").map((candidate) => candidate.node.stableId).sort())
      .toEqual(["details", "title-only"]);
    expect(rankSemanticCandidates(playerSettings, "captions").map((candidate) => candidate.node.stableId))
      .toEqual(["cc-on"]);
  });

  it("fails closed when a previously known descriptor or focus loses role/name provenance", () => {
    const descriptor = {
      stableId: "play",
      role: "button",
      name: "Play",
      bounds: bounds(0, 0),
      visible: true,
      enabled: true,
      focusable: true,
      selectionState: null,
      valueNow: null,
    } as const;
    const missingName = node({
      stableId: "play",
      role: "button",
      name: null,
      bounds: bounds(0, 0),
      focusable: true,
    });
    const missingRole = node({
      stableId: "play",
      role: null,
      name: "Play",
      bounds: bounds(0, 0),
      focusable: true,
    });

    expect(nodeMatchesStreamingDescriptor(missingName, descriptor)).toBe(false);
    expect(nodeMatchesStreamingDescriptor(missingRole, descriptor)).toBe(false);
    expect(focusMatchesNode({ stableId: "play", role: "button", name: "Play" }, missingName)).toBe(false);
    expect(focusMatchesNode({ stableId: "play", role: "button", name: "Play" }, missingRole)).toBe(false);
  });

  it("requires one playback progress source and correlates the same provenance after action", () => {
    const progress = (stableId: string, valueNow: number) => node({
      stableId,
      role: "progressbar",
      name: "Playback position",
      bounds: bounds(100, 540, 1_000, 14),
      valueNow,
    });
    const player = (children: readonly UiNodeSnapshot[]) => semanticSnapshot([
      node({ role: "main", name: "Playing a feature film" }, [
        node({ role: "section", name: "Player controls" }, children),
      ]),
    ]);
    const before = playbackProgressObservation(player([progress("position", 100)]));

    expect(before).not.toBeNull();
    expect(playbackProgressObservation(
      player([progress("different-position", 250), progress("position", 90)]),
      before?.provenance,
    )?.value).toBe(90);
    expect(playbackProgressObservation(
      player([progress("position", 100), progress("secondary", 200)]),
    )).toBeNull();
  });

  it("requires a unique selected caption-track provenance", () => {
    const track = (stableId: string, name: string) => node({
      stableId,
      role: "button",
      name,
      focusable: true,
      selectionState: "on",
    });
    const captions = (tracks: readonly UiNodeSnapshot[]) => semanticSnapshot([
      node({ role: "dialog", name: "Captions", modal: true }, tracks),
    ]);

    expect(selectedCaptionTrack(captions([track("off", "Off Current selection")]))).toMatchObject({
      stableId: "off",
      selectionState: "on",
    });
    expect(selectedCaptionTrack(captions([
      track("off", "Off Current selection"),
      track("english", "English captions"),
    ]))).toBeNull();
  });

  it("walks the UI tree iteratively and enforces exact node, depth, cycle, and text bounds", () => {
    let deepest = node({ role: "button", name: "Leaf" });
    for (let depth = 0; depth < STREAMING_UI_TREE_LIMITS.maxDepth; depth += 1) {
      deepest = node({ role: "group", name: `Depth ${String(depth)}` }, [deepest]);
    }
    expect(flattenUiTree([deepest])).toHaveLength(STREAMING_UI_TREE_LIMITS.maxDepth + 1);

    const tooDeep = node({ role: "group", name: "Too deep" }, [deepest]);
    expect(() => flattenUiTree([tooDeep])).toThrow(/depth limit/u);
    const cyclicChildren: UiNodeSnapshot[] = [];
    const cyclic = node({ role: "group", name: "Cycle" }, cyclicChildren);
    cyclicChildren.push(cyclic);
    expect(() => flattenUiTree([cyclic])).toThrow(/repeated or cyclic/u);
    expect(() => flattenUiTree(Array.from(
      { length: STREAMING_UI_TREE_LIMITS.maxNodes + 1 },
      (_, index) => node({ role: "button", name: `Node ${String(index)}` }),
    ))).toThrow(/node limit/u);
    expect(() => flattenUiTree([node({
      role: "button",
      name: "x".repeat(STREAMING_UI_TREE_LIMITS.maxTextLength + 1),
    })])).toThrow(/text limit/u);
  });
});

describe("streaming budget boundaries", () => {
  it.each([
    ["maxActions", 0],
    ["maxActions", -1],
    ["maxActions", 1.5],
    ["maxActions", Number.NaN],
    ["maxActions", Number.POSITIVE_INFINITY],
    ["maxActions", 1_000_001],
    ["maxStates", 0],
    ["maxStates", -1],
    ["maxStates", 1.5],
    ["maxStates", Number.NaN],
    ["maxStates", Number.POSITIVE_INFINITY],
    ["maxStates", 100_001],
    ["maxLocalDepth", -1],
    ["maxLocalDepth", 1.5],
    ["maxLocalDepth", Number.NaN],
    ["maxLocalDepth", Number.POSITIVE_INFINITY],
    ["maxLocalDepth", 4_097],
    ["maxLocalStates", 0],
    ["maxLocalStates", -1],
    ["maxLocalStates", 1.5],
    ["maxLocalStates", Number.NaN],
    ["maxLocalStates", Number.POSITIVE_INFINITY],
    ["maxLocalStates", 100_001],
    ["maxDurationMs", 0],
    ["maxDurationMs", -1],
    ["maxDurationMs", 1.5],
    ["maxDurationMs", Number.NaN],
    ["maxDurationMs", Number.POSITIVE_INFINITY],
    ["maxDurationMs", 2_147_483_648],
  ] as const)("rejects the invalid %s streaming budget %s", async (name, value) => {
    const budgets = { [name]: value } as Partial<StreamingPackBudgets>;
    const maximum = name === "maxActions"
      ? 1_000_000
      : name === "maxLocalDepth"
        ? 4_096
        : name === "maxDurationMs"
          ? 2_147_483_647
          : 100_000;
    const qualifier = name === "maxLocalDepth" ? "non-negative" : "positive";
    const error = await runStreamingPack(
      new StreamingFakeDriver("conventional"),
      { budgets },
    ).then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe(
      `${name} must be a ${qualifier} safe integer no greater than ${String(maximum)}.`,
    );
  });

  it.each([
    ["unknown reset strategy", { resetStrategy: "factory-reset" as never }, "resetStrategy must be reload, relaunch, or clear-data."],
    ["non-function restore hook", { restoreInitialState: 1 as never }, "restoreInitialState must be a function."],
    ["non-function clock hook", { monotonicNow: 1 as never }, "monotonicNow must be a function."],
    ["non-function pointer hook", { pointerProbe: { probe: 1 } as never }, "pointerProbe must expose a probe function."],
    ["non-finite clock result", { monotonicNow: () => Number.NaN }, "monotonicNow must return a finite number."],
  ] as const)("rejects %s", async (_label, options, message) => {
    const error = await runStreamingPack(
      new StreamingFakeDriver("conventional"),
      options as StreamingPackOptions,
    ).then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe(message);
  });

  it.each([
    ["null options", null, "Streaming pack options must be an object."],
    ["array options", [], "Streaming pack options must be an object."],
    ["non-object budgets", { budgets: [] }, "budgets must be an object."],
  ] as const)("preserves the exact TypeError for %s", async (_label, options, message) => {
    const error = await runStreamingPack(
      new StreamingFakeDriver("conventional"),
      options as never,
    ).then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe(message);
  });

  it("uses the explicit three-minute standard duration budget", () => {
    expect(DEFAULT_STREAMING_PACK_BUDGETS.maxDurationMs).toBe(180_000);
  });

  it("stops at exactly zero local depth without sending a directional action", async () => {
    const driver = new StreamingFakeDriver("conventional");
    const result = await runStreamingPack(driver, {
      budgets: { maxLocalDepth: 0 },
      pointerProbe: reachablePointer,
    });

    expect(result.status).toBe("partial");
    expect(result.termination.reason).toBe("max-local-depth");
    expect(result.statistics.physicalActions).toBe(0);
    expect(driver.pressCount).toBe(0);
  });

  it("expands exactly one local state before the local-state boundary", async () => {
    const driver = new StreamingFakeDriver("variant");
    const result = await runStreamingPack(driver, {
      budgets: { maxLocalStates: 1 },
      pointerProbe: reachablePointer,
    });

    expect(result.status).toBe("partial");
    expect(result.termination.reason).toBe("max-local-states");
    expect(result.stages.find((stageResult) => stageResult.stage === "content")?.detail)
      .toContain("expanded exactly 1 unique states");
    expect(result.statistics.physicalActions).toBe(driver.pressCount);
    expect(driver.pressCount).toBe(3);
  });

  it("does not report a complete journey when player expansion reaches its local-state budget", async () => {
    const result = await runStreamingPack(
      new StreamingFakeDriver("conventional"),
      {
        budgets: { maxLocalStates: 4 },
        pointerProbe: reachablePointer,
      },
    );

    expect(result.status).toBe("partial");
    expect(result.termination.reason).toBe("max-local-states");
    expect(result.stages.find((stageResult) => stageResult.stage === "controls")?.status).toBe("partial");
  });

  it("retains exactly the configured number of global semantic states", async () => {
    const driver = new StreamingFakeDriver("conventional");
    const result = await runStreamingPack(driver, {
      budgets: { maxStates: 1 },
      pointerProbe: reachablePointer,
    });

    expect(result.status).toBe("error");
    expect(result.termination.reason).toBe("max-states");
    expect(result.statistics.uniqueStates).toBe(1);
    expect(result.statistics.physicalActions).toBe(1);
  });

  it("stops at the exact monotonic duration boundary", async () => {
    const driver = new StreamingFakeDriver("conventional");
    let now = 0;
    const result = await runStreamingPack(driver, {
      budgets: { maxDurationMs: 25 },
      monotonicNow: () => now,
      restoreInitialState: async () => {
        await driver.reset();
        now = 25;
      },
    });

    expect(result.status).toBe("error");
    expect(result.termination.reason).toBe("max-duration");
    expect(result.statistics.elapsedMs).toBe(25);
    expect(result.statistics.physicalActions).toBe(0);
  });
});

describe("destructive action policy", () => {
  it("rejects purchase/account actions even when they are visible buttons", () => {
    expect(isSafeStreamingCandidate(node({
      role: "button",
      name: "Subscribe and confirm purchase",
    }))).toBe(false);
    expect(isSafeStreamingCandidate(node({
      role: "button",
      name: "Open film details",
    }), "Featured movies")).toBe(true);
  });
});
