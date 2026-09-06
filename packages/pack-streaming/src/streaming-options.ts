import {
  DEFAULT_STREAMING_PACK_BUDGETS,
  type StreamingPackBudgets,
  type StreamingPackOptions,
} from "./types.js";

const MAX_STREAMING_ACTIONS = 1_000_000;
const MAX_STREAMING_STATES = 100_000;
const MAX_STREAMING_LOCAL_DEPTH = 4_096;
const MAX_STREAMING_DURATION_MS = 2_147_483_647;

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

function normaliseBudgets(overrides: Partial<StreamingPackBudgets> | undefined): StreamingPackBudgets {
  if (overrides !== undefined
    && (typeof overrides !== "object" || overrides === null || Array.isArray(overrides))) {
    throw new TypeError("budgets must be an object.");
  }
  const values = { ...DEFAULT_STREAMING_PACK_BUDGETS, ...overrides };
  return {
    maxActions: positiveInteger(values.maxActions, "maxActions", MAX_STREAMING_ACTIONS),
    maxStates: positiveInteger(values.maxStates, "maxStates", MAX_STREAMING_STATES),
    maxLocalDepth: nonNegativeInteger(values.maxLocalDepth, "maxLocalDepth", MAX_STREAMING_LOCAL_DEPTH),
    maxLocalStates: positiveInteger(values.maxLocalStates, "maxLocalStates", MAX_STREAMING_STATES),
    maxDurationMs: positiveInteger(values.maxDurationMs, "maxDurationMs", MAX_STREAMING_DURATION_MS),
  };
}

export function validateStreamingOptions(options: StreamingPackOptions): StreamingPackBudgets {
if (typeof options !== "object" || options === null || Array.isArray(options)) {
  throw new TypeError("Streaming pack options must be an object.");
}
if (options.resetStrategy !== undefined
  && options.resetStrategy !== "reload"
  && options.resetStrategy !== "relaunch"
  && options.resetStrategy !== "clear-data") {
  throw new TypeError("resetStrategy must be reload, relaunch, or clear-data.");
}
if (options.restoreInitialState !== undefined && typeof options.restoreInitialState !== "function") {
  throw new TypeError("restoreInitialState must be a function.");
}
if (options.monotonicNow !== undefined && typeof options.monotonicNow !== "function") {
  throw new TypeError("monotonicNow must be a function.");
}
if (options.pointerProbe !== undefined
  && (typeof options.pointerProbe !== "object"
    || options.pointerProbe === null
    || typeof options.pointerProbe.probe !== "function")) {
  throw new TypeError("pointerProbe must expose a probe function.");
}
  return normaliseBudgets(options.budgets);
}
