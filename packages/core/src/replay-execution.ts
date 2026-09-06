import type { ActionResult, RemoteKey, StateSnapshot, TVDoctorDriver } from "@tvdoctor/protocol";

import {
  DEFAULT_REPLAY_BUDGETS,
  MAX_REPLAY_DURATION_MS,
  type CompiledReplayPlan,
  type ReplayAfterEvidenceContext,
  type ReplayBeforeEvidenceContext,
  type ReplayExecutionEvidence,
  type ReplayExecutionOptions,
  type ReplayExecutionPhase,
  type ReplayExecutionReason,
  type ReplayExecutionReasonCode,
  type ReplayExecutionResult,
  type ReplayExecutionStatus,
  type ReplayRestoreContext,
} from "./replay-contracts.js";
import { validateCompiledReplayPlan } from "./replay-compilation.js";
import { elapsed, ReplayDeadlineExceeded, safeErrorMessage, withinDeadline, type ReplayDeadline } from "./replay-deadline.js";
import { combinePredicates, evaluateElementPhase, evaluateFocus, type PredicateEvaluation } from "./replay-evaluation.js";

interface MutableReplayEvidence {
  beforeSnapshot: StateSnapshot | null;
  afterSnapshot: StateSnapshot | null;
  setupActionResults: ActionResult[];
  assertionActionResult: ActionResult | null;
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

function reason(code: ReplayExecutionReasonCode, message: string, phase: ReplayExecutionPhase): ReplayExecutionReason {
  return { code, message, phase };
}

function timeoutResult(context: ResultContext, phase: ReplayExecutionPhase): ReplayExecutionResult {
  return executionResult(context, "inconclusive", reason(
    "duration-budget-exhausted",
    "The replay duration budget was exhausted before classification.",
    phase,
  ));
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
      beforeSnapshot: null, afterSnapshot: null, setupActionResults: [], assertionActionResult: null,
    };
    return executionResult(
      { plan, now: () => 0, startedAtMs, actionsPressed: 0, evidence },
      "error",
      reason("invalid-options", `Replay clock failed: ${safeErrorMessage(error)}`, "preflight"),
    );
  }
  const evidence: MutableReplayEvidence = {
    beforeSnapshot: null, afterSnapshot: null, setupActionResults: [], assertionActionResult: null,
  };
  let actionsPressed = 0;
  const context = (): ResultContext => ({ plan, now, startedAtMs, actionsPressed, evidence });
  const interruptionResult = (phase: ReplayExecutionPhase): ReplayExecutionResult | null => options.signal?.aborted === true
    ? executionResult(context(), "inconclusive", reason(
      "interrupted", "Replay was interrupted after the current operation.", phase,
    ))
    : null;

  const maxActions = options.budgets?.maxActions ?? DEFAULT_REPLAY_BUDGETS.maxActions;
  const maxDurationMs = options.budgets?.maxDurationMs ?? DEFAULT_REPLAY_BUDGETS.maxDurationMs;
  if (!Number.isSafeInteger(maxActions) || maxActions < 0
    || !Number.isSafeInteger(maxDurationMs) || maxDurationMs <= 0
    || maxDurationMs > MAX_REPLAY_DURATION_MS || !Number.isFinite(startedAtMs)) {
    return executionResult(context(), "error", reason(
      "invalid-options",
      `Replay budgets require a non-negative safe action count and a duration from 1 through ${String(MAX_REPLAY_DURATION_MS)} ms.`,
      "preflight",
    ));
  }
  const planValidation = validateCompiledReplayPlan(plan);
  if (planValidation.status === "invalid") {
    return executionResult(context(), "error", reason("invalid-plan", planValidation.reason, "preflight"));
  }
  plan = planValidation.plan;
  const preflightInterruption = interruptionResult("preflight");
  if (preflightInterruption !== null) return preflightInterruption;
  if (plan.totalActions > maxActions) {
    return executionResult(context(), "inconclusive", reason(
      "action-budget-exhausted",
      `Replay needs ${String(plan.totalActions)} actions but the budget allows ${String(maxActions)}.`,
      "preflight",
    ));
  }

  const deadline: ReplayDeadline = { expiresAtMs: startedAtMs + maxDurationMs, now };
  let capabilities: ReadonlySet<string>;
  try {
    capabilities = await withinDeadline(deadline, () => driver.capabilities());
  } catch (error) {
    if (error instanceof ReplayDeadlineExceeded) return timeoutResult(context(), "capabilities");
    return executionResult(context(), "error", reason("driver-error", safeErrorMessage(error), "capabilities"));
  }
  const capabilitiesInterruption = interruptionResult("capabilities");
  if (capabilitiesInterruption !== null) return capabilitiesInterruption;
  if (!capabilities.has("remote-input")) {
    return executionResult(context(), "inconclusive", reason(
      "remote-input-unavailable", "The driver does not advertise remote-input capability.", "capabilities",
    ));
  }

  const resetInterruption = interruptionResult("reset");
  if (resetInterruption !== null) return resetInterruption;
  try {
    if (options.restore !== undefined) {
      const restoreContext = cloneForHook<ReplayRestoreContext>({ plan, strategy: plan.replay.reset.strategy });
      await withinDeadline(deadline, () => options.restore?.(restoreContext));
    } else if (driver.reset !== undefined) {
      await withinDeadline(deadline, () => driver.reset?.(plan.replay.reset.strategy));
    } else {
      return executionResult(context(), "inconclusive", reason(
        "reset-unavailable", "The driver has no reset method and no restoration hook was supplied.", "reset",
      ));
    }
  } catch (error) {
    if (error instanceof ReplayDeadlineExceeded) return timeoutResult(context(), "reset");
    return executionResult(context(), "error", reason("reset-error", safeErrorMessage(error), "reset"));
  }
  const afterResetInterruption = interruptionResult("reset");
  if (afterResetInterruption !== null) return afterResetInterruption;

  const press = async (key: RemoteKey, phase: "setup" | "assertion"): Promise<ReplayExecutionResult | ActionResult> => {
    const beforeInputInterruption = interruptionResult(phase);
    if (beforeInputInterruption !== null) return beforeInputInterruption;
    if (actionsPressed >= maxActions) {
      return executionResult(context(), "inconclusive", reason(
        "action-budget-exhausted", "Replay action budget was exhausted.", phase,
      ));
    }
    let actionResult: ActionResult;
    try {
      actionResult = await withinDeadline(deadline, () => driver.press(key));
      actionsPressed += 1;
    } catch (error) {
      if (error instanceof ReplayDeadlineExceeded) return timeoutResult(context(), phase);
      return executionResult(context(), "error", reason("input-error", safeErrorMessage(error), phase));
    }
    const afterInputInterruption = interruptionResult(phase);
    if (afterInputInterruption !== null) return afterInputInterruption;
    if (actionResult.key !== key) {
      return executionResult(context(), "error", reason(
        "input-result-mismatch", `Driver returned ${actionResult.key} for requested ${key}.`, phase,
      ));
    }
    if (actionResult.outcome === "unsupported") {
      return executionResult(context(), "inconclusive", reason(
        "input-unavailable", actionResult.message ?? `${key} is unsupported.`, phase,
      ));
    }
    if (actionResult.outcome === "failed") {
      return executionResult(context(), "error", reason(
        "input-failed", actionResult.message ?? `${key} failed.`, phase,
      ));
    }
    if (actionResult.outcome === "inconclusive") {
      return executionResult(context(), "inconclusive", reason(
        "input-unobserved", actionResult.message ?? `${key} could not be observed after delivery.`, phase,
      ));
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
    return executionResult(context(), "error", reason("snapshot-error", safeErrorMessage(error), "checkpoint"));
  }
  const afterCheckpointInterruption = interruptionResult("checkpoint");
  if (afterCheckpointInterruption !== null) return afterCheckpointInterruption;
  let checkpoint: PredicateEvaluation;
  try {
    checkpoint = combinePredicates([
      evaluateFocus(evidence.beforeSnapshot, plan.setup.checkpointFocusElement),
      ...evaluateElementPhase(evidence.beforeSnapshot, plan.elementStateAssertions, "checkpoint"),
    ]);
  } catch (error) {
    return executionResult(context(), "error", reason("evaluation-error", safeErrorMessage(error), "checkpoint"));
  }
  if (checkpoint.status === "unobservable") {
    return executionResult(context(), "inconclusive", reason("observation-unavailable", checkpoint.detail, "checkpoint"));
  }
  if (checkpoint.status !== "match") {
    return executionResult(context(), "inconclusive", reason("checkpoint-drift", checkpoint.detail, "checkpoint"));
  }

  if (options.evidence?.captureBefore !== undefined) {
    const beforeEvidenceInterruption = interruptionResult("before-evidence");
    if (beforeEvidenceInterruption !== null) return beforeEvidenceInterruption;
    try {
      const hookContext = cloneForHook<ReplayBeforeEvidenceContext>({
        plan, snapshot: evidence.beforeSnapshot, setupActionResults: [...evidence.setupActionResults],
      });
      await withinDeadline(deadline, () => options.evidence?.captureBefore?.(hookContext));
    } catch (error) {
      if (error instanceof ReplayDeadlineExceeded) return timeoutResult(context(), "before-evidence");
      return executionResult(context(), "error", reason("evidence-error", safeErrorMessage(error), "before-evidence"));
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
    return executionResult(context(), "error", reason("snapshot-error", safeErrorMessage(error), "after-snapshot"));
  }
  const capturedAfterInterruption = interruptionResult("after-snapshot");
  if (capturedAfterInterruption !== null) return capturedAfterInterruption;

  if (options.evidence?.captureAfter !== undefined) {
    const beforeSnapshot = evidence.beforeSnapshot;
    const afterSnapshot = evidence.afterSnapshot;
    if (beforeSnapshot === null || afterSnapshot === null) {
      return executionResult(context(), "error", reason(
        "invalid-plan", "Replay evidence snapshots were unexpectedly absent.", "after-evidence",
      ));
    }
    try {
      const afterEvidenceInterruption = interruptionResult("after-evidence");
      if (afterEvidenceInterruption !== null) return afterEvidenceInterruption;
      const hookContext = cloneForHook<ReplayAfterEvidenceContext>({
        plan, snapshot: afterSnapshot, setupActionResults: [...evidence.setupActionResults],
        beforeSnapshot, actionResult: assertionResult, afterSnapshot,
      });
      await withinDeadline(deadline, () => options.evidence?.captureAfter?.(hookContext));
    } catch (error) {
      if (error instanceof ReplayDeadlineExceeded) return timeoutResult(context(), "after-evidence");
      return executionResult(context(), "error", reason("evidence-error", safeErrorMessage(error), "after-evidence"));
    }
    const capturedEvidenceInterruption = interruptionResult("after-evidence");
    if (capturedEvidenceInterruption !== null) return capturedEvidenceInterruption;
  }
  try {
    if (!(deadline.expiresAtMs - deadline.now() > 0)) return timeoutResult(context(), "evaluation");
  } catch (error) {
    return executionResult(context(), "error", reason(
      "invalid-options", `Replay clock failed: ${safeErrorMessage(error)}`, "evaluation",
    ));
  }
  let reproduced: PredicateEvaluation;
  let fixed: PredicateEvaluation;
  try {
    reproduced = combinePredicates([
      evaluateFocus(evidence.afterSnapshot, plan.assertion.observedElement),
      ...evaluateElementPhase(evidence.afterSnapshot, plan.elementStateAssertions, "reproduced"),
    ]);
    const fixedPredicates = [
      ...(plan.assertion.expectedElement === null ? [] : [evaluateFocus(evidence.afterSnapshot, plan.assertion.expectedElement)]),
      ...evaluateElementPhase(evidence.afterSnapshot, plan.elementStateAssertions, "fixed"),
    ];
    fixed = combinePredicates(fixedPredicates);
  } catch (error) {
    return executionResult(context(), "error", reason("evaluation-error", safeErrorMessage(error), "evaluation"));
  }
  try {
    if (!(deadline.expiresAtMs - deadline.now() > 0)) return timeoutResult(context(), "evaluation");
  } catch (error) {
    return executionResult(context(), "error", reason(
      "invalid-options", `Replay clock failed: ${safeErrorMessage(error)}`, "evaluation",
    ));
  }
  if (reproduced.status === "match" && fixed.status === "match") {
    return executionResult(context(), "inconclusive", reason(
      "assertion-ambiguous", "The observed failure and corrected-state predicates both matched.", "evaluation",
    ));
  }
  if (reproduced.status === "match") return executionResult(context(), "reproduced", null);
  if (fixed.status === "match") {
    if (plan.confidence === "deterministic") return executionResult(context(), "fixed", null);
    return executionResult(context(), "inconclusive", reason(
      "best-effort-cannot-prove-fixed",
      "The expected state matched, but a best-effort replay cannot prove the issue fixed.",
      "evaluation",
    ));
  }
  if (reproduced.status === "unobservable" || fixed.status === "unobservable") {
    const unavailable = reproduced.status === "unobservable" ? reproduced : fixed;
    return executionResult(context(), "inconclusive", reason("observation-unavailable", unavailable.detail, "evaluation"));
  }
  return executionResult(context(), "inconclusive", reason(
    "assertion-drift", "The result matched neither the reproduced failure nor an explicit corrected state.", "evaluation",
  ));
}
