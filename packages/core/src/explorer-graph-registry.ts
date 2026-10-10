import type { RemoteKey, StateSnapshot } from "@tvdoctor/protocol";
import type { ComputedSnapshotFingerprint } from "./fingerprint.js";
import type {
  ExplorationActionAttempt,
  ExplorationGraph,
  FocusState,
  FocusTransition,
  ScreenState,
  ScreenTransition,
} from "./graph.js";
import {
  explorerId as id,
  type InternalFocusState,
  type MutableScreenState,
  type RegisteredState,
  type RepetitionGroup,
} from "./explorer-state.js";

export interface ExplorerGraphRegistry {
  readonly screenStates: MutableScreenState[];
  readonly focusStates: InternalFocusState[];
  readonly screenTransitions: ScreenTransition[];
  readonly focusTransitions: FocusTransition[];
  readonly attempts: ExplorationActionAttempt[];
  readonly screenByIdentity: Map<string, MutableScreenState>;
  readonly stateByIdentity: Map<string, InternalFocusState>;
  readonly repetitionGroups: Map<string, RepetitionGroup>;
  registerState(
    snapshot: StateSnapshot,
    fingerprint: ComputedSnapshotFingerprint,
    sequence: readonly RemoteKey[],
    repetitionGroup: string | null,
  ): RegisteredState;
  snapshot(): ExplorationGraph;
}

export function createExplorerGraphRegistry(
  measureGraphBookkeeping: <T>(operation: () => T) => T,
): ExplorerGraphRegistry {
  const screenStates: MutableScreenState[] = [];
  const focusStates: InternalFocusState[] = [];
  const screenTransitions: ScreenTransition[] = [];
  const focusTransitions: FocusTransition[] = [];
  const attempts: ExplorationActionAttempt[] = [];
  const screenByIdentity = new Map<string, MutableScreenState>();
  const stateByIdentity = new Map<string, InternalFocusState>();
  const repetitionGroups = new Map<string, RepetitionGroup>();

  const registerState = (
    snapshot: StateSnapshot,
    fingerprint: ComputedSnapshotFingerprint,
    sequence: readonly RemoteKey[],
    repetitionGroup: string | null,
  ): RegisteredState => measureGraphBookkeeping(() => {
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

  const snapshot = (): ExplorationGraph => ({
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

  return {
    screenStates,
    focusStates,
    screenTransitions,
    focusTransitions,
    attempts,
    screenByIdentity,
    stateByIdentity,
    repetitionGroups,
    registerState,
    snapshot,
  };
}
