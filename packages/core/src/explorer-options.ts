import {
  NAVIGATION_KEYS,
  REMOTE_KEYS,
  type RemoteKey,
} from "@tvdoctor/protocol";

import {
  normaliseActionSettlingOptions,
  type NormalisedActionSettlingOptions,
} from "./action-settling.js";
import {
  DEFAULT_EXPLORATION_BUDGETS,
  EXPLORATION_BUDGET_PROFILES,
  MAX_EXPLORATION_BUDGETS,
  type ExplorerOptions,
  type ExplorationBudgets,
  type ExplorationFrontierStrategy,
  type ExplorationProfile,
  type ExplorationRestorationMode,
  type NormalisedRepetitionCompressionOptions,
  type RepetitionCompressionOptions,
} from "./explorer-contracts.js";

export interface NormalisedExplorerOptions {
  readonly budgets: ExplorationBudgets;
  readonly actionOrder: readonly RemoteKey[];
  readonly replayActions: readonly RemoteKey[];
  readonly frontierStrategy: ExplorationFrontierStrategy;
  readonly restorationMode: ExplorationRestorationMode;
  readonly allowRootRestorationFallback: boolean;
  readonly refreshVisibleSelfLoops: boolean;
  readonly repetitionCompression: NormalisedRepetitionCompressionOptions;
  readonly settling: NormalisedActionSettlingOptions;
  readonly replaySettling: NormalisedActionSettlingOptions;
  readonly monotonicSource: () => number;
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
  const result = [...(actions ?? NAVIGATION_KEYS)];
  const allowed = new Set<string>(REMOTE_KEYS);
  if (result.some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw new TypeError("Explorer actions must contain only known remote keys.");
  }
  if (new Set(result).size !== result.length) {
    throw new TypeError("Explorer actions must not contain duplicates.");
  }
  return result;
}

function normaliseReplayActions(
  replayActions: readonly RemoteKey[] | undefined,
  actionOrder: readonly RemoteKey[],
): readonly RemoteKey[] {
  if (replayActions !== undefined && !Array.isArray(replayActions)) {
    throw new TypeError("Explorer replayActions must be an array.");
  }
  const configured = new Set(actionOrder);
  const defaults = NAVIGATION_KEYS.filter((key) => configured.has(key));
  const result = [...(replayActions ?? defaults)];
  const known = new Set<string>(REMOTE_KEYS);
  if (result.some((key) => typeof key !== "string" || !known.has(key))) {
    throw new TypeError("Explorer replayActions must contain only known remote keys.");
  }
  if (new Set(result).size !== result.length) {
    throw new TypeError("Explorer replayActions must not contain duplicates.");
  }
  if (result.some((key) => !configured.has(key))) {
    throw new TypeError("Explorer replayActions must be a subset of configured actions.");
  }
  return result;
}

export function normaliseExplorerOptions(options: ExplorerOptions): NormalisedExplorerOptions {
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
  const replayActions = normaliseReplayActions(options.replayActions, actionOrder);
  const frontierStrategy = normaliseFrontierStrategy(
    options.frontierStrategy,
    options.profile,
  );
  const restorationMode = options.restorationMode ?? "root-only";
  if (restorationMode !== "root-only"
    && restorationMode !== "verified-live-only"
    && restorationMode !== "verified-local") {
    throw new TypeError("restorationMode must be root-only, verified-live-only, or verified-local.");
  }
  const repetitionCompression = normaliseRepetitionCompression(
    options.profile,
    options.repetitionCompression,
  );
  const settling = normaliseActionSettlingOptions(options.settling);
  const replaySettling = options.replaySettling === undefined
    ? settling
    : normaliseActionSettlingOptions(options.replaySettling);
  if (options.restoreInitialState !== undefined && typeof options.restoreInitialState !== "function") {
    throw new TypeError("restoreInitialState must be a function.");
  }
  if (options.restoreInitialSnapshot !== undefined && typeof options.restoreInitialSnapshot !== "function") {
    throw new TypeError("restoreInitialSnapshot must be a function.");
  }
  if (options.refreshVisibleSelfLoops !== undefined && typeof options.refreshVisibleSelfLoops !== "boolean") {
    throw new TypeError("refreshVisibleSelfLoops must be a boolean.");
  }
  if (options.allowRootRestorationFallback !== undefined
    && typeof options.allowRootRestorationFallback !== "boolean") {
    throw new TypeError("allowRootRestorationFallback must be a boolean.");
  }
  if (options.actionsForState !== undefined && typeof options.actionsForState !== "function") {
    throw new TypeError("actionsForState must be a function.");
  }
  if (options.onActionObserved !== undefined && typeof options.onActionObserved !== "function") {
    throw new TypeError("onActionObserved must be a function.");
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
  return {
    budgets,
    actionOrder,
    replayActions,
    frontierStrategy,
    restorationMode,
    allowRootRestorationFallback: options.allowRootRestorationFallback ?? true,
    refreshVisibleSelfLoops: options.refreshVisibleSelfLoops ?? true,
    repetitionCompression,
    settling,
    replaySettling,
    monotonicSource: options.monotonicNow ?? (() => performance.now()),
  };
}
