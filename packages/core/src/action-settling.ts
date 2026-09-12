import {
  isRemoteKey,
  type ActionResult,
  type DriverOperationOptions,
  type RemoteKey,
  type StateSnapshot,
  type TVDoctorDriver,
} from "@tvdoctor/protocol";

export interface ActionSettlingLimits {
  /** Maximum snapshots, including the first snapshot after press. */
  readonly maxSnapshots?: number;
  /** Consecutive equal snapshots required by stable-snapshot settling. */
  readonly requiredStableSnapshots?: number;
}

/** Per-key limits allow longer proofs for activation than focus-only navigation. */
export type ActionSettlingKeyOverrides = Readonly<Partial<Record<RemoteKey, ActionSettlingLimits>>>;

type NormalisedActionSettlingLimits = Required<ActionSettlingLimits>;
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
  /** Optional per-key limits; unspecified keys use the limits above. */
  readonly keyOverrides?: ActionSettlingKeyOverrides;
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
  /** Cooperative cancellation for the active press/snapshot sequence. */
  readonly signal?: AbortSignal;
}

export interface NormalisedActionSettlingOptions {
  readonly strategy: ActionSettlingStrategy;
  readonly maxSnapshots: number;
  readonly requiredStableSnapshots: number;
  readonly keyOverrides: Readonly<Partial<Record<RemoteKey, NormalisedActionSettlingLimits>>>;
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
  /** All observations used, including a reused post-action snapshot. */
  readonly snapshotsObserved: number;
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
  if (options.keyOverrides !== undefined
    && (typeof options.keyOverrides !== "object" || options.keyOverrides === null || Array.isArray(options.keyOverrides))) {
    throw new TypeError("keyOverrides must be an object.");
  }
  const keyOverrides: Partial<Record<RemoteKey, NormalisedActionSettlingLimits>> = {};
  for (const [rawKey, rawLimits] of Object.entries(options.keyOverrides ?? {})) {
    if (!isRemoteKey(rawKey)) throw new TypeError(`keyOverrides contains an unsupported remote key: ${rawKey}.`);
    if (typeof rawLimits !== "object" || rawLimits === null || Array.isArray(rawLimits)) {
      throw new TypeError(`keyOverrides.${rawKey} must be an object.`);
    }
    const unknownFields = Object.keys(rawLimits).filter((field) => (
      field !== "maxSnapshots" && field !== "requiredStableSnapshots"
    ));
    if (unknownFields.length > 0) {
      throw new TypeError(`keyOverrides.${rawKey} contains an unsupported field: ${unknownFields[0]}.`);
    }
    const overrideMaxSnapshots = positiveInteger(
      rawLimits.maxSnapshots ?? maxSnapshots,
      `keyOverrides.${rawKey}.maxSnapshots`,
    );
    const overrideRequiredStableSnapshots = positiveInteger(
      rawLimits.requiredStableSnapshots ?? requiredStableSnapshots,
      `keyOverrides.${rawKey}.requiredStableSnapshots`,
    );
    if (overrideRequiredStableSnapshots > overrideMaxSnapshots) {
      throw new TypeError(`keyOverrides.${rawKey}.requiredStableSnapshots must not exceed maxSnapshots.`);
    }
    if (strategy === "driver"
      && (overrideMaxSnapshots !== 1 || overrideRequiredStableSnapshots !== 1)) {
      throw new TypeError("driver settling requires exactly one snapshot for every key.");
    }
    keyOverrides[rawKey] = {
      maxSnapshots: overrideMaxSnapshots,
      requiredStableSnapshots: overrideRequiredStableSnapshots,
    };
  }
  return {
    strategy,
    maxSnapshots,
    requiredStableSnapshots,
    keyOverrides,
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
  const operationOptions: DriverOperationOptions | undefined = options.signal === undefined
    ? undefined
    : { signal: options.signal };
  options.signal?.throwIfAborted();
  const actionResult = await driver.press(key, operationOptions);

  if (actionResult.outcome === "failed" || actionResult.outcome === "inconclusive") {
    if (actionResult.outcome !== "inconclusive" || options.allowUnsettledActions !== true) {
      throw new Error(
        `Driver could not settle ${key} input: ${actionResult.message ?? actionResult.outcome}`,
        { cause: actionResult },
      );
    }
  }

  if (actionResult.outcome === "inconclusive") {
    const snapshot = actionResult.postActionSnapshot ?? await driver.snapshot(operationOptions);
    return {
      actionResult,
      snapshot,
      snapshotsCaptured: actionResult.postActionSnapshot === undefined ? 1 : 0,
      snapshotsObserved: 1,
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
      snapshot = await driver.snapshot(operationOptions);
      snapshotsCaptured = 1;
    }
    return {
      actionResult,
      snapshot,
      snapshotsCaptured,
      snapshotsObserved: 1,
      reusedDriverObservation,
      settled: true,
    };
  }

  // Stable-snapshot mode seeds its equivalence chain from the driver's settled
  // observation when present, then keeps polling canonical snapshots.
  const keyLimits = settling.keyOverrides[key] ?? settling;
  let stableSnapshots = 1;
  if (actionResult.postActionSnapshot !== undefined) {
    snapshot = actionResult.postActionSnapshot;
    reusedDriverObservation = true;
  } else {
    snapshot = await driver.snapshot(operationOptions);
    snapshotsCaptured = 1;
  }
  let snapshotsObserved = 1;
  while (snapshotsObserved < keyLimits.maxSnapshots
    && stableSnapshots < keyLimits.requiredStableSnapshots) {
    await settling.wait(settling.pollIntervalMs);
    options.signal?.throwIfAborted();
    const nextSnapshot = await driver.snapshot(operationOptions);
    snapshotsCaptured += 1;
    snapshotsObserved += 1;
    stableSnapshots = settling.equivalent(snapshot, nextSnapshot)
      ? stableSnapshots + 1
      : 1;
    snapshot = nextSnapshot;
  }
  return {
    actionResult,
    snapshot,
    snapshotsCaptured,
    snapshotsObserved,
    reusedDriverObservation,
    settled: stableSnapshots >= keyLimits.requiredStableSnapshots,
  };
}
