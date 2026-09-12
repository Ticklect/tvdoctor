import type {
  DriverOperationOptions,
  ElementBounds,
  FocusTarget,
  RemoteKey,
  ResetStrategy,
  StateSnapshot,
  TVDoctorDriver,
  TVDoctorIssue,
  UiSelectionState,
} from "@tvdoctor/protocol";
import type {
  ReplayExecutionReason,
  ReplayExecutionStatus,
} from "@tvdoctor/core";

export const STREAMING_STAGE_NAMES = [
  "home",
  "content",
  "details",
  "play",
  "player",
  "controls",
  "player-volume",
  "pause-resume",
  "seek-forward",
  "seek-backward",
  "player-back",
  "settings",
  "captions",
  "caption-selection",
  "appearance",
  "caption-text-colour",
  "nested-back",
] as const;

export type StreamingStageName = (typeof STREAMING_STAGE_NAMES)[number];

export type StreamingStageStatus =
  | "passed"
  | "failed"
  | "partial"
  | "unobservable"
  | "skipped";

export interface StreamingElementDescriptor {
  readonly stableId: string | null;
  readonly role: string | null;
  readonly name: string | null;
  readonly bounds: ElementBounds | null;
  readonly visible: boolean | null;
  readonly enabled: boolean | null;
  readonly focusable: boolean | null;
  readonly selectionState: UiSelectionState | null;
  readonly valueNow: number | null;
}

export interface StreamingStageResult {
  readonly stage: StreamingStageName;
  readonly status: StreamingStageStatus;
  readonly detail: string;
  /** Exact reset-relative remote sequence at the observation point. */
  readonly sequence: readonly RemoteKey[];
  readonly target: StreamingElementDescriptor | null;
}

export interface AppearanceControlResult {
  readonly element: StreamingElementDescriptor;
  readonly remotelyReachable: boolean;
  readonly exactSequence: readonly RemoteKey[] | null;
  readonly activation: "not-attempted" | "observed" | "unobservable";
  readonly detail: string;
}

export interface StreamingPackBudgets {
  /** Counts every driver.press call, including discovery restore replays. */
  readonly maxActions: number;
  /** Unique semantic focus states retained across every stage. */
  readonly maxStates: number;
  /** Maximum directional sequence depth for one local semantic search. */
  readonly maxLocalDepth: number;
  /** Maximum unique focus states expanded during one local search. */
  readonly maxLocalStates: number;
  /** Monotonic duration for discovery, probes, restoration, and replay. */
  readonly maxDurationMs: number;
}

export const DEFAULT_STREAMING_PACK_BUDGETS: StreamingPackBudgets = {
  maxActions: 900,
  maxStates: 180,
  maxLocalDepth: 12,
  maxLocalStates: 48,
  maxDurationMs: 180_000,
};

export interface StreamingPointerProbeRequest {
  readonly kind: "caption-text-colour" | "player-volume-control";
  readonly element: StreamingElementDescriptor;
  readonly snapshot: StateSnapshot;
  /** The exact remote-only route that reached the containing semantic surface. */
  readonly surfaceSequence: readonly RemoteKey[];
  /** Aborted when the pack-wide deadline expires. */
  readonly signal?: AbortSignal;
}

export interface StreamingPointerObservedChange {
  /** A bounded, human-readable property observed in an isolated pointer context. */
  readonly property: string;
  readonly before: string | null;
  readonly after: string;
}

export type StreamingPointerProbeResult =
  | {
    readonly status: "reachable";
    readonly detail: string;
    readonly observedChange: StreamingPointerObservedChange;
  }
  | {
    readonly status: "unreachable";
    readonly detail: string;
  }
  | {
    readonly status: "unobservable" | "error";
    readonly detail: string;
  };

export interface StreamingPointerProbeRecord {
  readonly kind: StreamingPointerProbeRequest["kind"];
  readonly element: StreamingElementDescriptor;
  readonly result: StreamingPointerProbeResult;
  readonly mainSessionRestored: boolean;
  readonly restorationDetail: string;
}

export interface StreamingPointerProbe {
  /**
   * Optional, platform-owned pointer observation. The pack never imports a
   * pointer runtime. It restores the remote journey immediately after the hook.
   */
  probe(request: StreamingPointerProbeRequest): Promise<StreamingPointerProbeResult>;
}

export interface StreamingPackOptions {
  readonly budgets?: Partial<StreamingPackBudgets>;
  readonly resetStrategy?: ResetStrategy;
  readonly restoreInitialState?: (options?: DriverOperationOptions) => Promise<void>;
  readonly pointerProbe?: StreamingPointerProbe;
  readonly monotonicNow?: () => number;
}

export type StreamingPackTerminationReason =
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
  | "replay-diverged"
  | "driver-error"
  | "journey-partial";

export interface StreamingPackTermination {
  readonly reason: StreamingPackTerminationReason;
  readonly complete: boolean;
  readonly detail: string;
}

export interface StreamingPackStatistics {
  readonly physicalActions: number;
  readonly discoveryActions: number;
  readonly probeActions: number;
  readonly replayActions: number;
  readonly resets: number;
  readonly snapshots: number;
  readonly uniqueStates: number;
  readonly pointerProbes: number;
  readonly elapsedMs: number;
}

export interface StreamingReplayResult {
  readonly issueId: string;
  readonly status: ReplayExecutionStatus | "unavailable";
  readonly reason: ReplayExecutionReason | { readonly message: string } | null;
  readonly actionsPressed: number;
}

export interface StreamingPackResult {
  readonly status: "complete" | "partial" | "unobservable" | "error";
  readonly termination: StreamingPackTermination;
  readonly budgets: StreamingPackBudgets;
  readonly stages: readonly StreamingStageResult[];
  readonly issues: readonly TVDoctorIssue[];
  readonly appearanceControls: readonly AppearanceControlResult[];
  readonly volumeControl: AppearanceControlResult | null;
  readonly replays: readonly StreamingReplayResult[];
  readonly pointerProbes: readonly StreamingPointerProbeRecord[];
  readonly journeySequence: readonly RemoteKey[];
  readonly statistics: StreamingPackStatistics;
}

export type StreamingDriver = TVDoctorDriver;

export interface StreamingFocusedObservation {
  readonly target: FocusTarget | null;
  readonly snapshot: StateSnapshot;
}
