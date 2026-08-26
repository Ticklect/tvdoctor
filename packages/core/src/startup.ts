import type {
  ElementBounds,
  RemoteKey,
  ResetStrategy,
  StateSnapshot,
  TVDoctorDriver,
  UiNodeSnapshot,
} from "@tvdoctor/protocol";
import { PreparedStateDivergenceError } from "./errors.js";
import { REMOTE_KEYS } from "@tvdoctor/protocol";
import {
  normaliseActionSettlingOptions,
  pressAndObserve,
} from "./action-settling.js";
import { computeSnapshotFingerprint } from "./fingerprint.js";
import { createCanonicalSemanticIdentity, createSemanticIssueId } from "./semantic-issue-id.js";

export const STARTUP_BLOCKER_KINDS = [
  "consent-wall",
  "onboarding",
  "login",
  "region-selection",
  "age-gate",
  "system-setup",
] as const;

export type StartupBlockerKind = (typeof STARTUP_BLOCKER_KINDS)[number];

export interface StartupElementEvidence {
  readonly stableId: string | null;
  readonly role: string | null;
  readonly name: string | null;
  readonly bounds: ElementBounds | null;
}
export interface StartupBlocker {
  readonly kind: StartupBlockerKind;
  readonly element: StartupElementEvidence;
  readonly focusedElement: StartupElementEvidence | null;
  /** Bounded, sanitised semantic text used by the generic classifier. */
  readonly textSample: string;
}
export interface StartupControlCandidate extends StartupElementEvidence {
  readonly enabled: boolean | null;
  readonly focused: boolean | null;
}
export type StartupPreparationPolicy =
  | { readonly kind: "observe" }
  | { readonly kind: "remote-sequence"; readonly actions: readonly RemoteKey[] };

export interface StartupStabilityOptions {
  readonly maxSnapshots?: number;
  readonly requiredStableSnapshots?: number;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
}
export type NormalisedStartupStabilityOptions = Required<StartupStabilityOptions>;

export interface StartupPreparationOptions {
  readonly policy?: StartupPreparationPolicy;
  readonly resetStrategy?: ResetStrategy;
  readonly stability?: StartupStabilityOptions;
  readonly monotonicNow?: () => number;
  readonly wait?: (durationMs: number) => Promise<void>;
}

export type StartupPreparationStatus =
  | "ready"
  | "setup-blocker"
  | "unstable"
  | "preparation-ineffective"
  | "failed";

export interface StartupPreparationStep {
  readonly operation:
    | "initial-stability"
    | "blocker-detection"
    | "policy-action"
    | "prepared-capture"
    | "reset-verification";
  readonly detail: string;
}

export interface StartupPreparationResult {
  readonly status: StartupPreparationStatus;
  readonly resetStrategy: ResetStrategy;
  readonly policy: StartupPreparationPolicy;
  readonly blockers: readonly StartupBlocker[];
  readonly controls: readonly StartupControlCandidate[];
  readonly steps: readonly StartupPreparationStep[];
  readonly identityHash: string | null;
  /** Snapshot supporting blocker evidence; never reused as exploration DOM. */
  readonly representativeSnapshot?: StateSnapshot;
  /**
   * Present only for `ready`. Each call performs a bounded fresh reset and
   * returns a newly captured snapshot; no DOM or fingerprint is reused.
   */
  readonly restoreToPreparedState?: () => Promise<StateSnapshot>;
}

export interface StartupBlockerFinding {
  readonly issue: {
    readonly id: string;
    readonly rule: "remote.startup-blocker";
    readonly title: string;
    readonly description: string;
    readonly severity: "info";
    readonly confidence: "deterministic";
    readonly pack: "navigation";
    readonly screen: string | null;
    readonly expected: string;
    readonly observed: string;
    readonly transition: null;
    readonly evidence: readonly {
      readonly kind: "verified-fact";
      readonly summary: string;
      readonly source: string;
      readonly artifact: string | null;
    }[];
    readonly reproduction:
      | { readonly status: "unavailable"; readonly reason: string };
  };
}

const DEFAULT_STABILITY: Readonly<NormalisedStartupStabilityOptions> = {
  maxSnapshots: 8,
  requiredStableSnapshots: 2,
  pollIntervalMs: 200,
  timeoutMs: 20_000,
};

