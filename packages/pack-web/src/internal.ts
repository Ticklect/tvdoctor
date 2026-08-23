import type {
  ActionResult,
  Capability,
  RemoteKey,
  StateSnapshot,
  TVDoctorDriver,
} from "@tvdoctor/protocol";
import { CAPABILITIES, REMOTE_KEYS } from "@tvdoctor/protocol";
import {
  focusedWebEntry,
  webSemanticStateIdentity,
} from "./semantics.js";
import {
  DEFAULT_WEB_PACK_BUDGETS,
  WEB_STAGE_NAMES,
  type WebElementDescriptor,
  type WebPackBudgets,
  type WebPackOptions,
  type WebPackStatistics,
  type WebPackTerminationReason,
  type WebStageName,
} from "./types.js";

export const DIRECTION_KEYS: readonly RemoteKey[] = ["UP", "DOWN", "LEFT", "RIGHT"];

const HARD_BUDGET_LIMITS: WebPackBudgets = {
  maxActions: 2_000,
  maxStates: 512,
  maxLocalDepth: 24,
  maxLocalStates: 128,
  maxDurationMs: 600_000,
  maxFocusProbes: 64,
  maxSettingsSurfaces: 32,
  maxLogs: 2_048,
};

const BUDGET_KEYS = Object.keys(DEFAULT_WEB_PACK_BUDGETS) as (keyof WebPackBudgets)[];
const REMOTE_KEY_SET: ReadonlySet<string> = new Set(REMOTE_KEYS);
const STAGE_SET: ReadonlySet<string> = new Set(WEB_STAGE_NAMES);

export class WebPackStop extends Error {
  public readonly reason: WebPackTerminationReason;

  public constructor(
    reason: WebPackTerminationReason,
    message: string,
  ) {
    super(message);
    this.reason = reason;
    this.name = "WebPackStop";
  }
}

