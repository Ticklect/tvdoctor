import type {
  ActionResult,
  DriverOperationOptions,
  ElementBounds,
  RemoteKey,
  ResetStrategy,
  StateSnapshot,
  TVDoctorDriver,
  TVDoctorIssue,
} from "@tvdoctor/protocol";

export const WEB_STAGE_NAMES = [
  "search",
  "settings",
  "accessibility",
  "layout",
  "performance",
  "crash",
] as const;

export type WebStageName = (typeof WEB_STAGE_NAMES)[number];

export type WebStageStatus =
  | "passed"
  | "failed"
  | "partial"
  | "unobservable"
  | "skipped";

export interface WebElementDescriptor {
  readonly stableId: string | null;
  readonly role: string | null;
  readonly name: string | null;
  readonly bounds: ElementBounds | null;
  readonly visible: boolean | null;
  readonly enabled: boolean | null;
  readonly focusable: boolean | null;
}

export interface WebStageResult {
  readonly stage: WebStageName;
  readonly status: WebStageStatus;
  readonly detail: string;
  readonly issues: readonly TVDoctorIssue[];
  /** Exact reset-relative sequences observed by this stage, never fixture routes. */
  readonly observations: readonly WebStageObservation[];
}

export interface WebStageObservation {
  readonly kind: string;
  readonly status: "available" | "partial" | "unavailable";
  readonly detail: string;
  readonly sequence: readonly RemoteKey[];
  readonly target: WebElementDescriptor | null;
  readonly actionResult: ActionResult | null;
}

export interface WebPackBudgets {
  /** Counts every driver.press call, including restoration replays. */
  readonly maxActions: number;
  /** Unique semantic focus/surface states retained for the complete run. */
  readonly maxStates: number;
  readonly maxLocalDepth: number;
  readonly maxLocalStates: number;
  readonly maxDurationMs: number;
  readonly maxFocusProbes: number;
  readonly maxSettingsSurfaces: number;
  readonly maxLogs: number;
}

export const DEFAULT_WEB_PACK_BUDGETS: WebPackBudgets = {
  maxActions: 1_200,
  maxStates: 160,
  maxLocalDepth: 12,
  maxLocalStates: 48,
  maxDurationMs: 180_000,
  maxFocusProbes: 24,
  maxSettingsSurfaces: 12,
  maxLogs: 512,
};

export interface SearchQueryEntryRequest {
  readonly query: string;
  readonly input: WebElementDescriptor;
  readonly snapshot: StateSnapshot;
  readonly inputSequence: readonly RemoteKey[];
  readonly signal?: AbortSignal;
}

export type SearchQueryEntryResult =
  | {
    readonly status: "entered";
    readonly method: "system-keyboard" | "driver-text-input";
    readonly observedQuery: string;
    readonly resultsObserved: boolean;
    readonly detail: string;
  }
  | {
    readonly status: "unavailable" | "error";
    readonly detail: string;
  };

export interface SearchQueryEntryHook {
  /**
   * System/driver text fallback only. Remote on-screen keyboard input is owned
   * by the pack so every D-pad action remains counted and reproducible.
   */
  enter(request: SearchQueryEntryRequest): Promise<SearchQueryEntryResult>;
}

export interface IsolatedPointerProbeRequest {
  readonly kind: "search-submit";
  readonly element: WebElementDescriptor;
  readonly snapshot: StateSnapshot;
  readonly surfaceSequence: readonly RemoteKey[];
  readonly signal?: AbortSignal;
}

export type IsolatedPointerProbeResult =
  | {
    readonly status: "activated";
    readonly observedEffect: string;
    readonly detail: string;
  }
  | {
    readonly status: "not-activated" | "unavailable" | "error";
    readonly detail: string;
  };

export interface IsolatedPointerProbe {
  /** Runs outside the main remote session; the pack restores immediately afterward. */
  probe(request: IsolatedPointerProbeRequest): Promise<IsolatedPointerProbeResult>;
}