const MAX_TEXT_SAMPLE = 500;
const MAX_TREE_NODES = 4_096;

class StartupUnstableError extends Error {
  constructor() {
    super("The startup snapshot did not reach the configured canonical stability boundary.");
    this.name = "StartupUnstableError";
  }
}

function flattenNodes(snapshot: StateSnapshot): readonly UiNodeSnapshot[] {
  if (snapshot.uiTree.status !== "available") return [];
  const result: UiNodeSnapshot[] = [];
  const pending = [...snapshot.uiTree.value];
  while (pending.length > 0 && result.length < MAX_TREE_NODES) {
    const node = pending.shift();
    if (node === undefined) break;
    result.push(node);
    pending.push(...node.children);
  }
  return result;
}

function elementEvidence(node: UiNodeSnapshot): StartupElementEvidence {
  return {
    stableId: node.stableId,
    role: node.role,
    name: node.name,
    bounds: node.bounds,
  };
}

function normaliseText(value: string | null | undefined): string {
  return value?.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase() ?? "";
}

function subtreeText(nodes: readonly UiNodeSnapshot[]): string {
  return nodes
    .flatMap((node) => [node.name, node.text])
    .filter((value): value is string => value !== null && value !== undefined)
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
}

function findNode(
  nodes: readonly UiNodeSnapshot[],
  predicate: (node: UiNodeSnapshot) => boolean,
): UiNodeSnapshot | null {
  return nodes.find(predicate) ?? null;
}

function isDescendant(
  candidate: UiNodeSnapshot,
  ancestor: UiNodeSnapshot,
): boolean {
  return (ancestor.children ?? []).some((child) => (
    child === candidate || isDescendant(candidate, child)
  ));
}

function classifyDialog(dialog: UiNodeSnapshot, text: string): StartupBlockerKind | null {
  if (/\b(?:consent|cookies?|privacy)\b|\bbefore you continue\b/u.test(text)) {
    return "consent-wall";
  }
  if (/\b(?:onboarding|welcome|get started|set up|setup)\b/u.test(text)) return "onboarding";
  if (/\b(?:sign in|log in|login)\b|\baccount required\b/u.test(text)) return "login";
  if (/\b(?:region|country|language)\s+(?:selection|choice|wall)\b|\b(?:select|choose)\s+(?:region|country|language)\b/u.test(text)) {
    return "region-selection";
  }
  if (/\bage gate\b|\bbirth(?:date|day)\b|\bare you over\b/u.test(text)) return "age-gate";
  if (/\b(?:system|device) setup\b/u.test(text)) return "system-setup";
  void dialog;
  return null;
}

function detectBlockers(snapshot: StateSnapshot): readonly StartupBlocker[] {
  const nodes = flattenNodes(snapshot);
  const dialogs = nodes.filter((node) => (
    node.visible !== false
    && (node.modal === true || node.role === "dialog" || node.role === "alertdialog")
  ));
  const focusTarget = snapshot.focusedElement.status === "available"
    ? snapshot.focusedElement.value
    : null;
  const focusedNode = focusTarget === null ? null : findNode(
    nodes,
    (node) => node.focused === true
      || (focusTarget.stableId !== undefined && node.stableId === focusTarget.stableId),
  );
  if (focusedNode === null) return [];

  for (const dialog of dialogs) {
    if (dialog !== focusedNode && !isDescendant(focusedNode, dialog)) continue;
    const descendants = flattenNodes({
      capturedAt: snapshot.capturedAt,
      location: snapshot.location,
      focusedElement: snapshot.focusedElement,
      uiTree: snapshot.uiTree.status === "available"
        ? { status: "available", value: dialog.children }
        : snapshot.uiTree,
    });
    const text = subtreeText([dialog, ...descendants]);
    const kind = classifyDialog(dialog, normaliseText(text));
    if (kind === null) continue;
    return [{
      kind,
      element: elementEvidence(dialog),
      focusedElement: elementEvidence(focusedNode),
      textSample: text.slice(0, MAX_TEXT_SAMPLE),
    }];
  }
  return [];
}

