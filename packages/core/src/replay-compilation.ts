import {
  REPLAY_SCHEMA_VERSION,
  PROTOCOL_VALIDATION_LIMITS,
  isRemoteKey,
  parseTVDoctorReplayV1,
  type RemotePressStep,
  type ReplayTransitionAssertion,
  type ReproductionConfidence,
  type TVDoctorIssue,
  type TVDoctorReplayV1,
} from "@tvdoctor/protocol";

import {
  REPLAY_MINIMIZATION_NOT_ATTEMPTED_REASON,
  type CompiledReplayPlan,
  type ReplayCompilationOptions,
  type ReplayCompilationResult,
  type ReplayElementSelector,
  type ReplayElementStateAssertion,
  type ReplayElementStateExpectation,
  type ReplayModalOpenIdentity,
} from "./replay-contracts.js";

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

function sameSteps(left: readonly RemotePressStep[], right: readonly RemotePressStep[]): boolean {
  return left.length === right.length && left.every((step, index) => {
    const other = right[index];
    return other !== undefined && step.key === other.key && step.repeat === other.repeat;
  });
}

function sameNullableSteps(
  left: readonly RemotePressStep[] | null,
  right: readonly RemotePressStep[] | null,
): boolean {
  return left === null || right === null ? left === right : sameSteps(left, right);
}

function replayMatchesIssue(replay: TVDoctorReplayV1, issue: TVDoctorIssue): string | null {
  if (replay.issueId !== issue.id) return "Replay issueId does not match its source issue.";
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

function inferredElementAssertions(issue: TVDoctorIssue | undefined): readonly ReplayElementStateAssertion[] {
  if (issue?.rule === "remote.focus-trap") {
    return [{
      selector: { roles: ["dialog", "alertdialog"] },
      checkpoint: { present: true, visible: true, modal: true },
      reproduced: { present: true, visible: true, modal: true },
      fixed: { present: false },
    }];
  }
  if (issue?.rule === "keyboard.modal-focus-escape") {
    return [{
      selector: { roles: ["dialog", "alertdialog"] },
      checkpoint: { present: true, visible: true, modal: true, containsFocus: true },
      reproduced: { present: true, visible: true, modal: true, containsFocus: false,
        sameAsCheckpoint: true, sameLocationAsCheckpoint: true },
      fixed: { present: true, visible: true, modal: true, containsFocus: true,
        sameAsCheckpoint: true, sameLocationAsCheckpoint: true },
    }];
  }
  if (issue?.rule === "keyboard.modal-tab-focus-loss") {
    return [{
      selector: { roles: ["dialog", "alertdialog"] },
      checkpoint: { present: true, visible: true, modal: true, containsFocus: true },
      reproduced: { present: true, visible: true, modal: true, focusAbsent: true,
        sameAsCheckpoint: true, sameLocationAsCheckpoint: true },
      fixed: { present: true, visible: true, modal: true, containsFocus: true,
        sameAsCheckpoint: true, sameLocationAsCheckpoint: true },
    }];
  }
  return [];
}

/**
 * The only deterministic keyboard detector currently emitted by the explorer
 * is modal-focus-escape. Other keyboard rules are explicit REVIEW leads and
 * lack a positive corrected-state predicate in portable report/v1.
 */
const MODAL_OPEN_WITNESS_SOURCE = "tvdoctor.keyboard.modal-open/v1";
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const PORTABLE_ISSUE_ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u;

/**
 * This witness is an exact machine-readable observation of the new modal and
 * its opener, retained from the original action. A stable ID without role/name
 * is insufficient: an unrelated dialog can reuse a DOM ID after a repair.
 */
function modalOpenWitness(issue: TVDoctorIssue | undefined): ReplayModalOpenIdentity | null {
  if (issue?.rule !== "keyboard.modal-open-focus-not-transferred") return null;
  const records = issue.evidence.filter((entry) => entry.source === MODAL_OPEN_WITNESS_SOURCE);
  if (records.length !== 1 || records[0]?.kind !== "verified-fact"
    || !PORTABLE_ISSUE_ARTIFACT_ID.test(issue.id)) return null;
  // The scanner emits the canonical witness with artifact:null. The report
  // writer attaches its real evidence/issue-id/transition.json slot. Permit
  // only that exact issue-owned path; higher-level saved-report verification
  // must still validate the descriptor's SHA-256/length and file containment.
  const artifact = records[0].artifact;
  if (artifact !== null && artifact !== `evidence/${issue.id}/transition.json`) return null;
  const raw = records[0].summary;
  if (raw.length === 0 || raw.length > 1_000) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  const record = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => (
    typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).join(",") === keys.join(",")
  );
  if (!record(data, ["modal", "opener"])
    || !record(data["modal"], ["stableId", "role", "name"])
    || !record(data["opener"], ["stableId", "role", "name"])) return null;
  const modal = data["modal"];
  const opener = data["opener"];
  const goodId = (value: unknown): value is string => typeof value === "string" && PORTABLE_ID.test(value);
  const goodName = (value: unknown): value is string => typeof value === "string"
    && value.length > 0 && value.length <= 160 && value.trim() === value
    && Array.from(value).every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127 && !(code >= 128 && code <= 159);
    });
  if (JSON.stringify(data) !== raw
    || !goodId(modal["stableId"]) || !goodId(opener["stableId"])
    || modal["stableId"] === opener["stableId"]
    || (modal["role"] !== "dialog" && modal["role"] !== "alertdialog")
    || opener["role"] !== "button"
    || !goodName(modal["name"]) || !goodName(opener["name"])) return null;
  const transition = issue.transition;
  if (transition === null || transition.action !== "SELECT"
    || transition.fromElement !== opener["stableId"]
    || transition.observedElement !== opener["stableId"]
    || transition.expectedElement !== modal["stableId"]) return null;
  return {
    modal: { stableId: modal["stableId"], role: modal["role"], name: modal["name"] },
    opener: { stableId: opener["stableId"], role: "button", name: opener["name"] },
  };
}

