import {
  REMOTE_KEYS,
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
    maxDurationMs: 600_000,
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
  /** Deterministic action priority. Defaults to protocol REMOTE_KEYS order. */
  readonly actions?: readonly RemoteKey[];
  /** Used when restoreInitialState is absent. */
  readonly resetStrategy?: ResetStrategy;
  /** Allows adapters to supply an equivalent deterministic root restoration. */
  readonly restoreInitialState?: () => Promise<void>;
  /** Injectable monotonic clock for deterministic hosts/tests. */
  readonly monotonicNow?: () => number;
  /** Legacy calls remain BFS; explicit profiles default to deterministic priority. */
  readonly frontierStrategy?: ExplorationFrontierStrategy;
  /** Conservative repeated carousel/list-item compression. */
  readonly repetitionCompression?: RepetitionCompressionOptions;
  /** Optional bounded post-press snapshot stability polling. */
  readonly settling?: ActionSettlingOptions;
}

export type ExplorationTerminationReason =
  | "queue-exhausted"
  | "max-actions"
  | "max-states"
  | "max-depth"
  | "max-duration"
  | "remote-input-unavailable"
  | "restoration-unavailable"
  | "restoration-failed"
  | "replay-diverged"
  | "settling-exhausted"
  | "driver-error";

export interface ExplorationTermination {
  readonly reason: ExplorationTerminationReason;
  readonly complete: boolean;
}

export interface ExplorationStatistics {
  readonly physicalActions: number;
  readonly explorationActions: number;
  readonly replayActions: number;
  readonly visitedStates: number;
  readonly screenStates: number;
  readonly focusStates: number;
  readonly maximumQueueSize: number;
  readonly elapsedMs: number;
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

function incomplete(reason: Exclude<ExplorationTerminationReason, "queue-exhausted">): ExplorationTermination {
  return { reason, complete: false };
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
  const result = [...(actions ?? REMOTE_KEYS)];
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
  let maximumQueueSize = 0;
  let repeatedStates = 0;
  let compressedStates = 0;
  let deferredStates = 0;
  let settlingPolls = 0;
  let unsettledActions = 0;
  let frontierInsertionSequence = 0;

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
  const finish = (termination: ExplorationTermination): ExplorationResult => ({
    graph: graph(),
    termination,
    budgets,
    actionOrder: [...actionOrder],
    statistics: {
      physicalActions,
      explorationActions,
      replayActions,
      visitedStates: focusStates.length,
      screenStates: screenStates.length,
      focusStates: focusStates.length,
      maximumQueueSize,
      elapsedMs: elapsed(),
      repeatedStates,
      compressedStates,
      deferredStates,
      settlingPolls,
      unsettledActions,
    },
  });

  let capabilities: ReadonlySet<string>;
  try {
    capabilities = await withinDurationBudget(() => driver.capabilities());
  } catch (error) {
    if (error instanceof DurationBudgetExceeded) return finish(incomplete("max-duration"));
    return finish(incomplete("driver-error"));
  }
  if (!capabilities.has("remote-input")) {
    return finish(incomplete("remote-input-unavailable"));
  }

  const restoreInitialState = options.restoreInitialState ?? (driver.reset === undefined
    ? undefined
    : async () => driver.reset?.(options.resetStrategy ?? "reload"));
  if (restoreInitialState === undefined) {
    return finish(incomplete("restoration-unavailable"));
  }

  const workBudgetTermination = (): ExplorationTermination | null => {
    if (elapsed() >= budgets.maxDurationMs) return incomplete("max-duration");
    if (physicalActions >= budgets.maxActions) return incomplete("max-actions");
    return null;
  };

  let initialSnapshot: StateSnapshot;
  try {
    await withinDurationBudget(restoreInitialState);
    if (elapsed() >= budgets.maxDurationMs) return finish(incomplete("max-duration"));
    initialSnapshot = await withinDurationBudget(() => driver.snapshot());
  } catch (error) {
    if (error instanceof DurationBudgetExceeded) return finish(incomplete("max-duration"));
    return finish(incomplete("restoration-failed"));
  }

  const initialFingerprint = computeSnapshotFingerprint(initialSnapshot);
  const registerState = (
    snapshot: StateSnapshot,
    fingerprint: ComputedSnapshotFingerprint,
    sequence: readonly RemoteKey[],
    repetitionGroup: string | null,
  ): RegisteredState => {
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
  };

  const initialRepetitionGroup = repetitionGroupKey(
    initialSnapshot,
    initialFingerprint,
    repetitionCompression,
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
    insertionOrder: frontierInsertionSequence,
  }];
  frontierInsertionSequence += 1;
  maximumQueueSize = 1;
  let depthLimited = false;

