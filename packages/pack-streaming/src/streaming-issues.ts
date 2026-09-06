import {
  createCanonicalSemanticIdentity,
  createSemanticIssueId,
  type SemanticIdentityValue,
} from "@tvdoctor/core";
import type {
  RemoteKey,
  RemotePressStep,
  ResetStrategy,
  TVDoctorIssue,
} from "@tvdoctor/protocol";
import {
  normaliseSemanticText,
  semanticElementLabel,
} from "./semantics.js";
import {
  STREAMING_STAGE_NAMES,
  type StreamingElementDescriptor,
  type StreamingPointerProbeResult,
  type StreamingStageResult,
} from "./types.js";
import type { ExpandedState } from "./streaming-search.js";

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

export function rewindIssue(
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

export function captionsIssue(
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

export function textColourIssue(
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

export function volumePointerOnlyIssue(
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

export function findWitnessSource(
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

export function addSkippedStages(stages: StreamingStageResult[]): void {
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