export interface WebFocusVisualSample {
  readonly outlineWidthPx: number | null;
  readonly borderWidthPx: number | null;
  readonly opacity: number | null;
  readonly transform: string | null;
  readonly backgroundColor: string | null;
  readonly boxShadow: string | null;
}

export interface WebFocusVisibilityProbeRequest {
  readonly element: WebElementDescriptor;
  readonly snapshot: StateSnapshot;
  readonly focusSequence: readonly RemoteKey[];
  readonly signal?: AbortSignal;
}

export type WebFocusVisibilityProbeResult =
  | {
    readonly status: "available";
    readonly unfocused: WebFocusVisualSample;
    readonly focused: WebFocusVisualSample;
    /** Changed-pixel ratio for equal-sized isolated crops, from 0 through 1. */
    readonly screenshotDifferenceRatio: number | null;
    readonly detail: string;
  }
  | {
    readonly status: "unavailable" | "error";
    readonly detail: string;
  };

export interface WebFocusVisibilityProbe {
  /** Browser-owned CSS/crop proof; the semantic pack never imports a DOM runtime. */
  probe(request: WebFocusVisibilityProbeRequest): Promise<WebFocusVisibilityProbeResult>;
}

export interface ViewportRectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type ViewportObservationResult =
  | {
    readonly status: "available";
    readonly viewport: ViewportRectangle;
    readonly source: string;
  }
  | {
    readonly status: "unavailable" | "error";
    readonly detail: string;
  };

export interface ViewportObservationHook {
  observe(snapshot: StateSnapshot, options?: DriverOperationOptions): Promise<ViewportObservationResult>;
}

export interface WebPackHooks {
  readonly searchQueryEntry?: SearchQueryEntryHook;
  readonly pointerProbe?: IsolatedPointerProbe;
  readonly webFocusVisibility?: WebFocusVisibilityProbe;
  readonly viewport?: ViewportObservationHook;
}

export interface WebPackOptions {
  /** Unique selected stages. Omit to run all six stages in canonical order. */
  readonly stages?: readonly WebStageName[];
  readonly budgets?: Partial<WebPackBudgets>;
  readonly resetStrategy?: ResetStrategy;
  readonly restoreInitialState?: (options?: DriverOperationOptions) => Promise<void>;
  readonly searchQuery?: string;
  /** Streaming-pack reset-relative Settings-open sequence; must end in SELECT. */
  readonly playerSettingsSequence?: readonly RemoteKey[];
  /** Project/fixture configuration, not a universal pack threshold. */
  readonly menuResponseThresholdMs?: number;
  readonly hooks?: WebPackHooks;
  readonly monotonicNow?: () => number;
}

export type WebPackTerminationReason =
  | "complete"
  | "max-actions"
  | "max-states"
  | "max-local-depth"
  | "max-local-states"
  | "max-duration"
  | "remote-input-unavailable"
  | "ui-tree-unavailable"
  | "restoration-unavailable"
  | "restoration-failed"
  | "invalid-options"
  | "driver-error";

export interface WebPackTermination {
  readonly reason: WebPackTerminationReason;
  readonly complete: boolean;
  readonly detail: string;
}

export interface WebPackStatistics {
  readonly physicalActions: number;
  readonly discoveryActions: number;
  readonly probeActions: number;
  readonly replayActions: number;
  readonly resets: number;
  readonly snapshots: number;
  readonly uniqueStates: number;
  readonly focusProbes: number;
  readonly pointerProbes: number;
  readonly elapsedMs: number;
}

export interface WebPackResult {
  readonly status: "complete" | "partial" | "unobservable" | "error";
  readonly termination: WebPackTermination;
  readonly budgets: WebPackBudgets;
  readonly stages: readonly WebStageResult[];
  readonly issues: readonly TVDoctorIssue[];
  readonly statistics: WebPackStatistics;
}

export type WebPackDriver = TVDoctorDriver;
