import {
  CAPABILITIES,
  isCapability,
  isRemoteKey,
  PROTOCOL_VALIDATION_LIMITS,
  type ActionResult,
  type AppReference,
  type Capability,
  type FocusTarget,
  type RemoteKey,
  type ResetStrategy,
  type StateSnapshot,
  type TVDoctorDriver,
  type UiNodeSnapshot,
} from "@tvdoctor/protocol";

import { flattenBoundedUiTree } from "./bounded-ui-tree.js";

export const DRIVER_CONFORMANCE_LIMITS = {
  maxRemoteKeys: 32,
  maxJsonNodes: 250_000,
  maxJsonDepth: 300,
  maxJsonBytes: PROTOCOL_VALIDATION_LIMITS.maxJsonBytes,
  maxStringLength: PROTOCOL_VALIDATION_LIMITS.maxStringLength,
} as const;

export type DriverConformanceCheckStatus = "pass" | "fail" | "unavailable";
export type DriverConformanceStatus = DriverConformanceCheckStatus;
export type DriverConformanceResetStrategy = Exclude<ResetStrategy, "clear-data">;

export interface DriverConformanceSnapshotExpectation {
  readonly location?: string;
  readonly focusedElementStableId?: string | null;
  readonly uiTree?: "available" | "unavailable";
}

export interface DriverConformanceExpectations {
  readonly requiredCapabilities?: readonly Capability[];
  readonly initialSnapshot?: DriverConformanceSnapshotExpectation;
  readonly afterResetSnapshot?: DriverConformanceSnapshotExpectation;
}

export interface DriverConformanceOptions {
  /** Optional caller-owned safe fixture/app to launch before snapshot and input checks. */
  readonly app?: AppReference;
  /** Optional non-destructive reset to exercise after the initial snapshot. */
  readonly resetStrategy?: DriverConformanceResetStrategy;
  /** Exact caller-supplied input sequence. TVDoctor never adds keys to this list. */
  readonly remoteKeys?: readonly RemoteKey[];
  readonly expectations?: DriverConformanceExpectations;
  readonly signal?: AbortSignal;
}

export interface DriverConformanceCheck {
  readonly id: string;
  readonly status: DriverConformanceCheckStatus;
  readonly detail: string;
}

export interface DriverConformanceResult {
  readonly status: DriverConformanceStatus;
  readonly checks: readonly DriverConformanceCheck[];
  readonly counts: Readonly<Record<DriverConformanceCheckStatus, number>>;
  readonly actionsRequested: number;
  readonly actionsAttempted: number;
}

const ACTION_OUTCOMES = new Set(["applied", "unsupported", "failed", "inconclusive"] as const);
const RESET_STRATEGIES = new Set<ResetStrategy>(["reload", "relaunch"]);

function check(
  id: string,
  status: DriverConformanceCheckStatus,
  detail: string,
): DriverConformanceCheck {
  return { id, status, detail };
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return (prototype === Object.prototype || prototype === null)
    && Object.getOwnPropertySymbols(value).length === 0;
}

function boundedString(value: unknown, allowEmpty = true): value is string {
  return typeof value === "string"
    && value.length <= DRIVER_CONFORMANCE_LIMITS.maxStringLength
    && (allowEmpty || value.length > 0);
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function jsonSafetyError(root: unknown): string | null {
  type Frame =
    | { readonly kind: "value"; readonly value: unknown; readonly depth: number }
    | { readonly kind: "leave"; readonly value: object };
  const stack: Frame[] = [{ kind: "value", value: root, depth: 0 }];
  const active = new WeakSet<object>();
  let nodes = 0;

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    if (frame.kind === "leave") {
      active.delete(frame.value);
      continue;
    }
    nodes += 1;
    if (nodes > DRIVER_CONFORMANCE_LIMITS.maxJsonNodes) return "JSON node limit exceeded.";
    if (frame.depth > DRIVER_CONFORMANCE_LIMITS.maxJsonDepth) return "JSON depth limit exceeded.";

    const value = frame.value;
    if (value === null || typeof value === "boolean" || typeof value === "string") {
      if (typeof value === "string" && value.length > DRIVER_CONFORMANCE_LIMITS.maxStringLength) {
        return "JSON string limit exceeded.";
      }
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return "JSON contained a non-finite number.";
      continue;
    }
    if (typeof value !== "object") return "JSON contained a non-serializable value.";
    if (active.has(value)) return "JSON contained a cyclic reference.";
    if (Object.getOwnPropertySymbols(value).length > 0) return "JSON contained symbol properties.";
    if (!Array.isArray(value) && !plainRecord(value)) return "JSON contained a non-plain object.";

    active.add(value);
    stack.push({ kind: "leave", value });
    const values = Array.isArray(value) ? value : Object.values(value);
    for (let index = values.length - 1; index >= 0; index -= 1) {
      stack.push({ kind: "value", value: values[index], depth: frame.depth + 1 });
    }
  }

  let rendered: string;
  try {
    rendered = JSON.stringify(root);
  } catch {
    return "JSON serialization failed.";
  }
  if (new TextEncoder().encode(rendered).byteLength > DRIVER_CONFORMANCE_LIMITS.maxJsonBytes) {
    return "JSON byte limit exceeded.";
  }
  return null;
}

