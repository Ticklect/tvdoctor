import {
  REPLAY_SCHEMA_VERSION,
  PROTOCOL_VALIDATION_LIMITS,
  isRemoteKey,
  parseTVDoctorReplayV1,
  type ActionResult,
  type FocusTarget,
  type RemoteKey,
  type RemotePressStep,
  type ReplayTransitionAssertion,
  type ReproductionConfidence,
  type StateSnapshot,
  type TVDoctorDriver,
  type TVDoctorIssue,
  type TVDoctorReplayV1,
  type UiNodeSnapshot,
} from "@tvdoctor/protocol";

export const REPLAY_MINIMIZATION_NOT_ATTEMPTED_REASON =
  "Sequence minimization is deferred until after Milestone 5.";

export interface ReplayExecutionBudgets {
  /** Maximum physical driver.press calls, including the assertion action. */
  readonly maxActions: number;
  /** Monotonic wall-clock budget for the complete replay workflow. */
  readonly maxDurationMs: number;
}

export const DEFAULT_REPLAY_BUDGETS: ReplayExecutionBudgets = {
  maxActions: 250,
  maxDurationMs: 30_000,
};

/** Largest delay Node and browsers can schedule without 32-bit overflow. */
export const MAX_REPLAY_DURATION_MS = 2_147_483_647;

export interface ReplayElementSelector {
  readonly stableId?: string;
  readonly role?: string;
  readonly roles?: readonly string[];
  readonly name?: string;
}

/**
 * Only properties explicitly supplied by the caller are asserted. `null`
 * observations never satisfy a boolean expectation.
 */
export interface ReplayElementStateExpectation {
  readonly present?: boolean;
  readonly visible?: boolean;
  readonly enabled?: boolean;
  readonly focusable?: boolean;
  readonly focused?: boolean;
  readonly modal?: boolean;
}

/**
 * Element predicates supplement the transition assertion. This is useful for
 * defects such as a modal focus trap, where closing the modal is the corrected
 * state but there is no single required focus destination.
 */
export interface ReplayElementStateAssertion {
  readonly selector: ReplayElementSelector;
  readonly checkpoint?: ReplayElementStateExpectation;
  readonly reproduced?: ReplayElementStateExpectation;
  readonly fixed?: ReplayElementStateExpectation;
}

export interface ReplaySequenceSourceMetadata {
  readonly originalSequence: readonly RemotePressStep[];
  readonly minimizedSequence: readonly RemotePressStep[] | null;
}

export interface ReplayCompilationOptions {
  /**
   * Portable replay artifacts do not carry confidence. Consequently,
   * compileReplay defaults to best-effort unless this is explicitly supplied.
   */
  readonly confidence?: ReproductionConfidence;
  readonly elementStateAssertions?: readonly ReplayElementStateAssertion[];
  readonly sequenceMetadata?: ReplaySequenceSourceMetadata;
  /**
   * Trusted issue provenance for a replay loaded from a report. When present,
   * issue id, reset, steps, transition, metadata, and confidence are correlated.
   */
  readonly sourceIssue?: TVDoctorIssue;
}

export interface ReplayMinimizationMetadata {
  readonly status: "not-attempted";
  readonly reason: string;
}

export interface ReplaySequenceMetadata extends ReplaySequenceSourceMetadata {
  readonly executedSequence: "original";
  readonly minimization: ReplayMinimizationMetadata;
}

export interface ReplaySetupPlan {
  readonly steps: readonly RemotePressStep[];
  readonly checkpointFocusElement: string | null;
}

export interface CompiledReplayPlan {
  /**
   * Process-local execution plan. Persist `replay` and compile it again rather
   * than serializing or cloning this correlated plan.
   */
  readonly replay: TVDoctorReplayV1;
  readonly setup: ReplaySetupPlan;
  readonly assertion: ReplayTransitionAssertion;
  readonly elementStateAssertions: readonly ReplayElementStateAssertion[];
  readonly confidence: ReproductionConfidence;
  readonly totalActions: number;
  readonly sequence: ReplaySequenceMetadata;
}

export const REPLAY_COMPILATION_REASON_CODES = [
  "reproduction-unavailable",
  "invalid-replay",
] as const;

export type ReplayCompilationReasonCode =
  (typeof REPLAY_COMPILATION_REASON_CODES)[number];

export interface ReplayCompilationReason {
  readonly code: ReplayCompilationReasonCode;
  readonly message: string;
}

export type ReplayCompilationResult =
  | {
    readonly status: "compiled";
    readonly plan: CompiledReplayPlan;
  }
  | {
    readonly status: "unavailable";
    readonly reason: ReplayCompilationReason;
  }
  | {
    readonly status: "invalid";
    readonly reason: ReplayCompilationReason;
  };

export interface ReplayRestoreContext {
  readonly plan: CompiledReplayPlan;
  readonly strategy: CompiledReplayPlan["replay"]["reset"]["strategy"];
}

export interface ReplayBeforeEvidenceContext {
  readonly plan: CompiledReplayPlan;
  readonly snapshot: StateSnapshot;
  readonly setupActionResults: readonly ActionResult[];
}

export interface ReplayAfterEvidenceContext extends ReplayBeforeEvidenceContext {
  readonly beforeSnapshot: StateSnapshot;
  readonly actionResult: ActionResult;
  readonly afterSnapshot: StateSnapshot;
}

export interface ReplayEvidenceHooks {
  readonly captureBefore?: (
    context: ReplayBeforeEvidenceContext,
  ) => void | Promise<void>;
  readonly captureAfter?: (
    context: ReplayAfterEvidenceContext,
  ) => void | Promise<void>;
}

export interface ReplayExecutionOptions {
  readonly budgets?: Partial<ReplayExecutionBudgets>;
  readonly signal?: AbortSignal;
  /** Overrides driver.reset for environments with a stronger restoration hook. */
  readonly restore?: (context: ReplayRestoreContext) => void | Promise<void>;
  readonly evidence?: ReplayEvidenceHooks;
  /** Injectable monotonic clock for deterministic hosts and tests. */
  readonly now?: () => number;
}

export const REPLAY_EXECUTION_STATUSES = [
  "reproduced",
  "fixed",
  "inconclusive",
  "error",
] as const;

export type ReplayExecutionStatus =
  (typeof REPLAY_EXECUTION_STATUSES)[number];

