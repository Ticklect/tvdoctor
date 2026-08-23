import {
  isRemoteKey,
  type RemoteKey,
} from "@tvdoctor/protocol";
import type { ExplorationGraph } from "./graph.js";

export type SequenceSemanticsOracle = (
  candidate: readonly RemoteKey[],
) => boolean | Promise<boolean>;

export interface SequenceMinimizationOptions {
  /** Keep the diagnostic assertion action at the end of every candidate. */
  readonly preserveFinalAction?: boolean;
  /** Strict bound across the original proof and all candidate checks. */
  readonly maxChecks?: number;
}

export type SequenceMinimizationStatus =
  | "minimized"
  | "unchanged"
  | "baseline-rejected"
  | "max-checks";

export interface SequenceMinimizationResult {
  readonly status: SequenceMinimizationStatus;
  readonly originalSequence: readonly RemoteKey[];
  /** Null only when the oracle rejected the original sequence itself. */
  readonly minimizedSequence: readonly RemoteKey[] | null;
  readonly checks: number;
  readonly removedActions: number;
  /** True means the returned candidate was explicitly accepted by the oracle. */
  readonly semanticsPreserved: boolean;
}

const DEFAULT_MAX_CHECKS = 256;
const MAX_MINIMIZATION_CHECKS = 100_000;

function validMaxChecks(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_MINIMIZATION_CHECKS) {
    throw new TypeError("maxChecks must be a positive integer.");
  }
  return value;
}

function copyAndValidateSequence(sequence: readonly RemoteKey[]): readonly RemoteKey[] {
  if (!Array.isArray(sequence) || !sequence.every(isRemoteKey)) {
    throw new TypeError("sequence must contain only protocol remote keys.");
  }
  return [...sequence];
}

function withoutRange(
  sequence: readonly RemoteKey[],
  start: number,
  end: number,
): readonly RemoteKey[] {
  return [...sequence.slice(0, start), ...sequence.slice(end)];
}

/**
 * Deterministic delta-debugging with an exact caller-owned semantic oracle.
 * A key is removed only after the complete candidate has been accepted. The
 * returned sequence is therefore never a heuristic simplification.
 */
export async function minimizeActionSequence(
  sequence: readonly RemoteKey[],
  preservesSemantics: SequenceSemanticsOracle,
  options: SequenceMinimizationOptions = {},
): Promise<SequenceMinimizationResult> {
  const originalSequence = copyAndValidateSequence(sequence);
  const maxChecks = validMaxChecks(options.maxChecks ?? DEFAULT_MAX_CHECKS);
  const preserveFinalAction = options.preserveFinalAction ?? true;
  let checks = 0;

  const accepted = async (candidate: readonly RemoteKey[]): Promise<boolean | null> => {
    if (checks >= maxChecks) return null;
    checks += 1;
    return Boolean(await preservesSemantics([...candidate]));
  };

  if (await accepted(originalSequence) !== true) {
    return {
      status: "baseline-rejected",
      originalSequence,
      minimizedSequence: null,
      checks,
      removedActions: 0,
      semanticsPreserved: false,
    };
  }

  let candidate = [...originalSequence];
  let granularity = 2;
  let exhausted = false;
  while (true) {
    const removableLength = candidate.length - (preserveFinalAction && candidate.length > 0 ? 1 : 0);
    if (removableLength === 0) break;
    const chunkSize = Math.ceil(removableLength / granularity);
    let reduced = false;
    for (let start = 0; start < removableLength; start += chunkSize) {
      const end = Math.min(start + chunkSize, removableLength);
      const trial = withoutRange(candidate, start, end);
      const trialAccepted = await accepted(trial);
      if (trialAccepted === null) {
        exhausted = true;
        break;
      }
      if (trialAccepted) {
        candidate = [...trial];
        granularity = Math.max(2, granularity - 1);
        reduced = true;
        break;
      }
    }
    if (exhausted) break;
    if (reduced) continue;
    if (granularity >= removableLength) break;
    granularity = Math.min(removableLength, granularity * 2);
  }

  // Finish at a deterministic one-minimal candidate when the check budget permits.
  let index = 0;
  while (!exhausted) {
    const removableLength = candidate.length - (preserveFinalAction && candidate.length > 0 ? 1 : 0);
    if (index >= removableLength) break;
    const trial = withoutRange(candidate, index, index + 1);
    const trialAccepted = await accepted(trial);
    if (trialAccepted === null) {
      exhausted = true;
      break;
    }
    if (trialAccepted) {
      candidate = [...trial];
    } else {
      index += 1;
    }
  }

  return {
    status: exhausted
      ? "max-checks"
      : candidate.length < originalSequence.length
        ? "minimized"
        : "unchanged",
    originalSequence,
    minimizedSequence: candidate,
    checks,
    removedActions: originalSequence.length - candidate.length,
    semanticsPreserved: true,
  };
}

interface DeterministicGraphMachine {
  readonly rootStateId: string;
  readonly nextState: ReadonlyMap<string, string>;
}

function graphMachine(graph: ExplorationGraph): DeterministicGraphMachine | null {
  const roots = graph.focus.states.filter((state) => (
    state.firstSeenDepth === 0 && state.discoveredBy.length === 0
  ));
  const root = roots.length === 1 ? roots[0] : undefined;
  if (root === undefined) return null;
  const nextState = new Map<string, string>();
  for (const edge of [...graph.focus.transitions, ...graph.screens.transitions]) {
    const key = `${edge.fromFocusStateId}\u001f${edge.key}`;
    const previous = nextState.get(key);
    if (previous !== undefined && previous !== edge.toFocusStateId) return null;
    nextState.set(key, edge.toFocusStateId);
  }
  return { rootStateId: root.id, nextState };
}

function graphDestination(
  machine: DeterministicGraphMachine,
  sequence: readonly RemoteKey[],
): string | null {
  let state = machine.rootStateId;
  for (const key of sequence) {
    const destination = machine.nextState.get(`${state}\u001f${key}`);
    if (destination === undefined) return null;
    state = destination;
  }
  return state;
}

/**
 * Minimise against an observed graph only when every used state/action edge is
 * deterministic. Equality means the candidate reaches the exact same FocusState.
 */
export async function minimizeGraphSequence(
  graph: ExplorationGraph,
  sequence: readonly RemoteKey[],
  options: SequenceMinimizationOptions = {},
): Promise<SequenceMinimizationResult> {
  const original = copyAndValidateSequence(sequence);
  const machine = graphMachine(graph);
  const expectedDestination = machine === null ? null : graphDestination(machine, original);
  if (machine === null || expectedDestination === null) {
    return {
      status: "baseline-rejected",
      originalSequence: original,
      minimizedSequence: null,
      checks: 0,
      removedActions: 0,
      semanticsPreserved: false,
    };
  }
  return minimizeActionSequence(
    original,
    (candidate) => graphDestination(machine, candidate) === expectedDestination,
    options,
  );
}
