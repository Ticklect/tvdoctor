import {
  compileIssueReplay,
  createCanonicalSemanticIdentity,
  createSemanticIssueId,
  executeReplay,
  type SemanticIdentityValue,
} from "@tvdoctor/core";
import type {
  ActionResult,
  Capability,
  RemoteKey,
  RemotePressStep,
  ResetStrategy,
  StateSnapshot,
  TVDoctorDriver,
  TVDoctorIssue,
  UiNodeSnapshot,
} from "@tvdoctor/protocol";
import {
  activeSurfaceEntries,
  describeStreamingElement,
  focusedCandidate,
  focusedEntry,
  isPlayerSettingsSurface,
  isInteractiveNode,
  isSafeStreamingCandidate,
  nodeMatchesStreamingDescriptor,
  normaliseSemanticText,
  playbackProgressObservation,
  rankSemanticCandidates,
  selectedCaptionTrack,
  semanticContext,
  semanticElementLabel,
  semanticStateIdentity,
  uniqueDescriptorEntry,
  type RankedSemanticCandidate,
  type StreamingSemanticTarget,
} from "./semantics.js";
import {
  DEFAULT_STREAMING_PACK_BUDGETS,
  STREAMING_STAGE_NAMES,
  type AppearanceControlResult,
  type StreamingElementDescriptor,
  type StreamingPackBudgets,
  type StreamingPackOptions,
  type StreamingPackResult,
  type StreamingPackStatistics,
  type StreamingPackTerminationReason,
  type StreamingPointerProbeRequest,
  type StreamingPointerProbeRecord,
  type StreamingPointerProbeResult,
  type StreamingReplayResult,
  type StreamingStageName,
  type StreamingStageResult,
} from "./types.js";

const DIRECTIONAL_KEYS: readonly RemoteKey[] = ["UP", "RIGHT", "DOWN", "LEFT"];

type ActionKind = "discovery" | "probe" | "replay";

interface SelectCheckpoint {
  readonly descriptor: StreamingElementDescriptor;
  readonly stateIdentity: string;
}

interface SearchResult {
  readonly status: "found" | "not-found";
  readonly sequence: readonly RemoteKey[];
  readonly snapshot: StateSnapshot;
  readonly candidate: RankedSemanticCandidate | null;
  readonly complete: boolean;
  readonly reason: "complete" | "max-local-depth" | "max-local-states";
  readonly detail: string;
}

interface ExpandedState {
  readonly path: readonly RemoteKey[];
  readonly snapshot: StateSnapshot;
  readonly focused: StreamingElementDescriptor | null;
}

interface ExpansionResult {
  readonly states: readonly ExpandedState[];
  readonly complete: boolean;
  readonly reason: "complete" | "focus-unobservable" | "max-local-depth" | "max-local-states";
  readonly expandedStates: number;
}

class PackStop extends Error {
  readonly reason: StreamingPackTerminationReason;

  constructor(
    reason: StreamingPackTerminationReason,
    message: string,
  ) {
    super(message);
    this.name = "PackStop";
    this.reason = reason;
  }
}

class JourneyStop extends Error {
  readonly reason: "journey-partial" | "max-local-depth" | "max-local-states";