export const REPLAY_EXECUTION_REASON_CODES = [
  "action-budget-exhausted",
  "duration-budget-exhausted",
  "remote-input-unavailable",
  "reset-unavailable",
  "input-unavailable",
  "input-unobserved",
  "checkpoint-drift",
  "observation-unavailable",
  "assertion-drift",
  "assertion-ambiguous",
  "best-effort-cannot-prove-fixed",
  "invalid-options",
  "invalid-plan",
  "driver-error",
  "reset-error",
  "input-failed",
  "input-error",
  "input-result-mismatch",
  "snapshot-error",
  "evaluation-error",
  "evidence-error",
  "interrupted",
] as const;

export type ReplayExecutionReasonCode =
  (typeof REPLAY_EXECUTION_REASON_CODES)[number];

export const REPLAY_EXECUTION_PHASES = [
  "preflight",
  "capabilities",
  "reset",
  "setup",
  "checkpoint",
  "before-evidence",
  "assertion",
  "after-snapshot",
  "after-evidence",
  "evaluation",
] as const;

export type ReplayExecutionPhase =
  (typeof REPLAY_EXECUTION_PHASES)[number];

export interface ReplayExecutionReason {
  readonly code: ReplayExecutionReasonCode;
  readonly message: string;
  readonly phase: ReplayExecutionPhase;
}

export interface ReplayExecutionEvidence {
  readonly beforeSnapshot: StateSnapshot | null;
  readonly afterSnapshot: StateSnapshot | null;
  readonly setupActionResults: readonly ActionResult[];
  readonly assertionActionResult: ActionResult | null;
}

export interface ReplayExecutionResult {
  readonly status: ReplayExecutionStatus;
  readonly reason: ReplayExecutionReason | null;
  readonly replayId: string;
  readonly issueId: string;
  readonly confidence: ReproductionConfidence;
  readonly actionsPressed: number;
  readonly elapsedMs: number;
  readonly sequence: ReplaySequenceMetadata;
  readonly evidence: ReplayExecutionEvidence;
}

interface MutableReplayEvidence {
  beforeSnapshot: StateSnapshot | null;
  afterSnapshot: StateSnapshot | null;
  setupActionResults: ActionResult[];
  assertionActionResult: ActionResult | null;
}

interface PredicateEvaluation {
  readonly status: "match" | "mismatch" | "unobservable" | "absent";
  readonly detail: string;
}

interface ReplayDeadline {
  readonly expiresAtMs: number;
  readonly now: () => number;
}

class ReplayDeadlineExceeded extends Error {
  public constructor() {
    super("The replay duration budget was exhausted.");
    this.name = "ReplayDeadlineExceeded";
  }
}

const COMPILED_PLAN_SIGNATURES = new WeakMap<CompiledReplayPlan, string>();

function planSignature(plan: CompiledReplayPlan): string | null {
  try {
    // Clone first so caller-supplied toJSON methods cannot conceal mutation.
    return JSON.stringify(structuredClone(plan)) ?? null;
  } catch {
    return null;
  }
}

function registerCompiledPlan(plan: CompiledReplayPlan): CompiledReplayPlan {
  const signature = planSignature(plan);
  if (signature === null) {
    throw new TypeError("A compiled replay plan must be JSON-serializable.");
  }
  COMPILED_PLAN_SIGNATURES.set(plan, signature);
  return plan;
}

function copySteps(steps: readonly RemotePressStep[]): RemotePressStep[] {
  return steps.map((step) => ({ key: step.key, repeat: step.repeat }));
}

function sameSteps(
  left: readonly RemotePressStep[],
  right: readonly RemotePressStep[],
): boolean {
  return left.length === right.length && left.every((step, index) => {
    const other = right[index];
    return other !== undefined && step.key === other.key && step.repeat === other.repeat;
  });
}

function sameNullableSteps(
  left: readonly RemotePressStep[] | null,
  right: readonly RemotePressStep[] | null,
): boolean {
  return left === null || right === null
    ? left === right
    : sameSteps(left, right);
}

function replayMatchesIssue(
  replay: TVDoctorReplayV1,
  issue: TVDoctorIssue,
): string | null {
  if (replay.issueId !== issue.id) {
    return "Replay issueId does not match its source issue.";
  }
  if (issue.reproduction.status !== "available") {
    return "A replay cannot be correlated with an unavailable issue reproduction.";
  }
  if (issue.transition === null) {
    return "A replay cannot be correlated with an issue that has no transition assertion.";
  }
  if (replay.reset.strategy !== issue.reproduction.resetStrategy) {
    return "Replay reset strategy does not match its source issue.";
  }
  if (!sameSteps(replay.steps, issue.reproduction.originalSequence)) {
    return "Replay steps do not match the source issue original sequence.";
  }
  if (replay.assertion.fromElement !== issue.transition.fromElement
    || replay.assertion.action !== issue.transition.action
    || replay.assertion.expectedElement !== issue.transition.expectedElement
    || replay.assertion.observedElement !== issue.transition.observedElement) {
    return "Replay transition assertion does not match its source issue.";
  }
  return null;
}

function inferredElementAssertions(
  issue: TVDoctorIssue | undefined,
): readonly ReplayElementStateAssertion[] {
  if (issue?.rule !== "remote.focus-trap") return [];
  return [{
    selector: { roles: ["dialog", "alertdialog"] },
    checkpoint: { present: true, visible: true, modal: true },
    reproduced: { present: true, visible: true, modal: true },
    fixed: { present: false },
  }];
}

function validateSteps(
  steps: readonly RemotePressStep[],
  label: string,
  allowEmpty: boolean,
): { readonly total: number } | { readonly error: string } {
  if (!Array.isArray(steps)) {
    return { error: `${label} must be an array.` };
  }
  if (!allowEmpty && steps.length === 0) {
    return { error: `${label} must contain at least one action.` };
  }
  if (steps.length > PROTOCOL_VALIDATION_LIMITS.maxRemoteSteps) {
    return { error: `${label} exceeds the protocol step limit.` };
  }

  let total = 0;
  for (const [index, step] of steps.entries()) {
    if (typeof step !== "object" || step === null) {
      return { error: `${label}[${String(index)}] must be an object.` };
    }
    if (!isRemoteKey(step.key)) {
      return { error: `${label}[${String(index)}].key is not a supported remote key.` };
    }
    if (!Number.isSafeInteger(step.repeat) || step.repeat <= 0
      || step.repeat > PROTOCOL_VALIDATION_LIMITS.maxRemoteRepeat) {
      return {
        error: `${label}[${String(index)}].repeat must be a positive integer within the protocol limit.`,
      };
    }
    total += step.repeat;
    if (!Number.isSafeInteger(total)
      || total > PROTOCOL_VALIDATION_LIMITS.maxTotalRemotePresses) {
      return { error: `${label} expands beyond the protocol action-count limit.` };
    }
  }
  return { total };
}

