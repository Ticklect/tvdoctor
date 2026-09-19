import type { DriverOperationOptions, RemoteKey, StateSnapshot, TVDoctorDriver } from "@tvdoctor/protocol";
import { PreparedStateDivergenceError } from "./errors.js";
import {
  computeSnapshotFingerprint,
  type ComputedSnapshotFingerprint,
} from "./fingerprint.js";
import type { ExplorationActionAttempt, ExplorationGraph, FocusState, FocusTransition, ScreenState, ScreenTransition } from "./graph.js";
import type { ExplorerOptions, ExplorationResult, ExplorationTermination } from "./explorer-contracts.js";
import {
  createExplorerActionHooks,
  executeExplorerAction,
} from "./explorer-actions.js";
import { annotateFrontierTermination, scheduleDestinationFrontier, scheduleFrontierContinuation, takePreferredFrontierWithCount, type QueueEntry } from "./explorer-frontier.js";
import { normaliseExplorerOptions } from "./explorer-options.js";
import { createVerifiedLocalRestorer } from "./explorer-local-restoration.js";
import { createExplorerPerformance } from "./explorer-performance.js";
import {
  OperationDeadlineExceeded,
  runWithOperationDeadline,
} from "./operation-deadline.js";
import { createExplorerRestorer, DurationBudgetExceeded, incomplete } from "./explorer-restoration.js";
import { RestorationDiagnosticRecorder } from "./explorer-restoration-diagnostics.js";
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
  complete: true };