export interface ResolvedWebPackConfiguration {
  readonly budgets: WebPackBudgets;
  readonly stages: readonly WebStageName[];
  readonly searchQuery: string;
  readonly playerSettingsSequence: readonly RemoteKey[] | null;
  readonly menuResponseThresholdMs: number | null;
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object.`);
  }
}

function resolveBudgets(input: Partial<WebPackBudgets> | undefined): WebPackBudgets {
  if (input === undefined) return { ...DEFAULT_WEB_PACK_BUDGETS };
  assertPlainObject(input, "budgets");
  for (const key of Object.keys(input)) {
    if (!(BUDGET_KEYS as readonly string[]).includes(key)) {
      throw new TypeError(`Unknown web-pack budget '${key}'.`);
    }
  }
  const values = Object.fromEntries(BUDGET_KEYS.map((key) => {
    const value = input[key] === undefined ? DEFAULT_WEB_PACK_BUDGETS[key] : input[key];
    if (!Number.isSafeInteger(value) || value <= 0 || value > HARD_BUDGET_LIMITS[key]) {
      throw new RangeError(
        `${key} must be a positive safe integer no greater than ${String(HARD_BUDGET_LIMITS[key])}.`,
      );
    }
    return [key, value];
  })) as unknown as WebPackBudgets;
  return values;
}

function resolveStages(input: readonly WebStageName[] | undefined): readonly WebStageName[] {
  if (input === undefined) return [...WEB_STAGE_NAMES];
  if (!Array.isArray(input) || input.length === 0 || input.length > WEB_STAGE_NAMES.length) {
    throw new TypeError("stages must be a non-empty bounded array.");
  }
  const selected = new Set<WebStageName>();
  for (const stage of input) {
    if (typeof stage !== "string" || !STAGE_SET.has(stage)) {
      throw new TypeError(`Unknown web-pack stage '${String(stage)}'.`);
    }
    const stageName = stage as WebStageName;
    if (selected.has(stageName)) throw new TypeError(`Web-pack stage '${stageName}' was selected more than once.`);
    selected.add(stageName);
  }
  return WEB_STAGE_NAMES.filter((stage) => selected.has(stage));
}

function resolveQuery(input: string | undefined): string {
  const query = (input ?? "NOVA").normalize("NFKC").trim();
  const points = [...query];
  if (points.length === 0 || points.length > 32 || query.length > 128) {
    throw new RangeError("searchQuery must contain 1-32 bounded Unicode code points.");
  }
  if (!/^[\p{L}\p{N} '\-’]+$/u.test(query)) {
    throw new TypeError("searchQuery may contain letters, numbers, spaces, apostrophes, and hyphens only.");
  }
  if (/\b(password|passwd|secret|token|credit card|api key|private key)\b/iu.test(query)) {
    throw new TypeError("searchQuery appears sensitive and was rejected.");
  }
  if (/\d{12,}/u.test(query)) {
    throw new TypeError("searchQuery contains a long numeric sequence and was rejected as potentially sensitive.");
  }
  return query;
}

function resolveSequence(input: readonly RemoteKey[] | undefined): readonly RemoteKey[] | null {
  if (input === undefined) return null;
  if (!Array.isArray(input) || input.length === 0 || input.length > 256) {
    throw new RangeError("playerSettingsSequence must contain 1-256 remote keys.");
  }
  for (const key of input) {
    if (typeof key !== "string" || !REMOTE_KEY_SET.has(key)) {
      throw new TypeError(`playerSettingsSequence contained invalid key '${String(key)}'.`);
    }
  }
  if (input.at(-1) !== "SELECT") {
    throw new TypeError("playerSettingsSequence must end in SELECT so menu response can be measured.");
  }
  return [...input];
}

function resolveThreshold(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isFinite(value) || value < 1 || value > 60_000) {
    throw new RangeError("menuResponseThresholdMs must be between 1 and 60000 milliseconds.");
  }
  return value;
}

export function resolveWebPackConfiguration(options: WebPackOptions): ResolvedWebPackConfiguration {
  return {
    budgets: resolveBudgets(options.budgets),
    stages: resolveStages(options.stages),
    searchQuery: resolveQuery(options.searchQuery),
    playerSettingsSequence: resolveSequence(options.playerSettingsSequence),
    menuResponseThresholdMs: resolveThreshold(options.menuResponseThresholdMs),
  };
}

function boundedMessage(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message.replace(/\p{Cc}/gu, " ").slice(0, 512) || "Unknown driver error.";
}

function validateTiming(result: ActionResult, expectedKey: RemoteKey): void {
  if (result.key !== expectedKey) throw new TypeError("Driver ActionResult key did not match the requested key.");
  if (!["applied", "unsupported", "failed"].includes(result.outcome)) {
    throw new TypeError("Driver ActionResult outcome was invalid.");
  }
  const timing = result.timing;
  const values = [
    timing.inputSentAtMs,
    timing.firstResponseAtMs,
    timing.focusSettledAtMs,
    timing.screenSettledAtMs,
  ].filter((value): value is number => value !== undefined);
  if (values.some((value) => !Number.isFinite(value))) {
    throw new TypeError("Driver ActionResult timing must contain finite numbers.");
  }
  for (const value of values.slice(1)) {
    if (value < timing.inputSentAtMs) {
      throw new RangeError("Driver ActionResult timing ended before input was sent.");
    }
  }
  if (timing.firstResponseAtMs !== undefined
    && timing.focusSettledAtMs !== undefined
    && timing.focusSettledAtMs < timing.firstResponseAtMs) {
    throw new RangeError("Driver ActionResult focus settled before its first response.");
  }
  if (timing.firstResponseAtMs !== undefined
    && timing.screenSettledAtMs !== undefined
    && timing.screenSettledAtMs < timing.firstResponseAtMs) {
    throw new RangeError("Driver ActionResult screen settled before its first response.");
  }
  if (result.message !== undefined && typeof result.message !== "string") {
    throw new TypeError("Driver ActionResult message must be a string when present.");
  }
  if (typeof result.message === "string" && result.message.length > 1_024) {
    throw new RangeError("Driver ActionResult message exceeded the web-pack limit.");
  }
}

export type ActionCategory = "discovery" | "probe" | "replay";

export class WebPackSession {
  readonly #driver: TVDoctorDriver;
  readonly #options: WebPackOptions;
  readonly #budgets: WebPackBudgets;
  readonly #now: () => number;
  readonly #startMs: number;
  #lastNowMs: number;
  readonly #uniqueStates = new Set<string>();
  #physicalActions = 0;
  #discoveryActions = 0;
  #probeActions = 0;
  #replayActions = 0;
  #resets = 0;
  #snapshots = 0;
  #focusProbes = 0;
  #pointerProbes = 0;

  public constructor(driver: TVDoctorDriver, options: WebPackOptions, budgets: WebPackBudgets) {
    this.#driver = driver;
    this.#options = options;
    this.#budgets = budgets;
    this.#now = options.monotonicNow ?? (() => performance.now());
    const started = this.#now();
    if (!Number.isFinite(started)) throw new TypeError("monotonicNow returned a non-finite value.");
    this.#startMs = started;
    this.#lastNowMs = started;
  }

  public get driver(): TVDoctorDriver {
    return this.#driver;
  }

  public get budgets(): WebPackBudgets {
    return this.#budgets;
  }

  #elapsed(): number {
    const current = this.#now();
    if (!Number.isFinite(current)) throw new TypeError("monotonicNow returned a non-finite value.");
    if (current < this.#lastNowMs) throw new RangeError("monotonicNow moved backwards.");
    this.#lastNowMs = current;
    return current - this.#startMs;
  }

  public ensureDuration(): void {
    if (this.#elapsed() > this.#budgets.maxDurationMs) {
      throw new WebPackStop("max-duration", "The web-pack monotonic duration budget was exhausted.");
    }
  }

  public async capabilities(): Promise<ReadonlySet<Capability>> {
    this.ensureDuration();
    const capabilities = await this.#driver.capabilities();
    if (typeof capabilities !== "object" || capabilities === null
      || !(Symbol.iterator in capabilities)) {
      throw new TypeError("Driver capabilities must be an iterable ReadonlySet.");
    }
    const allowed: ReadonlySet<string> = new Set(CAPABILITIES);
    const validated = new Set<Capability>();
    for (const capability of capabilities) {
      if (typeof capability !== "string" || !allowed.has(capability)) {
        throw new TypeError(`Driver exposed unknown capability '${String(capability)}'.`);
      }
      validated.add(capability);
    }
    return validated;
  }

  public async snapshot(): Promise<StateSnapshot> {
    this.ensureDuration();
    const snapshot = await this.#driver.snapshot();
    this.#snapshots += 1;
    if (typeof snapshot.capturedAt !== "string" || snapshot.capturedAt.length === 0 || snapshot.capturedAt.length > 128) {
      throw new TypeError("Driver snapshot capturedAt was invalid.");
    }
    const identity = webSemanticStateIdentity(snapshot);
    if (identity !== null && !this.#uniqueStates.has(identity)) {
      if (this.#uniqueStates.size >= this.#budgets.maxStates) {
        throw new WebPackStop("max-states", "The web-pack unique semantic state budget was exhausted.");
      }
      this.#uniqueStates.add(identity);
    }
    return snapshot;
  }

  public async press(key: RemoteKey, category: ActionCategory): Promise<ActionResult> {
    this.ensureDuration();
    if (this.#physicalActions >= this.#budgets.maxActions) {
      throw new WebPackStop("max-actions", "The web-pack physical action budget was exhausted.");
    }
    this.#physicalActions += 1;
    if (category === "discovery") this.#discoveryActions += 1;
    else if (category === "probe") this.#probeActions += 1;
    else this.#replayActions += 1;
    const result = await this.#driver.press(key);
    validateTiming(result, key);
    return result;
  }

  public async restore(): Promise<void> {
    this.ensureDuration();
    try {
      if (this.#options.restoreInitialState !== undefined) {
        await this.#options.restoreInitialState();
      } else if (this.#driver.reset !== undefined) {
        await this.#driver.reset(this.#options.resetStrategy ?? "reload");
      } else {
        throw new WebPackStop(
          "restoration-unavailable",
          "Reset-relative exploration requires restoreInitialState or driver.reset.",
        );
      }
      this.#resets += 1;
    } catch (error) {
      if (error instanceof WebPackStop) throw error;
      throw new WebPackStop("restoration-failed", `Initial-state restoration failed: ${boundedMessage(error)}`);
    }
  }

  public async restoreAndReplay(
    sequence: readonly RemoteKey[],
    category: ActionCategory,
  ): Promise<StateSnapshot> {
    await this.restore();
    for (const key of sequence) {
      const action = await this.press(key, category);
      if (action.outcome !== "applied") {
        throw new WebPackStop(
          "restoration-failed",
          `Reset-relative replay stopped because ${key} was ${action.outcome}.`,
        );
      }
    }
    return this.snapshot();
  }

  public recordFocusProbe(): void {
    if (this.#focusProbes >= this.#budgets.maxFocusProbes) {
      throw new WebPackStop("max-local-states", "The focus-visibility probe budget was exhausted.");
    }
    this.#focusProbes += 1;
  }

  public recordPointerProbe(): void {
    this.#pointerProbes += 1;
  }

  public statistics(): WebPackStatistics {
    let elapsedMs: number;
    try {
      elapsedMs = Math.max(0, Math.round(this.#elapsed()));
    } catch {
      elapsedMs = Math.max(0, Math.round(this.#lastNowMs - this.#startMs));
    }
    return {
      physicalActions: this.#physicalActions,
      discoveryActions: this.#discoveryActions,
      probeActions: this.#probeActions,
      replayActions: this.#replayActions,
      resets: this.#resets,
      snapshots: this.#snapshots,
      uniqueStates: this.#uniqueStates.size,
      focusProbes: this.#focusProbes,
      pointerProbes: this.#pointerProbes,
      elapsedMs,
    };
  }
}

export interface ExpandedWebState {
  readonly snapshot: StateSnapshot;
  readonly relativePath: readonly RemoteKey[];
  readonly exactPath: readonly RemoteKey[];
  readonly focused: WebElementDescriptor | null;
}

export interface WebSurfaceExpansion {
  readonly states: readonly ExpandedWebState[];
  readonly complete: boolean;
  readonly reason: "complete" | "max-local-depth" | "max-local-states" | "target-found" | "unobservable";
}

function descriptorFromFocused(snapshot: StateSnapshot): WebElementDescriptor | null {
  const entry = focusedWebEntry(snapshot);
  if (entry === null) return null;
  return {
    stableId: entry.node.stableId,
    role: entry.node.role,
    name: entry.node.name ?? entry.node.text,
    bounds: entry.node.bounds,
    visible: entry.node.visible,
    enabled: entry.node.enabled,
    focusable: entry.node.focusable,
  };
}

export async function expandWebSurface(
  session: WebPackSession,
  baseSequence: readonly RemoteKey[],
  restoreBase: () => Promise<StateSnapshot>,
  stopWhen?: (state: ExpandedWebState) => boolean,
): Promise<WebSurfaceExpansion> {
  const initial = await restoreBase();
  const initialIdentity = webSemanticStateIdentity(initial);
  if (initialIdentity === null) {
    return { states: [], complete: false, reason: "unobservable" };
  }

  const states: ExpandedWebState[] = [{
    snapshot: initial,
    relativePath: [],
    exactPath: [...baseSequence],
    focused: descriptorFromFocused(initial),
  }];
  if (stopWhen?.(states[0] as ExpandedWebState) === true) {
    return { states, complete: false, reason: "target-found" };
  }
  const seen = new Set([initialIdentity]);
  let cursor = 0;
  let depthLimited = false;
  let unobservableTransition = false;

  while (cursor < states.length) {
    const source = states[cursor];
    cursor += 1;
    if (source === undefined) break;
    if (source.relativePath.length >= session.budgets.maxLocalDepth) {
      depthLimited = true;
      continue;
    }

    for (const direction of DIRECTION_KEYS) {
      await restoreBase();
      for (const key of source.relativePath) {
        const replay = await session.press(key, "discovery");
        if (replay.outcome !== "applied") {
          throw new WebPackStop("restoration-failed", "A retained local route could not be restored.");
        }
      }
      const action = await session.press(direction, "discovery");
      if (action.outcome !== "applied") {
        unobservableTransition = true;
        continue;
      }
      const snapshot = await session.snapshot();
      const identity = webSemanticStateIdentity(snapshot);
      if (identity === null) {
        unobservableTransition = true;
        continue;
      }
      if (seen.has(identity)) continue;
      if (states.length >= session.budgets.maxLocalStates) {
        return { states, complete: false, reason: "max-local-states" };
      }
      seen.add(identity);
      const relativePath = [...source.relativePath, direction];
      const retained: ExpandedWebState = {
        snapshot,
        relativePath,
        exactPath: [...baseSequence, ...relativePath],
        focused: descriptorFromFocused(snapshot),
      };
      states.push(retained);
      if (stopWhen?.(retained) === true) {
        return { states, complete: false, reason: "target-found" };
      }
    }
  }

  return {
    states,
    complete: !depthLimited && !unobservableTransition,
    reason: depthLimited ? "max-local-depth" : unobservableTransition ? "unobservable" : "complete",
  };
}

export function safeErrorMessage(error: unknown): string {
  return boundedMessage(error);
}