function validElementLabel(value: string | null): boolean {
  return value === null || (typeof value === "string" && value.trim().length > 0);
}

function selectorIsValid(selector: ReplayElementSelector): boolean {
  const values = [selector.stableId, selector.role, selector.name];
  const stringsValid = values.every((value) => value === undefined
    || (typeof value === "string" && value.trim().length > 0));
  const rolesValid = selector.roles === undefined || (
    Array.isArray(selector.roles)
    && selector.roles.length > 0
    && selector.roles.every((role) => typeof role === "string" && role.trim().length > 0)
    && new Set(selector.roles).size === selector.roles.length
  );
  const hasIdentity = values.some((value) => typeof value === "string" && value.trim().length > 0)
    || (selector.roles?.length ?? 0) > 0;
  return stringsValid && rolesValid && hasIdentity
    && !(selector.role !== undefined && selector.roles !== undefined);
}

const ELEMENT_STATE_KEYS = [
  "present",
  "visible",
  "enabled",
  "focusable",
  "focused",
  "modal",
] as const;

function expectationIsValid(expectation: ReplayElementStateExpectation): boolean {
  let asserted = false;
  for (const key of ELEMENT_STATE_KEYS) {
    const value = expectation[key];
    if (value !== undefined) {
      if (typeof value !== "boolean") return false;
      asserted = true;
    }
  }
  if (!asserted) return false;
  if (expectation.present === false) {
    return ELEMENT_STATE_KEYS.every((key) => key === "present"
      || expectation[key] === undefined);
  }
  return true;
}

function validateElementAssertions(
  assertions: readonly ReplayElementStateAssertion[],
): string | null {
  if (!Array.isArray(assertions)) return "elementStateAssertions must be an array.";
  if (assertions.length > PROTOCOL_VALIDATION_LIMITS.maxListEntries) {
    return "elementStateAssertions exceeds the protocol list limit.";
  }
  for (const [index, assertion] of assertions.entries()) {
    if (typeof assertion !== "object" || assertion === null) {
      return `elementStateAssertions[${String(index)}] must be an object.`;
    }
    if (!selectorIsValid(assertion.selector)) {
      return `elementStateAssertions[${String(index)}].selector must contain at least one non-empty identity.`;
    }
    const expectations = [
      assertion.checkpoint,
      assertion.reproduced,
      assertion.fixed,
    ];
    if (expectations.every((expectation) => expectation === undefined)) {
      return `elementStateAssertions[${String(index)}] must assert at least one phase.`;
    }
    if (expectations.some((expectation) => expectation !== undefined
      && !expectationIsValid(expectation))) {
      return `elementStateAssertions[${String(index)}] contains an empty or contradictory expectation.`;
    }
  }
  return null;
}

function copySelector(selector: ReplayElementSelector): ReplayElementSelector {
  return {
    ...(selector.stableId === undefined ? {} : { stableId: selector.stableId }),
    ...(selector.role === undefined ? {} : { role: selector.role }),
    ...(selector.roles === undefined ? {} : { roles: [...selector.roles] }),
    ...(selector.name === undefined ? {} : { name: selector.name }),
  };
}

function copyExpectation(
  expectation: ReplayElementStateExpectation,
): ReplayElementStateExpectation {
  return {
    ...(expectation.present === undefined ? {} : { present: expectation.present }),
    ...(expectation.visible === undefined ? {} : { visible: expectation.visible }),
    ...(expectation.enabled === undefined ? {} : { enabled: expectation.enabled }),
    ...(expectation.focusable === undefined ? {} : { focusable: expectation.focusable }),
    ...(expectation.focused === undefined ? {} : { focused: expectation.focused }),
    ...(expectation.modal === undefined ? {} : { modal: expectation.modal }),
  };
}

function copyElementAssertion(
  assertion: ReplayElementStateAssertion,
): ReplayElementStateAssertion {
  return {
    selector: copySelector(assertion.selector),
    ...(assertion.checkpoint === undefined
      ? {}
      : { checkpoint: copyExpectation(assertion.checkpoint) }),
    ...(assertion.reproduced === undefined
      ? {}
      : { reproduced: copyExpectation(assertion.reproduced) }),
    ...(assertion.fixed === undefined
      ? {}
      : { fixed: copyExpectation(assertion.fixed) }),
  };
}

function splitSetupSteps(
  steps: readonly RemotePressStep[],
): readonly RemotePressStep[] {
  const setup = copySteps(steps);
  const final = setup.at(-1);
  if (final === undefined) return [];
  if (final.repeat === 1) {
    setup.pop();
  } else {
    setup[setup.length - 1] = { key: final.key, repeat: final.repeat - 1 };
  }
  return setup;
}

function invalidCompilation(message: string): ReplayCompilationResult {
  return {
    status: "invalid",
    reason: { code: "invalid-replay", message },
  };
}

