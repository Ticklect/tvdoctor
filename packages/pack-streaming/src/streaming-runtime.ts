import type {
  ActionResult,
  Capability,
  DriverOperationOptions,
  RemoteKey,
  ResetStrategy,
  StateSnapshot,
  TVDoctorDriver,
} from "@tvdoctor/protocol";
import {
  OperationDeadlineExceeded,
  runWithOperationDeadline,
} from "@tvdoctor/core";
import {
  describeStreamingElement,
  focusedEntry,
  isSafeStreamingCandidate,
  nodeMatchesStreamingDescriptor,
  semanticContext,
  semanticStateIdentity,
  uniqueDescriptorEntry,
} from "./semantics.js";
import type {
  StreamingElementDescriptor,
  StreamingPackBudgets,
  StreamingPackStatistics,
  StreamingPackTerminationReason,
} from "./types.js";

export type ActionKind = "discovery" | "probe" | "replay";

interface SelectCheckpoint {
  readonly descriptor: StreamingElementDescriptor;
  readonly stateIdentity: string;
}

export class PackStop extends Error {
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

export class JourneyStop extends Error {
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

export function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class StreamingSession {
  private readonly driver: TVDoctorDriver;
  readonly budgets: StreamingPackBudgets;
  private readonly resetStrategy: ResetStrategy;
  private readonly restoreInitialState: ((options?: DriverOperationOptions) => Promise<void>) | undefined;
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
  private terminal = false;

  constructor(
    driver: TVDoctorDriver,
    budgets: StreamingPackBudgets,
    resetStrategy: ResetStrategy,
    restoreInitialState: ((options?: DriverOperationOptions) => Promise<void>) | undefined,
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

  async operation<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.terminal) {
      throw new PackStop("max-duration", "The streaming pack session is unusable after its duration deadline.");
    }
    const remainingMs = this.remainingDuration();
    if (remainingMs <= 0) throw new PackStop("max-duration", "The streaming pack duration budget was exhausted.");
    try {
      return await runWithOperationDeadline(
        { timeoutMs: Math.max(1, Math.ceil(remainingMs)) },
        operation,
      );
    } catch (error) {
      if (!(error instanceof OperationDeadlineExceeded)) throw error;
      this.terminal = true;
      throw new PackStop("max-duration", "The streaming pack duration budget was exhausted during a driver operation.");
    }
  }

  async capabilities(): Promise<ReadonlySet<Capability>> {
    try {
      return await this.operation((signal) => this.driver.capabilities({ signal }));
    } catch (error) {
      if (error instanceof PackStop) throw error;
      throw new PackStop("driver-error", `Driver capabilities failed: ${safeErrorMessage(error)}`);
    }
  }

  async snapshot(): Promise<StateSnapshot> {
    try {
      const snapshot = await this.operation((signal) => this.driver.snapshot({ signal }));
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
      : async (options?: DriverOperationOptions) => this.driver.reset?.(this.resetStrategy, options));
    if (restore === undefined) {
      throw new PackStop("restoration-unavailable", "The driver has no reset method and no restoration hook was supplied.");
    }
    try {
      await this.operation((signal) => restore({ signal }));
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
      result = await this.operation((signal) => this.driver.press(key, { signal }));
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