  const takeFrontier = (): QueueEntry | undefined => {
    if (frontierStrategy === "breadth-first") return frontier.shift();
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
    return frontier.splice(bestIndex, 1)[0];
  };

  const restore = async (entry: QueueEntry): Promise<RestoreResult> => {
    try {
      await withinDurationBudget(restoreInitialState);
    } catch (error) {
      if (error instanceof DurationBudgetExceeded) {
        return { status: "stop", termination: incomplete("max-duration") };
      }
      return { status: "stop", termination: incomplete("restoration-failed") };
    }
    const afterResetBudget = workBudgetTermination();
    if (afterResetBudget !== null) return { status: "stop", termination: afterResetBudget };

    let resetSnapshot: StateSnapshot;
    try {
      resetSnapshot = await withinDurationBudget(() => driver.snapshot());
    } catch (error) {
      if (error instanceof DurationBudgetExceeded) {
        return { status: "stop", termination: incomplete("max-duration") };
      }
      return { status: "stop", termination: incomplete("driver-error") };
    }
    if (computeSnapshotFingerprint(resetSnapshot).stateIdentity !== initialFingerprint.stateIdentity) {
      return { status: "stop", termination: incomplete("replay-diverged") };
    }

    let currentSnapshot = resetSnapshot;
    for (const key of entry.sequence) {
      const budgetTermination = workBudgetTermination();
      if (budgetTermination !== null) return { status: "stop", termination: budgetTermination };
      physicalActions += 1;
      replayActions += 1;
      try {
        const observation = await withinDurationBudget(() => pressAndObserve(driver, key, settling));
        settlingPolls += observation.snapshotsCaptured - 1;
        if (!observation.settled) unsettledActions += 1;
        if (!observation.settled) {
          return { status: "stop", termination: incomplete("settling-exhausted") };
        }
        currentSnapshot = observation.snapshot;
        if (observation.actionResult.key !== key || observation.actionResult.outcome !== "applied") {
          return { status: "stop", termination: incomplete("replay-diverged") };
        }
      } catch (error) {
        if (error instanceof DurationBudgetExceeded) {
          return { status: "stop", termination: incomplete("max-duration") };
        }
        return { status: "stop", termination: incomplete("driver-error") };
      }
    }

    if (computeSnapshotFingerprint(currentSnapshot).stateIdentity !== entry.state.identity) {
      return { status: "stop", termination: incomplete("replay-diverged") };
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
        actionObservation = await withinDurationBudget(() => pressAndObserve(driver, key, settling));
        settlingPolls += actionObservation.snapshotsCaptured - 1;
        if (!actionObservation.settled) unsettledActions += 1;
      } catch (error) {
        if (error instanceof DurationBudgetExceeded) {
          termination = incomplete("max-duration");
          break exploration;
        }
        termination = incomplete("driver-error");
        break exploration;
      }
      if (!actionObservation.settled) {
        termination = incomplete("settling-exhausted");
        break exploration;
      }
      const observedFingerprint = computeSnapshotFingerprint(actionObservation.snapshot);
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
      if (replayable && !destination.state.scheduled) {
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
            insertionOrder: frontierInsertionSequence,
          });
          frontierInsertionSequence += 1;
          maximumQueueSize = Math.max(maximumQueueSize, frontier.length);
        }
      }

      if (elapsed() >= budgets.maxDurationMs) {
        termination = incomplete("max-duration");
        break exploration;
      }
    }
  }

  if (termination === null) {
    termination = depthLimited ? incomplete("max-depth") : COMPLETE_TERMINATION;
  }
  return finish(termination);
}