function keyboardOracle(
  issue: TVDoctorIssue | undefined,
  modalOpen: ReplayModalOpenIdentity | null,
): CompiledReplayPlan["keyboardOracle"] {
  if (issue === undefined || !issue.rule.startsWith("keyboard.")) return null;
  if (issue.rule === "keyboard.modal-open-focus-not-transferred") {
    return issue.confidence === "deterministic"
      && issue.evidence.some((entry) => entry.kind === "deterministic-failure")
      && issue.reproduction.status === "available"
      && issue.reproduction.confidence === "deterministic"
      && modalOpen !== null
      ? "modal-open-focus-not-transferred" : "review-only";
  }
  if (issue.rule !== "keyboard.modal-focus-escape"
    && issue.rule !== "keyboard.modal-tab-focus-loss") return "review-only";
  const transition = issue.transition;
  if (issue.confidence !== "deterministic"
    || !issue.evidence.some((entry) => entry.kind === "deterministic-failure")
    || issue.reproduction.status !== "available"
    || issue.reproduction.confidence !== "deterministic"
    || transition === null
    || (transition.action !== "TAB" && transition.action !== "SHIFT_TAB")
    || transition.fromElement === null || transition.expectedElement === null
    || (issue.rule === "keyboard.modal-focus-escape" && transition.observedElement === null)
    || (issue.rule === "keyboard.modal-tab-focus-loss" && transition.observedElement !== null)) return "review-only";
  return issue.rule === "keyboard.modal-focus-escape" ? "modal-focus-escape" : "modal-tab-focus-loss";
}

