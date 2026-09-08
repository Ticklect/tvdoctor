import type {
  ActionResult,
  Capability,
  LogEntry,
  RemoteKey,
  StateSnapshot,
  TVDoctorDriver,
  UiNodeSnapshot,
} from "@tvdoctor/protocol";
import {
  availableObservation,
  unavailableObservation,
} from "@tvdoctor/protocol";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_WEB_PACK_BUDGETS,
  flattenWebUiTree,
  isSafeSettingsSubmenu,
  isSafeWebControl,
  rankOnScreenKeyboardKeys,
  runAccessibilityStage,
  runCrashStage,
  runSearchStage,
  runSettingsStage,
  runWebPack,
  webSemanticStateIdentity,
  type WebFocusVisualSample,
} from "../src/index.js";
import { WebPackSession } from "../src/internal.js";
import { punctuateReason } from "../src/issues.js";

type FakeScreen = "app-settings" | "details" | "home" | "player-settings" | "search";

describe("unavailable-reproduction reason punctuation", () => {
  test("preserves a supplied period", () => {
    expect(punctuateReason("The proof requires isolated evidence.")).toBe("The proof requires isolated evidence.");
  });

  test("adds a period when terminal punctuation is absent", () => {
    expect(punctuateReason("  The proof requires isolated evidence  ")).toBe("The proof requires isolated evidence.");
  });

  test.each([
    ["The proof requires isolated evidence!", "The proof requires isolated evidence!"],
    ["The proof requires isolated evidence?", "The proof requires isolated evidence?"],
  ])("preserves terminal punctuation in %s", (reason, expected) => {
    expect(punctuateReason(reason)).toBe(expected);
  });

  test("reserves space for added punctuation at the protocol string limit", () => {
    const result = punctuateReason("x".repeat(65_536));
    expect(result).toHaveLength(65_536);
    expect(result.endsWith(".")).toBe(true);
  });
});

interface NodeOptions {
  readonly bounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly children?: readonly UiNodeSnapshot[];
  readonly focusable?: boolean;
  readonly focused?: boolean;
  readonly modal?: boolean;
  readonly text?: string | null;
  readonly visible?: boolean;
}

function uiNode(
  stableId: string | null,
  role: string | null,
  name: string | null,
  options: NodeOptions = {},
): UiNodeSnapshot {
  return {
    stableId,
    role,
    name,
    text: options.text ?? null,
    bounds: options.bounds ?? null,
    visible: options.visible ?? true,
    enabled: true,
    focusable: options.focusable ?? false,
    focused: options.focused ?? false,
    modal: options.modal ?? false,
    selectionState: null,
    valueNow: null,
    children: options.children ?? [],
  };
}

function visualSample(overrides: Partial<WebFocusVisualSample> = {}): WebFocusVisualSample {
  return {
    outlineWidthPx: 0,
    borderWidthPx: 1,
    opacity: 1,
    transform: "none",
    backgroundColor: "rgb(20, 20, 20)",
    boxShadow: "none",
    ...overrides,
  };
}

class FakeWebDriver implements TVDoctorDriver {
  public readonly selectedIds: string[] = [];
  public pressCount = 0;
  public panelX = 1_100;
  public settingsLatencyMs = 1_350;
  public logs: readonly LogEntry[] = [{
    timestamp: "2026-08-22T00:00:00.000Z",
    level: "error",
    message: "[Northstar fixture] Seeded startup console error: catalogue sync failed intentionally.",
  }];
  public capabilitiesValue: ReadonlySet<Capability> = new Set([
    "remote-input",
    "ui-tree",
    "accessibility-tree",
    "logs",
    "performance",
  ]);
  #screen: FakeScreen = "home";
  #focus = "home-nav";
  #query = "";
  #clock = 0;

  public setQuery(query: string): void {
    this.#query = query;
    this.#screen = "search";
    this.#focus = "search-input";
  }

  public capabilities(): Promise<ReadonlySet<Capability>> {
    return Promise.resolve(this.capabilitiesValue);
  }

  public reset(): Promise<void> {
    this.#screen = "home";
    this.#focus = "home-nav";
    this.#query = "";
    return Promise.resolve();
  }

  public getLogs(): Promise<readonly LogEntry[]> {
    return Promise.resolve(this.logs);
  }