/** Compile a validated portable replay into setup and assertion phases. */
export function compileReplay(
  replay: TVDoctorReplayV1,
  options: ReplayCompilationOptions = {},
): ReplayCompilationResult {
  try {
    parseTVDoctorReplayV1(replay);
  } catch (error) {
    return invalidCompilation(`Protocol replay validation failed: ${safeErrorMessage(error)}`);
  }
  if (options.confidence !== undefined
    && options.confidence !== "deterministic"
    && options.confidence !== "best-effort") {
    return invalidCompilation("Replay confidence must be deterministic or best-effort.");
  }
  if (options.confidence === "deterministic" && options.sourceIssue === undefined) {
    return invalidCompilation(
      "Deterministic replay confidence requires correlated sourceIssue provenance.",
    );
  }
  if (options.sourceIssue !== undefined) {
    const correlationError = replayMatchesIssue(replay, options.sourceIssue);
    if (correlationError !== null) return invalidCompilation(correlationError);
  }
  if (replay.schemaVersion !== REPLAY_SCHEMA_VERSION) {
    return invalidCompilation(`Unsupported replay schema version: ${String(replay.schemaVersion)}.`);
  }
  if (typeof replay.id !== "string" || replay.id.trim().length === 0) {
    return invalidCompilation("Replay id must be a non-empty string.");
  }
  if (typeof replay.issueId !== "string" || replay.issueId.trim().length === 0) {
    return invalidCompilation("Replay issueId must be a non-empty string.");
  }
  if (typeof replay.reset !== "object" || replay.reset === null
    || !["reload", "relaunch", "clear-data"].includes(replay.reset.strategy)) {
    return invalidCompilation("Replay reset strategy is invalid.");
  }
  if (typeof replay.assertion !== "object" || replay.assertion === null
    || replay.assertion.type !== "transition"
    || !isRemoteKey(replay.assertion.action)
    || !validElementLabel(replay.assertion.fromElement)
    || !validElementLabel(replay.assertion.expectedElement)
    || !validElementLabel(replay.assertion.observedElement)) {
    return invalidCompilation("Replay transition assertion is invalid.");
  }

  const stepsValidation = validateSteps(replay.steps, "Replay steps", false);
  if ("error" in stepsValidation) return invalidCompilation(stepsValidation.error);
  const finalStep = replay.steps.at(-1);
  if (finalStep === undefined || finalStep.key !== replay.assertion.action) {
    return invalidCompilation(
      "The final replay action must equal the transition assertion action.",
    );
  }

  const elementAssertions = [
    ...inferredElementAssertions(options.sourceIssue),
    ...(options.elementStateAssertions ?? []),
  ];
  const elementError = validateElementAssertions(elementAssertions);
  if (elementError !== null) return invalidCompilation(elementError);

  const issueReproduction = options.sourceIssue?.reproduction;
  const correlatedMetadata = issueReproduction?.status === "available"
    ? {
      originalSequence: issueReproduction.originalSequence,
      minimizedSequence: issueReproduction.minimizedSequence,
    }
    : null;
  if (correlatedMetadata !== null && options.sequenceMetadata !== undefined
    && (!sameSteps(
      correlatedMetadata.originalSequence,
      options.sequenceMetadata.originalSequence,
    ) || !sameNullableSteps(
      correlatedMetadata.minimizedSequence,
      options.sequenceMetadata.minimizedSequence,
    ))) {
    return invalidCompilation(
      "Sequence metadata does not match the correlated source issue.",
    );
  }
  const sourceMetadata = correlatedMetadata ?? options.sequenceMetadata ?? {
    originalSequence: replay.steps,
    minimizedSequence: null,
  };
  const originalValidation = validateSteps(
    sourceMetadata.originalSequence,
    "Original sequence metadata",
    false,
  );
  if ("error" in originalValidation) return invalidCompilation(originalValidation.error);
  if (!sameSteps(sourceMetadata.originalSequence, replay.steps)) {
    return invalidCompilation(
      "Original sequence metadata must exactly match the executable replay steps.",
    );
  }
  if (sourceMetadata.minimizedSequence !== null) {
    const minimizedValidation = validateSteps(
      sourceMetadata.minimizedSequence,
      "Minimized sequence metadata",
      false,
    );
    if ("error" in minimizedValidation) return invalidCompilation(minimizedValidation.error);
  }

  const copiedSteps = copySteps(replay.steps);
  const assertion: ReplayTransitionAssertion = {
    type: "transition",
    fromElement: replay.assertion.fromElement,
    action: replay.assertion.action,
    expectedElement: replay.assertion.expectedElement,
    observedElement: replay.assertion.observedElement,
  };
  const copiedReplay: TVDoctorReplayV1 = {
    schemaVersion: REPLAY_SCHEMA_VERSION,
    id: replay.id,
    issueId: replay.issueId,
    reset: { strategy: replay.reset.strategy },
    steps: copiedSteps,
    assertion,
  };

  const correlatedConfidence: ReproductionConfidence = options.sourceIssue === undefined
    ? "best-effort"
    : options.sourceIssue.confidence === "deterministic"
      && issueReproduction?.status === "available"
      && issueReproduction.confidence === "deterministic"
      && options.confidence !== "best-effort"
      ? "deterministic"
      : "best-effort";

  const plan = registerCompiledPlan({
    replay: copiedReplay,
    setup: {
      steps: splitSetupSteps(copiedSteps),
      checkpointFocusElement: assertion.fromElement,
    },
    assertion,
    elementStateAssertions: elementAssertions.map(copyElementAssertion),
    confidence: correlatedConfidence,
    totalActions: stepsValidation.total,
    sequence: {
      originalSequence: copySteps(sourceMetadata.originalSequence),
      minimizedSequence: sourceMetadata.minimizedSequence === null
        ? null
        : copySteps(sourceMetadata.minimizedSequence),
      executedSequence: "original",
      minimization: {
        status: "not-attempted",
        reason: REPLAY_MINIMIZATION_NOT_ATTEMPTED_REASON,
      },
    },
  });

  return {
    status: "compiled",
    plan,
  };
}

/** Build and compile the portable M5 replay carried by a diagnostic issue. */
export function compileIssueReplay(
  issue: TVDoctorIssue,
  options: ReplayCompilationOptions = {},
): ReplayCompilationResult {
  if (issue.reproduction.status === "unavailable") {
    return {
      status: "unavailable",
      reason: {
        code: "reproduction-unavailable",
        message: issue.reproduction.reason,
      },
    };
  }
  if (issue.transition === null) {
    return invalidCompilation(
      "An available issue reproduction needs a navigation transition assertion.",
    );
  }

  const issueConfidence: ReproductionConfidence = issue.confidence === "deterministic"
    && issue.reproduction.confidence === "deterministic"
    && options.confidence !== "best-effort"
    ? "deterministic"
    : "best-effort";
  const portableReplay: TVDoctorReplayV1 = {
    schemaVersion: REPLAY_SCHEMA_VERSION,
    id: `replay-${issue.id}`,
    issueId: issue.id,
    reset: { strategy: issue.reproduction.resetStrategy },
    steps: copySteps(issue.reproduction.originalSequence),
    assertion: {
      type: "transition",
      fromElement: issue.transition.fromElement,
      action: issue.transition.action,
      expectedElement: issue.transition.expectedElement,
      observedElement: issue.transition.observedElement,
    },
  };

  return compileReplay(portableReplay, {
    confidence: issueConfidence,
    ...(options.elementStateAssertions === undefined
      ? {}
      : { elementStateAssertions: options.elementStateAssertions }),
    sourceIssue: issue,
  });
}

function focusTargetMatches(target: FocusTarget, label: string): boolean {
  if (target.stableId !== undefined && target.stableId.trim().length > 0) {
    return target.stableId === label;
  }
  if (target.name !== undefined && target.name.trim().length > 0) {
    return target.name === label;
  }
  return target.role === label;
}