function boundsError(value: unknown): string | null {
  if (!plainRecord(value)) return "bounds must be a plain object.";
  for (const field of ["x", "y", "width", "height"] as const) {
    if (!Number.isFinite(value[field])) return `bounds.${field} must be finite.`;
  }
  if ((value["width"] as number) < 0 || (value["height"] as number) < 0) {
    return "bounds width and height must be non-negative.";
  }
  return null;
}

function focusTargetError(value: unknown): string | null {
  if (value === null) return null;
  if (!plainRecord(value)) return "focusedElement value must be an object or null.";
  for (const field of ["stableId", "role", "name"] as const) {
    const fieldValue = value[field];
    if (fieldValue !== undefined && !boundedString(fieldValue)) {
      return `focusedElement.${field} must be a bounded string when present.`;
    }
  }
  if (value["bounds"] !== undefined) {
    const error = boundsError(value["bounds"]);
    if (error !== null) return `focusedElement ${error}`;
  }
  return null;
}

function uiNodeError(node: UiNodeSnapshot): string | null {
  const record = node as unknown as Record<string, unknown>;
  for (const field of ["stableId", "role", "name", "text"] as const) {
    const value = record[field];
    if (value !== null && !boundedString(value)) return `UI node ${field} must be a bounded string or null.`;
  }
  if (record["bounds"] !== null) {
    const error = boundsError(record["bounds"]);
    if (error !== null) return `UI node ${error}`;
  }
  for (const field of ["visible", "enabled", "focusable", "focused", "modal"] as const) {
    const value = record[field];
    if (value !== null && typeof value !== "boolean") return `UI node ${field} must be boolean or null.`;
  }
  if (record["selectionState"] !== null
    && !["on", "off", "mixed"].includes(record["selectionState"] as string)) {
    return "UI node selectionState is invalid.";
  }
  if (record["valueNow"] !== null && !Number.isFinite(record["valueNow"])) {
    return "UI node valueNow must be finite or null.";
  }
  return null;
}

function observationError<T>(
  value: unknown,
  label: string,
  validateAvailable: (available: unknown) => string | null,
): string | null {
  if (!plainRecord(value)) return `${label} must be a plain observation object.`;
  if (value["status"] === "unavailable") {
    return boundedString(value["reason"], false) ? null : `${label} unavailable reason must be a bounded non-empty string.`;
  }
  if (value["status"] !== "available") return `${label} status must be available or unavailable.`;
  if (!Object.hasOwn(value, "value")) return `${label} available observation must contain value.`;
  return validateAvailable(value["value"] as T);
}

function snapshotError(snapshot: unknown): string | null {
  const jsonError = jsonSafetyError(snapshot);
  if (jsonError !== null) return jsonError;
  if (!plainRecord(snapshot)) return "Snapshot must be a plain object.";
  if (!boundedString(snapshot["capturedAt"], false) || !Number.isFinite(Date.parse(snapshot["capturedAt"]))) {
    return "capturedAt must be a bounded parseable timestamp.";
  }

  const locationError = observationError<string>(snapshot["location"], "location", (value) => (
    boundedString(value) ? null : "location value must be a bounded string."
  ));
  if (locationError !== null) return locationError;

  const focusError = observationError<FocusTarget | null>(
    snapshot["focusedElement"],
    "focusedElement",
    focusTargetError,
  );
  if (focusError !== null) return focusError;

  const treeError = observationError<readonly UiNodeSnapshot[]>(snapshot["uiTree"], "uiTree", (value) => {
    if (!Array.isArray(value)) return "uiTree value must be an array.";
    let entries: ReturnType<typeof flattenBoundedUiTree>;
    try {
      entries = flattenBoundedUiTree(value as readonly UiNodeSnapshot[]);
    } catch (error) {
      return error instanceof Error ? error.message : "uiTree validation failed.";
    }
    for (const entry of entries) {
      const error = uiNodeError(entry.node);
      if (error !== null) return error;
    }
    return null;
  });
  return treeError;
}

