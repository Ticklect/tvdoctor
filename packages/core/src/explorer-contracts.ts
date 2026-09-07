import type {
  RemoteKey,
  ResetStrategy,
  StateSnapshot,
} from "@tvdoctor/protocol";

import type { ActionSettlingOptions } from "./action-settling.js";
import type { ExplorationGraph } from "./graph.js";

export interface ExplorationBudgets {
  /** Every driver.press call, including deterministic path replay. */
  readonly maxActions: number;
  /** Maximum unique ScreenState/FocusState pairs retained in the visited set. */
  readonly maxStates: number;
  /** Maximum discovery-sequence length. */
  readonly maxDepth: number;
  /** Monotonic wall-clock budget, including reset, settling, and snapshots. */
  readonly maxDurationMs: number;
}

export const DEFAULT_EXPLORATION_BUDGETS: ExplorationBudgets = {
  maxActions: 2_500,
  maxStates: 250,
  maxDepth: 16,
  maxDurationMs: 120_000,
};

/** Hard resource ceilings for values accepted from public runtime options. */
export const MAX_EXPLORATION_BUDGETS: ExplorationBudgets = {
  maxActions: 1_000_000,
  maxStates: 100_000,
  maxDepth: 4_096,
  maxDurationMs: 2_147_483_647,
};

export type ExplorationProfile = "quick" | "standard" | "deep";

/** Versioned, explicit resource envelopes for local, CI, and exhaustive runs. */
export const EXPLORATION_BUDGET_PROFILES: Readonly<Record<
  ExplorationProfile,
  ExplorationBudgets
>> = {
  quick: {
    maxActions: 300,
    maxStates: 75,
    maxDepth: 8,
    maxDurationMs: 30_000,
  },
  standard: DEFAULT_EXPLORATION_BUDGETS,
  deep: {
    maxActions: 10_000,
    maxStates: 1_000,
    maxDepth: 32,
    maxDurationMs: 1_800_000,
  },
};

export type ExplorationFrontierStrategy = "breadth-first" | "priority";

export interface RepetitionCompressionOptions {
  /** Disabled for legacy calls; enabled by explicit quick/standard/deep profiles. */
  readonly enabled?: boolean;
  /** Maximum exact focus states retained for one proven repeated-item group. */
  readonly maxRepresentativesPerGroup?: number;
  /** Maximum representatives from one group expanded by the frontier. */
  readonly maxExpandedRepresentativesPerGroup?: number;
  /** Required patterned focusable siblings before a group is considered repeated. */
  readonly minimumEquivalentSiblings?: number;
}

export interface NormalisedRepetitionCompressionOptions {
  readonly enabled: boolean;
  readonly maxRepresentativesPerGroup: number;
  readonly maxExpandedRepresentativesPerGroup: number;
  readonly minimumEquivalentSiblings: number;
}

export interface ExplorerOptions {
  /** An explicit profile activates the M8 priority/compression defaults. */
  readonly profile?: ExplorationProfile;
  readonly budgets?: Partial<ExplorationBudgets>;
  /** Deterministic action priority. Defaults to the bounded navigation-key set. */
  readonly actions?: readonly RemoteKey[];
  /** Record transitions to these snapshots but do not enqueue them for expansion/replay. */
  readonly shouldExpand?: (snapshot: StateSnapshot) => boolean;
  /** Used when restoreInitialState is absent. */
  readonly resetStrategy?: ResetStrategy;
  /** Allows adapters to supply an equivalent deterministic root restoration. */
  readonly restoreInitialState?: () => Promise<void>;
  /**
   * Restores the prepared root and returns its verified semantic snapshot.
   * When supplied, this replaces the default reset-plus-snapshot boundary for
   * both startup and replay reconstruction.
   */
  readonly restoreInitialSnapshot?: () => Promise<StateSnapshot>;
  /** Injectable monotonic clock for deterministic hosts/tests. */
  readonly monotonicNow?: () => number;
  /** Legacy calls remain BFS; explicit profiles default to deterministic priority. */
  readonly frontierStrategy?: ExplorationFrontierStrategy;
  /** Conservative repeated carousel/list-item compression. */
  readonly repetitionCompression?: RepetitionCompressionOptions;
  /** Optional bounded post-press snapshot stability polling. */
  readonly settling?: ActionSettlingOptions;
  /** Continue to sibling actions when a driver reports transient unobserved input. */
  readonly allowUnsettledActions?: boolean;
  /** Bounded live progress after each observed or explicitly tolerated action. */
  readonly onProgress?: (progress: ExplorationProgress) => void;
  /** Cooperative cancellation checked between driver operations. */
  readonly signal?: AbortSignal;
}

