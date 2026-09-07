import type {
  ActionResult,
  RemotePressStep,
  ReplayTransitionAssertion,
  ReproductionConfidence,
  StateSnapshot,
  TVDoctorIssue,
  TVDoctorReplayV1,
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

/** Element predicates supplement the transition assertion. */
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
  /** Portable replays default to best-effort unless confidence is supplied. */
  readonly confidence?: ReproductionConfidence;
  readonly elementStateAssertions?: readonly ReplayElementStateAssertion[];
  readonly sequenceMetadata?: ReplaySequenceSourceMetadata;
  /** Trusted issue provenance for a replay loaded from a report. */
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
  /** Process-local plan; persist replay and compile it again instead. */
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
  | { readonly status: "compiled"; readonly plan: CompiledReplayPlan }
  | { readonly status: "unavailable"; readonly reason: ReplayCompilationReason }
  | { readonly status: "invalid"; readonly reason: ReplayCompilationReason };

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
  readonly captureBefore?: (context: ReplayBeforeEvidenceContext) => void | Promise<void>;
  readonly captureAfter?: (context: ReplayAfterEvidenceContext) => void | Promise<void>;
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

export const REPLAY_EXECUTION_STATUSES = ["reproduced", "fixed", "inconclusive", "error"] as const;
export type ReplayExecutionStatus = (typeof REPLAY_EXECUTION_STATUSES)[number];

export const REPLAY_EXECUTION_REASON_CODES = [
  "action-budget-exhausted", "duration-budget-exhausted", "remote-input-unavailable",
  "reset-unavailable", "input-unavailable", "input-unobserved", "checkpoint-drift",
  "observation-unavailable", "assertion-drift", "assertion-ambiguous",
  "best-effort-cannot-prove-fixed", "invalid-options", "invalid-plan", "driver-error",
  "reset-error", "input-failed", "input-error", "input-result-mismatch", "snapshot-error",
  "evaluation-error", "evidence-error", "interrupted",
] as const;
export type ReplayExecutionReasonCode = (typeof REPLAY_EXECUTION_REASON_CODES)[number];

export const REPLAY_EXECUTION_PHASES = [
  "preflight", "capabilities", "reset", "setup", "checkpoint", "before-evidence",
  "assertion", "after-snapshot", "after-evidence", "evaluation",
] as const;
export type ReplayExecutionPhase = (typeof REPLAY_EXECUTION_PHASES)[number];

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