  constructor(
    message: string,
    reason: "journey-partial" | "max-local-depth" | "max-local-states" = "journey-partial",
  ) {
    super(message);
    this.name = "JourneyStop";
    this.reason = reason;
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

function normaliseBudgets(overrides: Partial<StreamingPackBudgets> | undefined): StreamingPackBudgets {
  const values = { ...DEFAULT_STREAMING_PACK_BUDGETS, ...overrides };
  return {
    maxActions: positiveInteger(values.maxActions, "maxActions"),
    maxStates: positiveInteger(values.maxStates, "maxStates"),
    maxLocalDepth: nonNegativeInteger(values.maxLocalDepth, "maxLocalDepth"),
    maxLocalStates: positiveInteger(values.maxLocalStates, "maxLocalStates"),
    maxDurationMs: positiveInteger(values.maxDurationMs, "maxDurationMs"),
  };
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class StreamingSession {
  private readonly driver: TVDoctorDriver;
  readonly budgets: StreamingPackBudgets;
  private readonly resetStrategy: ResetStrategy;
  private readonly restoreInitialState: (() => Promise<void>) | undefined;
  private readonly monotonicNow: () => number;
  private physicalActions = 0;
  private discoveryActions = 0;
  private probeActions = 0;
  private replayActions = 0;
  private resets = 0;
  private snapshots = 0;
  private pointerProbes = 0;
  private readonly uniqueStates = new Set<string>();
  private readonly selectCheckpoints = new Map<string, SelectCheckpoint>();
  private readonly startedAtMs: number;

  constructor(
    driver: TVDoctorDriver,
    budgets: StreamingPackBudgets,
    resetStrategy: ResetStrategy,
    restoreInitialState: (() => Promise<void>) | undefined,
    monotonicNow: () => number,
  ) {
    this.driver = driver;
    this.budgets = budgets;
    this.resetStrategy = resetStrategy;
    this.restoreInitialState = restoreInitialState;
    this.monotonicNow = monotonicNow;
    const startedAtMs = monotonicNow();
    if (!Number.isFinite(startedAtMs)) throw new TypeError("monotonicNow must return a finite number.");
    this.startedAtMs = startedAtMs;
  }

  now = (): number => {
    const value = this.monotonicNow();
    if (!Number.isFinite(value)) throw new PackStop("driver-error", "The monotonic clock returned a non-finite value.");
    return value;
  };

  elapsed(): number {
    return Math.max(0, this.now() - this.startedAtMs);
  }

  remainingActions(): number {
    return Math.max(0, this.budgets.maxActions - this.physicalActions);
  }

  remainingDuration(): number {
    return Math.max(0, this.budgets.maxDurationMs - this.elapsed());
  }

  async operation<T>(operation: () => Promise<T>): Promise<T> {
    const remainingMs = this.remainingDuration();
    if (remainingMs <= 0) throw new PackStop("max-duration", "The streaming pack duration budget was exhausted.");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const operationResult = operation().then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    const timeoutResult = new Promise<{ readonly status: "timed-out" }>((resolve) => {
      timeout = setTimeout(() => resolve({ status: "timed-out" }), remainingMs);
    });
    const result = await Promise.race([operationResult, timeoutResult]);
    if (timeout !== undefined) clearTimeout(timeout);
    if (result.status === "timed-out") {
      throw new PackStop("max-duration", "The streaming pack duration budget was exhausted during a driver operation.");
    }
    if (result.status === "rejected") throw result.error;
    return result.value;
  }

  async capabilities(): Promise<ReadonlySet<Capability>> {
    try {
      return await this.operation(() => this.driver.capabilities());
    } catch (error) {
      if (error instanceof PackStop) throw error;
      throw new PackStop("driver-error", `Driver capabilities failed: ${safeErrorMessage(error)}`);
    }
  }

  async snapshot(): Promise<StateSnapshot> {
    try {
      const snapshot = await this.operation(() => this.driver.snapshot());
      this.snapshots += 1;
      const identity = semanticStateIdentity(snapshot);
      if (identity !== null) {
        if (!this.uniqueStates.has(identity) && this.uniqueStates.size >= this.budgets.maxStates) {
          throw new PackStop("max-states", "The streaming pack global state budget was exhausted.");
        }
        this.uniqueStates.add(identity);
      }
      return snapshot;
    } catch (error) {
      if (error instanceof PackStop) throw error;
      throw new PackStop("driver-error", `Driver snapshot failed: ${safeErrorMessage(error)}`);
    }
  }

  async restore(): Promise<void> {
    const restore = this.restoreInitialState ?? (this.driver.reset === undefined
      ? undefined
      : async () => this.driver.reset?.(this.resetStrategy));
    if (restore === undefined) {
      throw new PackStop("restoration-unavailable", "The driver has no reset method and no restoration hook was supplied.");
    }
    try {
      await this.operation(restore);
      this.resets += 1;
    } catch (error) {
      if (error instanceof PackStop) throw error;
      throw new PackStop("restoration-failed", `Root restoration failed: ${safeErrorMessage(error)}`);
    }
  }

  private checkpointKey(sequence: readonly RemoteKey[]): string {
    return sequence.join("\u001f");
  }

  private validateSafeCheckpoint(
    snapshot: StateSnapshot,
    checkpoint: SelectCheckpoint,
  ): void {
    const entry = uniqueDescriptorEntry(snapshot, checkpoint.descriptor);
    const focused = focusedEntry(snapshot);
    const identity = semanticStateIdentity(snapshot);
    if (
      entry === null
      || focused === null
      || entry.node !== focused.node
      || !isSafeStreamingCandidate(entry.node, semanticContext(entry))
      || identity === null
      || identity !== checkpoint.stateIdentity
    ) {
      throw new PackStop(
        "replay-diverged",
        "A semantic SELECT checkpoint drifted; activation was withheld before any unsafe action could fire.",
      );
    }
  }

  async activate(
    sequenceBeforeSelect: readonly RemoteKey[],
    descriptor: StreamingElementDescriptor,
    kind: ActionKind,
  ): Promise<ActionResult> {
    const snapshot = await this.snapshot();
    const entry = uniqueDescriptorEntry(snapshot, descriptor);
    const focused = focusedEntry(snapshot);
    const identity = semanticStateIdentity(snapshot);
    if (
      entry === null
      || focused === null
      || entry.node !== focused.node
      || !isSafeStreamingCandidate(entry.node, semanticContext(entry))
      || identity === null
    ) {
      throw new PackStop(
        "replay-diverged",
        `The intended safe semantic target was not uniquely focused; SELECT was withheld (target=${entry === null ? "unresolved" : "resolved"}, focus=${focused === null ? "unresolved" : "resolved"}, same=${String(entry !== null && focused !== null && entry.node === focused.node)}, safe=${String(entry !== null && isSafeStreamingCandidate(entry.node, semanticContext(entry)))}, state=${identity === null ? "unobservable" : "observable"}).`,
      );
    }
    const checkpointKey = this.checkpointKey(sequenceBeforeSelect);
    const checkpoint = { descriptor: describeStreamingElement(entry.node), stateIdentity: identity };
    const existing = this.selectCheckpoints.get(checkpointKey);
    if (existing !== undefined && (
      existing.stateIdentity !== checkpoint.stateIdentity
      || !nodeMatchesStreamingDescriptor(entry.node, existing.descriptor)
    )) {
      throw new PackStop(
        "replay-diverged",
        "A reset-relative SELECT path resolved to conflicting semantic targets; SELECT was withheld.",
      );
    }
    this.selectCheckpoints.set(checkpointKey, checkpoint);
    return this.press("SELECT", kind, true);
  }

  async press(
    key: RemoteKey,
    kind: ActionKind,
    selectAuthorised = false,
  ): Promise<ActionResult> {
    if (key === "SELECT" && !selectAuthorised) {
      throw new PackStop(
        "replay-diverged",
        "SELECT requires a freshly validated safe semantic checkpoint.",
      );
    }
    if (this.physicalActions >= this.budgets.maxActions) {
      throw new PackStop("max-actions", "The streaming pack physical-input budget was exhausted.");
    }
    this.physicalActions += 1;
    if (kind === "discovery") this.discoveryActions += 1;
    if (kind === "probe") this.probeActions += 1;
    if (kind === "replay") this.replayActions += 1;
    let result: ActionResult;
    try {
      result = await this.operation(() => this.driver.press(key));
    } catch (error) {
      if (error instanceof PackStop) throw error;
      throw new PackStop("driver-error", `Remote input ${key} failed: ${safeErrorMessage(error)}`);
    }
    if (result.key !== key || result.outcome !== "applied") {
      throw new PackStop(
        "replay-diverged",
        `Remote input ${key} returned ${result.key}/${result.outcome}; deterministic traversal cannot continue.`,
      );
    }
    return result;
  }

  async restoreAndReplay(
    sequence: readonly RemoteKey[],
    kind: ActionKind,
  ): Promise<StateSnapshot> {
    await this.restore();
    const travelled: RemoteKey[] = [];
    for (const key of sequence) {
      if (key === "SELECT") {
        const checkpoint = this.selectCheckpoints.get(this.checkpointKey(travelled));
        if (checkpoint === undefined) {
          throw new PackStop(
            "replay-diverged",
            "A replayed SELECT had no trusted semantic checkpoint; activation was withheld.",
          );
        }
        this.validateSafeCheckpoint(await this.snapshot(), checkpoint);
        await this.press(key, kind, true);
      } else {
        await this.press(key, kind);
      }
      travelled.push(key);
    }
    return this.snapshot();
  }

  recordPointerProbe(): void {
    this.pointerProbes += 1;
  }

  replayDriver(): TVDoctorDriver {
    const travelled: RemoteKey[] = [];
    return {
      capabilities: async () => this.capabilities(),
      press: async (key) => {
        if (key === "SELECT") {
          const checkpoint = this.selectCheckpoints.get(this.checkpointKey(travelled));
          if (checkpoint === undefined) {
            throw new PackStop(
              "replay-diverged",
              "A replayed SELECT had no trusted semantic checkpoint; activation was withheld.",
            );
          }
          this.validateSafeCheckpoint(await this.snapshot(), checkpoint);
        }
        const result = await this.press(key, "replay", key === "SELECT");
        travelled.push(key);
        return result;
      },
      snapshot: async () => this.snapshot(),
      reset: async () => {
        travelled.splice(0);
        await this.restore();
      },
    };
  }

  statistics(): StreamingPackStatistics {
    return {
      physicalActions: this.physicalActions,
      discoveryActions: this.discoveryActions,
      probeActions: this.probeActions,
      replayActions: this.replayActions,
      resets: this.resets,
      snapshots: this.snapshots,
      uniqueStates: this.uniqueStates.size,
      pointerProbes: this.pointerProbes,
      elapsedMs: this.elapsed(),
    };
  }
}

function focusDescriptor(snapshot: StateSnapshot): StreamingElementDescriptor | null {
  const entry = focusedEntry(snapshot);
  return entry === null ? null : describeStreamingElement(entry.node);
}

function targetDirectionOrder(
  snapshot: StateSnapshot,
  target: RankedSemanticCandidate | undefined,
): readonly RemoteKey[] {
  const focused = focusedEntry(snapshot)?.node.bounds;
  const desired = target?.node.bounds;
  if (focused === null || focused === undefined || desired === null || desired === undefined) {
    return DIRECTIONAL_KEYS;
  }
  const horizontal = desired.x + desired.width / 2 - (focused.x + focused.width / 2);
  const vertical = desired.y + desired.height / 2 - (focused.y + focused.height / 2);
  const primary: RemoteKey = Math.abs(horizontal) >= Math.abs(vertical)
    ? horizontal >= 0 ? "RIGHT" : "LEFT"
    : vertical >= 0 ? "DOWN" : "UP";
  return [primary, ...DIRECTIONAL_KEYS.filter((key) => key !== primary)];
}

async function findSemanticTarget(
  session: StreamingSession,
  prefix: readonly RemoteKey[],
  target: StreamingSemanticTarget,
): Promise<SearchResult> {
  const queue: RemoteKey[][] = [[]];
  const visited = new Set<string>();
  let index = 0;
  let depthLimited = false;
  let expandedStates = 0;
  let lastSnapshot = await session.restoreAndReplay(prefix, "discovery");
  let visibleCandidate = rankSemanticCandidates(lastSnapshot, target)[0] ?? null;

  while (index < queue.length) {
    const suffix = queue[index];
    index += 1;
    if (suffix === undefined) break;
    const snapshot = suffix.length === 0
      ? lastSnapshot
      : await session.restoreAndReplay([...prefix, ...suffix], "discovery");
    lastSnapshot = snapshot;
    const rankedCandidates = rankSemanticCandidates(snapshot, target);
    visibleCandidate ??= rankedCandidates[0] ?? null;
    const identity = semanticStateIdentity(snapshot) ?? `unobservable:${String(index)}`;
    if (visited.has(identity)) continue;
    visited.add(identity);
    const focused = focusedCandidate(snapshot, target);
    if (focused !== null) {
      return {
        status: "found",
        sequence: [...prefix, ...suffix],
        snapshot,
        candidate: focused,
        complete: true,
        reason: "complete",
        detail: `A safe ${target} control was reached using semantic D-pad discovery.`,
      };
    }
    if (suffix.length >= session.budgets.maxLocalDepth) {
      depthLimited = true;
      continue;
    }
    if (expandedStates >= session.budgets.maxLocalStates) {
      return {
        status: "not-found",
        sequence: prefix,
        snapshot,
        candidate: visibleCandidate,
        complete: false,
        reason: "max-local-states",
        detail: `The ${target} search expanded exactly ${String(expandedStates)} unique states and reached its local-state budget.`,
      };
    }
    expandedStates += 1;
    const order = targetDirectionOrder(snapshot, visibleCandidate ?? undefined);
    for (const key of order) queue.push([...suffix, key]);
  }
  return {
    status: "not-found",
    sequence: prefix,
    snapshot: lastSnapshot,
    candidate: visibleCandidate,
    complete: !depthLimited,
    reason: depthLimited ? "max-local-depth" : "complete",
    detail: depthLimited
      ? `The ${target} search reached its local-depth budget.`
      : `No reachable safe ${target} control was found after bounded local expansion.`,
  };
}

async function findExactTarget(
  session: StreamingSession,
  prefix: readonly RemoteKey[],
  descriptor: StreamingElementDescriptor,
): Promise<SearchResult> {
  const queue: RemoteKey[][] = [[]];
  const visited = new Set<string>();
  let index = 0;
  let depthLimited = false;
  let expandedStates = 0;
  let lastSnapshot = await session.restoreAndReplay(prefix, "probe");

  while (index < queue.length) {
    const suffix = queue[index];
    index += 1;
    if (suffix === undefined) break;
    const snapshot = suffix.length === 0
      ? lastSnapshot
      : await session.restoreAndReplay([...prefix, ...suffix], "probe");
    lastSnapshot = snapshot;
    const identity = semanticStateIdentity(snapshot) ?? `unobservable:${String(index)}`;
    if (visited.has(identity)) continue;
    visited.add(identity);
    const entry = uniqueDescriptorEntry(snapshot, descriptor);
    const focused = focusedEntry(snapshot);
    if (entry !== null && focused !== null && entry.node === focused.node) {
      return {
        status: "found",
        sequence: [...prefix, ...suffix],
        snapshot,
        candidate: {
          ...entry,
          score: 0,
          descriptor: describeStreamingElement(entry.node),
        },
        complete: true,
        reason: "complete",
        detail: "The exact previously observed control was restored by local D-pad discovery.",
      };
    }
    if (suffix.length >= session.budgets.maxLocalDepth) {
      depthLimited = true;
      continue;
    }
    if (expandedStates >= session.budgets.maxLocalStates) {
      return {
        status: "not-found",
        sequence: prefix,
        snapshot,
        candidate: null,
        complete: false,
        reason: "max-local-states",
        detail: `Exact-control restoration expanded exactly ${String(expandedStates)} unique states and reached its local-state budget.`,
      };
    }
    expandedStates += 1;
    for (const key of DIRECTIONAL_KEYS) queue.push([...suffix, key]);
  }
  return {
    status: "not-found",
    sequence: prefix,
    snapshot: lastSnapshot,
    candidate: null,
    complete: !depthLimited,
    reason: depthLimited ? "max-local-depth" : "complete",
    detail: depthLimited
      ? "Exact-control restoration reached its local-depth budget."
      : "The exact previously observed control was not remotely reachable.",
  };
}

async function expandSurface(
  session: StreamingSession,
  prefix: readonly RemoteKey[],
): Promise<ExpansionResult> {
  const queue: RemoteKey[][] = [[]];
  const visited = new Set<string>();
  const states: ExpandedState[] = [];
  let index = 0;
  let depthLimited = false;
  let expandedStates = 0;

  while (index < queue.length) {
    const suffix = queue[index];
    index += 1;
    if (suffix === undefined) break;
    const snapshot = await session.restoreAndReplay([...prefix, ...suffix], "discovery");
    const identity = semanticStateIdentity(snapshot) ?? `unobservable:${String(index)}`;
    if (visited.has(identity)) continue;
    visited.add(identity);
    const focused = focusDescriptor(snapshot);
    states.push({
      path: [...prefix, ...suffix],
      snapshot,
      focused,
    });
    if (focused === null) {
      return { states, complete: false, reason: "focus-unobservable", expandedStates };
    }
    if (suffix.length >= session.budgets.maxLocalDepth) {
      depthLimited = true;
      continue;
    }
    if (expandedStates >= session.budgets.maxLocalStates) {
      return { states, complete: false, reason: "max-local-states", expandedStates };
    }
    expandedStates += 1;
    for (const key of DIRECTIONAL_KEYS) queue.push([...suffix, key]);
  }
  return {
    states,
    complete: !depthLimited,
    reason: depthLimited ? "max-local-depth" : "complete",
    expandedStates,
  };
}

function nodeMatchesDescriptor(node: UiNodeSnapshot, descriptor: StreamingElementDescriptor): boolean {
  return nodeMatchesStreamingDescriptor(node, descriptor);
}

function descriptorFromSnapshot(
  snapshot: StateSnapshot,
  descriptor: StreamingElementDescriptor,
): StreamingElementDescriptor | null {
  const entry = uniqueDescriptorEntry(snapshot, descriptor);
  return entry === null ? null : describeStreamingElement(entry.node);
}

function compressSequence(sequence: readonly RemoteKey[]): readonly RemotePressStep[] {
  const result: { key: RemoteKey; repeat: number }[] = [];
  for (const key of sequence) {
    const previous = result.at(-1);
    if (previous?.key === key) previous.repeat += 1;
    else result.push({ key, repeat: 1 });
  }
  return result;
}

function semanticDescriptorIdentity(
  descriptor: StreamingElementDescriptor,
): SemanticIdentityValue {
  return {
    stableId: normaliseSemanticText(descriptor.stableId) || null,
    role: normaliseSemanticText(descriptor.role) || null,
    name: normaliseSemanticText(descriptor.name) || null,
  };
}

function issueId(
  rule: string,
  journey: string,
  meaning: SemanticIdentityValue,
): string {
  const identity = createCanonicalSemanticIdentity([
    ["version", 2],
    ["rule", rule],
    ["pack", "streaming"],
    ["journey", journey],
    ["meaning", meaning],
  ]);
  return createSemanticIssueId("STREAM", identity);
}

function evidence(
  kind: TVDoctorIssue["evidence"][number]["kind"],
  summary: string,
): TVDoctorIssue["evidence"][number] {
  return { kind, summary, source: "streaming-pack", artifact: null };
}

function unavailableReproduction(reason: string): TVDoctorIssue["reproduction"] {
  return { status: "unavailable", reason };
}

function rewindIssue(
  path: readonly RemoteKey[],
  target: StreamingElementDescriptor,
  before: number,
  after: number,
): TVDoctorIssue {
  const label = semanticElementLabel(target);
  return {
    id: issueId("streaming.player-control", "player.seek-backward.inverted", {
      surface: "player",
      target: semanticDescriptorIdentity(target),
      transition: { action: "SELECT", outcome: "playback-position-increased" },
    }),
    rule: "streaming.player-control",
    title: "Rewind moved playback forwards",
    description: "Selecting the semantically identified rewind control increased the observed player position.",
    severity: "medium",
    confidence: "deterministic",
    pack: "streaming",
    screen: "Player",
    expected: `Playback position lower than ${String(before)}.`,
    observed: `Playback position changed from ${String(before)} to ${String(after)}.`,
    transition: {
      fromElement: label,
      action: "SELECT",
      expectedElement: label,
      observedElement: label,
    },
    evidence: [
      evidence("verified-fact", `Progress valueNow was ${String(before)} before SELECT.`),
      evidence("deterministic-failure", `Progress valueNow was ${String(after)} after SELECT.`),
      evidence("verified-fact", `Exact reset-relative remote sequence: ${path.join(" ")}.`),
    ],
    reproduction: unavailableReproduction(
      "Replay V1 can assert focus transitions but cannot assert numeric player position; emitting a focus-only replay would be misleading.",
    ),
  };
}

function captionsIssue(
  path: readonly RemoteKey[],
  target: StreamingElementDescriptor,
  original: StreamingElementDescriptor,
): TVDoctorIssue {
  const label = semanticElementLabel(target);
  return {
    id: issueId("streaming.captions", "captions.track-selection.ignored", {
      surface: "player-settings-captions",
      original: semanticDescriptorIdentity(original),
      target: semanticDescriptorIdentity(target),
      transition: { action: "SELECT", outcome: "selection-unchanged" },
    }),
    rule: "streaming.captions",
    title: "Caption track selection was ignored",
    description: "Selecting an unselected caption track left the original track selected.",
    severity: "high",
    confidence: "deterministic",
    pack: "streaming",
    screen: "Player > Settings > Captions",
    expected: "The selected caption track becomes on and the previous track becomes off.",
    observed: `${target.name ?? "Candidate track"} remained off while ${original.name ?? "the original track"} remained on.`,
    transition: {
      fromElement: label,
      action: "SELECT",
      expectedElement: label,
      observedElement: label,
    },
    evidence: [
      evidence("verified-fact", "The candidate track selectionState was off before SELECT."),
      evidence("deterministic-failure", "After SELECT, the candidate remained off and the original track remained on."),
      evidence("verified-fact", `Exact reset-relative remote sequence: ${path.join(" ")}.`),
    ],
    reproduction: unavailableReproduction(
      "Replay V1 cannot assert selectionState; a focus-only replay would not prove whether the caption track changed.",
    ),
  };
}

function textColourIssue(
  sequence: readonly RemoteKey[],
  source: StreamingElementDescriptor,
  target: StreamingElementDescriptor,
  observed: StreamingElementDescriptor,
  pointer: Extract<StreamingPointerProbeResult, { readonly status: "reachable" }>,
  resetStrategy: ResetStrategy,
): TVDoctorIssue {
  const fromLabel = semanticElementLabel(source);
  const expectedLabel = semanticElementLabel(target);
  const observedLabel = semanticElementLabel(observed);
  return {
    id: issueId("remote.reachability", "captions.appearance.text-colour.remote-unreachable", {
      surface: "player-settings-captions-appearance",
      target: semanticDescriptorIdentity(target),
      transition: { actionKind: "directional-focus", outcome: "target-unreachable" },
    }),
    rule: "remote.reachability",
    title: "Caption Text Colour is unreachable by remote",
    description: "Text Colour was visible, enabled, and pointer reachable, but complete bounded local D-pad expansion could not focus it.",
    severity: "high",
    confidence: "deterministic",
    pack: "streaming",
    screen: "Player > Settings > Captions > Appearance",
    expected: `${expectedLabel ?? "Text Colour"} receives focus from ${fromLabel ?? "the adjacent control"}.`,
    observed: `${observedLabel ?? "A different control"} received focus instead.`,
    transition: {
      fromElement: fromLabel,
      action: sequence.at(-1) ?? "DOWN",
      expectedElement: expectedLabel,
      observedElement: observedLabel,
    },
    evidence: [
      evidence("verified-fact", "Text Colour was visible and enabled in the active Appearance UI tree."),
      evidence("deterministic-failure", "Every discovered local D-pad focus state was expanded without reaching Text Colour."),
      evidence("deterministic-failure", `${fromLabel ?? "Adjacent control"} --${sequence.at(-1) ?? "DOWN"}--> ${observedLabel ?? "different control"}.`),
      evidence("verified-fact", `Exact reset-relative remote sequence: ${sequence.join(" ")}.`),
      evidence("verified-fact", `An isolated platform pointer probe reached the control: ${pointer.detail}`),
      evidence(
        "verified-fact",
        `Pointer activation changed ${pointer.observedChange.property} from ${pointer.observedChange.before ?? "absent"} to ${pointer.observedChange.after}.`,
      ),
    ],
    reproduction: {
      status: "available",
      resetStrategy,
      originalSequence: compressSequence(sequence),
      minimizedSequence: null,
      confidence: "deterministic",
      artifact: null,
    },
  };
}

function volumePointerOnlyIssue(
  target: StreamingElementDescriptor,
  pointer: Extract<StreamingPointerProbeResult, { readonly status: "reachable" }>,
  resetStrategy: ResetStrategy,
  witness: {
    readonly sequence: readonly RemoteKey[];
    readonly source: StreamingElementDescriptor;
    readonly observed: StreamingElementDescriptor;
  } | null,
): TVDoctorIssue {
  const targetLabel = semanticElementLabel(target);
  const sourceLabel = semanticElementLabel(witness?.source ?? null);
  const observedLabel = semanticElementLabel(witness?.observed ?? null);
  const reproduction: TVDoctorIssue["reproduction"] = witness === null
    ? unavailableReproduction(
      "Complete remote expansion and isolated pointer activation proved the pointer-only control, but no concrete adjacent D-pad transition was observable for a truthful focus replay.",
    )
    : {
      status: "available",
      resetStrategy,
      originalSequence: compressSequence(witness.sequence),
      minimizedSequence: null,
      confidence: "deterministic",
      artifact: null,
    };
  return {
    id: issueId("accessibility.pointer-only-control", "player.volume.pointer-only", {
      surface: "player-controls",
      target: semanticDescriptorIdentity(target),
      transition: { actionKind: "directional-focus", outcome: "target-unreachable" },
    }),
    rule: "accessibility.pointer-only-control",
    title: "Player volume control is pointer-only",
    description: "A semantic player volume control was pointer reachable and changed through an isolated pointer activation, but was remote unreachable in every state from a complete bounded D-pad expansion.",
    severity: "medium",
    confidence: "deterministic",
    pack: "streaming",
    screen: "Player",
    expected: witness === null
      ? `${targetLabel ?? "The player volume control"} is reachable with the remote.`
      : `${targetLabel ?? "The player volume control"} receives focus from ${sourceLabel ?? "the adjacent player control"}.`,
    observed: witness === null
      ? "No reset-relative D-pad path focused the control."
      : `${observedLabel ?? "A different player control"} received focus instead.`,
    transition: witness === null ? null : {
      fromElement: sourceLabel,
      action: witness.sequence.at(-1) ?? "RIGHT",
      expectedElement: targetLabel,
      observedElement: observedLabel,
    },
    evidence: [
      evidence("verified-fact", "The control was visible, enabled, interactive, and semantically associated with the player controls."),
      evidence("deterministic-failure", "Complete bounded local D-pad expansion did not focus the volume control."),
      evidence(
        "verified-fact",
        `An isolated pointer activation changed ${pointer.observedChange.property} from ${pointer.observedChange.before ?? "absent"} to ${pointer.observedChange.after}.`,
      ),
      ...(witness === null ? [] : [
        evidence("deterministic-failure", `${sourceLabel ?? "Adjacent player control"} --${witness.sequence.at(-1) ?? "RIGHT"}--> ${observedLabel ?? "different control"}.`),
        evidence("verified-fact", `Exact reset-relative remote sequence: ${witness.sequence.join(" ")}.`),
      ]),
    ],
    reproduction,
  };
}

function findWitnessSource(
  target: StreamingElementDescriptor,
  states: readonly ExpandedState[],
): { readonly source: ExpandedState; readonly action: RemoteKey } | null {
  if (target.bounds === null) return null;
  const targetCenterX = target.bounds.x + target.bounds.width / 2;
  const targetCenterY = target.bounds.y + target.bounds.height / 2;
  const candidates = states
    .map((state) => ({ state, bounds: state.focused?.bounds }))
    .filter((value): value is { readonly state: ExpandedState; readonly bounds: NonNullable<StreamingElementDescriptor["bounds"]> } => value.bounds !== null)
    .map(({ state, bounds }) => {
      const sourceX = bounds.x + bounds.width / 2;
      const sourceY = bounds.y + bounds.height / 2;
      const deltaX = targetCenterX - sourceX;
      const deltaY = targetCenterY - sourceY;
      const horizontal = Math.abs(deltaX) >= Math.abs(deltaY);
      const action: RemoteKey = horizontal
        ? deltaX >= 0 ? "RIGHT" : "LEFT"
        : deltaY >= 0 ? "DOWN" : "UP";
      return {
        state,
        action,
        primaryDistance: horizontal ? Math.abs(deltaX) : Math.abs(deltaY),
        crossDistance: horizontal ? Math.abs(deltaY) : Math.abs(deltaX),
      };
    })
    .filter((candidate) => candidate.primaryDistance > 0)
    .sort((left, right) => (
      left.primaryDistance - right.primaryDistance
      || left.crossDistance - right.crossDistance
      || left.state.path.length - right.state.path.length
      || left.state.path.join(" ").localeCompare(right.state.path.join(" "), "en")
    ));
  const closest = candidates[0];
  return closest === undefined ? null : { source: closest.state, action: closest.action };
}

function addSkippedStages(stages: StreamingStageResult[]): void {
  const existing = new Set(stages.map((stage) => stage.stage));
  for (const stage of STREAMING_STAGE_NAMES) {
    if (!existing.has(stage)) {
      stages.push({
        stage,
        status: "skipped",
        detail: "A prior required semantic stage could not be completed.",
        sequence: [],
        target: null,
      });
    }
  }
}

async function replayIssue(
  session: StreamingSession,
  issue: TVDoctorIssue,
): Promise<StreamingReplayResult> {
  const compiled = compileIssueReplay(issue);
  if (compiled.status !== "compiled") {
    return {
      issueId: issue.id,
      status: "unavailable",
      reason: { message: compiled.reason.message },
      actionsPressed: 0,
    };
  }
  if (compiled.plan.totalActions > session.remainingActions()) {
    return {
      issueId: issue.id,
      status: "unavailable",
      reason: { message: "The global streaming-pack action budget had insufficient room for replay." },
      actionsPressed: 0,
    };
  }
  const result = await executeReplay(session.replayDriver(), compiled.plan, {
    budgets: {
      maxActions: session.remainingActions(),
      maxDurationMs: Math.max(1, Math.floor(session.remainingDuration())),
    },
    now: session.now,
  });
  return {
    issueId: issue.id,
    status: result.status,
    reason: result.reason,
    actionsPressed: result.actionsPressed,
  };
}

const MAX_POINTER_PROPERTY_LENGTH = 120;
const MAX_POINTER_VALUE_LENGTH = 500;
const MAX_POINTER_DETAIL_LENGTH = 1_000;

function boundedPointerText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string" || value.length > maximum) return null;
  let sanitised = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    sanitised += codePoint !== undefined && (
      codePoint <= 0x08
      || codePoint === 0x0b
      || codePoint === 0x0c
      || (codePoint >= 0x0e && codePoint <= 0x1f)
      || codePoint === 0x7f
    ) ? " " : character;
  }
  const bounded = sanitised.trim();
  return bounded.length > 0 && bounded.length <= maximum ? bounded : null;
}

function normalisePointerProbeResult(value: unknown): StreamingPointerProbeResult {
  if (typeof value !== "object" || value === null) {
    return { status: "error", detail: "The pointer hook returned a malformed result." };
  }
  const candidate = value as Record<string, unknown>;
  const detail = boundedPointerText(candidate["detail"], MAX_POINTER_DETAIL_LENGTH);
  if (detail === null) {
    return { status: "error", detail: "The pointer hook returned an invalid or oversized detail." };
  }
  if (
    candidate["status"] === "unreachable"
    || candidate["status"] === "unobservable"
    || candidate["status"] === "error"
  ) {
    return { status: candidate["status"], detail };
  }
  if (candidate["status"] !== "reachable") {
    return { status: "error", detail: "The pointer hook returned an unknown status." };
  }
  const observed = candidate["observedChange"];
  if (typeof observed !== "object" || observed === null) {
    return { status: "error", detail: "Pointer reachability lacked structured observed-change evidence." };
  }
  const change = observed as Record<string, unknown>;
  const property = boundedPointerText(change["property"], MAX_POINTER_PROPERTY_LENGTH);
  const rawBefore = change["before"];
  const before = rawBefore === null
    ? null
    : boundedPointerText(rawBefore, MAX_POINTER_VALUE_LENGTH);
  const after = boundedPointerText(change["after"], MAX_POINTER_VALUE_LENGTH);
  if (property === null || (rawBefore !== null && before === null) || after === null || before === after) {
    return {
      status: "error",
      detail: "Pointer reachability did not contain a bounded, observable before/after change.",
    };
  }
  return {
    status: "reachable",
    detail,
    observedChange: { property, before, after },
  };
}

async function runIsolatedPointerProbe(
  session: StreamingSession,
  probe: NonNullable<StreamingPackOptions["pointerProbe"]>,
  request: StreamingPointerProbeRequest,
  records: StreamingPointerProbeRecord[],
): Promise<StreamingPointerProbeResult> {
  const beforeIdentity = semanticStateIdentity(request.snapshot);
  let result: StreamingPointerProbeResult;
  session.recordPointerProbe();
  try {
    result = normalisePointerProbeResult(await session.operation(() => probe.probe(request)));
  } catch (error) {
    result = {
      status: "error",
      detail: boundedPointerText(safeErrorMessage(error), MAX_POINTER_DETAIL_LENGTH)
        ?? "The isolated pointer hook failed.",
    };
  }

  const restored = await session.restoreAndReplay(request.surfaceSequence, "probe");
  const afterIdentity = semanticStateIdentity(restored);
  const mainSessionRestored = beforeIdentity !== null && beforeIdentity === afterIdentity;
  const restorationDetail = mainSessionRestored
    ? "The main remote session restored to the same semantic surface and uniquely correlated focus after the isolated hook."
    : "The main remote session did not restore to the pre-hook semantic surface and focus.";
  records.push({
    kind: request.kind,
    element: request.element,
    result,
    mainSessionRestored,
    restorationDetail,
  });
  if (!mainSessionRestored) {
    throw new PackStop("restoration-failed", restorationDetail);
  }
  return result;
}

function isPlayingToggle(descriptor: StreamingElementDescriptor): boolean {
  return descriptor.selectionState === "on"
    || normaliseSemanticText(descriptor.name).includes("pause");
}

function isPausedToggle(descriptor: StreamingElementDescriptor): boolean {
  return descriptor.selectionState === "off"
    || normaliseSemanticText(descriptor.name).includes("play");
}

function isSameStableControl(
  before: StreamingElementDescriptor,
  after: StreamingElementDescriptor,
): boolean {
  if (before.stableId === null || after.stableId === null || before.stableId !== after.stableId) {
    return false;
  }
  return before.role === null
    || after.role === null
    || normaliseSemanticText(before.role) === normaliseSemanticText(after.role);
}

/**
 * Runs a safe, semantic streaming journey without accepting a route or fixture
 * hints. All discovery is based on roles, names, tree context, and D-pad state.
 */
export async function runStreamingPack(
  driver: TVDoctorDriver,
  options: StreamingPackOptions = {},
): Promise<StreamingPackResult> {
  const budgets = normaliseBudgets(options.budgets);
  const session = new StreamingSession(
    driver,
    budgets,
    options.resetStrategy ?? "reload",
    options.restoreInitialState,
    options.monotonicNow ?? (() => performance.now()),
  );
  const stages: StreamingStageResult[] = [];
  const issues: TVDoctorIssue[] = [];
  const appearanceControls: AppearanceControlResult[] = [];
  const replays: StreamingReplayResult[] = [];
  const pointerProbes: StreamingPointerProbeRecord[] = [];
  let volumeControl: AppearanceControlResult | null = null;
  let journeySequence: readonly RemoteKey[] = [];

  const stage = (
    name: StreamingStageName,
    status: StreamingStageResult["status"],
    detail: string,
    sequence: readonly RemoteKey[],
    target: StreamingElementDescriptor | null = null,
  ): void => {
    stages.push({ stage: name, status, detail, sequence: [...sequence], target });
  };

  const requireTarget = async (
    prefix: readonly RemoteKey[],
    target: StreamingSemanticTarget,
    stageName: StreamingStageName,
  ): Promise<SearchResult & { readonly status: "found"; readonly candidate: RankedSemanticCandidate }> => {
    const found = await findSemanticTarget(session, prefix, target);
    if (found.status === "not-found" || found.candidate === null) {
      stage(
        stageName,
        found.candidate === null ? "unobservable" : "partial",
        found.detail,
        prefix,
        found.candidate?.descriptor ?? null,
      );
      throw new JourneyStop(
        found.detail,
        found.reason === "max-local-depth" || found.reason === "max-local-states"
          ? found.reason
          : "journey-partial",
      );
    }
    stage(stageName, "passed", found.detail, found.sequence, found.candidate.descriptor);
    return { ...found, status: "found", candidate: found.candidate };
  };

  try {
    const capabilities = await session.capabilities();
    if (!capabilities.has("remote-input")) {
      throw new PackStop("remote-input-unavailable", "The driver does not advertise remote-input capability.");
    }
    if (!capabilities.has("ui-tree")) {
      throw new PackStop("ui-tree-unavailable", "The driver does not advertise UI-tree capability.");
    }

    const homeSnapshot = await session.restoreAndReplay([], "discovery");
    if (homeSnapshot.uiTree.status === "unavailable") {
      throw new PackStop("ui-tree-unavailable", homeSnapshot.uiTree.reason);
    }
    const homeFocus = focusDescriptor(homeSnapshot);
    if (homeFocus === null) {
      stage("home", "unobservable", "The reset root did not expose one uniquely correlated stable remote focus.", []);
      throw new JourneyStop("Home focus could not be correlated safely.");
    }
    stage("home", "passed", "A reset root with an observable UI tree and uniquely correlated remote focus was established.", [], homeFocus);

    const content = await requireTarget([], "content", "content");
    await session.activate(content.sequence, content.candidate.descriptor, "discovery");
    let snapshot = await session.snapshot();
    journeySequence = [...content.sequence, "SELECT"];
    const playOnDetails = rankSemanticCandidates(snapshot, "play")[0] ?? null;
    if (playOnDetails === null) {
      stage("details", "partial", "Selecting safe content did not expose a semantic Play or Resume control.", journeySequence);
      throw new JourneyStop("Details could not be semantically confirmed.");
    }
    stage("details", "passed", "Selecting a safe content candidate exposed a Details surface with Play or Resume.", journeySequence, playOnDetails.descriptor);

    const play = await requireTarget(journeySequence, "play", "play");
    await session.activate(play.sequence, play.candidate.descriptor, "discovery");
    snapshot = await session.snapshot();
    journeySequence = [...play.sequence, "SELECT"];
    const visibleToggle = rankSemanticCandidates(snapshot, "toggle-play")[0] ?? null;
    const playerProgress = playbackProgressObservation(snapshot);
    if (visibleToggle === null && playerProgress === null) {
      stage("player", "unobservable", "Play was activated, but neither player controls nor a numeric player position were observable.", journeySequence);
      throw new JourneyStop("The player could not be semantically confirmed.");
    }
    stage("player", "passed", "Play opened a surface with observable player semantics.", journeySequence, visibleToggle?.descriptor ?? null);
    const playerSequence = journeySequence;
    const initialPlayerSnapshot = snapshot;
    const playerExpansion = await expandSurface(session, playerSequence);
    const expandedPlayerTarget = (target: StreamingSemanticTarget): {
      readonly state: ExpandedState;
      readonly candidate: RankedSemanticCandidate;
    } | null => {
      for (const state of playerExpansion.states) {
        const candidate = focusedCandidate(state.snapshot, target);
        if (candidate !== null) return { state, candidate };
      }
      return null;
    };

    const toggleTarget = expandedPlayerTarget("toggle-play");
    const toggleReachable = toggleTarget !== null;
    stage(
      "controls",
      toggleReachable && playerExpansion.complete
        ? "passed"
        : toggleReachable || !playerExpansion.complete
          ? "partial"
          : "unobservable",
      toggleReachable
        ? playerExpansion.complete
          ? "A semantic play/pause control was uniquely focused during complete local D-pad expansion."
          : `A semantic play/pause control was focused, but player expansion stopped after exactly ${String(playerExpansion.expandedStates)} expanded states at ${playerExpansion.reason}.`
        : `A visible player control did not count as reachable; expansion stopped at ${playerExpansion.reason}.`,
      toggleTarget?.state.path ?? playerSequence,
      toggleTarget?.candidate.descriptor ?? visibleToggle?.descriptor ?? null,
    );

    const volumeCandidate = rankSemanticCandidates(initialPlayerSnapshot, "volume-control")[0] ?? null;
    let volumeConclusive = false;
    if (volumeCandidate === null) {
      stage("player-volume", "unobservable", "No semantic player volume control was observable.", playerSequence);
    } else {
      const reached = playerExpansion.states.find((state) => (
        state.focused !== null && nodeMatchesDescriptor(volumeCandidate.node, state.focused)
      ));
      volumeControl = {
        element: volumeCandidate.descriptor,
        remotelyReachable: reached !== undefined,
        exactSequence: reached?.path ?? null,
        activation: "not-attempted",
        detail: reached !== undefined
          ? playerExpansion.complete
            ? "The semantic volume control was uniquely focused during complete local D-pad expansion."
            : `The semantic volume control was focused before incomplete expansion stopped at ${playerExpansion.reason}.`
          : playerExpansion.complete
            ? "Complete local D-pad expansion did not focus the semantic volume control."
            : `Remote reachability was not claimed because expansion stopped at ${playerExpansion.reason}.`,
      };
      if (reached !== undefined) {
        volumeConclusive = true;
        stage("player-volume", "passed", "The semantic volume control was remote reachable.", reached.path, volumeCandidate.descriptor);
      } else if (!playerExpansion.complete) {
        stage("player-volume", "partial", `Volume reachability remained unproven because expansion stopped at ${playerExpansion.reason}.`, playerSequence, volumeCandidate.descriptor);
      } else {
        const pointer = options.pointerProbe === undefined
          ? null
          : await runIsolatedPointerProbe(session, options.pointerProbe, {
            kind: "player-volume-control",
            element: volumeCandidate.descriptor,
            snapshot: initialPlayerSnapshot,
            surfaceSequence: playerSequence,
          }, pointerProbes);
        if (pointer?.status !== "reachable") {
          stage(
            "player-volume",
            "unobservable",
            "Complete remote expansion did not reach the volume control, but real isolated pointer activation was not established.",
            playerSequence,
            volumeCandidate.descriptor,
          );
        } else {
          const source = findWitnessSource(volumeCandidate.descriptor, playerExpansion.states);
          let witness: Parameters<typeof volumePointerOnlyIssue>[3] = null;
          if (source !== null && source.source.focused !== null) {
            await session.restoreAndReplay(source.source.path, "probe");
            await session.press(source.action, "probe");
            const afterWitness = await session.snapshot();
            const observed = focusDescriptor(afterWitness);
            if (observed !== null && nodeMatchesDescriptor(volumeCandidate.node, observed)) {
              volumeControl = {
                ...volumeControl,
                remotelyReachable: true,
                exactSequence: [...source.source.path, source.action],
                detail: "A fresh adjacent D-pad witness reached the volume control after expansion.",
              };
              volumeConclusive = true;
              stage("player-volume", "passed", "A fresh adjacent D-pad witness reached the volume control.", [...source.source.path, source.action], volumeCandidate.descriptor);
            } else if (observed !== null) {
              witness = {
                sequence: [...source.source.path, source.action],
                source: source.source.focused,
                observed,
              };
            }
          }
          if (!volumeConclusive) {
            volumeControl = {
              ...volumeControl,
              activation: "observed",
              detail: "Complete D-pad expansion proved remote unreachability and an isolated pointer activation produced a bounded observable change.",
            };
            const issue = volumePointerOnlyIssue(
              volumeCandidate.descriptor,
              pointer,
              options.resetStrategy ?? "reload",
              witness,
            );
            issues.push(issue);
            const replay = await replayIssue(session, issue);
            replays.push(replay);
            volumeConclusive = issue.reproduction.status === "unavailable" || replay.status === "reproduced";
            stage(
              "player-volume",
              "failed",
              witness === null
                ? "The volume control was pointer activated but remote unreachable; no truthful adjacent focus replay was available."
                : "The volume control was pointer activated but an adjacent D-pad transition focused a different control.",
              witness?.sequence ?? playerSequence,
              volumeCandidate.descriptor,
            );
          }
        }
      }
    }

    if (toggleTarget !== null) {
      const toggleSnapshot = await session.restoreAndReplay(toggleTarget.state.path, "probe");
      const currentToggle = focusedCandidate(toggleSnapshot, "toggle-play");
      if (currentToggle === null) {
        throw new PackStop("replay-diverged", "The discovered play/pause route did not restore its uniquely correlated semantic target.");
      }
      const beforeToggle = currentToggle.descriptor;
      if (!isPlayingToggle(beforeToggle)) {
        stage("pause-resume", "unobservable", "The reachable toggle did not expose a playing precondition, so SELECT was not used as a pause probe.", toggleTarget.state.path, beforeToggle);
      } else {
        await session.activate(toggleTarget.state.path, beforeToggle, "probe");
        const pausedSnapshot = await session.snapshot();
        const paused = focusedCandidate(pausedSnapshot, "toggle-play")?.descriptor ?? null;
        const safeResume = paused !== null
          && isSameStableControl(beforeToggle, paused)
          && isPausedToggle(paused);
        if (!safeResume || paused === null) {
          stage(
            "pause-resume",
            "unobservable",
            "Pause was attempted, but the same uniquely correlated safe toggle was not reconfirmed; resume SELECT was withheld.",
            [...toggleTarget.state.path, "SELECT"],
            paused,
          );
        } else {
          const pausedSequence: readonly RemoteKey[] = [...toggleTarget.state.path, "SELECT"];
          await session.activate(pausedSequence, paused, "probe");
          const resumedSnapshot = await session.snapshot();
          const resumed = focusedCandidate(resumedSnapshot, "toggle-play")?.descriptor ?? null;
          const resumedObserved = resumed !== null
            && isSameStableControl(beforeToggle, resumed)
            && isPlayingToggle(resumed);
          stage(
            "pause-resume",
            resumedObserved ? "passed" : "unobservable",
            resumedObserved
              ? "The same safe player toggle changed from playing to paused and back to playing using SELECT."
              : "Resume was activated only after safe-toggle reconfirmation, but the resumed state was not observable.",
            [...pausedSequence, "SELECT"],
            resumed,
          );
        }
      }
    } else {
      stage("pause-resume", "unobservable", "No uniquely focused semantic play/pause control was remote reachable.", playerSequence);
    }

    const pausedTarget = async (target: "seek-backward" | "seek-forward"): Promise<{
      readonly sequence: readonly RemoteKey[];
      readonly snapshot: StateSnapshot;
      readonly candidate: RankedSemanticCandidate;
    } | null> => {
      const desired = expandedPlayerTarget(target);
      if (toggleTarget === null || desired === null) return null;
      const pauseSnapshot = await session.restoreAndReplay(toggleTarget.state.path, "probe");
      const pause = focusedCandidate(pauseSnapshot, "toggle-play");
      if (pause === null || !isPlayingToggle(pause.descriptor)) return null;
      await session.activate(toggleTarget.state.path, pause.descriptor, "probe");
      const pausedSnapshot = await session.snapshot();
      const paused = focusedCandidate(pausedSnapshot, "toggle-play")?.descriptor ?? null;
      if (
        paused === null
        || !isSameStableControl(pause.descriptor, paused)
        || !isPausedToggle(paused)
      ) {
        return null;
      }
      if (
        toggleTarget.state.path.length !== playerSequence.length
        || !toggleTarget.state.path.every((key, index) => key === playerSequence[index])
      ) {
        return null;
      }
      const suffix = desired.state.path.slice(playerSequence.length);
      const sequence: readonly RemoteKey[] = [...toggleTarget.state.path, "SELECT", ...suffix];
      const targetSnapshot = await session.restoreAndReplay(sequence, "probe");
      const candidate = focusedCandidate(targetSnapshot, target);
      return candidate === null ? null : { sequence, snapshot: targetSnapshot, candidate };
    };

    const forward = await pausedTarget("seek-forward");
    if (forward !== null) {
      const before = playbackProgressObservation(forward.snapshot);
      await session.activate(forward.sequence, forward.candidate.descriptor, "probe");
      const afterSnapshot = await session.snapshot();
      const after = before === null
        ? null
        : playbackProgressObservation(afterSnapshot, before.provenance);
      stage(
        "seek-forward",
        before === null || after === null ? "unobservable" : after.value > before.value ? "passed" : "failed",
        before === null || after === null
          ? "Forward was remote reachable, but one uniquely correlated playback-position value was unavailable."
          : `Forward changed the same playback-position valueNow from ${String(before.value)} to ${String(after.value)}.`,
        [...forward.sequence, "SELECT"],
        forward.candidate.descriptor,
      );
    } else {
      stage(
        "seek-forward",
        "unobservable",
        "A stable paused player precondition and uniquely correlated Forward target could not be established; SELECT was withheld.",
        playerSequence,
        null,
      );
    }

    const backward = await pausedTarget("seek-backward");
    if (backward !== null) {
      const before = playbackProgressObservation(backward.snapshot);
      await session.activate(backward.sequence, backward.candidate.descriptor, "probe");
      const afterSnapshot = await session.snapshot();
      const after = before === null
        ? null
        : playbackProgressObservation(afterSnapshot, before.provenance);
      const failed = before !== null && before.value > 0 && after !== null && after.value > before.value;
      const passed = before !== null && after !== null && after.value < before.value;
      stage(
        "seek-backward",
        failed ? "failed" : passed ? "passed" : "unobservable",
        before === null || after === null
          ? "Rewind was remote reachable, but one uniquely correlated playback-position value was unavailable."
          : before.value === 0 && after.value === 0
            ? "Rewind remained at the zero boundary; no lower-position precondition existed, so this was not classified as a failure."
            : `Rewind changed the same playback-position valueNow from ${String(before.value)} to ${String(after.value)}.`,
        [...backward.sequence, "SELECT"],
        backward.candidate.descriptor,
      );
      if (failed && before !== null && after !== null) {
        issues.push(rewindIssue(
          [...backward.sequence, "SELECT"],
          backward.candidate.descriptor,
          before.value,
          after.value,
        ));
      }
    } else {
      stage(
        "seek-backward",
        "unobservable",
        "A stable paused player precondition and uniquely correlated Rewind target could not be established; SELECT was withheld.",
        playerSequence,
        null,
      );
    }

    snapshot = await session.restoreAndReplay(playerSequence, "probe");
    const playerBackFrom = focusDescriptor(snapshot);
    await session.press("BACK", "probe");
    const playerBackSnapshot = await session.snapshot();
    const detailsRestored = rankSemanticCandidates(playerBackSnapshot, "play")[0] ?? null;
    stage(
      "player-back",
      detailsRestored === null ? "failed" : "passed",
      detailsRestored === null
        ? "BACK from Player did not restore a Details surface with Play or Resume."
        : "BACK from Player restored a Details surface with Play or Resume.",
      [...playerSequence, "BACK"],
      playerBackFrom,
    );

    const settings = expandedPlayerTarget("settings");
    if (settings === null) {
      stage(
        "settings",
        playerExpansion.complete ? "unobservable" : "partial",
        `No uniquely focused semantic Settings control was retained; player expansion stopped at ${playerExpansion.reason}.`,
        playerSequence,
      );
      throw new JourneyStop(
        "Player Settings was not remote reachable.",
        playerExpansion.reason === "max-local-depth" || playerExpansion.reason === "max-local-states"
          ? playerExpansion.reason
          : "journey-partial",
      );
    }
    const restoredSettings = await session.restoreAndReplay(settings.state.path, "discovery");
    const currentSettings = focusedCandidate(restoredSettings, "settings");
    if (currentSettings === null) {
      throw new PackStop("replay-diverged", "The discovered Settings route did not restore its uniquely correlated semantic target.");
    }
    stage(
      "settings",
      playerExpansion.complete ? "passed" : "partial",
      playerExpansion.complete
        ? "A semantic Settings control was retained from complete local player expansion."
        : `A semantic Settings control was retained, but player expansion stopped at ${playerExpansion.reason}.`,
      settings.state.path,
      currentSettings.descriptor,
    );
    const beforeSettingsIdentity = semanticStateIdentity(restoredSettings);
    const settingsAction = await session.activate(settings.state.path, currentSettings.descriptor, "discovery");
    snapshot = await session.snapshot();
    journeySequence = [...settings.state.path, "SELECT"];
    const afterSettingsIdentity = semanticStateIdentity(snapshot);
    const settingsSurfaceConfirmed = beforeSettingsIdentity !== null
      && afterSettingsIdentity !== null
      && beforeSettingsIdentity !== afterSettingsIdentity
      && isPlayerSettingsSurface(snapshot);
    const captionsOnSettings = settingsSurfaceConfirmed
      ? rankSemanticCandidates(snapshot, "captions")[0] ?? null
      : null;
    if (!settingsSurfaceConfirmed || captionsOnSettings === null) {
      stages.splice(stages.findIndex((value) => value.stage === "settings"), 1);
      stage(
        "settings",
        "partial",
        "The Settings control activated, but no distinct semantic player-settings surface with Captions was confirmed.",
        journeySequence,
        currentSettings.descriptor,
      );
      throw new JourneyStop("Player Settings could not be confirmed.");
    }
    const settingsLatency = settingsAction.timing.screenSettledAtMs === undefined
      ? null
      : settingsAction.timing.screenSettledAtMs - settingsAction.timing.inputSentAtMs;
    stages.splice(stages.findIndex((value) => value.stage === "settings"), 1);
    stage("settings", playerExpansion.complete ? "passed" : "partial", settingsLatency === null
      ? "Player Settings opened and exposed Captions; response latency was unavailable."
      : `Player Settings opened and exposed Captions in ${String(Math.max(0, settingsLatency))} ms.`, journeySequence, captionsOnSettings.descriptor);
    const settingsSequence = journeySequence;

    const captions = await requireTarget(settingsSequence, "captions", "captions");
    await session.activate(captions.sequence, captions.candidate.descriptor, "discovery");
    snapshot = await session.snapshot();
    journeySequence = [...captions.sequence, "SELECT"];
    const appearanceOnCaptions = rankSemanticCandidates(snapshot, "appearance")[0] ?? null;
    if (appearanceOnCaptions === null) {
      stages.splice(stages.findIndex((value) => value.stage === "captions"), 1);
      stage("captions", "partial", "Captions activated, but a semantic caption menu with Appearance was not confirmed.", journeySequence, captions.candidate.descriptor);
      throw new JourneyStop("Captions could not be confirmed.");
    }
    stages.splice(stages.findIndex((value) => value.stage === "captions"), 1);
    stage("captions", "passed", "The nested Captions menu was reached and exposed Appearance.", journeySequence, appearanceOnCaptions.descriptor);
    const captionsSequence = journeySequence;
    const captionsExpansion = await expandSurface(session, captionsSequence);
    if (!captionsExpansion.complete) {
      const captionsStageIndex = stages.findIndex((value) => value.stage === "captions");
      if (captionsStageIndex >= 0) {
        stages.splice(captionsStageIndex, 1, {
          stage: "captions",
          status: "partial",
          detail: `Captions opened, but local expansion stopped after exactly ${String(captionsExpansion.expandedStates)} expanded states at ${captionsExpansion.reason}.`,
          sequence: [...captionsSequence],
          target: appearanceOnCaptions.descriptor,
        });
      }
    }
    const expandedCaptionTarget = (target: "appearance" | "caption-track"): ExpandedState | null => (
      captionsExpansion.states.find((state) => focusedCandidate(state.snapshot, target) !== null) ?? null
    );

    const originalCaption = selectedCaptionTrack(snapshot);
    const trackState = expandedCaptionTarget("caption-track");
    if (trackState !== null && originalCaption !== null) {
      const trackSnapshot = await session.restoreAndReplay(trackState.path, "probe");
      const track = focusedCandidate(trackSnapshot, "caption-track");
      if (track === null) {
        throw new PackStop("replay-diverged", "The retained caption-track route did not restore its semantic target.");
      }
      const candidateBefore = descriptorFromSnapshot(trackSnapshot, track.descriptor);
      await session.activate(trackState.path, track.descriptor, "probe");
      const afterSnapshot = await session.snapshot();
      const candidateAfter = descriptorFromSnapshot(afterSnapshot, track.descriptor);
      const originalAfter = descriptorFromSnapshot(afterSnapshot, originalCaption);
      const selectionObservable = candidateBefore?.selectionState !== null
        && candidateAfter?.selectionState !== null
        && originalCaption.selectionState !== null
        && originalAfter?.selectionState !== null;
      const changed = candidateBefore?.selectionState === "off"
        && candidateAfter?.selectionState === "on"
        && originalCaption.selectionState === "on"
        && originalAfter?.selectionState === "off";
      const ignored = candidateBefore?.selectionState === "off"
        && candidateAfter?.selectionState === "off"
        && originalCaption.selectionState === "on"
        && originalAfter?.selectionState === "on";
      stage(
        "caption-selection",
        !selectionObservable
          ? "unobservable"
          : changed
            ? "passed"
            : ignored
              ? "failed"
              : "partial",
        !selectionObservable
          ? "Caption controls were reachable, but selectionState was not fully observable."
          : changed
            ? "Selecting a safe alternate caption track changed selectionState and cleared the previous track."
            : ignored
              ? "Selecting a safe alternate caption track left the exact original on/candidate off selection pair unchanged."
              : "Caption selection changed to an unexpected state combination, so it was not classified as the ignored-selection defect.",
        [...trackState.path, "SELECT"],
        track.descriptor,
      );
      if (ignored) {
        issues.push(captionsIssue([...trackState.path, "SELECT"], track.descriptor, originalCaption));
      }
      if (changed) {
        const originalTarget = await findExactTarget(session, captionsSequence, originalCaption);
        if (originalTarget.status !== "found" || originalTarget.candidate === null) {
          throw new PackStop(
            "restoration-failed",
            `The original caption track could not be reached for restoration: ${originalTarget.detail}`,
          );
        }
        await session.activate(originalTarget.sequence, originalTarget.candidate.descriptor, "probe");
        const restoredSelection = await session.snapshot();
        const restoredOriginal = descriptorFromSnapshot(restoredSelection, originalCaption);
        const clearedCandidate = descriptorFromSnapshot(restoredSelection, track.descriptor);
        if (restoredOriginal?.selectionState !== "on" || clearedCandidate?.selectionState !== "off") {
          throw new PackStop(
            "restoration-failed",
            "Selecting the original caption track did not restore the observed selection state.",
          );
        }
      }
      const restoredCaptions = await session.restoreAndReplay(captionsSequence, "probe");
      const originalRestored = descriptorFromSnapshot(restoredCaptions, originalCaption);
      if (originalCaption.selectionState === "on" && originalRestored?.selectionState !== "on") {
        throw new PackStop("restoration-failed", "The original caption selection could not be restored after its isolated probe.");
      }
    } else {
      stage(
        "caption-selection",
        "unobservable",
        originalCaption === null
          ? "No currently selected caption track exposed selectionState=on."
          : captionsExpansion.complete
            ? "No unselected caption track with observable selectionState was remote reachable."
            : `Caption-track expansion stopped at ${captionsExpansion.reason}.`,
        captionsSequence,
        null,
      );
    }

    const appearanceState = expandedCaptionTarget("appearance");
    if (appearanceState === null) {
      stage(
        "appearance",
        captionsExpansion.complete ? "unobservable" : "partial",
        `No uniquely focused Appearance control was retained; caption expansion stopped at ${captionsExpansion.reason}.`,
        captionsSequence,
        appearanceOnCaptions.descriptor,
      );
      throw new JourneyStop(
        "Caption Appearance was not remote reachable.",
        captionsExpansion.reason === "max-local-depth" || captionsExpansion.reason === "max-local-states"
          ? captionsExpansion.reason
          : "journey-partial",
      );
    }
    const restoredAppearance = await session.restoreAndReplay(appearanceState.path, "discovery");
    const appearance = focusedCandidate(restoredAppearance, "appearance");
    if (appearance === null) {
      throw new PackStop("replay-diverged", "The retained Appearance route did not restore its semantic target.");
    }
    stage("appearance", "passed", "A semantic Appearance control was retained from caption-menu expansion.", appearanceState.path, appearance.descriptor);
    await session.activate(appearanceState.path, appearance.descriptor, "discovery");
    snapshot = await session.snapshot();
    journeySequence = [...appearanceState.path, "SELECT"];
    const textTargetCandidate = rankSemanticCandidates(snapshot, "text-colour")[0] ?? null;
    if (textTargetCandidate === null) {
      stages.splice(stages.findIndex((value) => value.stage === "appearance"), 1);
      stage("appearance", "unobservable", "Appearance opened, but a semantic Text Colour control was not observable.", journeySequence);
      throw new JourneyStop("Caption Appearance could not be confirmed.");
    }
    const appearanceSequence = journeySequence;
    const initialAppearanceSnapshot = snapshot;
    const expansion = await expandSurface(session, appearanceSequence);
    const inventory = activeSurfaceEntries(initialAppearanceSnapshot)
      .filter((entry) => isSafeStreamingCandidate(entry.node, semanticContext(entry)) && isInteractiveNode(entry.node));
    for (const { node } of inventory) {
      const descriptor = describeStreamingElement(node);
      const reached = expansion.states.find((state) => (
        state.focused !== null && nodeMatchesDescriptor(node, state.focused)
      ));
      appearanceControls.push({
        element: descriptor,
        remotelyReachable: reached !== undefined,
        exactSequence: reached?.path ?? null,
        activation: "not-attempted",
        detail: reached === undefined
          ? expansion.complete
            ? "Visible safe control was not focused by complete local D-pad expansion."
            : `Visible safe control was not observed focused before expansion stopped at ${expansion.reason}; unreachability was not claimed.`
          : "Visible safe control was focused during local D-pad expansion; activation was not attempted without an observable reversible value contract.",
      });
    }
    stages.splice(stages.findIndex((value) => value.stage === "appearance"), 1);
    stage(
      "appearance",
      expansion.complete ? "passed" : "partial",
      expansion.complete
        ? `Caption Appearance local expansion completed across ${String(expansion.states.length)} reachable focus states and inventoried ${String(inventory.length)} safe controls.`
        : `Caption Appearance expansion stopped at ${expansion.reason}.`,
      appearanceSequence,
      appearance.descriptor,
    );

    const textTarget = textTargetCandidate.descriptor;
    const textReached = expansion.states.some((state) => (
      state.focused !== null && nodeMatchesDescriptor(textTargetCandidate.node, state.focused)
    ));
    let textConclusive = false;
    if (textReached) {
      textConclusive = true;
      stage(
        "caption-text-colour",
        expansion.complete ? "passed" : "partial",
        expansion.complete
          ? "Text Colour was reached by the remote during complete local expansion."
          : `Text Colour was reached, but full Appearance expansion stopped at ${expansion.reason}.`,
        appearanceSequence,
        textTarget,
      );
    } else if (!expansion.complete) {
      stage("caption-text-colour", "partial", "Text Colour was not reached, but local expansion was incomplete so unreachability was not claimed.", appearanceSequence, textTarget);
    } else {
      const pointer = options.pointerProbe === undefined
        ? null
        : await runIsolatedPointerProbe(session, options.pointerProbe, {
            kind: "caption-text-colour",
            element: textTarget,
            snapshot: initialAppearanceSnapshot,
            surfaceSequence: appearanceSequence,
          }, pointerProbes);
      const witness = findWitnessSource(textTarget, expansion.states);
      if (pointer?.status !== "reachable") {
        stage(
          "caption-text-colour",
          "unobservable",
          "Complete remote expansion did not reach Text Colour, but real isolated pointer activation was not established.",
          appearanceSequence,
          textTarget,
        );
      } else if (witness === null || witness.source.focused === null) {
        stage("caption-text-colour", "unobservable", "Text Colour was pointer activated and remote unreachable, but no adjacent geometric transition witness was observable for truthful replay.", appearanceSequence, textTarget);
      } else {
        await session.restoreAndReplay(witness.source.path, "probe");
        await session.press(witness.action, "probe");
        const afterWitness = await session.snapshot();
        const observed = focusDescriptor(afterWitness);
        const observedIsTarget = observed !== null && nodeMatchesDescriptor(textTargetCandidate.node, observed);
        if (observed === null) {
          stage("caption-text-colour", "unobservable", "The witness transition lost observable focus.", [...witness.source.path, witness.action], textTarget);
        } else if (observedIsTarget) {
          textConclusive = true;
          stage("caption-text-colour", "passed", "The adjacent witness transition reached Text Colour.", [...witness.source.path, witness.action], textTarget);
        } else {
          const exactSequence = [...witness.source.path, witness.action];
          stage(
            "caption-text-colour",
            "failed",
            "Text Colour was pointer activated but remote unreachable; the adjacent D-pad transition focused a different control.",
            exactSequence,
            textTarget,
          );
          const issue = textColourIssue(
            exactSequence,
            witness.source.focused,
            textTarget,
            observed,
            pointer,
            options.resetStrategy ?? "reload",
          );
          issues.push(issue);
          const replay = await replayIssue(session, issue);
          replays.push(replay);
          textConclusive = replay.status === "reproduced";
        }
      }
    }

    let backSnapshot = await session.restoreAndReplay(appearanceSequence, "probe");
    let nestedBackPassed = backSnapshot.uiTree.status === "available";
    const backPath: RemoteKey[] = [...appearanceSequence];
    for (const expected of ["appearance", "captions", "settings"] as const) {
      await session.press("BACK", "probe");
      backPath.push("BACK");
      backSnapshot = await session.snapshot();
      const confirmed = expected === "appearance"
        ? rankSemanticCandidates(backSnapshot, "appearance").length > 0
        : expected === "captions"
          ? rankSemanticCandidates(backSnapshot, "captions").length > 0
          : rankSemanticCandidates(backSnapshot, "settings").length > 0
            || rankSemanticCandidates(backSnapshot, "toggle-play").length > 0;
      nestedBackPassed &&= confirmed;
    }
    stage(
      "nested-back",
      nestedBackPassed ? "passed" : "failed",
      nestedBackPassed
        ? "BACK closed Appearance, Captions, and Settings one semantic level at a time."
        : "At least one nested BACK transition did not expose the expected parent semantic surface.",
      backPath,
      focusDescriptor(backSnapshot),
    );

    const complete = playerExpansion.complete
      && captionsExpansion.complete
      && expansion.complete
      && volumeConclusive
      && textConclusive
      && nestedBackPassed
      && stages.every((result) => result.status === "passed" || result.status === "failed");
    if (!complete) {
      addSkippedStages(stages);
      const localReasons = [playerExpansion.reason, captionsExpansion.reason, expansion.reason];
      const terminationReason = localReasons.includes("max-local-states")
        ? "max-local-states"
        : localReasons.includes("max-local-depth")
          ? "max-local-depth"
          : "journey-partial";
      return {
        status: "partial",
        termination: {
          reason: terminationReason,
          complete: false,
          detail: "The semantic journey ran, but one or more remote, pointer, restoration, or replay observations remained inconclusive.",
        },
        budgets,
        stages,
        issues,
        appearanceControls,
        replays,
        volumeControl,
        pointerProbes,
        journeySequence,
        statistics: session.statistics(),
      };
    }

    return {
      status: "complete",
      termination: {
        reason: "complete",
        complete: true,
        detail: "The bounded semantic streaming journey, local Appearance expansion, and applicable focus replay completed.",
      },
      budgets,
      stages,
      issues,
      appearanceControls,
      replays,
      volumeControl,
      pointerProbes,
      journeySequence,
      statistics: session.statistics(),
    };
  } catch (error) {
    addSkippedStages(stages);
    if (error instanceof JourneyStop) {
      return {
        status: "partial",
        termination: { reason: error.reason, complete: false, detail: error.message },
        budgets,
        stages,
        issues,
        appearanceControls,
        replays,
        volumeControl,
        pointerProbes,
        journeySequence,
        statistics: session.statistics(),
      };
    }
    const stop = error instanceof PackStop
      ? error
      : new PackStop("driver-error", safeErrorMessage(error));
    return {
      status: stop.reason === "ui-tree-unavailable" ? "unobservable" : "error",
      termination: { reason: stop.reason, complete: false, detail: stop.message },
      budgets,
      stages,
      issues,
      appearanceControls,
      replays,
      volumeControl,
      pointerProbes,
      journeySequence,
      statistics: session.statistics(),
    };
  }
}
