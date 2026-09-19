import type { RemoteKey, StateSnapshot, UiNodeSnapshot } from "@tvdoctor/protocol";

import type {
  RestorationDiagnostic,
  RestorationFailureSubtype,
  RestorationRejectionReason,
  RestorationStateDiagnostic,
  RestorationStrategy,
} from "./explorer-contracts.js";
import {
  computeSnapshotFingerprint,
  type ComputedSnapshotFingerprint,
} from "./fingerprint.js";

export const MAX_RESTORATION_DIAGNOSTICS = 64;
export const MAX_RESTORATION_HISTORY = 16;

const MAX_LOCATION_LENGTH = 512;
const MAX_STABLE_IDENTIFIERS = 32;
const MAX_FOCUS_PATH_DEPTH = 16;
const MAX_DIAGNOSTIC_TREE_NODES = 512;

interface PlatformRestorationContext {
  readonly platform?: string;
  readonly applicationId?: string | null;
  readonly processId?: number | null;
  readonly processGeneration?: number | null;
  readonly processIdentitySource?: string;
  readonly activity?: string | null;
  readonly activityGeneration?: number | null;
  readonly activityGenerationObservable?: boolean;
  readonly rootIdentity?: string | null;
  readonly rootIdentitySource?: string;
  readonly windowId?: number | null;
  readonly windowGeneration?: number | null;
  readonly observationSequence?: number | null;
  readonly observerStructureFingerprint?: string | null;
  readonly observerStateFingerprint?: string | null;
}

export interface PendingRestorationDiagnostic {
  readonly restorationCycleNumber: number;
  readonly traversalDepth: number;
  readonly destinationStateId: string;
  readonly strategy: RestorationStrategy;
  readonly status: "success" | "failed";
  readonly elapsedMs: number;
  readonly actionHistory?: readonly RemoteKey[];
  readonly before?: RestorationStateDiagnostic;
  readonly after?: RestorationStateDiagnostic;
  readonly expected?: RestorationStateDiagnostic;
  readonly history?: readonly RestorationStateDiagnostic[];
  readonly subtype?: RestorationFailureSubtype;
  readonly rejectionReason?: RestorationRejectionReason;
}

