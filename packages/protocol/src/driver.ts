import type { Capability } from "./capability.js";
import type { Observation } from "./observation.js";
import type { RemoteKey } from "./remote-key.js";

/**
 * `inconclusive` marks input that was delivered while settling evidence stayed
 * unavailable, so callers must not attribute a transition or a no-op to it.
 */
export type ActionOutcome = "applied" | "unsupported" | "failed" | "inconclusive";

/** Bounded, always-safe profiling counters attached to every driver action. */
export interface ActionProfile {
  /** Where the compared pre-input state came from. */
  readonly baselineSource: "fresh" | "cached" | "unavailable";
  /** Number of heavyweight observations taken for this action. */
  readonly captureCount: number;
  /** Per-observation durations in ms; implementations may cap the list size. */
  readonly captureDurationsMs?: readonly number[];
  /** Input dispatch duration in ms when measured. */
  readonly inputDispatchMs?: number;
  /** Settling poll iterations performed. */
  readonly pollCount?: number;
  /** True when observations started failing instantly (device wedge signature). */
  readonly wedgeSuspected?: boolean;
  /** Persistent transport request/response time, excluding input dispatch. */
  readonly transportMs?: number;
  /** Time from input completion to the first relevant platform event. */
  readonly observerEventLatencyMs?: number;
  /** Time spent generating the canonical platform snapshot. */
  readonly snapshotGenerationMs?: number;
  /** Event-driven quiet/no-op confirmation time inside the platform observer. */
  readonly settlingMs?: number;
  /** Time spent converting the observer payload to the canonical driver snapshot. */
  readonly hostConversionMs?: number;
  /** End-to-end driver action time, including input, settling, and conversion. */
  readonly totalMs?: number;
}

export interface ActionTiming {
  readonly inputSentAtMs: number;
  readonly firstResponseAtMs?: number;
  readonly focusSettledAtMs?: number;
  readonly screenSettledAtMs?: number;
  readonly profile?: ActionProfile;
}

export interface ActionResult {
  readonly key: RemoteKey;
  readonly outcome: ActionOutcome;
  readonly timing: ActionTiming;
  readonly message?: string;
  /**
   * Canonical observation captured at the settle boundary for `applied`
   * actions. Optional: drivers that cannot safely produce one omit it, and
   * callers must fall back to `snapshot()`.
   */
  readonly postActionSnapshot?: StateSnapshot;
}

export interface ElementBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface FocusTarget {
  readonly stableId?: string;
  readonly role?: string;
  readonly name?: string;
  readonly bounds?: ElementBounds;
}

/** Normalised selection/toggle state exposed by a platform UI hierarchy. */
export const UI_SELECTION_STATES = ["on", "off", "mixed"] as const;

export type UiSelectionState = (typeof UI_SELECTION_STATES)[number];

/**
 * A platform-neutral, JSON-serializable node from a driver's UI hierarchy.
 *
 * `null` means the driver could not provide that property for this node. The
 * hierarchy itself is wrapped in an `Observation` so a driver can explicitly
 * report that no UI tree is available at all.
 */
export interface UiNodeSnapshot {
  readonly stableId: string | null;
  readonly role: string | null;
  readonly name: string | null;
  readonly text: string | null;
  readonly bounds: ElementBounds | null;
  readonly visible: boolean | null;
  /** Explicit interaction availability; null means the driver cannot observe it. */
  readonly enabled: boolean | null;
  readonly focusable: boolean | null;
  readonly focused: boolean | null;
  /** Whether this node is an active modal surface; null means unobservable. */
  readonly modal: boolean | null;
  /** Checked, pressed, or selected state; null means unavailable or not applicable. */
  readonly selectionState: UiSelectionState | null;
  /** Finite current numeric value; null means unavailable or not applicable. */
  readonly valueNow: number | null;
  readonly children: readonly UiNodeSnapshot[];
}

export interface StateSnapshot {
  readonly capturedAt: string;
  readonly location: Observation<string>;
  readonly focusedElement: Observation<FocusTarget | null>;
  readonly uiTree: Observation<readonly UiNodeSnapshot[]>;
}

export type ScreenshotMediaType = "image/png" | "image/jpeg";

/** Metadata for an on-disk screenshot, suitable for report serialization. */
export interface ScreenshotArtifact {
  readonly path: string;
  readonly mediaType: ScreenshotMediaType;
  readonly width: number;
  readonly height: number;
  readonly capturedAt: string;
}

export type ResetStrategy = "relaunch" | "reload" | "clear-data";

export interface AppReference {
  readonly id: string;
  readonly artifactPath?: string;
  readonly launchUri?: string;
}

export interface LogEntry {
  readonly timestamp: string;
  readonly level: "debug" | "info" | "warning" | "error";
  readonly message: string;
}

export interface TVDoctorDriver {
  capabilities(): Promise<ReadonlySet<Capability>>;
  press(key: RemoteKey): Promise<ActionResult>;
  snapshot(): Promise<StateSnapshot>;
  captureScreenshot?(artifactPath: string): Promise<ScreenshotArtifact>;
  reset?(strategy: ResetStrategy): Promise<void>;
  install?(artifactPath: string): Promise<void>;
  launch?(app: AppReference): Promise<void>;
  getLogs?(): Promise<readonly LogEntry[]>;
}