export async function explore(
  driver: TVDoctorDriver,
  options: ExplorerOptions = {},
): Promise<ExplorationResult> {
  const {
    budgets, actionOrder, replayActions: rootReplayActions, frontierStrategy, restorationMode, allowRootRestorationFallback, refreshVisibleSelfLoops, repetitionCompression,
    settling,
    replaySettling,
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
  let verifiedStateReuses = 0;
  let verifiedPathRestorations = 0;
  let restorationFallbacks = 0;
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
  let restorationCycleCount = (): number => 0;
  const { phaseTimings, durationSince, measureSynchronous, measuredDriver } = createExplorerPerformance(
    driver,
    monotonicNow,
  );
  const fingerprintSnapshot = (snapshot: StateSnapshot): ComputedSnapshotFingerprint => (
    measureSynchronous("semanticNormalizationMs", () => computeSnapshotFingerprint(snapshot))
  );
  const screenStates: MutableScreenState[] = [];
  const focusStates: InternalFocusState[] = [];
  const screenTransitions: ScreenTransition[] = [];
  const focusTransitions: FocusTransition[] = [];
  const attempts: ExplorationActionAttempt[] = [], restorationDiagnostics = new RestorationDiagnosticRecorder();
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
  const withinDurationBudget = async <T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const remainingMs = budgets.maxDurationMs - elapsed();
    if (remainingMs <= 0) throw new DurationBudgetExceeded();
    try {
      return await runWithOperationDeadline({
        timeoutMs: Math.max(1, Math.ceil(remainingMs)),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }, operation);
    } catch (error) {
      if (error instanceof OperationDeadlineExceeded) throw new DurationBudgetExceeded();
      throw error;
    }
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
        verifiedStateReuses,
        verifiedPathRestorations,
        restorationFallbacks,
        restorationAttempts: restorationDiagnostics.attempts, restorationSuccesses: restorationDiagnostics.successes, restorationFailures: restorationDiagnostics.failures,
        restorationCycles: restorationCycleCount(),
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
      restorationDiagnostics: restorationDiagnostics.snapshot(),
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
  const actionHooks = createExplorerActionHooks({ actionOrder,
    actionsForState: options.actionsForState, onActionObserved: options.onActionObserved,
    withinDurationBudget });

  let capabilities: ReadonlySet<string>;
  try {
    capabilities = await withinDurationBudget((signal) => driver.capabilities({ signal }));
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
    : async (operationOptions?: DriverOperationOptions) => driver.reset?.(
      options.resetStrategy ?? "reload",
      operationOptions,
    ));
  const restoreInitialSnapshot = options.restoreInitialSnapshot;
  if (restoreInitialState === undefined && restoreInitialSnapshot === undefined) {
    return finish(incomplete("restoration-unavailable", undefined, { subtype: "strategy-exhausted", rejectionReason: "no-restoration-strategy" }));
  }

  const restoreAndCapture = async (signal: AbortSignal): Promise<StateSnapshot> => {
    const operationOptions = { signal };
    if (restoreInitialSnapshot !== undefined) return await restoreInitialSnapshot(operationOptions);
    await restoreInitialState?.(operationOptions);
    return await measuredDriver.snapshot(operationOptions);
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
  const recordSettlingObservation = (snapshotsObserved: number, settled: boolean): void => {
    settlingPolls += snapshotsObserved - 1;
    if (!settled) unsettledActions += 1;
  };

  const restoreFromRoot = createExplorerRestorer({
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
    settling: replaySettling,
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
        onSettlingObservation: recordSettlingObservation,
    onReplayDuration: (durationMs) => {
      phaseTimings.pathReplayMs += durationMs;
    },
    onDiagnostic: (diagnostic) => { restorationDiagnostics.record(diagnostic); },
  });
  const localRestorer = createVerifiedLocalRestorer({
    enabled: restorationMode !== "root-only", allowPathRestoration: restorationMode === "verified-local",
    allowRootRestorationFallback,
    refreshVisibleSelfLoops,
    actionOrder,
    rootReplayActions: new Set(rootReplayActions),
    initialSnapshot,
    initialIdentity: initialFingerprint.stateIdentity,
    measuredDriver,
    settling: replaySettling,
    rootRestore: restoreFromRoot,
    workBudgetTermination,
    withinDurationBudget,
    signalAborted,
    fingerprintSnapshot,
    stateByIdentity,
    monotonicNow,
    durationSince,
    onReplayAction: () => { physicalActions += 1; replayActions += 1; },
    onSettlingObservation: recordSettlingObservation,
    onReplayDuration: (durationMs) => { phaseTimings.pathReplayMs += durationMs; },
    onStateReuse: () => { verifiedStateReuses += 1; },
    onPathRestoration: () => { verifiedPathRestorations += 1; },
    onFallback: () => { restorationFallbacks += 1; },
    onDiagnostic: (diagnostic) => { restorationDiagnostics.record(diagnostic); },
  });
  restorationCycleCount = localRestorer.cycleCount;
  const restore = localRestorer.restore;

  let termination: ExplorationTermination | null = null;
  let skippedRestoration: ExplorationTermination | null = null;
  exploration: while (frontier.length > 0) {
    const selected = measureSynchronous("graphBookkeepingMs", () => takePreferredFrontierWithCount(
      frontier, frontierStrategy, actionRank,
      restorationMode === "root-only" ? null : localRestorer.liveIdentity(),
    ));
    pendingStates = selected.pendingStates;
    const entry = selected.entry;
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

    let stateActionOrder = entry.remainingActions;
    if (stateActionOrder === undefined) {
      const stateActions = await actionHooks.actionsForState(entry, signalAborted);
      if (stateActions.status === "stop") {
        termination = stateActions.termination;
        break;
      }
      stateActionOrder = stateActions.actions;
    }
    for (const [stateActionIndex, key] of stateActionOrder.entries()) {
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
      if (restored.status === "skip") {
        skippedRestoration ??= restored.termination;
        break;
      }

      const afterRestoreBudget = workBudgetTermination();
      if (afterRestoreBudget !== null) {
        termination = afterRestoreBudget;
        break exploration;
      }

      const actionSequence = sequenceWith(entry.sequence, key);
      physicalActions += 1;
      explorationActions += 1;
      const actionExecution = await executeExplorerAction({
        driver: measuredDriver,
        key,
        settling,
        allowUnsettledActions: options.allowUnsettledActions === true,
        withinDurationBudget,
        signalAborted,
        clearLiveState: localRestorer.clearLive,
    onSettlingObservation: recordSettlingObservation,
      });
      if (actionExecution.status === "stop") {
        termination = actionExecution.termination;
        break exploration;
      }
      if (actionExecution.status === "unsettled") {
        publishProgress();
        continue;
      }
      const actionObservation = actionExecution.observation;
      const observedHookTermination = await actionHooks.onActionObserved(
        entry, key, restored.snapshot, actionObservation.snapshot, signalAborted,
      );
      if (observedHookTermination !== null) {
        termination = observedHookTermination;
        break exploration;
      }
      const observedFingerprint = fingerprintSnapshot(actionObservation.snapshot);
      const expandable = options.shouldExpand?.(actionObservation.snapshot) ?? true;
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
      if (replayable
        && expandable
        && compressedDestination === undefined) {
        localRestorer.recordEdge({
          fromIdentity: entry.state.identity,
          toIdentity: observedFingerprint.stateIdentity,
          key,
          expandable: true,
        });
      }
      if (replayable && expandable) {
        const scheduled = scheduleDestinationFrontier({
          frontier, state: destination.state, sequence: actionSequence,
          checkpoints: [...entry.checkpoints, observedFingerprint.stateIdentity],
          insertionOrder: frontierInsertionSequence,
          repetitionGroup: destination.state.repetitionGroup === null
            ? undefined
            : repetitionGroups.get(destination.state.repetitionGroup),
          maxExpandedRepresentativesPerGroup: repetitionCompression.maxExpandedRepresentativesPerGroup,
          markDeferred,
        });
        frontierInsertionSequence = scheduled.insertionOrder;
        maximumQueueSize = Math.max(maximumQueueSize, scheduled.queueSize);
        pendingStates = scheduled.queueSize;
      }
      const continuation = scheduleFrontierContinuation({
        frontier, entry, stateActionOrder, stateActionIndex,
        insertionOrder: frontierInsertionSequence,
        restorationEnabled: restorationMode !== "root-only",
        replayable, expandable, observedIdentity: observedFingerprint.stateIdentity,
      });
      frontierInsertionSequence = continuation.insertionOrder;
      maximumQueueSize = Math.max(maximumQueueSize, continuation.queueSize);
      pendingStates = continuation.queueSize;
      phaseTimings.graphBookkeepingMs += durationSince(bookkeepingStartedAt);
      publishProgress();
      const refreshTermination = await localRestorer.observeAfterAction(
        actionObservation.snapshot,
        observedFingerprint.stateIdentity,
        entry,
        expandable,
        continuation.remainingActions.length > 0 || frontier.length > 0,
      );
      if (refreshTermination !== null) { termination = refreshTermination; break exploration; }

      if (elapsed() >= budgets.maxDurationMs) {
        termination = incomplete("max-duration");
        break exploration;
      }
      if (continuation.yieldToLiveDestination) continue exploration;
    }
  }

  if (termination === null) {
    termination = skippedRestoration ?? (depthLimited
      ? incomplete("max-depth")
      : unsettledActions > 0
        ? incomplete(
          "settling-exhausted",
          `${String(unsettledActions)} action outcome(s) remained unobserved after tolerated transient observation loss.`,
        )
        : COMPLETE_TERMINATION);
  }
  termination = annotateFrontierTermination(termination, frontier, budgets.maxDepth, actionOrder.length);
  return finish(termination);
}