function evaluateFocus(
  snapshot: StateSnapshot,
  expected: string | null,
): PredicateEvaluation {
  if (snapshot.focusedElement.status === "unavailable") {
    return {
      status: "unobservable",
      detail: `Focus is unavailable: ${snapshot.focusedElement.reason}`,
    };
  }
  const actual = snapshot.focusedElement.value;
  if (expected === null) {
    return actual === null
      ? { status: "match", detail: "No focus target was observed, as asserted." }
      : { status: "mismatch", detail: "A focus target was observed where none was asserted." };
  }
  if (actual === null) {
    return {
      status: "mismatch",
      detail: `Expected focus on ${expected}, but no focus target was observed.`,
    };
  }
  return focusTargetMatches(actual, expected)
    ? { status: "match", detail: `Focus matched ${expected}.` }
    : { status: "mismatch", detail: `Focus did not match ${expected}.` };
}

function flattenUiTree(roots: readonly UiNodeSnapshot[]): readonly UiNodeSnapshot[] {
  const flattened: UiNodeSnapshot[] = [];
  const pending = [...roots].reverse();
  const visited = new Set<UiNodeSnapshot>();
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined || visited.has(node)) continue;
    visited.add(node);
    flattened.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) pending.push(child);
    }
  }
  return flattened;
}

function nodeMatchesSelector(
  node: UiNodeSnapshot,
  selector: ReplayElementSelector,
): boolean {
  return (selector.stableId === undefined || node.stableId === selector.stableId)
    && (selector.role === undefined || node.role === selector.role)
    && (selector.roles === undefined
      || (node.role !== null && selector.roles.includes(node.role)))
    && (selector.name === undefined || node.name === selector.name);
}

function selectorLabel(selector: ReplayElementSelector): string {
  return selector.stableId
    ?? selector.name
    ?? selector.role
    ?? selector.roles?.join(" or ")
    ?? "element";
}

function evaluateElementState(
  snapshot: StateSnapshot,
  selector: ReplayElementSelector,
  expectation: ReplayElementStateExpectation,
): PredicateEvaluation {
  if (snapshot.uiTree.status === "unavailable") {
    return {
      status: "unobservable",
      detail: `UI tree is unavailable: ${snapshot.uiTree.reason}`,
    };
  }
  const matches = flattenUiTree(snapshot.uiTree.value)
    .filter((node) => nodeMatchesSelector(node, selector));
  const label = selectorLabel(selector);
  if (expectation.present === false) {
    return matches.length === 0
      ? { status: "match", detail: `${label} is absent, as asserted.` }
      : { status: "mismatch", detail: `${label} is still present.` };
  }
  if (matches.length === 0) {
    return { status: "mismatch", detail: `${label} is absent.` };
  }
  const assertedProperties = [
    "visible",
    "enabled",
    "focusable",
    "focused",
    "modal",
  ].filter((key): key is Exclude<(typeof ELEMENT_STATE_KEYS)[number], "present"> => (
    expectation[key as Exclude<(typeof ELEMENT_STATE_KEYS)[number], "present">] !== undefined
  ));
  if (assertedProperties.length === 0) {
    return { status: "match", detail: `${label} is present, as asserted.` };
  }
  if (matches.length > 1) {
    return {
      status: "unobservable",
      detail: `${label} matched multiple UI nodes, so its state is ambiguous.`,
    };
  }
  const node = matches[0];
  if (node === undefined) {
    return { status: "mismatch", detail: `${label} is absent.` };
  }
  for (const property of assertedProperties) {
    const actual = node[property];
    const expected = expectation[property];
    if (actual === null) {
      return {
        status: "unobservable",
        detail: `${label}.${property} is unavailable.`,
      };
    }
    if (actual !== expected) {
      return {
        status: "mismatch",
        detail: `${label}.${property} did not match the assertion.`,
      };
    }
  }
  return { status: "match", detail: `${label} matched its asserted state.` };
}

function combinePredicates(
  predicates: readonly PredicateEvaluation[],
): PredicateEvaluation {
  if (predicates.length === 0) {
    return { status: "absent", detail: "No predicate was supplied." };
  }
  const mismatch = predicates.find((predicate) => predicate.status === "mismatch");
  if (mismatch !== undefined) return mismatch;
  const unobservable = predicates.find((predicate) => predicate.status === "unobservable");
  if (unobservable !== undefined) return unobservable;
  return { status: "match", detail: "Every predicate matched." };
}

function evaluateElementPhase(
  snapshot: StateSnapshot,
  assertions: readonly ReplayElementStateAssertion[],
  phase: "checkpoint" | "reproduced" | "fixed",
): readonly PredicateEvaluation[] {
  const evaluations: PredicateEvaluation[] = [];
  for (const assertion of assertions) {
    const expectation = assertion[phase];
    if (expectation !== undefined) {
      evaluations.push(evaluateElementState(snapshot, assertion.selector, expectation));
    }
  }
  return evaluations;
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withinDeadline<T>(
  deadline: ReplayDeadline,
  operation: () => T | Promise<T>,
): Promise<T> {
  const remainingMs = deadline.expiresAtMs - deadline.now();
  if (!(remainingMs > 0)) throw new ReplayDeadlineExceeded();

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new ReplayDeadlineExceeded());
        }, Math.min(remainingMs, MAX_REPLAY_DURATION_MS));
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function resultEvidence(evidence: MutableReplayEvidence): ReplayExecutionEvidence {
  return {
    beforeSnapshot: evidence.beforeSnapshot,
    afterSnapshot: evidence.afterSnapshot,
    setupActionResults: [...evidence.setupActionResults],
    assertionActionResult: evidence.assertionActionResult,
  };
}

function cloneForHook<T>(value: T): T {
  return structuredClone(value);
}

function elapsed(now: () => number, startedAtMs: number): number {
  try {
    const duration = now() - startedAtMs;
    return Number.isFinite(duration) ? Math.max(0, duration) : 0;
  } catch {
    return 0;
  }
}

interface ResultContext {
  readonly plan: CompiledReplayPlan;
  readonly now: () => number;
  readonly startedAtMs: number;
  readonly actionsPressed: number;
  readonly evidence: MutableReplayEvidence;
}

function executionResult(
  context: ResultContext,
  status: ReplayExecutionStatus,
  reason: ReplayExecutionReason | null,
): ReplayExecutionResult {
  return {
    status,
    reason,
    replayId: context.plan.replay.id,
    issueId: context.plan.replay.issueId,
    confidence: context.plan.confidence,
    actionsPressed: context.actionsPressed,
    elapsedMs: elapsed(context.now, context.startedAtMs),
    sequence: context.plan.sequence,
    evidence: resultEvidence(context.evidence),
  };
}