export interface ExplorationProgress {
  readonly physicalActions: number;
  readonly explorationActions: number;
  readonly replayActions: number;
  readonly screenStates: number;
  readonly focusStates: number;
  readonly pendingStates: number;
  readonly elapsedMs: number;
  readonly unsettledActions: number;
}

export type ExplorationTerminationReason =
  | "queue-exhausted"
  | "prepared-state-diverged"
  | "max-actions"
  | "max-states"
  | "max-depth"
  | "max-duration"
  | "remote-input-unavailable"
  | "restoration-unavailable"
  | "restoration-failed"
  | "replay-diverged"
  | "settling-exhausted"
  | "interrupted"
  | "driver-error";

export interface ExplorationTermination {
  readonly reason: ExplorationTerminationReason;
  readonly complete: boolean;
  /** Present for safety limits when queued work could not be attempted. */
  readonly remainingFrontierEntries?: number;
  /** Upper bound of outgoing actions represented by the pending frontier. */
  readonly remainingCandidateActions?: number;
  /** User-facing engine classification; canonical reason remains authoritative. */
  readonly detail?: string;
}

export interface ExplorationStatistics {
  readonly physicalActions: number;
  readonly explorationActions: number;
  readonly replayActions: number;
  /** Root restorations, including the initial restoration before discovery. */
  readonly resetCount: number;
  /** Restoration attempts made for queued state/action branches. */
  readonly replayRestorations: number;
  readonly visitedStates: number;
  readonly screenStates: number;
  readonly focusStates: number;
  readonly maximumQueueSize: number;
  /** Frontier entries which were still pending when exploration terminated. */
  readonly pendingStates: number;
  readonly elapsedMs: number;
  /** Mean first-discovery depth across retained exact focus states. */
  readonly averagePathDepth: number;
  readonly maximumPathDepth: number;
  /** Mean and maximum root-to-state replay length across restoration attempts. */
  readonly averageReplayLength: number;
  readonly maximumReplayLength: number;
  /** Exact state fingerprints observed after their first registration. */
  readonly repeatedStates?: number;
  /** Unique exact states represented by an equivalent repeated-item state. */
  readonly compressedStates?: number;
  /** Replayable repeated-item states deliberately withheld from expansion. */
  readonly deferredStates?: number;
  /** Extra snapshots captured by stable-snapshot settling. */
  readonly settlingPolls?: number;
  /** Actions whose bounded stability polling ended before convergence. */
  readonly unsettledActions?: number;
  /** Overlapping phase timings used to profile restoration and observation cost. */
  readonly timings: ExplorationPhaseTimings;
}

export interface ExplorationPhaseTimings {
  readonly resetMs: number;
  /** Root-to-state action replay, excluding the preceding root reset. */
  readonly pathReplayMs: number;
  /** Wall time inside driver.press(), including the driver's settling boundary. */
  readonly driverPressMs: number;
  /** Input-to-first-observable-response time reported by the driver. */
  readonly actionDispatchMs: number;
  /** First response to the reported focus-settled boundary. */
  readonly focusSettlingMs: number;
  /** Remaining time to the reported screen-settled boundary. */
  readonly screenSettlingMs: number;
  readonly snapshotCaptureMs: number;
  /** Canonical snapshot fingerprinting and semantic identity normalization. */
  readonly semanticNormalizationMs: number;
  /** Frontier selection, deduplication, registration, and transition recording. */
  readonly graphBookkeepingMs: number;
}

export interface ExplorationResult {
  readonly graph: ExplorationGraph;
  readonly termination: ExplorationTermination;
  readonly budgets: ExplorationBudgets;
  readonly actionOrder: readonly RemoteKey[];
  readonly statistics: ExplorationStatistics;
}