function actionResultError(result: unknown, expectedKey: RemoteKey): string | null {
  const jsonError = jsonSafetyError(result);
  if (jsonError !== null) return jsonError;
  if (!plainRecord(result)) return "ActionResult must be a plain object.";
  if (!isRemoteKey(result["key"]) || result["key"] !== expectedKey) {
    return "ActionResult key does not match the requested remote key.";
  }
  if (!ACTION_OUTCOMES.has(result["outcome"] as ActionResult["outcome"])) {
    return "ActionResult outcome is invalid.";
  }
  if (!plainRecord(result["timing"]) || !finiteNonNegative(result["timing"]["inputSentAtMs"])) {
    return "ActionResult timing.inputSentAtMs must be finite and non-negative.";
  }
  const input = result["timing"]["inputSentAtMs"];
  for (const field of ["firstResponseAtMs", "focusSettledAtMs", "screenSettledAtMs"] as const) {
    const value = result["timing"][field];
    if (value !== undefined && (!finiteNonNegative(value) || value < input)) {
      return `ActionResult timing.${field} must be finite and no earlier than inputSentAtMs.`;
    }
  }
  if (result["message"] !== undefined && !boundedString(result["message"])) {
    return "ActionResult message must be a bounded string when present.";
  }
  const profile = result["timing"]["profile"];
  if (profile !== undefined) {
    if (!plainRecord(profile)
      || !["fresh", "cached", "unavailable"].includes(profile["baselineSource"] as string)
      || !Number.isSafeInteger(profile["captureCount"])
      || (profile["captureCount"] as number) < 0) {
      return "ActionResult timing.profile has an invalid baselineSource or captureCount.";
    }
    const durations = profile["captureDurationsMs"];
    if (durations !== undefined && (!Array.isArray(durations)
      || durations.length > DRIVER_CONFORMANCE_LIMITS.maxRemoteKeys
      || durations.some((value) => !finiteNonNegative(value)))) {
      return "ActionResult timing.profile capture durations are invalid or unbounded.";
    }
    for (const field of [
      "inputDispatchMs",
      "transportMs",
      "observerEventLatencyMs",
      "snapshotGenerationMs",
      "settlingMs",
      "hostConversionMs",
      "totalMs",
    ] as const) {
      const value = profile[field];
      if (value !== undefined && !finiteNonNegative(value)) {
        return `ActionResult timing.profile.${field} must be finite and non-negative.`;
      }
    }
    if (profile["pollCount"] !== undefined
      && (!Number.isSafeInteger(profile["pollCount"]) || (profile["pollCount"] as number) < 0)) {
      return "ActionResult timing.profile.pollCount must be a non-negative safe integer.";
    }
    if (profile["wedgeSuspected"] !== undefined && typeof profile["wedgeSuspected"] !== "boolean") {
      return "ActionResult timing.profile.wedgeSuspected must be boolean when present.";
    }
  }
  if (result["postActionSnapshot"] !== undefined) {
    const error = snapshotError(result["postActionSnapshot"]);
    if (error !== null) return `postActionSnapshot: ${error}`;
  }
  return null;
}

function expectationChecks(
  prefix: string,
  snapshot: StateSnapshot,
  expectation: DriverConformanceSnapshotExpectation | undefined,
): readonly DriverConformanceCheck[] {
  if (expectation === undefined) return [];
  const checks: DriverConformanceCheck[] = [];
  if (expectation.location !== undefined) {
    const location = snapshot.location;
    if (location.status === "unavailable") {
      checks.push(check(`${prefix}.location`, "unavailable", "Location observation is unavailable."));
    } else {
      checks.push(check(
        `${prefix}.location`,
        location.value === expectation.location ? "pass" : "fail",
        location.value === expectation.location ? "Location matched the fixture expectation." : "Location did not match the fixture expectation.",
      ));
    }
  }
  if (expectation.focusedElementStableId !== undefined) {
    const focused = snapshot.focusedElement;
    if (focused.status === "unavailable") {
      checks.push(check(`${prefix}.focus`, "unavailable", "Focused-element observation is unavailable."));
    } else {
      const actual = focused.value?.stableId ?? null;
      checks.push(check(
        `${prefix}.focus`,
        actual === expectation.focusedElementStableId ? "pass" : "fail",
        actual === expectation.focusedElementStableId ? "Focus matched the fixture expectation." : "Focus did not match the fixture expectation.",
      ));
    }
  }
  if (expectation.uiTree !== undefined) {
    const actual = snapshot.uiTree.status;
    checks.push(check(
      `${prefix}.ui-tree`,
      actual === expectation.uiTree ? "pass" : actual === "unavailable" ? "unavailable" : "fail",
      actual === expectation.uiTree ? "UI-tree availability matched the fixture expectation." : "UI-tree availability did not match the fixture expectation.",
    ));
  }
  return checks;
}