function reason(
  code: ReplayExecutionReasonCode,
  message: string,
  phase: ReplayExecutionPhase,
): ReplayExecutionReason {
  return { code, message, phase };
}

function timeoutResult(
  context: ResultContext,
  phase: ReplayExecutionPhase,
): ReplayExecutionResult {
  return executionResult(
    context,
    "inconclusive",
    reason(
      "duration-budget-exhausted",
      "The replay duration budget was exhausted before classification.",
      phase,
    ),
  );
}

type ExecutionPlanValidation =
  | { readonly status: "valid"; readonly plan: CompiledReplayPlan }
  | { readonly status: "invalid"; readonly reason: string };

function invalidExecutionPlan(reason: string): ExecutionPlanValidation {
  return { status: "invalid", reason };
}

function validateExecutionPlan(plan: CompiledReplayPlan): ExecutionPlanValidation {
  const registeredSignature = COMPILED_PLAN_SIGNATURES.get(plan);
  if (registeredSignature === undefined) {
    return invalidExecutionPlan("Replay plan was not produced by this compiler instance.");
  }
  let trustedPlan: CompiledReplayPlan;
  try {
    trustedPlan = structuredClone(plan);
  } catch {
    return invalidExecutionPlan("Replay plan could not be isolated for execution.");
  }
  const currentSignature = planSignature(trustedPlan);
  if (currentSignature === null || currentSignature !== registeredSignature) {
    return invalidExecutionPlan("Replay plan changed after compilation.");
  }
  if (trustedPlan.confidence !== "deterministic" && trustedPlan.confidence !== "best-effort") {
    return invalidExecutionPlan("Compiled replay confidence is invalid.");
  }
  try {
    parseTVDoctorReplayV1(trustedPlan.replay);
  } catch (error) {
    return invalidExecutionPlan(
      `Compiled portable replay is invalid: ${safeErrorMessage(error)}`,
    );
  }
  if (trustedPlan.assertion.type !== trustedPlan.replay.assertion.type
    || trustedPlan.assertion.fromElement !== trustedPlan.replay.assertion.fromElement
    || trustedPlan.assertion.action !== trustedPlan.replay.assertion.action
    || trustedPlan.assertion.expectedElement !== trustedPlan.replay.assertion.expectedElement
    || trustedPlan.assertion.observedElement !== trustedPlan.replay.assertion.observedElement) {
    return invalidExecutionPlan(
      "Compiled assertion does not exactly match the portable replay assertion.",
    );
  }
  const replaySteps = validateSteps(trustedPlan.replay.steps, "Compiled replay steps", false);
  if ("error" in replaySteps) return invalidExecutionPlan(replaySteps.error);
  const setupSteps = validateSteps(trustedPlan.setup.steps, "Compiled setup steps", true);
  if ("error" in setupSteps) return invalidExecutionPlan(setupSteps.error);
  if (!sameSteps(trustedPlan.setup.steps, splitSetupSteps(trustedPlan.replay.steps))) {
    return invalidExecutionPlan("Compiled setup steps do not exactly match the replay prefix.");
  }
  if (replaySteps.total !== trustedPlan.totalActions
    || setupSteps.total + 1 !== trustedPlan.totalActions) {
    return invalidExecutionPlan("Compiled replay action counts are inconsistent.");
  }
  const final = trustedPlan.replay.steps.at(-1);
  if (final === undefined || final.key !== trustedPlan.assertion.action) {
    return invalidExecutionPlan("Compiled replay final action does not match its assertion.");
  }
  if (trustedPlan.setup.checkpointFocusElement !== trustedPlan.assertion.fromElement) {
    return invalidExecutionPlan(
      "Compiled replay checkpoint does not match its transition source.",
    );
  }
  const originalSteps = validateSteps(
    trustedPlan.sequence.originalSequence,
    "Compiled original sequence metadata",
    false,
  );
  if ("error" in originalSteps) return invalidExecutionPlan(originalSteps.error);
  if (!sameSteps(trustedPlan.sequence.originalSequence, trustedPlan.replay.steps)) {
    return invalidExecutionPlan(
      "Compiled original sequence metadata does not match replay steps.",
    );
  }
  if (trustedPlan.sequence.minimizedSequence !== null) {
    const minimizedSteps = validateSteps(
      trustedPlan.sequence.minimizedSequence,
      "Compiled minimized sequence metadata",
      false,
    );
    if ("error" in minimizedSteps) return invalidExecutionPlan(minimizedSteps.error);
  }
  if (trustedPlan.sequence.executedSequence !== "original"
    || trustedPlan.sequence.minimization.status !== "not-attempted"
    || trustedPlan.sequence.minimization.reason !== REPLAY_MINIMIZATION_NOT_ATTEMPTED_REASON) {
    return invalidExecutionPlan("Compiled sequence provenance is invalid.");
  }
  const elementError = validateElementAssertions(trustedPlan.elementStateAssertions);
  return elementError === null
    ? { status: "valid", plan: trustedPlan }
    : invalidExecutionPlan(elementError);
}

/**
 * Restore, replay the exact setup sequence, validate its checkpoint, and then
 * execute the single assertion action. A changed-but-unexpected state is always
 * inconclusive; it is never classified as fixed.
 */
