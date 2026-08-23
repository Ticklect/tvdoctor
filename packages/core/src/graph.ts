import type {
  ActionResult,
  RemoteKey,
  StateSnapshot,
} from "@tvdoctor/protocol";
import type { SnapshotFingerprint, StateFingerprint } from "./fingerprint.js";

export interface ScreenState {
  readonly id: string;
  readonly fingerprint: StateFingerprint;
  readonly firstSeenDepth: number;
  readonly discoveredBy: readonly RemoteKey[];
  readonly representativeSnapshot: StateSnapshot;
  readonly focusStateIds: readonly string[];
}

export interface FocusState {
  readonly id: string;
  readonly screenStateId: string;
  readonly fingerprint: StateFingerprint;
  readonly stateFingerprint: string;
  readonly confidence: SnapshotFingerprint["confidence"];
  readonly firstSeenDepth: number;
  readonly discoveredBy: readonly RemoteKey[];
  readonly representativeSnapshot: StateSnapshot;
}

export interface ScreenTransition {
  readonly id: string;
  readonly fromScreenStateId: string;
  readonly toScreenStateId: string;
  readonly fromFocusStateId: string;
  readonly toFocusStateId: string;
  readonly key: RemoteKey;
  readonly actionSequence: readonly RemoteKey[];
  readonly actionResult: ActionResult;
  readonly attemptId: string;
}

export interface FocusTransition {
  readonly id: string;
  readonly screenStateId: string;
  readonly fromFocusStateId: string;
  readonly toFocusStateId: string;
  readonly key: RemoteKey;
  readonly actionSequence: readonly RemoteKey[];
  readonly actionResult: ActionResult;
  readonly attemptId: string;
}

export interface ExplorationActionAttempt {
  readonly id: string;
  readonly fromScreenStateId: string;
  readonly fromFocusStateId: string;
  /** Null only when the observed state would exceed maxStates. */
  readonly toScreenStateId: string | null;
  readonly toFocusStateId: string | null;
  readonly key: RemoteKey;
  readonly actionSequence: readonly RemoteKey[];
  readonly actionResult: ActionResult;
  readonly beforeSnapshot: StateSnapshot;
  readonly afterSnapshot: StateSnapshot;
  readonly observedFingerprint: SnapshotFingerprint;
}

export interface ScreenGraph {
  readonly states: readonly ScreenState[];
  readonly transitions: readonly ScreenTransition[];
}

export interface FocusGraph {
  readonly states: readonly FocusState[];
  readonly transitions: readonly FocusTransition[];
}

export interface ExplorationGraph {
  readonly screens: ScreenGraph;
  readonly focus: FocusGraph;
  /** Every exploratory input, including unchanged and budget-edge observations. */
  readonly actions: readonly ExplorationActionAttempt[];
}