function hash32(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function compactHash(prefix: string, value: string): string {
  return `${prefix}-${hash32(value, 0x811c9dc5)}${hash32(value, 0x9e3779b9)}-${String(value.length)}`;
}

function nodeToken(node: UiNodeSnapshot): string {
  return [node.stableId ?? "", node.role ?? "", node.name ?? ""]
    .map((value) => value.replace(/\s+/gu, " ").trim().slice(0, 128))
    .join("|");
}

function treeDiagnostics(snapshot: StateSnapshot): {
  readonly focusedStableId?: string;
  readonly focusedPath?: readonly string[];
  readonly stableIdentifiers?: readonly string[];
  readonly visibleStructureFingerprint?: string;
  readonly actionableNodeFingerprint?: string;
  readonly navigationStructureFingerprint?: string;
  readonly visibleNodeCount?: number;
  readonly actionableNodeCount?: number;
} {
  if (snapshot.uiTree.status !== "available") return {};
  const targetStableId = snapshot.focusedElement.status === "available"
    ? snapshot.focusedElement.value?.stableId
    : undefined;
  const stableIdentifiers = new Set<string>();
  const visibleTokens: string[] = [];
  const actionableTokens: string[] = [];
  const navigationTokens: string[] = [];
  let focusedPath: readonly string[] | undefined;
  let visibleNodeCount = 0;
  let actionableNodeCount = 0;
  let visited = 0;

  const visit = (node: UiNodeSnapshot, ancestry: readonly string[]): void => {
    if (visited >= MAX_DIAGNOSTIC_TREE_NODES) return;
    visited += 1;
    if (node.visible === false) return;
    visibleNodeCount += 1;
    const token = nodeToken(node);
    const nextPath = [...ancestry, token].slice(-MAX_FOCUS_PATH_DEPTH);
    visibleTokens.push(`${String(nextPath.length)}:${token}`);
    if (node.stableId !== null && stableIdentifiers.size < MAX_STABLE_IDENTIFIERS) {
      stableIdentifiers.add(node.stableId.slice(0, 256));
    }
    const androidClickable = (node as UiNodeSnapshot & { readonly clickable?: boolean | null }).clickable === true;
    const actionable = node.enabled !== false && (node.focusable === true || androidClickable);
    if (actionable) {
      actionableNodeCount += 1;
      const actionToken = `${nextPath.join(">")}\u001fenabled`;
      actionableTokens.push(actionToken);
      navigationTokens.push(`${String(nextPath.length)}:${actionToken}`);
    }
    if (focusedPath === undefined
      && (node.focused === true || (targetStableId !== undefined && node.stableId === targetStableId))) {
      focusedPath = nextPath;
    }
    for (const child of node.children) visit(child, nextPath);
  };
  for (const root of snapshot.uiTree.value) visit(root, []);

  return {
    ...(targetStableId === undefined ? {} : { focusedStableId: targetStableId.slice(0, 256) }),
    ...(focusedPath === undefined ? {} : { focusedPath }),
    stableIdentifiers: [...stableIdentifiers].sort(),
    visibleStructureFingerprint: compactHash("visible", visibleTokens.join("\u001e")),
    actionableNodeFingerprint: compactHash("actionable", actionableTokens.join("\u001e")),
    navigationStructureFingerprint: compactHash("navigation", navigationTokens.join("\u001e")),
    visibleNodeCount,
    actionableNodeCount,
  };
}

function boundedActionHistory(history: readonly RemoteKey[]): readonly RemoteKey[] {
  if (history.length <= MAX_RESTORATION_HISTORY) return [...history];
  return history.slice(history.length - MAX_RESTORATION_HISTORY);
}

export function restorationStateDiagnostic(
  snapshot: StateSnapshot,
  fingerprint: ComputedSnapshotFingerprint = computeSnapshotFingerprint(snapshot),
): RestorationStateDiagnostic {
  const location = snapshot.location.status === "available"
    ? snapshot.location.value.slice(0, MAX_LOCATION_LENGTH)
    : undefined;
  const platform = (snapshot as StateSnapshot & {
    readonly restorationContext?: PlatformRestorationContext;
  }).restorationContext;
  const tree = treeDiagnostics(snapshot);
  return {
    capturedAt: snapshot.capturedAt,
    stateFingerprint: fingerprint.fingerprint.stateValue,
    screenFingerprint: fingerprint.fingerprint.screen.value,
    focusFingerprint: fingerprint.fingerprint.focus.value,
    ...(location === undefined ? {} : { location }),
    focusIdentity: fingerprint.focusIdentity,
    ...tree,
    ...(platform === undefined ? {} : {
      ...(platform.platform === undefined ? {} : { platform: platform.platform }),
      ...(platform.applicationId === undefined ? {} : { applicationId: platform.applicationId }),
      ...(platform.processId === undefined ? {} : { processId: platform.processId }),
      ...(platform.processGeneration === undefined ? {} : { processGeneration: platform.processGeneration }),
      ...(platform.processIdentitySource === undefined ? {} : { processIdentitySource: platform.processIdentitySource }),
      ...(platform.activity === undefined ? {} : { activity: platform.activity }),
      ...(platform.activityGeneration === undefined ? {} : { activityGeneration: platform.activityGeneration }),
      ...(platform.activityGenerationObservable === undefined ? {} : {
        activityGenerationObservable: platform.activityGenerationObservable,
      }),
      ...(platform.rootIdentity === undefined ? {} : { rootIdentity: platform.rootIdentity }),
      ...(platform.rootIdentitySource === undefined ? {} : { rootIdentitySource: platform.rootIdentitySource }),
      ...(platform.windowId === undefined ? {} : { windowId: platform.windowId }),
      ...(platform.windowGeneration === undefined ? {} : { windowGeneration: platform.windowGeneration }),
      ...(platform.observationSequence === undefined ? {} : { observationSequence: platform.observationSequence }),
      ...(platform.observerStructureFingerprint === undefined ? {} : {
        observerStructureFingerprint: platform.observerStructureFingerprint,
      }),
      ...(platform.observerStateFingerprint === undefined ? {} : {
        observerStateFingerprint: platform.observerStateFingerprint,
      }),
    }),
  };
}

export function boundedRestorationHistory(
  history: readonly RestorationStateDiagnostic[],
): readonly RestorationStateDiagnostic[] {
  if (history.length <= MAX_RESTORATION_HISTORY) return [...history];
  return history.slice(history.length - MAX_RESTORATION_HISTORY);
}

export class RestorationDiagnosticRecorder {
  readonly #diagnostics: RestorationDiagnostic[] = [];
  readonly #retries = new Map<string, number>();
  #attempts = 0;
  #successes = 0;
  #failures = 0;

  record(input: PendingRestorationDiagnostic): void {
    const successfulRestorationsBeforeAttempt = this.#successes;
    this.#attempts += 1;
    if (input.status === "success") this.#successes += 1;
    else this.#failures += 1;

    const retryKey = `${input.destinationStateId}\u001f${input.strategy}`;
    const retryNumber = this.#retries.get(retryKey) ?? 0;
    this.#retries.set(retryKey, retryNumber + 1);

    if (this.#diagnostics.length >= MAX_RESTORATION_DIAGNOSTICS) return;
    this.#diagnostics.push({
      attemptNumber: this.#attempts,
      retryNumber,
      restorationCycleNumber: input.restorationCycleNumber,
      successfulRestorationsBeforeAttempt,
      traversalDepth: input.traversalDepth,
      destinationStateId: input.destinationStateId,
      strategy: input.strategy,
      status: input.status,
      elapsedMs: Math.max(0, input.elapsedMs),
      actionHistory: boundedActionHistory(input.actionHistory ?? []),
      ...(input.before === undefined ? {} : { before: input.before }),
      ...(input.after === undefined ? {} : { after: input.after }),
      ...(input.expected === undefined ? {} : { expected: input.expected }),
      history: boundedRestorationHistory(input.history ?? []),
      ...(input.subtype === undefined ? {} : { subtype: input.subtype }),
      ...(input.rejectionReason === undefined ? {} : { rejectionReason: input.rejectionReason }),
    });
  }

  get attempts(): number { return this.#attempts; }
  get successes(): number { return this.#successes; }
  get failures(): number { return this.#failures; }
  snapshot(): readonly RestorationDiagnostic[] { return [...this.#diagnostics]; }
}
