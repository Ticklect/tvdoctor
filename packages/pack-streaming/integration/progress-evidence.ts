export type ProgressDirection = "decrease" | "unchanged" | "increase";

export type ProgressOperation = "seek-backward" | "seek-forward";

export interface ProgressEvidenceInput {
  readonly operation: ProgressOperation;
  readonly action: string;
  readonly target: string;
  readonly expectedDirection: ProgressDirection;
  readonly before: number;
  readonly after: number;
}

export interface NormalisedProgressEvidence extends ProgressEvidenceInput {
  readonly delta: number;
  readonly observedDirection: ProgressDirection;
}

function directionForDelta(delta: number): ProgressDirection {
  if (delta < 0) return "decrease";
  if (delta > 0) return "increase";
  return "unchanged";
}

export function normaliseProgressEvidence(
  evidence: ProgressEvidenceInput,
): NormalisedProgressEvidence {
  if (evidence.operation !== "seek-backward" && evidence.operation !== "seek-forward") {
    throw new Error("Progress evidence requires a recognised seek operation.");
  }
  if (!Number.isFinite(evidence.before) || !Number.isFinite(evidence.after)) {
    throw new Error("Progress evidence requires finite before and after values.");
  }
  if (evidence.action.trim().length === 0 || evidence.target.trim().length === 0) {
    throw new Error("Progress evidence requires a non-empty action and target.");
  }
  const requiredDirection = evidence.operation === "seek-backward" ? "decrease" : "increase";
  if (evidence.expectedDirection !== requiredDirection) {
    throw new Error(`${evidence.operation} requires expected direction ${requiredDirection}.`);
  }
  const delta = evidence.after - evidence.before;
  if (!Number.isFinite(delta)) {
    throw new Error("Progress evidence requires a finite delta.");
  }
  return {
    ...evidence,
    delta,
    observedDirection: directionForDelta(delta),
  };
}

export function equivalentProgressSemantics(
  discovery: ProgressEvidenceInput,
  freshCapture: ProgressEvidenceInput,
): boolean {
  const left = normaliseProgressEvidence(discovery);
  const right = normaliseProgressEvidence(freshCapture);
  return left.operation === right.operation
    && left.action === right.action
    && left.target === right.target
    && left.expectedDirection === right.expectedDirection
    && left.observedDirection === right.observedDirection
    && left.delta === right.delta;
}