function controlCandidates(snapshot: StateSnapshot): readonly StartupControlCandidate[] {
  return flattenNodes(snapshot)
    .filter((node) => node.visible !== false && node.enabled !== false && node.focusable === true)
    .map((node) => ({
      ...elementEvidence(node),
      enabled: node.enabled,
      focused: node.focused,
    }))
    .slice(0, 64);
}

function identityHash(snapshot: StateSnapshot): string {
  return computeSnapshotFingerprint(snapshot).fingerprint.stateValue;
}

function validatePolicy(policy: StartupPreparationPolicy): StartupPreparationPolicy {
  if (typeof policy !== "object" || policy === null) {
    throw new TypeError("startup policy must be an object.");
  }
  if (policy.kind === "observe") return policy;
  if (policy.kind !== "remote-sequence") {
    throw new TypeError("startup policy.kind must be observe or remote-sequence.");
  }
  if (!Array.isArray(policy.actions) || policy.actions.length === 0) {
    throw new TypeError("startup policy.actions must contain at least one remote key.");
  }
  const allowed = new Set<string>(REMOTE_KEYS);
  if (policy.actions.some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw new TypeError("startup policy.actions must contain only known remote keys.");
  }
  if (new Set(policy.actions).size !== policy.actions.length) {
    throw new TypeError("startup policy.actions must not contain duplicates.");
  }
  return { kind: "remote-sequence", actions: [...policy.actions] };
}

function normaliseStability(options: StartupStabilityOptions | undefined): NormalisedStartupStabilityOptions {
  const value = options ?? {};
  const positive = (input: number | undefined, fallback: number, maximum: number, name: string): number => {
    const selected = input ?? fallback;
    if (!Number.isSafeInteger(selected) || selected <= 0 || selected > maximum) {
      throw new TypeError(`startup stability.${name} must be a positive safe integer no greater than ${String(maximum)}.`);
    }
    return selected;
  };
  const maxSnapshots = positive(value.maxSnapshots, DEFAULT_STABILITY.maxSnapshots, 32, "maxSnapshots");
  const requiredStableSnapshots = positive(
    value.requiredStableSnapshots,
    DEFAULT_STABILITY.requiredStableSnapshots,
    maxSnapshots,
    "requiredStableSnapshots",
  );
  const pollIntervalMs = value.pollIntervalMs ?? DEFAULT_STABILITY.pollIntervalMs;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 60_000) {
    throw new TypeError("startup stability.pollIntervalMs must be between 0 and 60000.");
  }
  return {
    maxSnapshots,
    requiredStableSnapshots,
    pollIntervalMs,
    timeoutMs: positive(value.timeoutMs, DEFAULT_STABILITY.timeoutMs, 120_000, "timeoutMs"),
  };
}

interface StableCapture {
  readonly snapshot: StateSnapshot;
  readonly identity: string;
}

async function captureStableSnapshot(
  driver: TVDoctorDriver,
  stability: NormalisedStartupStabilityOptions,
  context: { monotonicNow(): number; wait(durationMs: number): Promise<void> },
): Promise<StableCapture> {
  const deadline = context.monotonicNow() + stability.timeoutMs;
  let current = await driver.snapshot();
  let currentIdentity = computeSnapshotFingerprint(current).stateIdentity;
  let stableCount = 1;
  let attempts = 1;
  while (stableCount < stability.requiredStableSnapshots) {
    if (attempts >= stability.maxSnapshots) throw new StartupUnstableError();
    await context.wait(stability.pollIntervalMs);
    if (context.monotonicNow() >= deadline) throw new StartupUnstableError();
    const next = await driver.snapshot();
    if (next.uiTree.status !== "available") throw new StartupUnstableError();
    const nextIdentity = computeSnapshotFingerprint(next).stateIdentity;
    stableCount = nextIdentity === currentIdentity ? stableCount + 1 : 1;
    current = next;
    currentIdentity = nextIdentity;
    attempts += 1;
    if (stableCount >= stability.requiredStableSnapshots) {
      return { snapshot: current, identity: currentIdentity };
    }
    if (context.monotonicNow() >= deadline) throw new StartupUnstableError();
  }
  if (current.uiTree.status !== "available") throw new StartupUnstableError();
  return { snapshot: current, identity: currentIdentity };
}