  public press(key: RemoteKey): Promise<ActionResult> {
    this.pressCount += 1;
    const inputSentAtMs = this.#clock;
    this.#clock += 2_000;
    const before = this.#focus;
    if (key === "SELECT") this.selectedIds.push(before);
    this.#apply(key);
    const slowSettings = before === "player-settings" && key === "SELECT";
    const delay = slowSettings ? this.settingsLatencyMs : 12;
    return Promise.resolve({
      key,
      outcome: "applied",
      timing: {
        inputSentAtMs,
        firstResponseAtMs: inputSentAtMs + Math.min(delay, 40),
        focusSettledAtMs: inputSentAtMs + delay,
        screenSettledAtMs: inputSentAtMs + delay,
      },
    });
  }

  #move(edges: Readonly<Record<string, Partial<Record<RemoteKey, string>>>>, key: RemoteKey): void {
    const next = edges[this.#focus]?.[key];
    if (next !== undefined) this.#focus = next;
  }

  #apply(key: RemoteKey): void {
    if (this.#screen === "home") {
      const edges: Readonly<Record<string, Partial<Record<RemoteKey, string>>>> = {
        "home-nav": { UP: "player-settings", DOWN: "search-nav", RIGHT: "home-card-1" },
        "search-nav": { UP: "home-nav", DOWN: "settings-nav" },
        "settings-nav": { UP: "search-nav" },
        "home-card-1": { LEFT: "home-nav", RIGHT: "home-card-2" },
        "home-card-2": { LEFT: "home-card-1" },
        "player-settings": { DOWN: "home-nav" },
      };
      if (key === "SELECT" && this.#focus === "search-nav") {
        this.#screen = "search";
        this.#focus = "search-input";
      } else if (key === "SELECT" && this.#focus === "settings-nav") {
        this.#screen = "app-settings";
        this.#focus = "app-settings-appearance";
      } else if (key === "SELECT" && this.#focus === "player-settings") {
        this.#screen = "player-settings";
        this.#focus = "settings-captions";
      } else {
        this.#move(edges, key);
      }
      return;
    }
    if (this.#screen === "search") {
      const resultTarget = this.#query.length > 0 ? "search-result-1" : "search-input";
      const edges: Readonly<Record<string, Partial<Record<RemoteKey, string>>>> = {
        "search-input": { DOWN: "search-key-n" },
        "search-key-n": { UP: "search-input", RIGHT: "search-key-o", DOWN: resultTarget },
        "search-key-o": { LEFT: "search-key-n", RIGHT: "search-key-v", DOWN: resultTarget },
        "search-key-v": { LEFT: "search-key-o", RIGHT: "search-key-a", DOWN: resultTarget },
        "search-key-a": { LEFT: "search-key-v", DOWN: resultTarget },
        "search-result-1": { UP: "search-key-a" },
      };
      const character: Readonly<Record<string, string>> = {
        "search-key-n": "N",
        "search-key-o": "O",
        "search-key-v": "V",
        "search-key-a": "A",
      };
      if (key === "SELECT" && character[this.#focus] !== undefined) {
        this.#query += character[this.#focus];
      } else if (key === "SELECT" && this.#focus === "search-result-1") {
        this.#screen = "details";
        this.#focus = "details-play";
      } else {
        this.#move(edges, key);
      }
      return;
    }
    if (this.#screen === "details" && key === "BACK") {
      this.#screen = "search";
      this.#focus = "search-result-1";
      return;
    }
    if (this.#screen === "app-settings") {
      const edges: Readonly<Record<string, Partial<Record<RemoteKey, string>>>> = {
        "app-settings-appearance": { DOWN: "app-settings-about" },
        "app-settings-about": { UP: "app-settings-appearance" },
      };
      if (key === "BACK") {
        this.#screen = "home";
        this.#focus = "settings-nav";
      } else {
        this.#move(edges, key);
      }
      return;
    }
    if (this.#screen === "player-settings" && key === "BACK") {
      this.#screen = "home";
      this.#focus = "player-settings";
    }
  }

