import type {
  ActionResult,
  RemoteKey,
  StateSnapshot,
  TVDoctorDriver,
} from "@tvdoctor/protocol";
import { computeSnapshotFingerprint } from "./fingerprint.js";

export type ActionSettlingStrategy = "driver" | "stable-snapshot";

export interface ActionSettlingOptions {
  /**
   * `driver` trusts the driver's press promise and takes one snapshot.
   * `stable-snapshot` additionally requires consecutive equivalent snapshots.
   */
  readonly strategy?: ActionSettlingStrategy;
  /** Maximum snapshots, including the first snapshot after press. */
  readonly maxSnapshots?: number;
  /** Consecutive equal snapshots required by stable-snapshot settling. */
  readonly requiredStableSnapshots?: number;
  /** Delay between stability polls. Zero is valid and remains the default. */
  readonly pollIntervalMs?: number;
  /** Injectable wait primitive for deterministic hosts and tests. */
  readonly wait?: (durationMs: number) => Promise<void>;
  /**
   * Optional platform-neutral equivalence predicate. The default compares the
   * exact canonical state identities produced by the core fingerprinter.
   */
  readonly equivalent?: (previous: StateSnapshot, current: StateSnapshot) => boolean;
  /** Experimental Android surfaces may report transient input-observation loss. */
  readonly allowUnsettledActions?: boolean;
}

export interface NormalisedActionSettlingOptions {
  readonly strategy: ActionSettlingStrategy;
  readonly maxSnapshots: number;
  readonly requiredStableSnapshots: number;
  readonly pollIntervalMs: number;
  readonly wait: (durationMs: number) => Promise<void>;
  readonly equivalent: (previous: StateSnapshot, current: StateSnapshot) => boolean;
}

export const DEFAULT_ACTION_SETTLING_OPTIONS: Readonly<Pick<
  NormalisedActionSettlingOptions,
  "strategy" | "maxSnapshots" | "requiredStableSnapshots" | "pollIntervalMs"
>> = {
  strategy: "driver",
  maxSnapshots: 1,
  requiredStableSnapshots: 1,
  pollIntervalMs: 0,
};

const MAX_SETTLING_SNAPSHOTS = 1_000;
const MAX_SETTLING_INTERVAL_MS = 2_147_483_647;

export interface SettledActionObservation {
  readonly actionResult: ActionResult;
  readonly snapshot: StateSnapshot;
  /** Snapshot work is explicit so callers can benchmark stronger settling. */
  readonly snapshotsCaptured: number;
  /** True when the driver's own settled observation satisfied this request. */
  readonly reusedDriverObservation: boolean;
  /** False only when stable-snapshot exhausted its bounded polling allowance. */
  readonly settled: boolean;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_SETTLING_SNAPSHOTS) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return value;
}

function nonNegativeFinite(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SETTLING_INTERVAL_MS) {
    throw new TypeError(`${name} must be a non-negative safe integer duration.`);
  }
  return value;
}