function validateOptions(options: DriverConformanceOptions): readonly RemoteKey[] {
  const remoteKeys = options.remoteKeys ?? [];
  if (!Array.isArray(remoteKeys) || remoteKeys.length > DRIVER_CONFORMANCE_LIMITS.maxRemoteKeys) {
    throw new RangeError(`Driver conformance accepts at most ${String(DRIVER_CONFORMANCE_LIMITS.maxRemoteKeys)} remote keys.`);
  }
  for (const key of remoteKeys) {
    if (!isRemoteKey(key)) throw new TypeError("Driver conformance received an invalid remote key.");
  }
  if (options.resetStrategy !== undefined && !RESET_STRATEGIES.has(options.resetStrategy)) {
    throw new TypeError("Driver conformance resetStrategy must be reload or relaunch.");
  }
  for (const capability of options.expectations?.requiredCapabilities ?? []) {
    if (!isCapability(capability)) throw new TypeError("Driver conformance received an invalid required capability.");
  }
  if (options.expectations?.requiredCapabilities !== undefined
    && new Set(options.expectations.requiredCapabilities).size !== options.expectations.requiredCapabilities.length) {
    throw new TypeError("Driver conformance required capabilities must be unique.");
  }
  if (options.app !== undefined) {
    if (!boundedString(options.app.id, false)) throw new TypeError("Driver conformance app id must be a bounded non-empty string.");
    for (const value of [options.app.artifactPath, options.app.launchUri]) {
      if (value !== undefined && !boundedString(value, false)) {
        throw new TypeError("Driver conformance app fields must be bounded non-empty strings when supplied.");
      }
    }
  }
  for (const expectation of [
    options.expectations?.initialSnapshot,
    options.expectations?.afterResetSnapshot,
  ]) {
    if (expectation === undefined) continue;
    if (expectation.location !== undefined && !boundedString(expectation.location)) {
      throw new TypeError("Driver conformance expected location must be a bounded string.");
    }
    if (expectation.focusedElementStableId !== undefined
      && expectation.focusedElementStableId !== null
      && !boundedString(expectation.focusedElementStableId)) {
      throw new TypeError("Driver conformance expected focus id must be a bounded string or null.");
    }
    if (expectation.uiTree !== undefined
      && expectation.uiTree !== "available"
      && expectation.uiTree !== "unavailable") {
      throw new TypeError("Driver conformance uiTree expectation must be available or unavailable.");
    }
  }
  return remoteKeys;
}

function finalStatus(checks: readonly DriverConformanceCheck[]): DriverConformanceStatus {
  if (checks.some((entry) => entry.status === "fail")) return "fail";
  if (checks.some((entry) => entry.status === "unavailable")) return "unavailable";
  return "pass";
}

/**
 * Exercises the platform-neutral TVDoctorDriver contract against a caller-owned
 * safe fixture. The helper never invents remote input, performs installation, or
 * uses clear-data resets; platform qualification still requires real-platform
 * evidence outside this conformance gate.
 */