  #focusNode(id: string, role: string, name: string, bounds?: NodeOptions["bounds"]): UiNodeSnapshot {
    return uiNode(id, role, name, {
      ...(bounds === undefined ? {} : { bounds }),
      focusable: true,
      focused: this.#focus === id,
    });
  }

  #tree(): readonly UiNodeSnapshot[] {
    if (this.#screen === "home") {
      return [uiNode("home-main", "main", "Home screen", {
        children: [
          uiNode("primary-nav", "navigation", "Primary navigation", {
            children: [
              this.#focusNode("home-nav", "button", "Home"),
              this.#focusNode("search-nav", "button", "Search"),
              this.#focusNode("settings-nav", "button", "Settings"),
            ],
          }),
          uiNode("catalogue", "region", "Continue watching catalogue", {
            children: [
              this.#focusNode("home-card-1", "button", "Aurora"),
              this.#focusNode("home-card-2", "button", "Signal Lost"),
            ],
          }),
          uiNode("player-controls", "region", "Player controls", {
            children: [this.#focusNode("player-settings", "button", "Settings")],
          }),
        ],
      })];
    }
    if (this.#screen === "search") {
      const children: UiNodeSnapshot[] = [
        this.#focusNode("search-input", "textbox", "Search query"),
        this.#focusNode("search-submit", "button", "Search"),
        uiNode("search-keyboard", "region", "On-screen search keyboard", {
          children: [
            this.#focusNode("search-key-n", "button", "N"),
            this.#focusNode("search-key-o", "button", "O"),
            this.#focusNode("search-key-v", "button", "V"),
            this.#focusNode("search-key-a", "button", "A"),
          ],
        }),
      ];
      if (this.#query.length > 0) {
        children.push(uiNode("search-results", "region", "Search results", {
          children: [this.#focusNode("search-result-1", "button", "Nova")],
        }));
      }
      return [uiNode("search-main", "main", "Search screen", {
        children: [
          uiNode("search-primary-nav", "navigation", "Primary navigation", {
            children: [this.#focusNode("search-nav", "button", "Search")],
          }),
          uiNode("search-form", "region", "Search query and results", { children }),
        ],
      })];
    }
    if (this.#screen === "details") {
      return [uiNode("details-main", "main", "Nova details", {
        children: [
          uiNode("details-heading", "heading", "Nova details"),
          this.#focusNode("details-play", "button", "Play"),
        ],
      })];
    }
    if (this.#screen === "app-settings") {
      return [uiNode("app-settings-dialog", "dialog", "App settings", {
        modal: true,
        children: [
          uiNode("app-settings-heading", "heading", "App settings"),
          this.#focusNode("app-settings-appearance", "button", "Appearance Midnight"),
          this.#focusNode("app-settings-about", "button", "About this fixture"),
        ],
      })];
    }
    return [uiNode("player-settings-dialog", "dialog", "Player settings", {
      modal: true,
      bounds: { x: 0, y: 0, width: 1_280, height: 720 },
      children: [
        uiNode("settings-panel", "complementary", "Player settings panel", {
          bounds: { x: this.panelX, y: 0, width: 300, height: 720 },
          children: [
            uiNode("settings-heading", "heading", "Player settings"),
            this.#focusNode("settings-captions", "button", "Captions", {
              x: this.panelX + 20,
              y: 100,
              width: 260,
              height: 50,
            }),
          ],
        }),
      ],
    })];
  }

  public snapshot(): Promise<StateSnapshot> {
    const tree = this.#tree();
    const focused = flattenWebUiTree(tree).find((entry) => entry.node.focused === true)?.node;
    return Promise.resolve({
      capturedAt: "2026-08-22T00:00:00.000Z",
      location: availableObservation(`fake://${this.#screen}`),
      focusedElement: availableObservation(focused === undefined ? null : {
        ...(focused.stableId === null ? {} : { stableId: focused.stableId }),
        ...(focused.role === null ? {} : { role: focused.role }),
        ...(focused.name === null ? {} : { name: focused.name }),
        ...(focused.bounds === null ? {} : { bounds: focused.bounds }),
      }),
      uiTree: availableObservation(tree),
    });
  }
}

class FirstResponseOnlyDriver extends FakeWebDriver {
  public override async press(key: RemoteKey): Promise<ActionResult> {
    const result = await super.press(key);
    return {
      ...result,
      timing: {
        inputSentAtMs: result.timing.inputSentAtMs,
        ...(result.timing.firstResponseAtMs === undefined ? {} : { firstResponseAtMs: result.timing.firstResponseAtMs }),
        ...(result.timing.focusSettledAtMs === undefined ? {} : { focusSettledAtMs: result.timing.focusSettledAtMs }),
      },
    };
  }
}

class MalformedSlowTimingDriver extends FakeWebDriver {
  public override async press(key: RemoteKey): Promise<ActionResult> {
    const result = await super.press(key);
    const settled = result.timing.screenSettledAtMs;
    if (settled !== undefined && settled - result.timing.inputSentAtMs > 1_000) {
      return {
        ...result,
        timing: {
          ...result.timing,
          screenSettledAtMs: result.timing.inputSentAtMs - 1,
        },
      };
    }
    return result;
  }
}

class UnsupportedLeftDriver extends FakeWebDriver {
  public override press(key: RemoteKey): Promise<ActionResult> {
    if (key !== "LEFT") return super.press(key);
    this.pressCount += 1;
    return Promise.resolve({
      key,
      outcome: "unsupported",
      timing: { inputSentAtMs: Date.now() },
      message: "LEFT unavailable for adversarial coverage.",
    });
  }
}

