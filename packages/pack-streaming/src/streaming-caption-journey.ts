import type { RemoteKey, TVDoctorIssue } from "@tvdoctor/protocol";
import {
  activeSurfaceEntries,
  describeStreamingElement,
  focusedCandidate,
  isInteractiveNode,
  isSafeStreamingCandidate,
  rankSemanticCandidates,
  selectedCaptionTrack,
  semanticContext,
  type RankedSemanticCandidate,
  type StreamingSemanticTarget,
} from "./semantics.js";
import type {
  AppearanceControlResult,
  StreamingElementDescriptor,
  StreamingPackOptions,
  StreamingPointerProbeRecord,
  StreamingReplayResult,
  StreamingStageName,
  StreamingStageResult,
} from "./types.js";
import {
  JourneyStop,
  PackStop,
  type StreamingSession,
} from "./streaming-runtime.js";
import {
  descriptorFromSnapshot,
  expandSurface,
  findExactTarget,
  focusDescriptor,
  nodeMatchesDescriptor,
  type ExpandedState,
  type ExpansionResult,
  type SearchResult,
} from "./streaming-search.js";
import {
  captionsIssue,
  findWitnessSource,
  textColourIssue,
} from "./streaming-issues.js";
import { runIsolatedPointerProbe } from "./streaming-pointer-probe.js";
import { replayIssue } from "./streaming-replay.js";

interface CaptionJourneyContext {
  readonly session: StreamingSession;
  readonly options: StreamingPackOptions;
  readonly stages: StreamingStageResult[];
  readonly issues: TVDoctorIssue[];
  readonly appearanceControls: AppearanceControlResult[];
  readonly replays: StreamingReplayResult[];
  readonly pointerProbes: StreamingPointerProbeRecord[];
  readonly settingsSequence: readonly RemoteKey[];
  readonly stage: (
    name: StreamingStageName,
    status: StreamingStageResult["status"],
    detail: string,
    sequence: readonly RemoteKey[],
    target?: StreamingElementDescriptor | null,
  ) => void;
  readonly requireTarget: (
    prefix: readonly RemoteKey[],
    target: StreamingSemanticTarget,
    stageName: StreamingStageName,
  ) => Promise<SearchResult & {
    readonly status: "found";
    readonly candidate: RankedSemanticCandidate;
  }>;
}

export interface CaptionJourneyResult {
  readonly captionsExpansion: ExpansionResult;
  readonly expansion: ExpansionResult;
  readonly textConclusive: boolean;
  readonly nestedBackPassed: boolean;
  readonly journeySequence: readonly RemoteKey[];
}

/** Executes the ordered Captions, Appearance, Text Colour, and nested-BACK stages. */
export async function runCaptionJourney({
  session,
  options,
  stages,
  issues,
  appearanceControls,
  replays,
  pointerProbes,
  settingsSequence,
  stage,
  requireTarget,
}: CaptionJourneyContext): Promise<CaptionJourneyResult> {
    const captions = await requireTarget(settingsSequence, "captions", "captions");
    await session.activate(captions.sequence, captions.candidate.descriptor, "discovery");
    let snapshot = await session.snapshot();
    let journeySequence: readonly RemoteKey[] = [...captions.sequence, "SELECT"];
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
  return {
    captionsExpansion,
    expansion,
    textConclusive,
    nestedBackPassed,
    journeySequence,
  };
}
