import {
  NAVIGATION_KEYS,
  REMOTE_KEYS,
  type ActionResult,
  type RemoteKey,
  type ResetStrategy,
  type StateSnapshot,
  type TVDoctorDriver,
  type UiNodeSnapshot,
} from "@tvdoctor/protocol";
import {
  normaliseActionSettlingOptions,
  pressAndObserve,
  type ActionSettlingOptions,
  type NormalisedActionSettlingOptions,
} from "./action-settling.js";
import { PreparedStateDivergenceError } from "./errors.js";
import {
  computeSnapshotFingerprint,
  type ComputedSnapshotFingerprint,
} from "./fingerprint.js";
import type {
  ExplorationActionAttempt,
  ExplorationGraph,
  FocusState,
  FocusTransition,
  ScreenState,
  ScreenTransition,
} from "./graph.js";

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

interface MutableScreenState {
  readonly id: string;
  readonly identity: string;
  readonly fingerprint: ScreenState["fingerprint"];
  readonly firstSeenDepth: number;
  readonly discoveredBy: readonly RemoteKey[];
  readonly representativeSnapshot: StateSnapshot;
  readonly focusStateIds: string[];
}

interface InternalFocusState {
  readonly id: string;
  readonly screenStateId: string;
  readonly identity: string;
  readonly fingerprint: ComputedSnapshotFingerprint;
  readonly firstSeenDepth: number;
  readonly discoveredBy: readonly RemoteKey[];
  readonly representativeSnapshot: StateSnapshot;
  readonly repetitionGroup: string | null;
  readonly frontierPriority: number;
  scheduled: boolean;
}

interface QueueEntry {
  readonly state: InternalFocusState;
  readonly sequence: readonly RemoteKey[];
  /** Exact semantic state expected after each corresponding replay action. */
  readonly checkpoints: readonly string[];
  readonly insertionOrder: number;
}

interface RegisteredState {
  readonly state: InternalFocusState;
  readonly isNew: boolean;
  readonly newScreen: boolean;
}

interface RepetitionGroup {
  readonly key: string;
  readonly representatives: InternalFocusState[];
  expandedRepresentatives: number;
}

interface RestoreSuccess {
  readonly status: "ok";
  readonly snapshot: StateSnapshot;
}

interface RestoreStop {
  readonly status: "stop";
  readonly termination: ExplorationTermination;
}

type RestoreResult = RestoreSuccess | RestoreStop;

class DurationBudgetExceeded extends Error {
  constructor() {
    super("The exploration duration budget was exhausted during a driver call.");
    this.name = "DurationBudgetExceeded";
  }
}

const COMPLETE_TERMINATION: ExplorationTermination = {
  reason: "queue-exhausted",
  complete: true,
};

function incomplete(
  reason: Exclude<ExplorationTerminationReason, "queue-exhausted">,
  detail?: string,
): ExplorationTermination {
  return {
    reason,
    complete: false,
    ...(detail === undefined ? {} : { detail: detail.replace(/\s+/gu, " ").slice(0, 500) }),
  };
}

function snapshotNodeCount(snapshot: StateSnapshot): number | null {
  if (snapshot.uiTree.status !== "available") return null;
  const count = (nodes: readonly UiNodeSnapshot[]): number => nodes.reduce(
    (total, node) => total + 1 + count(node.children),
    0,
  );
  return count(snapshot.uiTree.value);
}

function snapshotStructure(snapshot: StateSnapshot): readonly string[] | null {
  if (snapshot.uiTree.status !== "available") return null;
  const flatten = (nodes: readonly UiNodeSnapshot[], depth: number): readonly string[] => nodes.flatMap((node) => [
    `${String(depth)}:${node.stableId ?? ""}|${node.role ?? ""}|${String(node.visible)}|${String(node.enabled)}|${String(node.focusable)}|${String(node.modal)}`,
    ...flatten(node.children, depth + 1),
  ]);
  return flatten(snapshot.uiTree.value, 0);
}

function snapshotDifference(expected: StateSnapshot, observed: StateSnapshot): string {
  const expectedLocation = expected.location.status === "available"
    ? expected.location.value
    : "unavailable";
  const observedLocation = observed.location.status === "available"
    ? observed.location.value
    : "unavailable";
  const expectedFocus = expected.focusedElement.status === "available"
    ? expected.focusedElement.value?.stableId ?? expected.focusedElement.value?.role ?? "none"
    : "unavailable";
  const observedFocus = observed.focusedElement.status === "available"
    ? observed.focusedElement.value?.stableId ?? observed.focusedElement.value?.role ?? "none"
    : "unavailable";
  const expectedNodes = snapshotNodeCount(expected);
  const observedNodes = snapshotNodeCount(observed);
  const expectedStructure = snapshotStructure(expected);
  const observedStructure = snapshotStructure(observed);
  let firstDifference = "";
  if (expectedStructure !== null && observedStructure !== null) {
    const differenceIndex = expectedStructure.findIndex(
      (value, index) => value !== observedStructure[index],
    );
    if (differenceIndex >= 0) {
      firstDifference = ` First structural difference at node ${String(differenceIndex + 1)}: ${expectedStructure[differenceIndex]} -> ${observedStructure[differenceIndex] ?? "missing"}.`;
    } else if (expectedStructure.length !== observedStructure.length) {
      firstDifference = ` First structural difference at node ${String(Math.min(expectedStructure.length, observedStructure.length) + 1)}: tree length changed.`;
    }
  }
  const locationDifference = expectedLocation === observedLocation
    ? ""
    : ` Location ${expectedLocation} -> ${observedLocation}.`;
  return `UI nodes ${String(expectedNodes ?? "unavailable")} -> ${String(observedNodes ?? "unavailable")}; focus ${expectedFocus} -> ${observedFocus}.${locationDifference}${firstDifference}`;
}

function positiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${name} must be a positive safe integer no greater than ${String(maximum)}.`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new TypeError(`${name} must be a non-negative safe integer no greater than ${String(maximum)}.`);
  }
  return value;
}

function positiveDuration(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_EXPLORATION_BUDGETS.maxDurationMs) {
    throw new TypeError(`${name} must be a positive safe integer duration no greater than ${String(MAX_EXPLORATION_BUDGETS.maxDurationMs)}.`);
  }
  return value;
}

function normaliseBudgets(
  profile: ExplorationProfile | undefined,
  overrides: Partial<ExplorationBudgets> | undefined,
): ExplorationBudgets {
  if (overrides !== undefined
    && (typeof overrides !== "object" || overrides === null || Array.isArray(overrides))) {
    throw new TypeError("budgets must be an object.");
  }
  const defaults = profile === undefined
    ? DEFAULT_EXPLORATION_BUDGETS
    : EXPLORATION_BUDGET_PROFILES[profile];
  const values = { ...defaults, ...overrides };
  return {
    maxActions: positiveInteger(values.maxActions, "maxActions", MAX_EXPLORATION_BUDGETS.maxActions),
    maxStates: positiveInteger(values.maxStates, "maxStates", MAX_EXPLORATION_BUDGETS.maxStates),
    maxDepth: nonNegativeInteger(values.maxDepth, "maxDepth", MAX_EXPLORATION_BUDGETS.maxDepth),
    maxDurationMs: positiveDuration(values.maxDurationMs, "maxDurationMs"),
  };
}

function normaliseFrontierStrategy(
  strategy: ExplorationFrontierStrategy | undefined,
  profile: ExplorationProfile | undefined,
): ExplorationFrontierStrategy {
  const result = strategy ?? (profile === undefined ? "breadth-first" : "priority");
  if (result !== "breadth-first" && result !== "priority") {
    throw new TypeError("frontierStrategy must be breadth-first or priority.");
  }
  return result;
}

function profileCompressionDefaults(
  profile: ExplorationProfile | undefined,
): NormalisedRepetitionCompressionOptions {
  if (profile === undefined) {
    return {
      enabled: false,
      maxRepresentativesPerGroup: 2,
      maxExpandedRepresentativesPerGroup: 1,
      minimumEquivalentSiblings: 3,
    };
  }
  const representatives = profile === "quick" ? 1 : profile === "standard" ? 2 : 4;
  const expanded = profile === "deep" ? 2 : 1;
  return {
    enabled: true,
    maxRepresentativesPerGroup: representatives,
    maxExpandedRepresentativesPerGroup: expanded,
    minimumEquivalentSiblings: 3,
  };
}

function normaliseRepetitionCompression(
  profile: ExplorationProfile | undefined,
  options: RepetitionCompressionOptions | undefined,
): NormalisedRepetitionCompressionOptions {
  if (options !== undefined
    && (typeof options !== "object" || options === null || Array.isArray(options))) {
    throw new TypeError("repetitionCompression must be an object.");
  }
  const defaults = profileCompressionDefaults(profile);
  if (options?.enabled !== undefined && typeof options.enabled !== "boolean") {
    throw new TypeError("repetitionCompression.enabled must be a boolean.");
  }
  const maxRepresentativesPerGroup = positiveInteger(
    options?.maxRepresentativesPerGroup ?? defaults.maxRepresentativesPerGroup,
    "maxRepresentativesPerGroup",
    MAX_EXPLORATION_BUDGETS.maxStates,
  );
  const maxExpandedRepresentativesPerGroup = positiveInteger(
    options?.maxExpandedRepresentativesPerGroup ?? defaults.maxExpandedRepresentativesPerGroup,
    "maxExpandedRepresentativesPerGroup",
    MAX_EXPLORATION_BUDGETS.maxStates,
  );
  if (maxExpandedRepresentativesPerGroup > maxRepresentativesPerGroup) {
    throw new TypeError(
      "maxExpandedRepresentativesPerGroup must not exceed maxRepresentativesPerGroup.",
    );
  }
  return {
    enabled: options?.enabled ?? defaults.enabled,
    maxRepresentativesPerGroup,
    maxExpandedRepresentativesPerGroup,
    minimumEquivalentSiblings: positiveInteger(
      options?.minimumEquivalentSiblings ?? defaults.minimumEquivalentSiblings,
      "minimumEquivalentSiblings",
      MAX_EXPLORATION_BUDGETS.maxStates,
    ),
  };
}

function normaliseActions(actions: readonly RemoteKey[] | undefined): readonly RemoteKey[] {
  if (actions !== undefined && !Array.isArray(actions)) {
    throw new TypeError("Explorer actions must be an array.");
  }
  const result = [...(actions ?? NAVIGATION_KEYS)];
  const allowed = new Set<string>(REMOTE_KEYS);
  if (result.some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw new TypeError("Explorer actions must contain only known remote keys.");
  }
  if (new Set(result).size !== result.length) {
    throw new TypeError("Explorer actions must not contain duplicates.");
  }
  return result;
}

function sequenceWith(sequence: readonly RemoteKey[], key: RemoteKey): readonly RemoteKey[] {
  return [...sequence, key];
}

function id(prefix: string, sequence: number): string {
  return `${prefix}-${String(sequence).padStart(4, "0")}`;
}

function normaliseRepeatedIdentifier(value: string | null): string | null {
  if (value === null) return null;
  const normalised = value.normalize("NFKC").trim().toLowerCase();
  if (!/\d/u.test(normalised)) return null;
  return normalised.replace(/\d+/gu, "#");
}

function dimensionBucket(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value / 16)) : "?";
}

interface LocatedNode {
  readonly node: UiNodeSnapshot;
  readonly ancestors: readonly UiNodeSnapshot[];
  readonly siblings: readonly UiNodeSnapshot[];
}

function locateFocusedNode(snapshot: StateSnapshot): LocatedNode | null {
  if (snapshot.uiTree.status !== "available") return null;
  const focusedTarget = snapshot.focusedElement.status === "available"
    ? snapshot.focusedElement.value
    : null;
  const visit = (
    nodes: readonly UiNodeSnapshot[],
    ancestors: readonly UiNodeSnapshot[],
  ): LocatedNode | null => {
    for (const node of nodes) {
      const matchesTarget = focusedTarget !== null
        && focusedTarget !== undefined
        && focusedTarget.stableId !== undefined
        && node.stableId === focusedTarget.stableId;
      if (node.focused === true || matchesTarget) {
        return { node, ancestors, siblings: nodes };
      }
      const nested = visit(node.children, [...ancestors, node]);
      if (nested !== null) return nested;
    }
    return null;
  };
  return visit(snapshot.uiTree.value, []);
}

/**
 * Recognise only explicit generated sibling patterns (for example card-17).
 * Names/text are ignored because content titles differ between equivalent
 * carousel cells; role, interaction state, dimensions, and ancestry remain.
 */
function repetitionGroupKey(
  snapshot: StateSnapshot,
  fingerprint: ComputedSnapshotFingerprint,
  compression: NormalisedRepetitionCompressionOptions,
): string | null {
  if (!compression.enabled) return null;
  const located = locateFocusedNode(snapshot);
  if (located === null || located.node.focusable !== true) return null;
  const identifierPattern = normaliseRepeatedIdentifier(located.node.stableId);
  if (identifierPattern === null) return null;
  const equivalentSiblings = located.siblings.filter((sibling) => (
    sibling.focusable === true
    && sibling.role === located.node.role
    && sibling.enabled === located.node.enabled
    && sibling.selectionState === located.node.selectionState
    && normaliseRepeatedIdentifier(sibling.stableId) === identifierPattern
  ));
  if (equivalentSiblings.length < compression.minimumEquivalentSiblings) return null;

  const ancestry = located.ancestors.map((ancestor) => (
    `${normaliseRepeatedIdentifier(ancestor.stableId) ?? ancestor.stableId ?? ""}:${ancestor.role ?? ""}`
  )).join("/");
  const bounds = located.node.bounds;
  const dimensions = bounds === null
    ? "?"
    // Horizontal carousels scroll as focus moves deeper into the rail, which
    // shifts the viewport-relative y coordinate without changing structural
    // identity. Width and height buckets are sufficient for equivalence.
    : `${dimensionBucket(bounds.width)},${dimensionBucket(bounds.height)}`;
  return [
    fingerprint.screenIdentity,
    ancestry,
    identifierPattern,
    located.node.role ?? "",
    String(located.node.enabled),
    // Visibility is excluded: horizontal scrolling changes which cards are in
    // the viewport without changing structural identity. A card scrolled out
    // of view is still the same interactive control as its visible siblings.
    "visible-excluded",
    located.node.selectionState ?? "",
    dimensions,
  ].join("\u001d");
}

function compareSequences(
  left: readonly RemoteKey[],
  right: readonly RemoteKey[],
  actionRank: ReadonlyMap<RemoteKey, number>,
): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftKey = left[index];
    const rightKey = right[index];
    if (leftKey === undefined || rightKey === undefined) break;
    const difference = (actionRank.get(leftKey) ?? Number.MAX_SAFE_INTEGER)
      - (actionRank.get(rightKey) ?? Number.MAX_SAFE_INTEGER);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

/**
 * Deterministic bounded BFS. Each queued state is restored from the same root
 * and reached by its explicit action sequence before an outgoing edge is tried.
 */
export async function explore(
  driver: TVDoctorDriver,
  options: ExplorerOptions = {},
): Promise<ExplorationResult> {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new TypeError("Explorer options must be an object.");
  }
  if (options.profile !== undefined
    && options.profile !== "quick"
    && options.profile !== "standard"
    && options.profile !== "deep") {
    throw new TypeError("profile must be quick, standard, or deep.");
  }
  const budgets = normaliseBudgets(options.profile, options.budgets);
  const actionOrder = normaliseActions(options.actions);
  const actionRank = new Map(actionOrder.map((key, index) => [key, index]));
  const frontierStrategy = normaliseFrontierStrategy(
    options.frontierStrategy,
    options.profile,
  );
  const repetitionCompression = normaliseRepetitionCompression(
    options.profile,
    options.repetitionCompression,
  );
  const settling: NormalisedActionSettlingOptions = normaliseActionSettlingOptions(
    options.settling,
  );
  if (options.restoreInitialState !== undefined && typeof options.restoreInitialState !== "function") {
    throw new TypeError("restoreInitialState must be a function.");
  }
  if (options.restoreInitialSnapshot !== undefined && typeof options.restoreInitialSnapshot !== "function") {
    throw new TypeError("restoreInitialSnapshot must be a function.");
  }
  if (options.monotonicNow !== undefined && typeof options.monotonicNow !== "function") {
    throw new TypeError("monotonicNow must be a function.");
  }
  if (options.resetStrategy !== undefined
    && options.resetStrategy !== "reload"
    && options.resetStrategy !== "relaunch"
    && options.resetStrategy !== "clear-data") {
    throw new TypeError("resetStrategy must be reload, relaunch, or clear-data.");
  }
  const monotonicSource = options.monotonicNow ?? (() => performance.now());
  const monotonicNow = (): number => {
    const value = monotonicSource();
    if (!Number.isFinite(value)) throw new TypeError("monotonicNow must return a finite number.");
    return value;
  };
  const startedAtMs = monotonicNow();
  let physicalActions = 0;
  let explorationActions = 0;
  let replayActions = 0;
  let resetCount = 0;
  let replayRestorations = 0;
  let totalReplayLength = 0;
  let maximumReplayLength = 0;
  let maximumQueueSize = 0;
  let pendingStates = 0;
  let repeatedStates = 0;
  let compressedStates = 0;
  let deferredStates = 0;
  let settlingPolls = 0;
  let unsettledActions = 0;
  let frontierInsertionSequence = 0;
  const phaseTimings = {
    resetMs: 0,
    pathReplayMs: 0,
    driverPressMs: 0,
    actionDispatchMs: 0,
    focusSettlingMs: 0,
    screenSettlingMs: 0,
    snapshotCaptureMs: 0,
    semanticNormalizationMs: 0,
    graphBookkeepingMs: 0,
  };

  const durationSince = (startedAt: number): number => Math.max(0, monotonicNow() - startedAt);
  const measureSynchronous = <T>(
    phase: "semanticNormalizationMs" | "graphBookkeepingMs",
    operation: () => T,
  ): T => {
    const operationStartedAt = monotonicNow();
    try {
      return operation();
    } finally {
      phaseTimings[phase] += durationSince(operationStartedAt);
    }
  };
  const fingerprintSnapshot = (snapshot: StateSnapshot): ComputedSnapshotFingerprint => (
    measureSynchronous("semanticNormalizationMs", () => computeSnapshotFingerprint(snapshot))
  );
  const recordActionTiming = (result: ActionResult): void => {
    const inputAt = result.timing.inputSentAtMs;
    const responseAt = Math.max(inputAt, result.timing.firstResponseAtMs ?? inputAt);
    const focusAt = Math.max(responseAt, result.timing.focusSettledAtMs ?? responseAt);
    const screenAt = Math.max(focusAt, result.timing.screenSettledAtMs ?? focusAt);
    phaseTimings.actionDispatchMs += responseAt - inputAt;
    phaseTimings.focusSettlingMs += focusAt - responseAt;
    phaseTimings.screenSettlingMs += screenAt - focusAt;
  };
  const measuredDriver: TVDoctorDriver = {
    capabilities: async () => driver.capabilities(),
    press: async (key) => {
      const pressStartedAt = monotonicNow();
      try {
        const result = await driver.press(key);
        recordActionTiming(result);
        return result;
      } finally {
        phaseTimings.driverPressMs += durationSince(pressStartedAt);
      }
    },
    snapshot: async () => {
      const snapshotStartedAt = monotonicNow();
      try {
        return await driver.snapshot();
      } finally {
        phaseTimings.snapshotCaptureMs += durationSince(snapshotStartedAt);
      }
    },
  };

  const screenStates: MutableScreenState[] = [];
  const focusStates: InternalFocusState[] = [];
  const screenTransitions: ScreenTransition[] = [];
  const focusTransitions: FocusTransition[] = [];
  const attempts: ExplorationActionAttempt[] = [];
  const screenByIdentity = new Map<string, MutableScreenState>();
  const stateByIdentity = new Map<string, InternalFocusState>();
  const repetitionGroups = new Map<string, RepetitionGroup>();
  const compressedStateIdentities = new Set<string>();
  const deferredStateIdentities = new Set<string>();

  const markCompressed = (stateIdentity: string): void => {
    if (compressedStateIdentities.has(stateIdentity)) return;
    compressedStateIdentities.add(stateIdentity);
    compressedStates += 1;
  };
  const markDeferred = (stateIdentity: string): void => {
    if (deferredStateIdentities.has(stateIdentity)) return;
    deferredStateIdentities.add(stateIdentity);
    deferredStates += 1;
  };

  const elapsed = (): number => Math.max(0, monotonicNow() - startedAtMs);
  const withinDurationBudget = async <T>(operation: () => Promise<T>): Promise<T> => {
    const remainingMs = budgets.maxDurationMs - elapsed();
    if (remainingMs <= 0) throw new DurationBudgetExceeded();

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const operationResult = operation().then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    const timeoutResult = new Promise<{ readonly status: "timed-out" }>((resolve) => {
      timeout = setTimeout(() => resolve({ status: "timed-out" }), remainingMs);
    });
    const result = await Promise.race([operationResult, timeoutResult]);
    if (timeout !== undefined) clearTimeout(timeout);
    if (result.status === "timed-out") throw new DurationBudgetExceeded();
    if (result.status === "rejected") throw result.error;
    return result.value;
  };
  const graph = (): ExplorationGraph => ({
    screens: {
      states: screenStates.map((state): ScreenState => ({
        id: state.id,
        fingerprint: state.fingerprint,
        firstSeenDepth: state.firstSeenDepth,
        discoveredBy: [...state.discoveredBy],
        representativeSnapshot: state.representativeSnapshot,
        focusStateIds: [...state.focusStateIds],
      })),
      transitions: [...screenTransitions],
    },
    focus: {
      states: focusStates.map((state): FocusState => ({
        id: state.id,
        screenStateId: state.screenStateId,
        fingerprint: state.fingerprint.fingerprint.focus,
        stateFingerprint: state.fingerprint.fingerprint.stateValue,
        confidence: state.fingerprint.fingerprint.confidence,
        firstSeenDepth: state.firstSeenDepth,
        discoveredBy: [...state.discoveredBy],
        representativeSnapshot: state.representativeSnapshot,
      })),
      transitions: [...focusTransitions],
    },
    actions: [...attempts],
  });
  const finish = (termination: ExplorationTermination): ExplorationResult => {
    const totalPathDepth = focusStates.reduce((total, state) => total + state.firstSeenDepth, 0);
    const maximumPathDepth = focusStates.reduce(
      (maximum, state) => Math.max(maximum, state.firstSeenDepth),
      0,
    );
    return {
      graph: graph(),
      termination,
      budgets,
      actionOrder: [...actionOrder],
      statistics: {
        physicalActions,
        explorationActions,
        replayActions,
        resetCount,
        replayRestorations,
        visitedStates: focusStates.length,
        screenStates: screenStates.length,
        focusStates: focusStates.length,
        maximumQueueSize,
        pendingStates,
        elapsedMs: elapsed(),
        averagePathDepth: focusStates.length === 0 ? 0 : totalPathDepth / focusStates.length,
        maximumPathDepth,
        averageReplayLength: replayRestorations === 0 ? 0 : totalReplayLength / replayRestorations,
        maximumReplayLength,
        repeatedStates,
        compressedStates,
        deferredStates,
        settlingPolls,
        unsettledActions,
        timings: { ...phaseTimings },
      },
    };
  };
  const publishProgress = (): void => {
    options.onProgress?.({
      physicalActions,
      explorationActions,
      replayActions,
      screenStates: screenStates.length,
      focusStates: focusStates.length,
      pendingStates,
      elapsedMs: elapsed(),
      unsettledActions,
    });
  };

  const signalAborted = (): boolean => options.signal?.aborted === true;
  if (signalAborted()) return finish(incomplete("interrupted"));
  if (options.shouldExpand !== undefined && typeof options.shouldExpand !== "function") {
    throw new TypeError("shouldExpand must be a function.");
  }

  let capabilities: ReadonlySet<string>;
  try {
    capabilities = await withinDurationBudget(() => driver.capabilities());
  } catch (error) {
    if (signalAborted()) return finish(incomplete("interrupted"));
    if (error instanceof DurationBudgetExceeded) return finish(incomplete("max-duration"));
    return finish(incomplete("driver-error"));
  }
  if (!capabilities.has("remote-input")) {
    return finish(incomplete("remote-input-unavailable"));
  }

  const restoreInitialState = options.restoreInitialState ?? (driver.reset === undefined
    ? undefined
    : async () => driver.reset?.(options.resetStrategy ?? "reload"));
  const restoreInitialSnapshot = options.restoreInitialSnapshot;
  if (restoreInitialState === undefined && restoreInitialSnapshot === undefined) {
    return finish(incomplete("restoration-unavailable"));
  }

  const restoreAndCapture = async (): Promise<StateSnapshot> => {
    if (restoreInitialSnapshot !== undefined) return await restoreInitialSnapshot();
    await restoreInitialState?.();
    return await measuredDriver.snapshot();
  };

  const workBudgetTermination = (): ExplorationTermination | null => {
    if (signalAborted()) return incomplete("interrupted");
    if (elapsed() >= budgets.maxDurationMs) return incomplete("max-duration");
    if (physicalActions >= budgets.maxActions) return incomplete("max-actions");
    return null;
  };

  const initialTermination = workBudgetTermination();
  if (initialTermination !== null) return finish(initialTermination);

  let initialSnapshot: StateSnapshot;
  try {
    resetCount += 1;
    const resetStartedAt = monotonicNow();
    try {
      initialSnapshot = await withinDurationBudget(restoreAndCapture);
    } finally {
      phaseTimings.resetMs += durationSince(resetStartedAt);
    }
    if (elapsed() >= budgets.maxDurationMs) return finish(incomplete("max-duration"));
  } catch (error) {
    if (signalAborted()) return finish(incomplete("interrupted"));
    if (error instanceof DurationBudgetExceeded) return finish(incomplete("max-duration"));
    if (error instanceof PreparedStateDivergenceError) return finish(incomplete("prepared-state-diverged"));
    return finish(incomplete("restoration-failed"));
  }

  const initialFingerprint = fingerprintSnapshot(initialSnapshot);
  const registerState = (
    snapshot: StateSnapshot,
    fingerprint: ComputedSnapshotFingerprint,
    sequence: readonly RemoteKey[],
    repetitionGroup: string | null,
  ): RegisteredState => measureSynchronous("graphBookkeepingMs", () => {
    const existing = stateByIdentity.get(fingerprint.stateIdentity);
    if (existing !== undefined) return { state: existing, isNew: false, newScreen: false };

    let screen = screenByIdentity.get(fingerprint.screenIdentity);
    const newScreen = screen === undefined;
    if (screen === undefined) {
      screen = {
        id: id("screen", screenStates.length + 1),
        identity: fingerprint.screenIdentity,
        fingerprint: fingerprint.fingerprint.screen,
        firstSeenDepth: sequence.length,
        discoveredBy: [...sequence],
        representativeSnapshot: snapshot,
        focusStateIds: [],
      };
      screenByIdentity.set(screen.identity, screen);
      screenStates.push(screen);
    }

    const state: InternalFocusState = {
      id: id("focus", focusStates.length + 1),
      screenStateId: screen.id,
      identity: fingerprint.stateIdentity,
      fingerprint,
      firstSeenDepth: sequence.length,
      discoveredBy: [...sequence],
      representativeSnapshot: snapshot,
      repetitionGroup,
      frontierPriority: newScreen ? 0 : 1,
      scheduled: false,
    };
    screen.focusStateIds.push(state.id);
    stateByIdentity.set(state.identity, state);
    focusStates.push(state);
    if (repetitionGroup !== null) {
      const group = repetitionGroups.get(repetitionGroup) ?? {
        key: repetitionGroup,
        representatives: [],
        expandedRepresentatives: 0,
      };
      group.representatives.push(state);
      repetitionGroups.set(repetitionGroup, group);
    }
    return { state, isNew: true, newScreen };
  });

  const initialRepetitionGroup = measureSynchronous(
    "graphBookkeepingMs",
    () => repetitionGroupKey(initialSnapshot, initialFingerprint, repetitionCompression),
  );
  const initial = registerState(initialSnapshot, initialFingerprint, [], initialRepetitionGroup);
  initial.state.scheduled = true;
  if (initialRepetitionGroup !== null) {
    const group = repetitionGroups.get(initialRepetitionGroup);
    if (group !== undefined) group.expandedRepresentatives += 1;
  }
  const frontier: QueueEntry[] = [{
    state: initial.state,
    sequence: [],
    checkpoints: [],
    insertionOrder: frontierInsertionSequence,
  }];
  frontierInsertionSequence += 1;
  maximumQueueSize = 1;
  pendingStates = 1;
  let depthLimited = false;

  const takeFrontier = (): QueueEntry | undefined => measureSynchronous("graphBookkeepingMs", () => {
    if (frontierStrategy === "breadth-first") {
      const selected = frontier.shift();
      pendingStates = frontier.length;
      return selected;
    }
    let bestIndex = 0;
    for (let index = 1; index < frontier.length; index += 1) {
      const candidate = frontier[index];
      const best = frontier[bestIndex];
      if (candidate === undefined || best === undefined) continue;
      const priorityDifference = candidate.state.frontierPriority - best.state.frontierPriority;
      const depthDifference = candidate.sequence.length - best.sequence.length;
      const sequenceDifference = compareSequences(candidate.sequence, best.sequence, actionRank);
      if (priorityDifference < 0
        || (priorityDifference === 0 && depthDifference < 0)
        || (priorityDifference === 0 && depthDifference === 0 && sequenceDifference < 0)
        || (priorityDifference === 0
          && depthDifference === 0
          && sequenceDifference === 0
          && candidate.insertionOrder < best.insertionOrder)) {
        bestIndex = index;
      }
    }
    const selected = frontier.splice(bestIndex, 1)[0];
    pendingStates = frontier.length;
    return selected;
  });

  const restore = async (entry: QueueEntry): Promise<RestoreResult> => {
    let resetSnapshot: StateSnapshot;
    replayRestorations += 1;
    totalReplayLength += entry.sequence.length;
    maximumReplayLength = Math.max(maximumReplayLength, entry.sequence.length);
    resetCount += 1;
    const resetStartedAt = monotonicNow();
    try {
      resetSnapshot = await withinDurationBudget(restoreAndCapture);
    } catch (error) {
      if (signalAborted()) {
        return { status: "stop", termination: incomplete("interrupted") };
      }
      if (error instanceof DurationBudgetExceeded) {
        return { status: "stop", termination: incomplete("max-duration") };
      }
      if (error instanceof PreparedStateDivergenceError) {
        return { status: "stop", termination: incomplete("prepared-state-diverged") };
      }
      return {
        status: "stop",
        termination: incomplete(
          "restoration-failed",
          error instanceof Error ? error.message : String(error),
        ),
      };
    } finally {
      phaseTimings.resetMs += durationSince(resetStartedAt);
    }
    const resetFingerprint = fingerprintSnapshot(resetSnapshot);
    if (resetFingerprint.stateIdentity !== initialFingerprint.stateIdentity) {
      return {
        status: "stop",
        termination: incomplete(
          "replay-diverged",
          `Root restoration produced ${resetFingerprint.fingerprint.stateValue}; expected ${initialFingerprint.fingerprint.stateValue} before replaying [${entry.sequence.join(", ")}]. ${snapshotDifference(initialSnapshot, resetSnapshot)}`,
        ),
      };
    }

    let currentSnapshot = resetSnapshot;
    const replayStartedAt = monotonicNow();
    try {
      for (const [index, key] of entry.sequence.entries()) {
        const budgetTermination = workBudgetTermination();
        if (budgetTermination !== null) return { status: "stop", termination: budgetTermination };
        physicalActions += 1;
        replayActions += 1;
        try {
          const observation = await withinDurationBudget(() => pressAndObserve(measuredDriver, key, settling));
          settlingPolls += observation.snapshotsCaptured - 1;
          if (!observation.settled) unsettledActions += 1;
          if (!observation.settled) {
            return { status: "stop", termination: incomplete("settling-exhausted") };
          }
          currentSnapshot = observation.snapshot;
          if (observation.actionResult.key !== key || observation.actionResult.outcome !== "applied") {
            return {
              status: "stop",
              termination: incomplete(
                "replay-diverged",
                `Replay action ${String(index + 1)}/${String(entry.sequence.length)} (${key}) returned ${observation.actionResult.key}/${observation.actionResult.outcome} for [${entry.sequence.join(", ")}].`,
              ),
            };
          }
          const expectedCheckpoint = entry.checkpoints[index];
          const observedCheckpoint = fingerprintSnapshot(currentSnapshot);
          if (expectedCheckpoint === undefined
            || observedCheckpoint.stateIdentity !== expectedCheckpoint) {
            const expectedState = expectedCheckpoint === undefined
              ? undefined
              : stateByIdentity.get(expectedCheckpoint);
            const expectedValue = expectedState?.fingerprint.fingerprint.stateValue
              ?? (expectedCheckpoint === undefined ? "a recorded checkpoint" : "the recorded checkpoint");
            const difference = expectedState === undefined
              ? ""
              : ` ${snapshotDifference(expectedState.representativeSnapshot, currentSnapshot)}`;
            return {
              status: "stop",
              termination: incomplete(
                "replay-diverged",
                `Replay checkpoint ${String(index + 1)}/${String(entry.sequence.length)} after ${key} produced ${observedCheckpoint.fingerprint.stateValue}; expected ${expectedValue} for [${entry.sequence.join(", ")}].${difference}`,
              ),
            };
          }
        } catch (error) {
          if (signalAborted()) {
            return { status: "stop", termination: incomplete("interrupted") };
          }
          if (error instanceof DurationBudgetExceeded) {
            return { status: "stop", termination: incomplete("max-duration") };
          }
          return {
            status: "stop",
            termination: incomplete(
              "driver-error",
              error instanceof Error ? error.message : String(error),
            ),
          };
        }
      }
    } finally {
      phaseTimings.pathReplayMs += durationSince(replayStartedAt);
    }

    const restoredFingerprint = fingerprintSnapshot(currentSnapshot);
    if (restoredFingerprint.stateIdentity !== entry.state.identity) {
      return {
        status: "stop",
        termination: incomplete(
          "replay-diverged",
          `Replay completed at ${restoredFingerprint.fingerprint.stateValue}; expected ${entry.state.fingerprint.fingerprint.stateValue} for [${entry.sequence.join(", ")}]. ${snapshotDifference(entry.state.representativeSnapshot, currentSnapshot)}`,
        ),
      };
    }
    return { status: "ok", snapshot: currentSnapshot };
  };

  let termination: ExplorationTermination | null = null;
  exploration: while (frontier.length > 0) {
    const entry = takeFrontier();
    if (entry === undefined) break;
    const budgetTermination = workBudgetTermination();
    if (budgetTermination !== null) {
      termination = budgetTermination;
      break;
    }
    if (entry.sequence.length >= budgets.maxDepth) {
      depthLimited = true;
      continue;
    }

    for (const key of actionOrder) {
      const beforeActionBudget = workBudgetTermination();
      if (beforeActionBudget !== null) {
        termination = beforeActionBudget;
        break exploration;
      }

      const restored = await restore(entry);
      if (restored.status === "stop") {
        termination = restored.termination;
        break exploration;
      }

      const afterRestoreBudget = workBudgetTermination();
      if (afterRestoreBudget !== null) {
        termination = afterRestoreBudget;
        break exploration;
      }

      const actionSequence = sequenceWith(entry.sequence, key);
      physicalActions += 1;
      explorationActions += 1;
      let actionObservation: Awaited<ReturnType<typeof pressAndObserve>>;
      try {
        actionObservation = await withinDurationBudget(() => pressAndObserve(measuredDriver, key, {
          ...settling,
          allowUnsettledActions: options.allowUnsettledActions === true,
        }));
        settlingPolls += actionObservation.snapshotsCaptured - 1;
        if (!actionObservation.settled) unsettledActions += 1;
      } catch (error) {
        if (signalAborted()) {
          termination = incomplete("interrupted");
          break exploration;
        }
        if (error instanceof DurationBudgetExceeded) {
          termination = incomplete("max-duration");
          break exploration;
        }
        termination = incomplete(
          "driver-error",
          error instanceof Error ? error.message : String(error),
        );
        break exploration;
      }
      if (!actionObservation.settled) {
        if (options.allowUnsettledActions === true) {
          publishProgress();
          continue;
        }
        termination = incomplete("settling-exhausted");
        break exploration;
      }
      const observedFingerprint = fingerprintSnapshot(actionObservation.snapshot);
      const bookkeepingStartedAt = monotonicNow();
      const knownDestination = stateByIdentity.get(observedFingerprint.stateIdentity);
      const attemptId = id("action", attempts.length + 1);
      if (knownDestination !== undefined) repeatedStates += 1;

      const observedRepetitionGroup = knownDestination?.repetitionGroup
        ?? repetitionGroupKey(
          actionObservation.snapshot,
          observedFingerprint,
          repetitionCompression,
        );
      const repetitionGroup = observedRepetitionGroup === null
        ? undefined
        : repetitionGroups.get(observedRepetitionGroup);
      const compressedDestination = knownDestination === undefined
        && repetitionGroup !== undefined
        && repetitionGroup.representatives.length
          >= repetitionCompression.maxRepresentativesPerGroup
        ? repetitionGroup.representatives[0]
        : undefined;
      if (compressedDestination !== undefined) {
        markCompressed(observedFingerprint.stateIdentity);
        markDeferred(observedFingerprint.stateIdentity);
      }

      if (knownDestination === undefined
        && compressedDestination === undefined
        && focusStates.length >= budgets.maxStates) {
        attempts.push({
          id: attemptId,
          fromScreenStateId: entry.state.screenStateId,
          fromFocusStateId: entry.state.id,
          toScreenStateId: null,
          toFocusStateId: null,
          key,
          actionSequence,
          actionResult: actionObservation.actionResult,
          beforeSnapshot: restored.snapshot,
          afterSnapshot: actionObservation.snapshot,
          observedFingerprint: observedFingerprint.fingerprint,
        });
        phaseTimings.graphBookkeepingMs += durationSince(bookkeepingStartedAt);
        termination = incomplete("max-states");
        break exploration;
      }

      const destination: RegisteredState = knownDestination !== undefined
        ? { state: knownDestination, isNew: false, newScreen: false }
        : compressedDestination !== undefined
          ? { state: compressedDestination, isNew: false, newScreen: false }
          : registerState(
            actionObservation.snapshot,
            observedFingerprint,
            actionSequence,
            observedRepetitionGroup,
          );
      attempts.push({
        id: attemptId,
        fromScreenStateId: entry.state.screenStateId,
        fromFocusStateId: entry.state.id,
        toScreenStateId: destination.state.screenStateId,
        toFocusStateId: destination.state.id,
        key,
        actionSequence,
        actionResult: actionObservation.actionResult,
        beforeSnapshot: restored.snapshot,
        afterSnapshot: actionObservation.snapshot,
        observedFingerprint: observedFingerprint.fingerprint,
      });

      if (entry.state.screenStateId === destination.state.screenStateId) {
        focusTransitions.push({
          id: id("focus-transition", focusTransitions.length + 1),
          screenStateId: entry.state.screenStateId,
          fromFocusStateId: entry.state.id,
          toFocusStateId: destination.state.id,
          key,
          actionSequence,
          actionResult: actionObservation.actionResult,
          attemptId,
        });
      } else {
        screenTransitions.push({
          id: id("screen-transition", screenTransitions.length + 1),
          fromScreenStateId: entry.state.screenStateId,
          toScreenStateId: destination.state.screenStateId,
          fromFocusStateId: entry.state.id,
          toFocusStateId: destination.state.id,
          key,
          actionSequence,
          actionResult: actionObservation.actionResult,
          attemptId,
        });
      }

      const replayable = actionObservation.actionResult.key === key
        && actionObservation.actionResult.outcome === "applied";
      const expandable = options.shouldExpand?.(actionObservation.snapshot) ?? true;
      if (replayable && expandable && !destination.state.scheduled) {
        const destinationGroup = destination.state.repetitionGroup === null
          ? undefined
          : repetitionGroups.get(destination.state.repetitionGroup);
        if (destinationGroup !== undefined
          && destinationGroup.expandedRepresentatives
            >= repetitionCompression.maxExpandedRepresentativesPerGroup) {
          markDeferred(destination.state.identity);
        } else {
          destination.state.scheduled = true;
          if (destinationGroup !== undefined) destinationGroup.expandedRepresentatives += 1;
          frontier.push({
            state: destination.state,
            sequence: actionSequence,
            checkpoints: [...entry.checkpoints, observedFingerprint.stateIdentity],
            insertionOrder: frontierInsertionSequence,
          });
          frontierInsertionSequence += 1;
          maximumQueueSize = Math.max(maximumQueueSize, frontier.length);
          pendingStates = frontier.length;
        }
      }
      phaseTimings.graphBookkeepingMs += durationSince(bookkeepingStartedAt);
      publishProgress();

      if (elapsed() >= budgets.maxDurationMs) {
        termination = incomplete("max-duration");
        break exploration;
      }
    }
  }

  if (termination === null) {
    termination = depthLimited
      ? incomplete("max-depth")
      : unsettledActions > 0
        ? incomplete(
          "settling-exhausted",
          `${String(unsettledActions)} action outcome(s) remained unobserved after tolerated transient observation loss.`,
        )
        : COMPLETE_TERMINATION;
  }
  const safetyLimited = termination.reason === "max-actions"
    || termination.reason === "max-states"
    || termination.reason === "max-depth"
    || termination.reason === "max-duration";
  if (safetyLimited && frontier.length > 0) {
    const eligibleEntries = frontier.filter((entry) => entry.sequence.length < budgets.maxDepth);
    termination = {
      ...termination,
      remainingFrontierEntries: frontier.length,
      remainingCandidateActions: eligibleEntries.length * actionOrder.length,
      detail: `Bounded-incomplete: ${String(frontier.length)} frontier entries remain after ${termination.reason}.`,
    };
  }
  return finish(termination);
}