export async function runDriverConformance(
  driver: TVDoctorDriver,
  options: DriverConformanceOptions = {},
): Promise<DriverConformanceResult> {
  const remoteKeys = validateOptions(options);
  const checks: DriverConformanceCheck[] = [];
  let capabilities: ReadonlySet<Capability> | null = null;
  let actionsAttempted = 0;

  try {
    const observed = await driver.capabilities(options.signal === undefined ? undefined : { signal: options.signal });
    const values = [...observed];
    const invalid = values.find((value) => !isCapability(value));
    if (values.length > CAPABILITIES.length || invalid !== undefined) {
      checks.push(check("capabilities.shape", "fail", "Driver returned invalid capabilities."));
    } else {
      capabilities = new Set(values);
      checks.push(check("capabilities.shape", "pass", "Driver returned known capabilities."));
    }
  } catch {
    checks.push(check("capabilities.shape", "fail", "Driver capabilities() failed."));
  }

  for (const required of options.expectations?.requiredCapabilities ?? []) {
    checks.push(check(
      `capabilities.required.${required}`,
      capabilities?.has(required) === true ? "pass" : "unavailable",
      capabilities?.has(required) === true ? "Required capability is available." : "Required capability is unavailable.",
    ));
  }

  if (options.app !== undefined) {
    if (driver.launch === undefined) {
      checks.push(check("launch", "unavailable", "Driver does not expose launch()."));
    } else {
      try {
        await driver.launch(options.app, options.signal === undefined ? undefined : { signal: options.signal });
        checks.push(check("launch", "pass", "Driver launched the caller-supplied fixture/app."));
      } catch {
        checks.push(check("launch", "fail", "Driver launch() failed for the caller-supplied fixture/app."));
      }
    }
  }

  try {
    const snapshot = await driver.snapshot(options.signal === undefined ? undefined : { signal: options.signal });
    const error = snapshotError(snapshot);
    if (error === null) {
      checks.push(check("snapshot.initial.shape", "pass", "Initial snapshot is bounded and JSON-safe."));
      checks.push(...expectationChecks("snapshot.initial", snapshot, options.expectations?.initialSnapshot));
    } else {
      checks.push(check("snapshot.initial.shape", "fail", error));
    }
  } catch {
    checks.push(check("snapshot.initial.shape", "fail", "Driver snapshot() failed."));
  }

  if (options.resetStrategy !== undefined) {
    if (driver.reset === undefined) {
      checks.push(check("reset", "unavailable", "Driver does not expose reset()."));
    } else {
      let resetCompleted = false;
      try {
        await driver.reset(options.resetStrategy, options.signal === undefined ? undefined : { signal: options.signal });
        checks.push(check("reset", "pass", "Driver completed the caller-supplied non-destructive reset."));
        resetCompleted = true;
      } catch {
        checks.push(check("reset", "fail", "Driver reset() failed."));
      }
      if (resetCompleted) {
        try {
        const snapshot = await driver.snapshot(options.signal === undefined ? undefined : { signal: options.signal });
        const error = snapshotError(snapshot);
        if (error === null) {
          checks.push(check("snapshot.after-reset.shape", "pass", "Post-reset snapshot is bounded and JSON-safe."));
          checks.push(...expectationChecks("snapshot.after-reset", snapshot, options.expectations?.afterResetSnapshot));
        } else {
          checks.push(check("snapshot.after-reset.shape", "fail", error));
        }
        } catch {
          checks.push(check("snapshot.after-reset.shape", "fail", "Driver snapshot() failed after reset."));
        }
      }
    }
  }

  const canExerciseRemoteInput = remoteKeys.length === 0 || capabilities?.has("remote-input") === true;
  for (const [index, key] of remoteKeys.entries()) {
    const prefix = `action.${String(index)}`;
    if (!canExerciseRemoteInput) {
      checks.push(check(prefix, "unavailable", "Remote-input capability was not available; input was not sent."));
      continue;
    }
    actionsAttempted += 1;
    try {
      const result = await driver.press(key, options.signal === undefined ? undefined : { signal: options.signal });
      const error = actionResultError(result, key);
      if (error !== null) {
        checks.push(check(prefix, "fail", error));
        continue;
      }
      const status: DriverConformanceCheckStatus = result.outcome === "applied"
        ? "pass"
        : result.outcome === "unsupported" ? "unavailable" : "fail";
      checks.push(check(
        prefix,
        status,
        result.outcome === "applied"
          ? "Remote action returned a valid applied ActionResult."
          : result.outcome === "unsupported"
            ? "Remote action is unsupported by this driver/fixture."
            : `Remote action returned ${result.outcome}; conformance remains fail-closed.`,
      ));
    } catch {
      checks.push(check(prefix, "fail", "Driver press() threw for the caller-supplied remote key."));
    }
  }

  const counts = {
    pass: checks.filter((entry) => entry.status === "pass").length,
    fail: checks.filter((entry) => entry.status === "fail").length,
    unavailable: checks.filter((entry) => entry.status === "unavailable").length,
  };
  return {
    status: finalStatus(checks),
    checks,
    counts,
    actionsRequested: remoteKeys.length,
    actionsAttempted,
  };
}