function locationIdentity(snapshot: StateSnapshot): string | null {
  return snapshot.location.status === "available"
    ? snapshot.location.value.split(/[?#]/u, 1)[0] ?? null
    : null;
}

export function createStartupBlockerFinding(
  blocker: StartupBlocker,
  snapshot: StateSnapshot,
  resetStrategy: ResetStrategy,
  prepared: boolean,
  preparationActions: readonly RemoteKey[] = [],
): StartupBlockerFinding {
  const location = locationIdentity(snapshot);
  const identity = createCanonicalSemanticIdentity([
    ["kind", blocker.kind],
    ["location", location],
    ["elementStableId", blocker.element.stableId],
    ["elementRole", blocker.element.role],
    ["prepared", prepared],
    ["preparationActions", [...preparationActions]],
  ]);
  const title = `Startup setup blocker: ${blocker.kind}`;
  const observed = prepared
    ? `${blocker.kind} was detected before preparation. The caller-selected remote policy produced a reproducible post-preparation state; the original wall remains recorded as setup evidence rather than an application defect.`
    : `${blocker.kind} is focused at startup and prevents bounded exploration from beginning. No consent or persistent state was changed because the caller selected observation-only preparation.`;
  const reason = prepared
    ? "A setup screen is environmental evidence; the selected preparation action sequence, not a single navigation transition, established the auditable start state."
    : "The caller selected observation-only startup preparation; TVDoctor never chooses or randomly accepts a consent action.";
  return {
    issue: {
      id: createSemanticIssueId("SETUP", identity),
      rule: "remote.startup-blocker",
      title,
      description: "Startup requires an explicit caller-selected setup choice before application navigation can be explored.",
      severity: "info",
      confidence: "deterministic",
      pack: "navigation",
      screen: location,
      expected: "A caller-selected, recorded preparation policy establishes and reproduces the audit's starting state.",
      observed,
      transition: null,
      evidence: [{
        kind: "verified-fact",
        summary: `Visible modal semantic sample: ${blocker.textSample || "(no text)"}`,
        source: "core/startup-preparation",
        artifact: null,
      }],
      reproduction: { status: "unavailable", reason },
    },
  };
}

export async function prepareStartup(
  driver: TVDoctorDriver,
  options: StartupPreparationOptions = {},
): Promise<StartupPreparationResult> {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("startup preparation options must be an object.");
  }
  if (options.monotonicNow !== undefined && typeof options.monotonicNow !== "function") {
    throw new TypeError("startup monotonicNow must be a function.");
  }
  if (options.wait !== undefined && typeof options.wait !== "function") {
    throw new TypeError("startup wait must be a function.");
  }
  const policy = validatePolicy(options.policy ?? { kind: "observe" });
  const resetStrategy = options.resetStrategy ?? "reload";
  if (!["reload", "relaunch", "clear-data"].includes(resetStrategy)) {
    throw new TypeError("startup resetStrategy must be reload, relaunch, or clear-data.");
  }
  const stability = normaliseStability(options.stability);
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const wait = options.wait ?? ((durationMs: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, durationMs);
  }));
  const context = { monotonicNow, wait };
  const steps: StartupPreparationStep[] = [];

  try {
    if (driver.reset === undefined) {
      throw new TypeError("Startup preparation requires a resettable driver.");
    }
    const reset = driver.reset.bind(driver);
    await reset(resetStrategy);
    const initial = await captureStableSnapshot(driver, stability, context);
    steps.push({
      operation: "initial-stability",
      detail: `Canonical identity ${identityHash(initial.snapshot)} reached required consecutive snapshots.`,
    });
    const blockers = detectBlockers(initial.snapshot);
    const controls = (blockers[0] === undefined
      ? controlCandidates(initial.snapshot)
      : (() => {
        const nodes = flattenNodes(initial.snapshot);
        const dialogNode = findNode(
          nodes,
          (node) => node.stableId === blockers[0]?.element.stableId
            && node.role === blockers[0]?.element.role
            && node.name === blockers[0]?.element.name,
        );
        if (dialogNode === null) throw new TypeError("Startup blocker node disappeared.");
        return controlCandidates({
          capturedAt: initial.snapshot.capturedAt,
          location: initial.snapshot.location,
          focusedElement: initial.snapshot.focusedElement,
          uiTree: initial.snapshot.uiTree.status === "available"
            ? { status: "available", value: [dialogNode] }
            : initial.snapshot.uiTree,
        });
      })());
    steps.push({
      operation: "blocker-detection",
      detail: blockers.length === 0
        ? "No visible focused setup modal matched generic startup semantics."
        : `Detected ${String(blockers.length)} focused setup modal(s).`,
    });

    let prepared = initial;
    if (blockers.length > 0 && policy.kind === "observe") {
      return {
        status: "setup-blocker",
        representativeSnapshot: initial.snapshot,
        resetStrategy,
        policy,
        blockers,
        controls,
        steps,
        identityHash: identityHash(initial.snapshot),
      };
    }

    if (policy.kind === "remote-sequence") {
      const settling = normaliseActionSettlingOptions({
        strategy: "stable-snapshot",
        maxSnapshots: Math.min(stability.maxSnapshots, 6),
        requiredStableSnapshots: Math.min(stability.requiredStableSnapshots, 2),
        pollIntervalMs: stability.pollIntervalMs,
        wait,
      });
      for (const key of policy.actions) {
        const observation = await pressAndObserve(driver, key, settling);
        steps.push({
          operation: "policy-action",
          detail: `${key}: ${observation.actionResult.outcome}${observation.actionResult.message === undefined ? "" : ` (${observation.actionResult.message})`}`,
        });
        if (!observation.settled || observation.actionResult.outcome !== "applied") {
          return {
            status: "preparation-ineffective",
            representativeSnapshot: prepared.snapshot,
            resetStrategy,
            policy,
            blockers,
            controls,
            steps,
            identityHash: identityHash(initial.snapshot),
          };
        }
      }
      prepared = await captureStableSnapshot(driver, stability, context);
      steps.push({
        operation: "prepared-capture",
        detail: `Post-policy canonical identity ${identityHash(prepared.snapshot)}.`,
      });
    }

    await reset(resetStrategy);
    const firstReset = await captureStableSnapshot(driver, stability, context);
    await reset(resetStrategy);
    const secondReset = await captureStableSnapshot(driver, stability, context);
    const reproducible = firstReset.identity === prepared.identity
      && secondReset.identity === firstReset.identity;
    const resetBlockers = [...detectBlockers(firstReset.snapshot), ...detectBlockers(secondReset.snapshot)];
    steps.push({
      operation: "reset-verification",
      detail: reproducible && resetBlockers.length === 0
        ? `Two fresh resets reproduced prepared identity ${identityHash(prepared.snapshot)}.`
        : "Fresh resets did not reproduce the prepared state.",
    });
    if (!reproducible || resetBlockers.length > 0) {
      return {
        status: "preparation-ineffective",
        representativeSnapshot: prepared.snapshot,
        resetStrategy,
        policy,
        blockers,
        controls,
        steps,
        identityHash: identityHash(prepared.snapshot),
      };
    }

    const restoreToPreparedState = async (): Promise<StateSnapshot> => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await reset(resetStrategy);
          const snapshot = await driver.snapshot();
          const identity = computeSnapshotFingerprint(snapshot).stateIdentity;
          if (identity === prepared.identity) return snapshot;
        } catch {
          await new Promise<void>((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
        }
      }
      throw new PreparedStateDivergenceError();
    };

    return {
      status: "ready",
      representativeSnapshot: prepared.snapshot,
      resetStrategy,
      policy,
      blockers,
      controls,
      steps,
      identityHash: prepared.identity,
      restoreToPreparedState,
    };
  } catch (error) {
    if (error instanceof StartupUnstableError) {
      return {
        status: "unstable",
        resetStrategy,
        policy,
        blockers: [],
        controls: [],
        steps,
        identityHash: null,
      };
    }
    return {
      status: "failed",
      resetStrategy,
      policy,
      blockers: [],
      controls: [],
      steps,
      identityHash: null,
    };
  }
}