function waitWithTimer(durationMs: number): Promise<void> {
  if (durationMs === 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

function sameCanonicalState(previous: StateSnapshot, current: StateSnapshot): boolean {
  return computeSnapshotFingerprint(previous).stateIdentity
    === computeSnapshotFingerprint(current).stateIdentity;
}

export function normaliseActionSettlingOptions(
  options: ActionSettlingOptions = {},
): NormalisedActionSettlingOptions {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new TypeError("settling must be an object.");
  }
  if (options.wait !== undefined && typeof options.wait !== "function") {
    throw new TypeError("wait must be a function.");
  }
  if (options.equivalent !== undefined && typeof options.equivalent !== "function") {
    throw new TypeError("equivalent must be a function.");
  }
  const strategy = options.strategy ?? DEFAULT_ACTION_SETTLING_OPTIONS.strategy;
  if (strategy !== "driver" && strategy !== "stable-snapshot") {
    throw new TypeError("settling strategy must be driver or stable-snapshot.");
  }
  const defaultMaxSnapshots = strategy === "driver"
    ? DEFAULT_ACTION_SETTLING_OPTIONS.maxSnapshots
    : 6;
  const defaultRequiredStableSnapshots = strategy === "driver"
    ? DEFAULT_ACTION_SETTLING_OPTIONS.requiredStableSnapshots
    : 2;
  const maxSnapshots = positiveInteger(
    options.maxSnapshots ?? defaultMaxSnapshots,
    "maxSnapshots",
  );
  const requiredStableSnapshots = positiveInteger(
    options.requiredStableSnapshots ?? defaultRequiredStableSnapshots,
    "requiredStableSnapshots",
  );
  if (requiredStableSnapshots > maxSnapshots) {
    throw new TypeError("requiredStableSnapshots must not exceed maxSnapshots.");
  }
  if (strategy === "driver" && (maxSnapshots !== 1 || requiredStableSnapshots !== 1)) {
    throw new TypeError("driver settling requires exactly one snapshot.");
  }
  return {
    strategy,
    maxSnapshots,
    requiredStableSnapshots,
    pollIntervalMs: nonNegativeFinite(
      options.pollIntervalMs ?? DEFAULT_ACTION_SETTLING_OPTIONS.pollIntervalMs,
      "pollIntervalMs",
    ),
    wait: options.wait ?? waitWithTimer,
    equivalent: options.equivalent ?? sameCanonicalState,
  };
}

/**
 * The protocol's press() promise remains the default settling boundary. Callers
 * can explicitly request bounded canonical-snapshot polling for drivers whose
 * promise resolves before their observable UI becomes stable.
 */
export async function pressAndObserve(
  driver: TVDoctorDriver,
  key: RemoteKey,
  options: ActionSettlingOptions = {},
): Promise<SettledActionObservation> {
  const settling = normaliseActionSettlingOptions(options);
  const actionResult = await driver.press(key);

  if (actionResult.outcome === "failed" || actionResult.outcome === "inconclusive") {
    if (actionResult.outcome !== "inconclusive" || options.allowUnsettledActions !== true) {
      throw new Error(
        `Driver could not settle ${key} input: ${actionResult.message ?? actionResult.outcome}`,
        { cause: actionResult },
      );
    }
  }

  if (actionResult.outcome === "inconclusive") {
    const snapshot = actionResult.postActionSnapshot ?? await driver.snapshot();
    return {
      actionResult,
      snapshot,
      snapshotsCaptured: actionResult.postActionSnapshot === undefined ? 1 : 0,
      reusedDriverObservation: actionResult.postActionSnapshot !== undefined,
      settled: false,
    };
  }

  let snapshot: StateSnapshot;
  let snapshotsCaptured = 0;
  let reusedDriverObservation = false;
  if (settling.strategy === "driver") {
    if (actionResult.postActionSnapshot !== undefined) {
      snapshot = actionResult.postActionSnapshot;
      reusedDriverObservation = true;
    } else {
      snapshot = await driver.snapshot();
      snapshotsCaptured = 1;
    }
    return {
      actionResult,
      snapshot,
      snapshotsCaptured,
      reusedDriverObservation,
      settled: true,
    };
  }

  // Stable-snapshot mode seeds its equivalence chain from the driver's settled
  // observation when present, then keeps polling canonical snapshots.
  let stableSnapshots = 1;
  if (actionResult.postActionSnapshot !== undefined) {
    snapshot = actionResult.postActionSnapshot;
    reusedDriverObservation = true;
  } else {
    snapshot = await driver.snapshot();
    snapshotsCaptured = 1;
  }
  while (snapshotsCaptured < settling.maxSnapshots
    && stableSnapshots < settling.requiredStableSnapshots) {
    await settling.wait(settling.pollIntervalMs);
    const nextSnapshot = await driver.snapshot();
    snapshotsCaptured += 1;
    stableSnapshots = settling.equivalent(snapshot, nextSnapshot)
      ? stableSnapshots + 1
      : 1;
    snapshot = nextSnapshot;
  }
  return {
    actionResult,
    snapshot,
    snapshotsCaptured,
    reusedDriverObservation,
    settled: stableSnapshots >= settling.requiredStableSnapshots,
  };
}