class AccessibilityDefectDriver extends FakeWebDriver {
  private readonly defect: "hidden-focusable" | "missing-name";

  public constructor(defect: "hidden-focusable" | "missing-name") {
    super();
    this.defect = defect;
  }

  public override async snapshot(): Promise<StateSnapshot> {
    const base = await super.snapshot();
    if (base.uiTree.status !== "available") return base;
    const defect = this.defect === "missing-name"
      ? uiNode("unnamed-action", "button", null, { focusable: false, text: null })
      : uiNode("hidden-action", "button", "Hidden action", { focusable: true, visible: false });
    const first = base.uiTree.value[0];
    if (first === undefined) return base;
    return {
      ...base,
      uiTree: availableObservation([{ ...first, children: [...first.children, defect] }]),
    };
  }
}

function fullOptions() {
  return {
    playerSettingsSequence: ["UP", "SELECT"] as const,
    menuResponseThresholdMs: 1_000,
    hooks: {
      pointerProbe: {
        probe: () => Promise.resolve({
          status: "activated" as const,
          observedEffect: "Search submitted marker changed from false to true.",
          detail: "Isolated pointer activation changed the submitted marker.",
        }),
      },
      viewport: {
        observe: () => Promise.resolve({
          status: "available" as const,
          viewport: { x: 0, y: 0, width: 1_280, height: 720 },
          source: "isolated browser viewport observation",
        }),
      },
      webFocusVisibility: {
        probe: (request: { readonly element: { readonly stableId: string | null } }) => Promise.resolve({
          status: "available" as const,
          unfocused: visualSample(),
          focused: request.element.stableId === "home-card-2"
            ? visualSample({ boxShadow: "0 0 0 1px rgba(255,255,255,.08)" })
            : visualSample({ backgroundColor: "rgb(255, 255, 255)" }),
          screenshotDifferenceRatio: request.element.stableId === "home-card-2" ? 0.001 : 0.25,
          detail: "Isolated equal crop and computed styles captured.",
        }),
      },
    },
  };
}

