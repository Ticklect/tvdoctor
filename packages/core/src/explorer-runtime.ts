import type { ActionResult, RemoteKey, StateSnapshot, TVDoctorDriver } from "@tvdoctor/protocol";
import { pressAndObserve } from "./action-settling.js";
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
import type { ExplorerOptions, ExplorationResult, ExplorationTermination } from "./explorer-contracts.js";
import { takeFrontier as selectFrontier, type QueueEntry } from "./explorer-frontier.js";
import { normaliseExplorerOptions } from "./explorer-options.js";
import {
  createExplorerRestorer,
  DurationBudgetExceeded,
  incomplete,
} from "./explorer-restoration.js";
import {
  explorerId as id,
  repetitionGroupKey,
  sequenceWith,
  type InternalFocusState,
  type MutableScreenState,
  type RegisteredState,
  type RepetitionGroup,
} from "./explorer-state.js";

const COMPLETE_TERMINATION: ExplorationTermination = {
  reason: "queue-exhausted",
  complete: true,
};

export async function explore(
  driver: TVDoctorDriver,
  options: ExplorerOptions = {},
): Promise<ExplorationResult> {
  const {
    budgets,
    actionOrder,
    frontierStrategy,
    repetitionCompression,
    settling,
    monotonicSource,
  } = normaliseExplorerOptions(options);
  const actionRank = new Map(actionOrder.map((key, index) => [key, index]));
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
    const selected = selectFrontier(frontier, frontierStrategy, actionRank);
    pendingStates = frontier.length;
    return selected;
  });

  const restore = createExplorerRestorer({
    restoreAndCapture,
    withinDurationBudget,
    signalAborted,
    monotonicNow,
    durationSince,
    fingerprintSnapshot,
    initialFingerprint,
    initialSnapshot,
    stateByIdentity,
    measuredDriver,
    settling,
    workBudgetTermination,
    onRestorationStart: (replayLength) => {
      replayRestorations += 1;
      totalReplayLength += replayLength;
      maximumReplayLength = Math.max(maximumReplayLength, replayLength);
      resetCount += 1;
    },
    onResetDuration: (durationMs) => {
      phaseTimings.resetMs += durationMs;
    },
    onReplayAction: () => {
      physicalActions += 1;
      replayActions += 1;
    },
    onSettlingObservation: (snapshotsObserved, settled) => {
      settlingPolls += snapshotsObserved - 1;
      if (!settled) unsettledActions += 1;
    },
    onReplayDuration: (durationMs) => {
      phaseTimings.pathReplayMs += durationMs;
    },
  });

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
        settlingPolls += actionObservation.snapshotsObserved - 1;
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