function validateSteps(
  steps: readonly RemotePressStep[], label: string, allowEmpty: boolean,
): { readonly total: number } | { readonly error: string } {
  if (!Array.isArray(steps)) return { error: `${label} must be an array.` };
  if (!allowEmpty && steps.length === 0) return { error: `${label} must contain at least one action.` };
  if (steps.length > PROTOCOL_VALIDATION_LIMITS.maxRemoteSteps) {
    return { error: `${label} exceeds the protocol step limit.` };
  }
  let total = 0;
  for (const [index, step] of steps.entries()) {
    if (typeof step !== "object" || step === null) return { error: `${label}[${String(index)}] must be an object.` };
    if (!isRemoteKey(step.key)) return { error: `${label}[${String(index)}].key is not a supported remote key.` };
    if (!Number.isSafeInteger(step.repeat) || step.repeat <= 0
      || step.repeat > PROTOCOL_VALIDATION_LIMITS.maxRemoteRepeat) {
      return { error: `${label}[${String(index)}].repeat must be a positive integer within the protocol limit.` };
    }
    total += step.repeat;
    if (!Number.isSafeInteger(total) || total > PROTOCOL_VALIDATION_LIMITS.maxTotalRemotePresses) {
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
  const rolesValid = selector.roles === undefined || (Array.isArray(selector.roles)
    && selector.roles.length > 0
    && selector.roles.every((role) => typeof role === "string" && role.trim().length > 0)
    && new Set(selector.roles).size === selector.roles.length);
  const hasIdentity = values.some((value) => typeof value === "string" && value.trim().length > 0)
    || (selector.roles?.length ?? 0) > 0;
  return stringsValid && rolesValid && hasIdentity && !(selector.role !== undefined && selector.roles !== undefined);
}

const ELEMENT_STATE_KEYS = [
  "present", "visible", "enabled", "focusable", "focused", "modal",
  "containsFocus", "focusAbsent", "sameAsCheckpoint", "sameLocationAsCheckpoint",
] as const;

function expectationIsValid(expectation: ReplayElementStateExpectation): boolean {
  let asserted = false;
  for (const key of ELEMENT_STATE_KEYS) {
    const value = expectation[key];
    if (value !== undefined) {
      if (typeof value !== "boolean") return false;
      if (key === "focusAbsent" && value !== true) return false;
      // The same-identity predicate has only a positive meaning. Accepting
      // `false` as a standalone assertion would silently match everything.
      if ((key === "sameAsCheckpoint" || key === "sameLocationAsCheckpoint") && value !== true) return false;
      asserted = true;
    }
  }
  if (!asserted) return false;
  if (expectation.present === false) {
    return ELEMENT_STATE_KEYS.every((key) => key === "present" || expectation[key] === undefined);
  }
  if (expectation.focusAbsent === true && expectation.containsFocus !== undefined) return false;
  return true;
}

function validateElementAssertions(assertions: readonly ReplayElementStateAssertion[]): string | null {
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
    const expectations = [assertion.checkpoint, assertion.reproduced, assertion.fixed];
    if (expectations.every((expectation) => expectation === undefined)) {
      return `elementStateAssertions[${String(index)}] must assert at least one phase.`;
    }
    if (expectations.some((expectation) => expectation !== undefined && !expectationIsValid(expectation))) {
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

function copyExpectation(expectation: ReplayElementStateExpectation): ReplayElementStateExpectation {
  return {
    ...(expectation.present === undefined ? {} : { present: expectation.present }),
    ...(expectation.visible === undefined ? {} : { visible: expectation.visible }),
    ...(expectation.enabled === undefined ? {} : { enabled: expectation.enabled }),
    ...(expectation.focusable === undefined ? {} : { focusable: expectation.focusable }),
    ...(expectation.focused === undefined ? {} : { focused: expectation.focused }),
    ...(expectation.modal === undefined ? {} : { modal: expectation.modal }),
    ...(expectation.containsFocus === undefined ? {} : { containsFocus: expectation.containsFocus }),
    ...(expectation.focusAbsent === undefined ? {} : { focusAbsent: expectation.focusAbsent }),
    ...(expectation.sameAsCheckpoint === undefined ? {} : { sameAsCheckpoint: expectation.sameAsCheckpoint }),
    ...(expectation.sameLocationAsCheckpoint === undefined ? {} : { sameLocationAsCheckpoint: expectation.sameLocationAsCheckpoint }),
  };
}

function copyElementAssertion(assertion: ReplayElementStateAssertion): ReplayElementStateAssertion {
  return {
    selector: copySelector(assertion.selector),
    ...(assertion.checkpoint === undefined ? {} : { checkpoint: copyExpectation(assertion.checkpoint) }),
    ...(assertion.reproduced === undefined ? {} : { reproduced: copyExpectation(assertion.reproduced) }),
    ...(assertion.fixed === undefined ? {} : { fixed: copyExpectation(assertion.fixed) }),
  };
}

function splitSetupSteps(steps: readonly RemotePressStep[]): readonly RemotePressStep[] {
  const setup = copySteps(steps);
  const final = setup.at(-1);
  if (final === undefined) return [];
  if (final.repeat === 1) setup.pop();
  else setup[setup.length - 1] = { key: final.key, repeat: final.repeat - 1 };
  return setup;
}

function invalidCompilation(message: string): ReplayCompilationResult {
  return { status: "invalid", reason: { code: "invalid-replay", message } };
}

/** Compile a validated portable replay into setup and assertion phases. */
export function compileReplay(replay: TVDoctorReplayV1, options: ReplayCompilationOptions = {}): ReplayCompilationResult {
  try {
    parseTVDoctorReplayV1(replay);
  } catch (error) {
    return invalidCompilation(`Protocol replay validation failed: ${safeErrorMessage(error)}`);
  }
  if (options.confidence !== undefined && options.confidence !== "deterministic" && options.confidence !== "best-effort") {
    return invalidCompilation("Replay confidence must be deterministic or best-effort.");
  }
  if (options.confidence === "deterministic" && options.sourceIssue === undefined) {
    return invalidCompilation("Deterministic replay confidence requires correlated sourceIssue provenance.");
  }
  if (options.sourceIssue !== undefined) {
    const correlationError = replayMatchesIssue(replay, options.sourceIssue);
    if (correlationError !== null) return invalidCompilation(correlationError);
  }
  if (replay.schemaVersion !== REPLAY_SCHEMA_VERSION) return invalidCompilation(`Unsupported replay schema version: ${String(replay.schemaVersion)}.`);
  if (typeof replay.id !== "string" || replay.id.trim().length === 0) return invalidCompilation("Replay id must be a non-empty string.");
  if (typeof replay.issueId !== "string" || replay.issueId.trim().length === 0) return invalidCompilation("Replay issueId must be a non-empty string.");
  if (typeof replay.reset !== "object" || replay.reset === null || !["reload", "relaunch", "clear-data"].includes(replay.reset.strategy)) {
    return invalidCompilation("Replay reset strategy is invalid.");
  }
  if (typeof replay.assertion !== "object" || replay.assertion === null
    || replay.assertion.type !== "transition" || !isRemoteKey(replay.assertion.action)
    || !validElementLabel(replay.assertion.fromElement) || !validElementLabel(replay.assertion.expectedElement)
    || !validElementLabel(replay.assertion.observedElement)) {
    return invalidCompilation("Replay transition assertion is invalid.");
  }
  const stepsValidation = validateSteps(replay.steps, "Replay steps", false);
  if ("error" in stepsValidation) return invalidCompilation(stepsValidation.error);
  const finalStep = replay.steps.at(-1);
  if (finalStep === undefined || finalStep.key !== replay.assertion.action) {
    return invalidCompilation("The final replay action must equal the transition assertion action.");
  }
  const elementAssertions = [...inferredElementAssertions(options.sourceIssue), ...(options.elementStateAssertions ?? [])];
  const elementError = validateElementAssertions(elementAssertions);
  if (elementError !== null) return invalidCompilation(elementError);
  const issueReproduction = options.sourceIssue?.reproduction;
  const correlatedMetadata = issueReproduction?.status === "available" ? {
    originalSequence: issueReproduction.originalSequence,
    minimizedSequence: issueReproduction.minimizedSequence,
  } : null;
  if (correlatedMetadata !== null && options.sequenceMetadata !== undefined
    && (!sameSteps(correlatedMetadata.originalSequence, options.sequenceMetadata.originalSequence)
      || !sameNullableSteps(correlatedMetadata.minimizedSequence, options.sequenceMetadata.minimizedSequence))) {
    return invalidCompilation("Sequence metadata does not match the correlated source issue.");
  }
  const sourceMetadata = correlatedMetadata ?? options.sequenceMetadata ?? { originalSequence: replay.steps, minimizedSequence: null };
  const originalValidation = validateSteps(sourceMetadata.originalSequence, "Original sequence metadata", false);
  if ("error" in originalValidation) return invalidCompilation(originalValidation.error);
  if (!sameSteps(sourceMetadata.originalSequence, replay.steps)) {
    return invalidCompilation("Original sequence metadata must exactly match the executable replay steps.");
  }
  if (sourceMetadata.minimizedSequence !== null) {
    const minimizedValidation = validateSteps(sourceMetadata.minimizedSequence, "Minimized sequence metadata", false);
    if ("error" in minimizedValidation) return invalidCompilation(minimizedValidation.error);
  }
  const copiedSteps = copySteps(replay.steps);
  const assertion: ReplayTransitionAssertion = {
    type: "transition", fromElement: replay.assertion.fromElement, action: replay.assertion.action,
    expectedElement: replay.assertion.expectedElement, observedElement: replay.assertion.observedElement,
  };
  const copiedReplay: TVDoctorReplayV1 = {
    schemaVersion: REPLAY_SCHEMA_VERSION, id: replay.id, issueId: replay.issueId,
    reset: { strategy: replay.reset.strategy }, steps: copiedSteps, assertion,
  };
  const correlatedConfidence: ReproductionConfidence = options.sourceIssue === undefined ? "best-effort"
    : options.sourceIssue.confidence === "deterministic" && issueReproduction?.status === "available"
      && issueReproduction.confidence === "deterministic" && options.confidence !== "best-effort"
      ? "deterministic" : "best-effort";
  const modalOpen = modalOpenWitness(options.sourceIssue);
  const plan = registerCompiledPlan({
    replay: copiedReplay,
    setup: { steps: splitSetupSteps(copiedSteps), checkpointFocusElement: assertion.fromElement },
    assertion,
    elementStateAssertions: elementAssertions.map(copyElementAssertion),
    keyboardOracle: keyboardOracle(options.sourceIssue, modalOpen),
    keyboardModalOpenIdentity: modalOpen,
    confidence: correlatedConfidence,
    totalActions: stepsValidation.total,
    sequence: {
      originalSequence: copySteps(sourceMetadata.originalSequence),
      minimizedSequence: sourceMetadata.minimizedSequence === null ? null : copySteps(sourceMetadata.minimizedSequence),
      executedSequence: "original",
      minimization: { status: "not-attempted", reason: REPLAY_MINIMIZATION_NOT_ATTEMPTED_REASON },
    },
  });
  return { status: "compiled", plan };
}

/** Build and compile the portable M5 replay carried by a diagnostic issue. */
export function compileIssueReplay(issue: TVDoctorIssue, options: ReplayCompilationOptions = {}): ReplayCompilationResult {
  if (issue.reproduction.status === "unavailable") {
    return { status: "unavailable", reason: { code: "reproduction-unavailable", message: issue.reproduction.reason } };
  }
  if (issue.transition === null) {
    return invalidCompilation("An available issue reproduction needs a navigation transition assertion.");
  }
  const issueConfidence: ReproductionConfidence = issue.confidence === "deterministic"
    && issue.reproduction.confidence === "deterministic" && options.confidence !== "best-effort"
    ? "deterministic" : "best-effort";
  const portableReplay: TVDoctorReplayV1 = {
    schemaVersion: REPLAY_SCHEMA_VERSION, id: `replay-${issue.id}`, issueId: issue.id,
    reset: { strategy: issue.reproduction.resetStrategy },
    steps: copySteps(issue.reproduction.originalSequence),
    assertion: {
      type: "transition", fromElement: issue.transition.fromElement, action: issue.transition.action,
      expectedElement: issue.transition.expectedElement, observedElement: issue.transition.observedElement,
    },
  };
  return compileReplay(portableReplay, {
    confidence: issueConfidence,
    ...(options.elementStateAssertions === undefined ? {} : { elementStateAssertions: options.elementStateAssertions }),
    sourceIssue: issue,
  });
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type ExecutionPlanValidation =
  | { readonly status: "valid"; readonly plan: CompiledReplayPlan }
  | { readonly status: "invalid"; readonly reason: string };

function invalidExecutionPlan(reason: string): ExecutionPlanValidation {
  return { status: "invalid", reason };
}

/** Internal trust boundary used by replay execution; signature registration stays private here. */
export function validateCompiledReplayPlan(plan: CompiledReplayPlan): ExecutionPlanValidation {
  const registeredSignature = COMPILED_PLAN_SIGNATURES.get(plan);
  if (registeredSignature === undefined) return invalidExecutionPlan("Replay plan was not produced by this compiler instance.");
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
  if (trustedPlan.keyboardOracle !== null && trustedPlan.keyboardOracle !== "modal-focus-escape"
    && trustedPlan.keyboardOracle !== "modal-tab-focus-loss"
    && trustedPlan.keyboardOracle !== "modal-open-focus-not-transferred"
    && trustedPlan.keyboardOracle !== "review-only") {
    return invalidExecutionPlan("Compiled keyboard oracle classification is invalid.");
  }
  if (trustedPlan.keyboardOracle === "modal-open-focus-not-transferred"
    && trustedPlan.keyboardModalOpenIdentity === null) {
    return invalidExecutionPlan("A deterministic modal-open oracle needs the exact original modal identity.");
  }
  try {
    parseTVDoctorReplayV1(trustedPlan.replay);
  } catch (error) {
    return invalidExecutionPlan(`Compiled portable replay is invalid: ${safeErrorMessage(error)}`);
  }
  if (trustedPlan.assertion.type !== trustedPlan.replay.assertion.type
    || trustedPlan.assertion.fromElement !== trustedPlan.replay.assertion.fromElement
    || trustedPlan.assertion.action !== trustedPlan.replay.assertion.action
    || trustedPlan.assertion.expectedElement !== trustedPlan.replay.assertion.expectedElement
    || trustedPlan.assertion.observedElement !== trustedPlan.replay.assertion.observedElement) {
    return invalidExecutionPlan("Compiled assertion does not exactly match the portable replay assertion.");
  }
  const replaySteps = validateSteps(trustedPlan.replay.steps, "Compiled replay steps", false);
  if ("error" in replaySteps) return invalidExecutionPlan(replaySteps.error);
  const setupSteps = validateSteps(trustedPlan.setup.steps, "Compiled setup steps", true);
  if ("error" in setupSteps) return invalidExecutionPlan(setupSteps.error);
  if (!sameSteps(trustedPlan.setup.steps, splitSetupSteps(trustedPlan.replay.steps))) {
    return invalidExecutionPlan("Compiled setup steps do not exactly match the replay prefix.");
  }
  if (replaySteps.total !== trustedPlan.totalActions || setupSteps.total + 1 !== trustedPlan.totalActions) {
    return invalidExecutionPlan("Compiled replay action counts are inconsistent.");
  }
  const final = trustedPlan.replay.steps.at(-1);
  if (final === undefined || final.key !== trustedPlan.assertion.action) {
    return invalidExecutionPlan("Compiled replay final action does not match its assertion.");
  }
  if (trustedPlan.setup.checkpointFocusElement !== trustedPlan.assertion.fromElement) {
    return invalidExecutionPlan("Compiled replay checkpoint does not match its transition source.");
  }
  const originalSteps = validateSteps(trustedPlan.sequence.originalSequence, "Compiled original sequence metadata", false);
  if ("error" in originalSteps) return invalidExecutionPlan(originalSteps.error);
  if (!sameSteps(trustedPlan.sequence.originalSequence, trustedPlan.replay.steps)) {
    return invalidExecutionPlan("Compiled original sequence metadata does not match replay steps.");
  }
  if (trustedPlan.sequence.minimizedSequence !== null) {
    const minimizedSteps = validateSteps(trustedPlan.sequence.minimizedSequence, "Compiled minimized sequence metadata", false);
    if ("error" in minimizedSteps) return invalidExecutionPlan(minimizedSteps.error);
  }
  if (trustedPlan.sequence.executedSequence !== "original"
    || trustedPlan.sequence.minimization.status !== "not-attempted"
    || trustedPlan.sequence.minimization.reason !== REPLAY_MINIMIZATION_NOT_ATTEMPTED_REASON) {
    return invalidExecutionPlan("Compiled sequence provenance is invalid.");
  }
  const elementError = validateElementAssertions(trustedPlan.elementStateAssertions);
  return elementError === null ? { status: "valid", plan: trustedPlan } : invalidExecutionPlan(elementError);
}