export async function executeReplay(
  driver: TVDoctorDriver,
  plan: CompiledReplayPlan,
  options: ReplayExecutionOptions = {},
): Promise<ReplayExecutionResult> {
  const now = options.now ?? (() => performance.now());
  let startedAtMs: number;
  try {
    startedAtMs = now();
  } catch (error) {
    startedAtMs = 0;
    const evidence: MutableReplayEvidence = {
      beforeSnapshot: null,
      afterSnapshot: null,
      setupActionResults: [],
      assertionActionResult: null,
    };
    return executionResult(
      { plan, now: () => 0, startedAtMs, actionsPressed: 0, evidence },
      "error",
      reason("invalid-options", `Replay clock failed: ${safeErrorMessage(error)}`, "preflight"),
    );
  }

  const evidence: MutableReplayEvidence = {
    beforeSnapshot: null,
    afterSnapshot: null,
    setupActionResults: [],
    assertionActionResult: null,
  };
  let actionsPressed = 0;
  const context = (): ResultContext => ({
    plan,
    now,
    startedAtMs,
    actionsPressed,
    evidence,
  });
  const interruptionResult = (
    phase: ReplayExecutionPhase,
  ): ReplayExecutionResult | null => options.signal?.aborted === true
    ? executionResult(
      context(),
      "inconclusive",
      reason("interrupted", "Replay was interrupted after the current operation.", phase),
    )
    : null;

  const maxActions = options.budgets?.maxActions ?? DEFAULT_REPLAY_BUDGETS.maxActions;
  const maxDurationMs = options.budgets?.maxDurationMs
    ?? DEFAULT_REPLAY_BUDGETS.maxDurationMs;
  if (!Number.isSafeInteger(maxActions) || maxActions < 0
    || !Number.isSafeInteger(maxDurationMs) || maxDurationMs <= 0
    || maxDurationMs > MAX_REPLAY_DURATION_MS
    || !Number.isFinite(startedAtMs)) {
    return executionResult(
      context(),
      "error",
      reason(
        "invalid-options",
        `Replay budgets require a non-negative safe action count and a duration from 1 through ${String(MAX_REPLAY_DURATION_MS)} ms.`,
        "preflight",
      ),
    );
  }
  const planValidation = validateExecutionPlan(plan);
  if (planValidation.status === "invalid") {
    return executionResult(
      context(),
      "error",
      reason("invalid-plan", planValidation.reason, "preflight"),
    );
  }
  plan = planValidation.plan;
  const preflightInterruption = interruptionResult("preflight");
  if (preflightInterruption !== null) return preflightInterruption;
  if (plan.totalActions > maxActions) {
    return executionResult(
      context(),
      "inconclusive",
      reason(
        "action-budget-exhausted",
        `Replay needs ${String(plan.totalActions)} actions but the budget allows ${String(maxActions)}.`,
        "preflight",
      ),
    );
  }

  const deadline: ReplayDeadline = {
    expiresAtMs: startedAtMs + maxDurationMs,
    now,
  };
  let capabilities: ReadonlySet<string>;
  try {
    capabilities = await withinDeadline(deadline, () => driver.capabilities());
  } catch (error) {
    if (error instanceof ReplayDeadlineExceeded) return timeoutResult(context(), "capabilities");
    return executionResult(
      context(),
      "error",
      reason("driver-error", safeErrorMessage(error), "capabilities"),
    );
  }
  const capabilitiesInterruption = interruptionResult("capabilities");
  if (capabilitiesInterruption !== null) return capabilitiesInterruption;
  if (!capabilities.has("remote-input")) {
    return executionResult(
      context(),
      "inconclusive",
      reason(
        "remote-input-unavailable",
        "The driver does not advertise remote-input capability.",
        "capabilities",
      ),
    );
  }

  const resetInterruption = interruptionResult("reset");
  if (resetInterruption !== null) return resetInterruption;
  try {
    if (options.restore !== undefined) {
      const restoreContext = cloneForHook<ReplayRestoreContext>({
        plan,
        strategy: plan.replay.reset.strategy,
      });
      await withinDeadline(deadline, () => options.restore?.(restoreContext));
    } else if (driver.reset !== undefined) {
      await withinDeadline(deadline, () => driver.reset?.(plan.replay.reset.strategy));
    } else {
      return executionResult(
        context(),
        "inconclusive",
        reason(
          "reset-unavailable",
          "The driver has no reset method and no restoration hook was supplied.",
          "reset",
        ),
      );
    }
  } catch (error) {
    if (error instanceof ReplayDeadlineExceeded) return timeoutResult(context(), "reset");
    return executionResult(
      context(),
      "error",
      reason("reset-error", safeErrorMessage(error), "reset"),
    );
  }
  const afterResetInterruption = interruptionResult("reset");
  if (afterResetInterruption !== null) return afterResetInterruption;

  const press = async (
    key: RemoteKey,
    phase: "setup" | "assertion",
  ): Promise<ReplayExecutionResult | ActionResult> => {
    const beforeInputInterruption = interruptionResult(phase);
    if (beforeInputInterruption !== null) return beforeInputInterruption;
    if (actionsPressed >= maxActions) {
      return executionResult(
        context(),
        "inconclusive",
        reason("action-budget-exhausted", "Replay action budget was exhausted.", phase),
      );
    }
    let actionResult: ActionResult;
    try {
      actionResult = await withinDeadline(deadline, () => driver.press(key));
      actionsPressed += 1;
    } catch (error) {
      if (error instanceof ReplayDeadlineExceeded) return timeoutResult(context(), phase);
      return executionResult(
        context(),
        "error",
        reason("input-error", safeErrorMessage(error), phase),
      );
    }
    const afterInputInterruption = interruptionResult(phase);
    if (afterInputInterruption !== null) return afterInputInterruption;
    if (actionResult.key !== key) {
      return executionResult(
        context(),
        "error",
        reason(
          "input-result-mismatch",
          `Driver returned ${actionResult.key} for requested ${key}.`,
          phase,
        ),
      );
    }
    if (actionResult.outcome === "unsupported") {
      return executionResult(
        context(),
        "inconclusive",
        reason("input-unavailable", actionResult.message ?? `${key} is unsupported.`, phase),
      );
    }
    if (actionResult.outcome === "failed") {
      return executionResult(
        context(),
        "error",
        reason("input-failed", actionResult.message ?? `${key} failed.`, phase),
      );
    }
    if (actionResult.outcome === "inconclusive") {
      return executionResult(
        context(),
        "inconclusive",
        reason(
          "input-unobserved",
          actionResult.message ?? `${key} could not be observed after delivery.`,
          phase,
        ),
      );
    }
    return actionResult;
  };

  for (const step of plan.setup.steps) {
    for (let repeat = 0; repeat < step.repeat; repeat += 1) {
      const actionResult = await press(step.key, "setup");
      if ("status" in actionResult) return actionResult;
      evidence.setupActionResults.push(actionResult);
    }
  }

  const checkpointInterruption = interruptionResult("checkpoint");
  if (checkpointInterruption !== null) return checkpointInterruption;
  try {
    evidence.beforeSnapshot = await withinDeadline(deadline, () => driver.snapshot());
  } catch (error) {
    if (error instanceof ReplayDeadlineExceeded) return timeoutResult(context(), "checkpoint");
    return executionResult(
      context(),
      "error",
      reason("snapshot-error", safeErrorMessage(error), "checkpoint"),
    );
  }
  const afterCheckpointInterruption = interruptionResult("checkpoint");
  if (afterCheckpointInterruption !== null) return afterCheckpointInterruption;

  let checkpoint: PredicateEvaluation;
  try {
    checkpoint = combinePredicates([
      evaluateFocus(evidence.beforeSnapshot, plan.setup.checkpointFocusElement),
      ...evaluateElementPhase(
        evidence.beforeSnapshot,
        plan.elementStateAssertions,
        "checkpoint",
      ),
    ]);
  } catch (error) {
    return executionResult(
      context(),
      "error",
      reason("evaluation-error", safeErrorMessage(error), "checkpoint"),
    );
  }
  if (checkpoint.status === "unobservable") {
    return executionResult(
      context(),
      "inconclusive",
      reason("observation-unavailable", checkpoint.detail, "checkpoint"),
    );
  }
  if (checkpoint.status !== "match") {
    return executionResult(
      context(),
      "inconclusive",
      reason("checkpoint-drift", checkpoint.detail, "checkpoint"),
    );
  }

  if (options.evidence?.captureBefore !== undefined) {
    const beforeEvidenceInterruption = interruptionResult("before-evidence");
    if (beforeEvidenceInterruption !== null) return beforeEvidenceInterruption;
    try {
      const hookContext = cloneForHook<ReplayBeforeEvidenceContext>({
        plan,
        snapshot: evidence.beforeSnapshot,
        setupActionResults: [...evidence.setupActionResults],
      });
      await withinDeadline(deadline, () => options.evidence?.captureBefore?.(hookContext));
    } catch (error) {
      if (error instanceof ReplayDeadlineExceeded) return timeoutResult(context(), "before-evidence");
      return executionResult(
        context(),
        "error",
        reason("evidence-error", safeErrorMessage(error), "before-evidence"),
      );
    }
    const afterBeforeEvidenceInterruption = interruptionResult("before-evidence");
    if (afterBeforeEvidenceInterruption !== null) return afterBeforeEvidenceInterruption;
  }

  const assertionResult = await press(plan.assertion.action, "assertion");
  if ("status" in assertionResult) return assertionResult;
  evidence.assertionActionResult = assertionResult;

  const afterSnapshotInterruption = interruptionResult("after-snapshot");
  if (afterSnapshotInterruption !== null) return afterSnapshotInterruption;
  try {
    evidence.afterSnapshot = await withinDeadline(deadline, () => driver.snapshot());
  } catch (error) {
    if (error instanceof ReplayDeadlineExceeded) return timeoutResult(context(), "after-snapshot");
    return executionResult(
      context(),
      "error",
      reason("snapshot-error", safeErrorMessage(error), "after-snapshot"),
    );
  }
  const capturedAfterInterruption = interruptionResult("after-snapshot");
  if (capturedAfterInterruption !== null) return capturedAfterInterruption;

  if (options.evidence?.captureAfter !== undefined) {
    const beforeSnapshot = evidence.beforeSnapshot;
    const afterSnapshot = evidence.afterSnapshot;
    if (beforeSnapshot === null || afterSnapshot === null) {
      return executionResult(
        context(),
        "error",
        reason("invalid-plan", "Replay evidence snapshots were unexpectedly absent.", "after-evidence"),
      );
    }
    try {
      const afterEvidenceInterruption = interruptionResult("after-evidence");
      if (afterEvidenceInterruption !== null) return afterEvidenceInterruption;
      const hookContext = cloneForHook<ReplayAfterEvidenceContext>({
        plan,
        snapshot: afterSnapshot,
        setupActionResults: [...evidence.setupActionResults],
        beforeSnapshot,
        actionResult: assertionResult,
        afterSnapshot,
      });
      await withinDeadline(deadline, () => options.evidence?.captureAfter?.(hookContext));
    } catch (error) {
      if (error instanceof ReplayDeadlineExceeded) return timeoutResult(context(), "after-evidence");
      return executionResult(
        context(),
        "error",
        reason("evidence-error", safeErrorMessage(error), "after-evidence"),
      );
    }
    const capturedEvidenceInterruption = interruptionResult("after-evidence");
    if (capturedEvidenceInterruption !== null) return capturedEvidenceInterruption;
  }

  try {
    if (!(deadline.expiresAtMs - deadline.now() > 0)) {
      return timeoutResult(context(), "evaluation");
    }
  } catch (error) {
    return executionResult(
      context(),
      "error",
      reason("invalid-options", `Replay clock failed: ${safeErrorMessage(error)}`, "evaluation"),
    );
  }

  let reproduced: PredicateEvaluation;
  let fixed: PredicateEvaluation;
  try {
    reproduced = combinePredicates([
      evaluateFocus(evidence.afterSnapshot, plan.assertion.observedElement),
      ...evaluateElementPhase(
        evidence.afterSnapshot,
        plan.elementStateAssertions,
        "reproduced",
      ),
    ]);
    const fixedPredicates = [
      ...(plan.assertion.expectedElement === null
        ? []
        : [evaluateFocus(evidence.afterSnapshot, plan.assertion.expectedElement)]),
      ...evaluateElementPhase(
        evidence.afterSnapshot,
        plan.elementStateAssertions,
        "fixed",
      ),
    ];
    fixed = combinePredicates(fixedPredicates);
  } catch (error) {
    return executionResult(
      context(),
      "error",
      reason("evaluation-error", safeErrorMessage(error), "evaluation"),
    );
  }

  try {
    if (!(deadline.expiresAtMs - deadline.now() > 0)) {
      return timeoutResult(context(), "evaluation");
    }
  } catch (error) {
    return executionResult(
      context(),
      "error",
      reason("invalid-options", `Replay clock failed: ${safeErrorMessage(error)}`, "evaluation"),
    );
  }

  if (reproduced.status === "match" && fixed.status === "match") {
    return executionResult(
      context(),
      "inconclusive",
      reason(
        "assertion-ambiguous",
        "The observed failure and corrected-state predicates both matched.",
        "evaluation",
      ),
    );
  }
  if (reproduced.status === "match") {
    return executionResult(context(), "reproduced", null);
  }
  if (fixed.status === "match") {
    if (plan.confidence === "deterministic") {
      return executionResult(context(), "fixed", null);
    }
    return executionResult(
      context(),
      "inconclusive",
      reason(
        "best-effort-cannot-prove-fixed",
        "The expected state matched, but a best-effort replay cannot prove the issue fixed.",
        "evaluation",
      ),
    );
  }
  if (reproduced.status === "unobservable" || fixed.status === "unobservable") {
    const unavailable = reproduced.status === "unobservable" ? reproduced : fixed;
    return executionResult(
      context(),
      "inconclusive",
      reason("observation-unavailable", unavailable.detail, "evaluation"),
    );
  }
  return executionResult(
    context(),
    "inconclusive",
    reason(
      "assertion-drift",
      "The result matched neither the reproduced failure nor an explicit corrected state.",
      "evaluation",
    ),
  );
}