describe("M7 web pack", () => {
  test("enforces the pack-wide deadline while every driver boundary is pending", async () => {
    const pending = <T>(): Promise<T> => new Promise(() => undefined);
    const cases: readonly (readonly [string, () => Promise<unknown>])[] = [
      ["capabilities", () => {
        const driver = new FakeWebDriver();
        driver.capabilities = () => pending<ReadonlySet<Capability>>();
        return new WebPackSession(driver, {}, {
          ...DEFAULT_WEB_PACK_BUDGETS,
          maxDurationMs: 30,
        }).capabilities();
      }],
      ["snapshot", () => {
        const driver = new FakeWebDriver();
        driver.snapshot = () => pending<StateSnapshot>();
        return new WebPackSession(driver, {}, {
          ...DEFAULT_WEB_PACK_BUDGETS,
          maxDurationMs: 30,
        }).snapshot();
      }],
      ["press", () => {
        const driver = new FakeWebDriver();
        driver.press = () => pending<ActionResult>();
        return new WebPackSession(driver, {}, {
          ...DEFAULT_WEB_PACK_BUDGETS,
          maxDurationMs: 30,
        }).press("RIGHT", "probe");
      }],
      ["reset", () => {
        const driver = new FakeWebDriver();
        driver.reset = () => pending<undefined>();
        return new WebPackSession(driver, {}, {
          ...DEFAULT_WEB_PACK_BUDGETS,
          maxDurationMs: 30,
        }).restore();
      }],
      ["restore hook", () => {
        const driver = new FakeWebDriver();
        const session = new WebPackSession(driver, {
          restoreInitialState: () => pending<undefined>(),
        }, {
          ...DEFAULT_WEB_PACK_BUDGETS,
          maxDurationMs: 30,
        });
        return session.restore();
      }],
      ["stage hook", () => {
        const driver = new FakeWebDriver();
        const session = new WebPackSession(driver, {}, {
          ...DEFAULT_WEB_PACK_BUDGETS,
          maxDurationMs: 30,
        });
        return session.withinDuration(() => pending<undefined>());
      }],
    ];

    for (const [name, run] of cases) {
      const startedAtMs = performance.now();
      await expect(run(), name).rejects.toMatchObject({ reason: "max-duration" });
      expect(performance.now() - startedAtMs, name).toBeLessThan(750);
    }
  });

  test("returns a truthful partial max-duration result for a never-settling hook", async () => {
    const result = await runWebPack(new FakeWebDriver(), {
      stages: ["layout"],
      playerSettingsSequence: ["UP", "SELECT"],
      budgets: { maxDurationMs: 30 },
      hooks: {
        viewport: {
          observe: () => new Promise(() => undefined),
        },
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      termination: { reason: "max-duration", complete: false },
    });
    expect(result.stages).toEqual([
      expect.objectContaining({ stage: "layout", status: "partial" }),
    ]);
  });

  test("keeps six stages independent and reports exactly the five intended defect domains", async () => {
    const result = await runWebPack(new FakeWebDriver(), fullOptions());

    expect(result.status, JSON.stringify(result, null, 2)).toBe("complete");
    expect(result.termination.complete).toBe(true);
    expect(result.stages.map((item) => item.stage)).toEqual([
      "search",
      "settings",
      "accessibility",
      "layout",
      "performance",
      "crash",
    ]);
    expect(result.issues.map((issue) => issue.rule).sort()).toEqual([
      "crash.console-error",
      "focus.visibility",
      "layout.viewport-clipping",
      "performance.menu-response",
      "search.remote-flow",
    ]);
    expect(result.stages.flatMap((item) => item.issues).map((issue) => issue.pack).sort()).toEqual([
      "accessibility",
      "crash",
      "layout",
      "performance",
      "search",
    ]);
    expect(result.issues.every((issue) => issue.reproduction.status === "unavailable")).toBe(true);
    expect(new Set(result.issues.map((issue) => issue.id)).size).toBe(5);
    expect(result.statistics.physicalActions).toBeGreaterThan(0);
    expect(result.statistics.physicalActions).toBeLessThanOrEqual(result.budgets.maxActions);
  });

  test("runs a canonical validated subset only", async () => {
    const result = await runWebPack(new FakeWebDriver(), {
      ...fullOptions(),
      stages: ["crash", "search"],
    });
    expect(result.stages.map((item) => item.stage)).toEqual(["search", "crash"]);
    expect((await runWebPack(new FakeWebDriver(), { stages: ["search", "search"] })).termination.reason).toBe("invalid-options");
    expect((await runWebPack(new FakeWebDriver(), { stages: [] })).termination.reason).toBe("invalid-options");
  });

  test("does not guess a player route or universal latency threshold", async () => {
    const driver = new FakeWebDriver();
    const result = await runWebPack(driver, { stages: ["layout", "performance"] });
    expect(result.status).toBe("unobservable");
    expect(result.stages.map((item) => item.status)).toEqual(["unobservable", "unobservable"]);
    expect(driver.pressCount).toBe(0);

    const noThreshold = await runWebPack(new FakeWebDriver(), {
      stages: ["performance"],
      playerSettingsSequence: ["UP", "SELECT"],
    });
    expect(noThreshold.stages[0]?.status).toBe("unobservable");
  });

  test("enters the configurable default query with counted semantic D-pad keys", async () => {
    const driver = new FakeWebDriver();
    const result = await runSearchStage(driver, fullOptions());
    const query = result.observations.find((item) => item.kind === "search-query");
    expect(query?.status, JSON.stringify(result, null, 2)).toBe("available");
    expect(query?.detail).toContain("counted semantic on-screen keys");
    expect(driver.selectedIds).toEqual(expect.arrayContaining([
      "search-key-n",
      "search-key-o",
      "search-key-v",
      "search-key-a",
    ]));
  });

  test("uses only an explicit system/driver text hook when a remote key is absent", async () => {
    const driver = new FakeWebDriver();
    const result = await runSearchStage(driver, {
      ...fullOptions(),
      searchQuery: "Z",
      hooks: {
        ...fullOptions().hooks,
        searchQueryEntry: {
          enter: ({ query }) => {
            driver.setQuery(query);
            return Promise.resolve({
              status: "entered" as const,
              method: "driver-text-input" as const,
              observedQuery: query,
              resultsObserved: true,
              detail: "Driver text input observed exact query and results.",
            });
          },
        },
      },
    });
    expect(result.observations.find((item) => item.kind === "search-query")?.detail).toContain("driver-text-input");
    expect(result.status).toBe("failed");
  });

  test("never activates ambiguous or destructive settings controls", async () => {
    const driver = new FakeWebDriver();
    const result = await runSettingsStage(driver);
    expect(result.status).toBe("passed");
    expect(driver.selectedIds.filter((id) => id.startsWith("app-settings-"))).toEqual([]);
    expect(driver.selectedIds).toContain("settings-nav");
  });

  test("keeps DOM-derived accessibility explicitly partial without accessibility-tree capability", async () => {
    const driver = new FakeWebDriver();
    driver.capabilitiesValue = new Set(["remote-input", "ui-tree"]);
    const result = await runAccessibilityStage(driver, {
      hooks: {
        webFocusVisibility: {
          probe: () => Promise.resolve({
            status: "available" as const,
            unfocused: visualSample(),
            focused: visualSample({ backgroundColor: "white" }),
            screenshotDifferenceRatio: 0.5,
            detail: "Strong isolated proof.",
          }),
        },
      },
    });
    expect(result.status).toBe("partial");
    expect(result.observations.find((item) => item.kind === "accessibility-tree")?.status).toBe("partial");
  });

  test("reports a stable deterministic finding for a visible interactive control without a name", async () => {
    const options = {
      hooks: {
        webFocusVisibility: {
          probe: () => Promise.resolve({
            status: "available" as const,
            unfocused: visualSample(),
            focused: visualSample({ backgroundColor: "white" }),
            screenshotDifferenceRatio: 0.5,
            detail: "Strong isolated proof.",
          }),
        },
      },
    };
    const first = await runAccessibilityStage(new AccessibilityDefectDriver("missing-name"), options);
    const second = await runAccessibilityStage(new AccessibilityDefectDriver("missing-name"), options);
    const firstIssue = first.issues.find((issue) => issue.rule === "accessibility.name");
    const secondIssue = second.issues.find((issue) => issue.rule === "accessibility.name");

    expect(first.status).toBe("failed");
    expect(firstIssue).toMatchObject({
      severity: "high",
      confidence: "deterministic",
      pack: "accessibility",
      reproduction: { status: "unavailable" },
    });
    expect(firstIssue?.id).toBe(secondIssue?.id);
  });

  test("reports a hidden focusable control without changing accessibility-stage ordering", async () => {
    const result = await runAccessibilityStage(new AccessibilityDefectDriver("hidden-focusable"), {
      hooks: {
        webFocusVisibility: {
          probe: () => Promise.resolve({
            status: "available" as const,
            unfocused: visualSample(),
            focused: visualSample({ backgroundColor: "white" }),
            screenshotDifferenceRatio: 0.5,
            detail: "Strong isolated proof.",
          }),
        },
      },
    });

    expect(result.stage).toBe("accessibility");
    expect(result.status).toBe("failed");
    expect(result.issues.map((issue) => issue.rule)).toContain("accessibility.hidden-focusable");
  });

  test("retains semantic accessibility findings when visual focus proof is unavailable", async () => {
    const result = await runAccessibilityStage(new AccessibilityDefectDriver("missing-name"));

    expect(result.status).toBe("failed");
    expect(result.issues.map((issue) => issue.rule)).toEqual(["accessibility.name"]);
    expect(result.observations.find((item) => item.kind === "focus-visibility")?.status).toBe("unavailable");
  });

  test("fails closed on invalid focus proof and never emits a heuristic issue from it", async () => {
    const result = await runAccessibilityStage(new FakeWebDriver(), {
      hooks: {
        webFocusVisibility: {
          probe: () => Promise.resolve({
            status: "available" as const,
            unfocused: visualSample(),
            focused: visualSample(),
            screenshotDifferenceRatio: 2,
            detail: "Invalid ratio.",
          }),
        },
      },
    });
    expect(result.issues).toEqual([]);
    expect(result.status).toBe("partial");
    expect(result.observations.some((item) => item.detail.includes("failed safely"))).toBe(true);
  });

  test("keeps semantic issue IDs stable across volatile geometry and timing", async () => {
    const firstDriver = new FakeWebDriver();
    const secondDriver = new FakeWebDriver();
    secondDriver.panelX = 1_180;
    secondDriver.settingsLatencyMs = 1_700;
    const first = await runWebPack(firstDriver, { ...fullOptions(), stages: ["layout", "performance"] });
    const second = await runWebPack(secondDriver, { ...fullOptions(), stages: ["layout", "performance"] });
    expect(second.issues.map((issue) => issue.id)).toEqual(first.issues.map((issue) => issue.id));
  });

  test("treats over-budget logs as unobservable instead of truncating into a pass", async () => {
    const driver = new FakeWebDriver();
    driver.logs = Array.from({ length: 3 }, (_, index) => ({
      timestamp: `2026-08-22T00:00:0${String(index)}.000Z`,
      level: "info" as const,
      message: `bounded log ${String(index)}`,
    }));
    const result = await runCrashStage(driver, { budgets: { maxLogs: 2 } });
    expect(result.status).toBe("unobservable");
    expect(result.issues).toEqual([]);
  });

  test("keeps console-error IDs stable when the same signature repeats", async () => {
    const single = new FakeWebDriver();
    const repeated = new FakeWebDriver();
    repeated.logs = [single.logs[0] as LogEntry, single.logs[0] as LogEntry];
    const first = await runCrashStage(single);
    const second = await runCrashStage(repeated);
    expect(second.issues).toHaveLength(1);
    expect(second.issues[0]?.id).toBe(first.issues[0]?.id);
    expect(second.issues[0]?.observed).toContain("2 occurrences");
  });

  test("does not claim pointer-only remote unreachability after an unsupported D-pad edge", async () => {
    const result = await runSearchStage(new UnsupportedLeftDriver(), fullOptions());
    expect(result.issues.some((issue) => issue.rule === "search.remote-flow")).toBe(false);
    expect(result.observations.find((item) => item.kind === "search-submit")?.status).toBe("partial");
  });

  test("does not pass crash robustness from logs alone when a live surface is unobservable", async () => {
    const driver = new FakeWebDriver();
    driver.logs = [];
    driver.capabilitiesValue = new Set(["logs"]);
    const result = await runCrashStage(driver);
    expect(result.status).toBe("partial");
    expect(result.observations.find((item) => item.kind === "live-surface")?.status).toBe("unavailable");
  });

  test("does not substitute first-response timing for menu-settled timing", async () => {
    const result = await runWebPack(new FirstResponseOnlyDriver(), {
      stages: ["performance"],
      playerSettingsSequence: ["UP", "SELECT"],
      menuResponseThresholdMs: 1_000,
    });
    expect(result.stages[0]?.status).toBe("unobservable");
    expect(result.issues).toEqual([]);
  });

  test("retains completed independent stages if a later stage fails hostile timing validation", async () => {
    const result = await runWebPack(new MalformedSlowTimingDriver(), {
      stages: ["settings", "performance"],
      playerSettingsSequence: ["UP", "SELECT"],
      menuResponseThresholdMs: 1_000,
    });
    expect(result.status).toBe("error");
    expect(result.termination.reason).toBe("driver-error");
    expect(result.stages[0]?.stage).toBe("settings");
    expect(result.stages[0]?.status).toBe("passed");
    expect(result.stages[1]).toMatchObject({ stage: "performance", status: "skipped" });
  });

  test("enforces strict options and global physical-action bounds", async () => {
    expect((await runWebPack(new FakeWebDriver(), { searchQuery: "password token" })).termination.reason).toBe("invalid-options");
    expect((await runWebPack(new FakeWebDriver(), { budgets: { maxActions: 2_001 } })).termination.reason).toBe("invalid-options");
    expect((await runWebPack(new FakeWebDriver(), { playerSettingsSequence: ["UP"] })).termination.reason).toBe("invalid-options");
    const bounded = await runWebPack(new FakeWebDriver(), {
      stages: ["search"],
      budgets: { maxActions: 1 },
    });
    expect(bounded.status).toBe("error");
    expect(bounded.termination.reason).toBe("max-actions");
    expect(bounded.statistics.physicalActions).toBe(1);
  });
});

describe("hostile semantic input bounds", () => {
  test("uses iterative traversal for the maximum legal depth", () => {
    let current = uiNode("leaf", "button", "Leaf");
    for (let depth = 0; depth < 128; depth += 1) {
      current = uiNode(`node-${String(depth)}`, "group", `Node ${String(depth)}`, { children: [current] });
    }
    expect(flattenWebUiTree([current])).toHaveLength(129);
  });

  test("rejects excessive depth, repeated references, text, and coordinates", () => {
    let tooDeep = uiNode("deep-leaf", "button", "Leaf");
    for (let depth = 0; depth < 129; depth += 1) {
      tooDeep = uiNode(`deep-${String(depth)}`, "group", "Deep", { children: [tooDeep] });
    }
    expect(() => flattenWebUiTree([tooDeep])).toThrow(/depth limit/u);

    const shared = uiNode("shared", "button", "Shared");
    const repeated = uiNode("root", "main", "Root", { children: [shared, shared] });
    expect(() => flattenWebUiTree([repeated])).toThrow(/repeated or cyclic/u);

    expect(() => flattenWebUiTree([uiNode("long", "button", "x".repeat(1_025))])).toThrow(/text limit/u);
    expect(() => flattenWebUiTree([uiNode("far", "button", "Far", {
      bounds: { x: 1_000_001, y: 0, width: 10, height: 10 },
    })])).toThrow(/coordinate limit/u);
  });

  test("correlates bounded duplicate browser name/text for an exact keyboard key only", () => {
    const key = uiNode("key-n", "button", "N", { focusable: true, focused: true, text: "N" });
    const snapshot: StateSnapshot = {
      capturedAt: "2026-08-22T00:00:00.000Z",
      location: unavailableObservation("not relevant"),
      focusedElement: availableObservation({ stableId: "key-n", role: "button", name: "N" }),
      uiTree: availableObservation([uiNode("keyboard", "region", "On-screen search keyboard", { children: [key] })]),
    };
    expect(rankOnScreenKeyboardKeys(snapshot, "N")).toHaveLength(1);
    expect(rankOnScreenKeyboardKeys(snapshot, "O")).toHaveLength(0);
  });

  test("does not let volatile bounds change a stable semantic state identity", () => {
    const snapshot = (x: number, stable = true): StateSnapshot => ({
      capturedAt: "2026-08-22T00:00:00.000Z",
      location: unavailableObservation("not relevant"),
      focusedElement: availableObservation({
        ...(stable ? { stableId: "target" } : {}),
        role: "button",
        name: "Target",
        bounds: { x, y: 0, width: 100, height: 40 },
      }),
      uiTree: availableObservation([uiNode(stable ? "target" : null, "button", "Target", {
        bounds: { x, y: 0, width: 100, height: 40 },
        focusable: true,
        focused: true,
      })]),
    });
    expect(webSemanticStateIdentity(snapshot(0))).toBe(webSemanticStateIdentity(snapshot(500)));
    expect(webSemanticStateIdentity(snapshot(0, false))).not.toBe(webSemanticStateIdentity(snapshot(500, false)));
  });

  test("does not collapse punctuation-distinct stable IDs", () => {
    const snapshot = (stableId: string): StateSnapshot => ({
      capturedAt: "2026-08-22T00:00:00.000Z",
      location: unavailableObservation("not relevant"),
      focusedElement: availableObservation({ stableId, role: "button", name: "Target" }),
      uiTree: availableObservation([uiNode(stableId, "button", "Target", { focusable: true, focused: true })]),
    });
    expect(webSemanticStateIdentity(snapshot("target-one"))).not.toBe(webSemanticStateIdentity(snapshot("target one")));
  });

  test("marks duplicate focused stable IDs and invalid fallback geometry unobservable", () => {
    const duplicated: StateSnapshot = {
      capturedAt: "2026-08-22T00:00:00.000Z",
      location: unavailableObservation("not relevant"),
      focusedElement: availableObservation({ stableId: "duplicate", role: "button", name: "Target" }),
      uiTree: availableObservation([
        uiNode("duplicate", "button", "Target", { focusable: true, focused: true }),
        uiNode("duplicate", "button", "Target", { focusable: true }),
      ]),
    };
    expect(webSemanticStateIdentity(duplicated)).toBeNull();

    const invalidGeometry: StateSnapshot = {
      capturedAt: "2026-08-22T00:00:00.000Z",
      location: unavailableObservation("not relevant"),
      focusedElement: availableObservation({
        role: "button",
        name: "Target",
        bounds: { x: 0, y: 0, width: -10, height: 10 },
      }),
      uiTree: availableObservation([uiNode(null, "button", "Target", { focusable: true, focused: true })]),
    };
    expect(() => webSemanticStateIdentity(invalidGeometry)).toThrow(/must not be negative/u);
  });

  test("fails closed on ambiguous and destructive settings labels", () => {
    const payment = uiNode("payment", "link", "Payment settings", { focusable: true });
    const appearance = uiNode("appearance", "button", "Appearance", { focusable: true });
    const safeLink = uiNode("accessibility", "link", "Accessibility settings", { focusable: true });
    const snapshot: StateSnapshot = {
      capturedAt: "2026-08-22T00:00:00.000Z",
      location: unavailableObservation("not relevant"),
      focusedElement: availableObservation(null),
      uiTree: availableObservation([uiNode("dialog", "dialog", "App settings", {
        modal: true,
        children: [payment, appearance, safeLink],
      })]),
    };
    const entries = flattenWebUiTree((snapshot.uiTree as { readonly status: "available"; readonly value: readonly UiNodeSnapshot[] }).value);
    const paymentEntry = entries.find((entry) => entry.node === payment);
    const appearanceEntry = entries.find((entry) => entry.node === appearance);
    const safeEntry = entries.find((entry) => entry.node === safeLink);
    expect(paymentEntry === undefined ? null : isSafeWebControl(payment, "payment settings")).toBe(false);
    expect(appearanceEntry === undefined ? null : isSafeSettingsSubmenu(appearanceEntry)).toBe(false);
    expect(safeEntry === undefined ? null : isSafeSettingsSubmenu(safeEntry)).toBe(true);
  });
});
