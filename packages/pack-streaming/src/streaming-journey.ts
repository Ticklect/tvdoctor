import type { RemoteKey, StateSnapshot, TVDoctorIssue } from "@tvdoctor/protocol";
import {
  focusedCandidate,
  isPlayerSettingsSurface,
  normaliseSemanticText,
  playbackProgressObservation,
  rankSemanticCandidates,
  semanticStateIdentity,
  type RankedSemanticCandidate,
  type StreamingSemanticTarget,
} from "./semantics.js";
import type {
  AppearanceControlResult,
  StreamingElementDescriptor,
  StreamingPackBudgets,
  StreamingPackOptions,
  StreamingPackResult,
  StreamingPointerProbeRecord,
  StreamingReplayResult,
  StreamingStageName,
  StreamingStageResult,
} from "./types.js";
import {
  JourneyStop,
  PackStop,
  safeErrorMessage,
  type StreamingSession,
} from "./streaming-runtime.js";
import {
  expandSurface,
  findSemanticTarget,
  focusDescriptor,
  nodeMatchesDescriptor,
  type ExpandedState,
  type SearchResult,
} from "./streaming-search.js";
import {
  addSkippedStages,
  findWitnessSource,
  rewindIssue,
  volumePointerOnlyIssue,
} from "./streaming-issues.js";
import { runIsolatedPointerProbe } from "./streaming-pointer-probe.js";
import { replayIssue } from "./streaming-replay.js";
import { runCaptionJourney } from "./streaming-caption-journey.js";

function isPlayingToggle(descriptor: StreamingElementDescriptor): boolean {
  return descriptor.selectionState === "on"
    || normaliseSemanticText(descriptor.name).includes("pause");
}

function isPausedToggle(descriptor: StreamingElementDescriptor): boolean {
  return descriptor.selectionState === "off"
    || normaliseSemanticText(descriptor.name).includes("play");
}

function isSameStableControl(
  before: StreamingElementDescriptor,
  after: StreamingElementDescriptor,
): boolean {
  if (before.stableId === null || after.stableId === null || before.stableId !== after.stableId) {
    return false;
  }
  return before.role === null
    || after.role === null
    || normaliseSemanticText(before.role) === normaliseSemanticText(after.role);
}

/** Executes the ordered semantic streaming journey using one bounded session. */
export async function runStreamingJourney(
  session: StreamingSession,
  options: StreamingPackOptions,
  budgets: StreamingPackBudgets,
): Promise<StreamingPackResult> {
  const stages: StreamingStageResult[] = [];
  const issues: TVDoctorIssue[] = [];
  const appearanceControls: AppearanceControlResult[] = [];
  const replays: StreamingReplayResult[] = [];
  const pointerProbes: StreamingPointerProbeRecord[] = [];
  let volumeControl: AppearanceControlResult | null = null;
  let journeySequence: readonly RemoteKey[] = [];

  const stage = (
    name: StreamingStageName,
    status: StreamingStageResult["status"],
    detail: string,
    sequence: readonly RemoteKey[],
    target: StreamingElementDescriptor | null = null,
  ): void => {
    stages.push({ stage: name, status, detail, sequence: [...sequence], target });
  };

  const requireTarget = async (
    prefix: readonly RemoteKey[],
    target: StreamingSemanticTarget,
    stageName: StreamingStageName,
  ): Promise<SearchResult & { readonly status: "found"; readonly candidate: RankedSemanticCandidate }> => {
    const found = await findSemanticTarget(session, prefix, target);
    if (found.status === "not-found" || found.candidate === null) {
      stage(
        stageName,
        found.candidate === null ? "unobservable" : "partial",
        found.detail,
        prefix,
        found.candidate?.descriptor ?? null,
      );
      throw new JourneyStop(
        found.detail,
        found.reason === "max-local-depth" || found.reason === "max-local-states"
          ? found.reason
          : "journey-partial",
      );
    }
    stage(stageName, "passed", found.detail, found.sequence, found.candidate.descriptor);
    return { ...found, status: "found", candidate: found.candidate };
  };

  try {
    const capabilities = await session.capabilities();
    if (!capabilities.has("remote-input")) {
      throw new PackStop("remote-input-unavailable", "The driver does not advertise remote-input capability.");
    }
    if (!capabilities.has("ui-tree")) {
      throw new PackStop("ui-tree-unavailable", "The driver does not advertise UI-tree capability.");
    }

    const homeSnapshot = await session.restoreAndReplay([], "discovery");
    if (homeSnapshot.uiTree.status === "unavailable") {
      throw new PackStop("ui-tree-unavailable", homeSnapshot.uiTree.reason);
    }
    const homeFocus = focusDescriptor(homeSnapshot);
    if (homeFocus === null) {
      stage("home", "unobservable", "The reset root did not expose one uniquely correlated stable remote focus.", []);
      throw new JourneyStop("Home focus could not be correlated safely.");
    }
    stage("home", "passed", "A reset root with an observable UI tree and uniquely correlated remote focus was established.", [], homeFocus);

    const content = await requireTarget([], "content", "content");
    await session.activate(content.sequence, content.candidate.descriptor, "discovery");
    let snapshot = await session.snapshot();
    journeySequence = [...content.sequence, "SELECT"];
    const playOnDetails = rankSemanticCandidates(snapshot, "play")[0] ?? null;
    if (playOnDetails === null) {
      stage("details", "partial", "Selecting safe content did not expose a semantic Play or Resume control.", journeySequence);
      throw new JourneyStop("Details could not be semantically confirmed.");
    }
    stage("details", "passed", "Selecting a safe content candidate exposed a Details surface with Play or Resume.", journeySequence, playOnDetails.descriptor);

    const play = await requireTarget(journeySequence, "play", "play");
    await session.activate(play.sequence, play.candidate.descriptor, "discovery");
    snapshot = await session.snapshot();
    journeySequence = [...play.sequence, "SELECT"];
    const visibleToggle = rankSemanticCandidates(snapshot, "toggle-play")[0] ?? null;
    const playerProgress = playbackProgressObservation(snapshot);
    if (visibleToggle === null && playerProgress === null) {
      stage("player", "unobservable", "Play was activated, but neither player controls nor a numeric player position were observable.", journeySequence);
      throw new JourneyStop("The player could not be semantically confirmed.");
    }
    stage("player", "passed", "Play opened a surface with observable player semantics.", journeySequence, visibleToggle?.descriptor ?? null);
    const playerSequence = journeySequence;
    const initialPlayerSnapshot = snapshot;
    const playerExpansion = await expandSurface(session, playerSequence);
    const expandedPlayerTarget = (target: StreamingSemanticTarget): {
      readonly state: ExpandedState;
      readonly candidate: RankedSemanticCandidate;
    } | null => {
      for (const state of playerExpansion.states) {
        const candidate = focusedCandidate(state.snapshot, target);
        if (candidate !== null) return { state, candidate };
      }
      return null;
    };

    const toggleTarget = expandedPlayerTarget("toggle-play");
    const toggleReachable = toggleTarget !== null;
    stage(
      "controls",
      toggleReachable && playerExpansion.complete
        ? "passed"
        : toggleReachable || !playerExpansion.complete
          ? "partial"
          : "unobservable",
      toggleReachable
        ? playerExpansion.complete
          ? "A semantic play/pause control was uniquely focused during complete local D-pad expansion."
          : `A semantic play/pause control was focused, but player expansion stopped after exactly ${String(playerExpansion.expandedStates)} expanded states at ${playerExpansion.reason}.`
        : `A visible player control did not count as reachable; expansion stopped at ${playerExpansion.reason}.`,
      toggleTarget?.state.path ?? playerSequence,
      toggleTarget?.candidate.descriptor ?? visibleToggle?.descriptor ?? null,
    );

    const volumeCandidate = rankSemanticCandidates(initialPlayerSnapshot, "volume-control")[0] ?? null;
    let volumeConclusive = false;
    if (volumeCandidate === null) {
      stage("player-volume", "unobservable", "No semantic player volume control was observable.", playerSequence);
    } else {
      const reached = playerExpansion.states.find((state) => (
        state.focused !== null && nodeMatchesDescriptor(volumeCandidate.node, state.focused)
      ));
      volumeControl = {
        element: volumeCandidate.descriptor,
        remotelyReachable: reached !== undefined,
        exactSequence: reached?.path ?? null,
        activation: "not-attempted",
        detail: reached !== undefined
          ? playerExpansion.complete
            ? "The semantic volume control was uniquely focused during complete local D-pad expansion."
            : `The semantic volume control was focused before incomplete expansion stopped at ${playerExpansion.reason}.`
          : playerExpansion.complete
            ? "Complete local D-pad expansion did not focus the semantic volume control."
            : `Remote reachability was not claimed because expansion stopped at ${playerExpansion.reason}.`,
      };
      if (reached !== undefined) {
        volumeConclusive = true;
        stage("player-volume", "passed", "The semantic volume control was remote reachable.", reached.path, volumeCandidate.descriptor);
      } else if (!playerExpansion.complete) {
        stage("player-volume", "partial", `Volume reachability remained unproven because expansion stopped at ${playerExpansion.reason}.`, playerSequence, volumeCandidate.descriptor);
      } else {
        const pointer = options.pointerProbe === undefined
          ? null
          : await runIsolatedPointerProbe(session, options.pointerProbe, {
            kind: "player-volume-control",
            element: volumeCandidate.descriptor,
            snapshot: initialPlayerSnapshot,
            surfaceSequence: playerSequence,
          }, pointerProbes);
        if (pointer?.status !== "reachable") {
          stage(
            "player-volume",
            "unobservable",
            "Complete remote expansion did not reach the volume control, but real isolated pointer activation was not established.",
            playerSequence,
            volumeCandidate.descriptor,
          );
        } else {
          const source = findWitnessSource(volumeCandidate.descriptor, playerExpansion.states);
          let witness: Parameters<typeof volumePointerOnlyIssue>[3] = null;
          if (source !== null && source.source.focused !== null) {
            await session.restoreAndReplay(source.source.path, "probe");
            await session.press(source.action, "probe");
            const afterWitness = await session.snapshot();
            const observed = focusDescriptor(afterWitness);
            if (observed !== null && nodeMatchesDescriptor(volumeCandidate.node, observed)) {
              volumeControl = {
                ...volumeControl,
                remotelyReachable: true,
                exactSequence: [...source.source.path, source.action],
                detail: "A fresh adjacent D-pad witness reached the volume control after expansion.",
              };
              volumeConclusive = true;
              stage("player-volume", "passed", "A fresh adjacent D-pad witness reached the volume control.", [...source.source.path, source.action], volumeCandidate.descriptor);
            } else if (observed !== null) {
              witness = {
                sequence: [...source.source.path, source.action],
                source: source.source.focused,
                observed,
              };
            }
          }
          if (!volumeConclusive) {
            volumeControl = {
              ...volumeControl,
              activation: "observed",
              detail: "Complete D-pad expansion proved remote unreachability and an isolated pointer activation produced a bounded observable change.",
            };
            const issue = volumePointerOnlyIssue(
              volumeCandidate.descriptor,
              pointer,
              options.resetStrategy ?? "reload",
              witness,
            );
            issues.push(issue);
            const replay = await replayIssue(session, issue);
            replays.push(replay);
            volumeConclusive = issue.reproduction.status === "unavailable" || replay.status === "reproduced";
            stage(
              "player-volume",
              "failed",
              witness === null
                ? "The volume control was pointer activated but remote unreachable; no truthful adjacent focus replay was available."
                : "The volume control was pointer activated but an adjacent D-pad transition focused a different control.",
              witness?.sequence ?? playerSequence,
              volumeCandidate.descriptor,
            );
          }
        }
      }
    }

    if (toggleTarget !== null) {
      const toggleSnapshot = await session.restoreAndReplay(toggleTarget.state.path, "probe");
      const currentToggle = focusedCandidate(toggleSnapshot, "toggle-play");
      if (currentToggle === null) {
        throw new PackStop("replay-diverged", "The discovered play/pause route did not restore its uniquely correlated semantic target.");
      }
      const beforeToggle = currentToggle.descriptor;
      if (!isPlayingToggle(beforeToggle)) {
        stage("pause-resume", "unobservable", "The reachable toggle did not expose a playing precondition, so SELECT was not used as a pause probe.", toggleTarget.state.path, beforeToggle);
      } else {
        await session.activate(toggleTarget.state.path, beforeToggle, "probe");
        const pausedSnapshot = await session.snapshot();
        const paused = focusedCandidate(pausedSnapshot, "toggle-play")?.descriptor ?? null;
        const safeResume = paused !== null
          && isSameStableControl(beforeToggle, paused)
          && isPausedToggle(paused);
        if (!safeResume || paused === null) {
          stage(
            "pause-resume",
            "unobservable",
            "Pause was attempted, but the same uniquely correlated safe toggle was not reconfirmed; resume SELECT was withheld.",
            [...toggleTarget.state.path, "SELECT"],
            paused,
          );
        } else {
          const pausedSequence: readonly RemoteKey[] = [...toggleTarget.state.path, "SELECT"];
          await session.activate(pausedSequence, paused, "probe");
          const resumedSnapshot = await session.snapshot();
          const resumed = focusedCandidate(resumedSnapshot, "toggle-play")?.descriptor ?? null;
          const resumedObserved = resumed !== null
            && isSameStableControl(beforeToggle, resumed)
            && isPlayingToggle(resumed);
          stage(
            "pause-resume",
            resumedObserved ? "passed" : "unobservable",
            resumedObserved
              ? "The same safe player toggle changed from playing to paused and back to playing using SELECT."
              : "Resume was activated only after safe-toggle reconfirmation, but the resumed state was not observable.",
            [...pausedSequence, "SELECT"],
            resumed,
          );
        }
      }
    } else {
      stage("pause-resume", "unobservable", "No uniquely focused semantic play/pause control was remote reachable.", playerSequence);
    }

    const pausedTarget = async (target: "seek-backward" | "seek-forward"): Promise<{
      readonly sequence: readonly RemoteKey[];
      readonly snapshot: StateSnapshot;
      readonly candidate: RankedSemanticCandidate;
    } | null> => {
      const desired = expandedPlayerTarget(target);
      if (toggleTarget === null || desired === null) return null;
      const pauseSnapshot = await session.restoreAndReplay(toggleTarget.state.path, "probe");
      const pause = focusedCandidate(pauseSnapshot, "toggle-play");
      if (pause === null || !isPlayingToggle(pause.descriptor)) return null;
      await session.activate(toggleTarget.state.path, pause.descriptor, "probe");
      const pausedSnapshot = await session.snapshot();
      const paused = focusedCandidate(pausedSnapshot, "toggle-play")?.descriptor ?? null;
      if (
        paused === null
        || !isSameStableControl(pause.descriptor, paused)
        || !isPausedToggle(paused)
      ) {
        return null;
      }
      if (
        toggleTarget.state.path.length !== playerSequence.length
        || !toggleTarget.state.path.every((key, index) => key === playerSequence[index])
      ) {
        return null;
      }
      const suffix = desired.state.path.slice(playerSequence.length);
      const sequence: readonly RemoteKey[] = [...toggleTarget.state.path, "SELECT", ...suffix];
      const targetSnapshot = await session.restoreAndReplay(sequence, "probe");
      const candidate = focusedCandidate(targetSnapshot, target);
      return candidate === null ? null : { sequence, snapshot: targetSnapshot, candidate };
    };

    const forward = await pausedTarget("seek-forward");
    if (forward !== null) {
      const before = playbackProgressObservation(forward.snapshot);
      await session.activate(forward.sequence, forward.candidate.descriptor, "probe");
      const afterSnapshot = await session.snapshot();
      const after = before === null
        ? null
        : playbackProgressObservation(afterSnapshot, before.provenance);
      stage(
        "seek-forward",
        before === null || after === null ? "unobservable" : after.value > before.value ? "passed" : "failed",
        before === null || after === null
          ? "Forward was remote reachable, but one uniquely correlated playback-position value was unavailable."
          : `Forward changed the same playback-position valueNow from ${String(before.value)} to ${String(after.value)}.`,
        [...forward.sequence, "SELECT"],
        forward.candidate.descriptor,
      );
    } else {
      stage(
        "seek-forward",
        "unobservable",
        "A stable paused player precondition and uniquely correlated Forward target could not be established; SELECT was withheld.",
        playerSequence,
        null,
      );
    }

    const backward = await pausedTarget("seek-backward");
    if (backward !== null) {
      const before = playbackProgressObservation(backward.snapshot);
      await session.activate(backward.sequence, backward.candidate.descriptor, "probe");
      const afterSnapshot = await session.snapshot();
      const after = before === null
        ? null
        : playbackProgressObservation(afterSnapshot, before.provenance);
      const failed = before !== null && before.value > 0 && after !== null && after.value > before.value;
      const passed = before !== null && after !== null && after.value < before.value;
      stage(
        "seek-backward",
        failed ? "failed" : passed ? "passed" : "unobservable",
        before === null || after === null
          ? "Rewind was remote reachable, but one uniquely correlated playback-position value was unavailable."
          : before.value === 0 && after.value === 0
            ? "Rewind remained at the zero boundary; no lower-position precondition existed, so this was not classified as a failure."
            : `Rewind changed the same playback-position valueNow from ${String(before.value)} to ${String(after.value)}.`,
        [...backward.sequence, "SELECT"],
        backward.candidate.descriptor,
      );
      if (failed && before !== null && after !== null) {
        issues.push(rewindIssue(
          [...backward.sequence, "SELECT"],
          backward.candidate.descriptor,
          before.value,
          after.value,
        ));
      }
    } else {
      stage(
        "seek-backward",
        "unobservable",
        "A stable paused player precondition and uniquely correlated Rewind target could not be established; SELECT was withheld.",
        playerSequence,
        null,
      );
    }

    snapshot = await session.restoreAndReplay(playerSequence, "probe");
    const playerBackFrom = focusDescriptor(snapshot);
    await session.press("BACK", "probe");
    const playerBackSnapshot = await session.snapshot();
    const detailsRestored = rankSemanticCandidates(playerBackSnapshot, "play")[0] ?? null;
    stage(
      "player-back",
      detailsRestored === null ? "failed" : "passed",
      detailsRestored === null
        ? "BACK from Player did not restore a Details surface with Play or Resume."
        : "BACK from Player restored a Details surface with Play or Resume.",
      [...playerSequence, "BACK"],
      playerBackFrom,
    );

    const settings = expandedPlayerTarget("settings");
    if (settings === null) {
      stage(
        "settings",
        playerExpansion.complete ? "unobservable" : "partial",
        `No uniquely focused semantic Settings control was retained; player expansion stopped at ${playerExpansion.reason}.`,
        playerSequence,
      );
      throw new JourneyStop(
        "Player Settings was not remote reachable.",
        playerExpansion.reason === "max-local-depth" || playerExpansion.reason === "max-local-states"
          ? playerExpansion.reason
          : "journey-partial",
      );
    }
    const restoredSettings = await session.restoreAndReplay(settings.state.path, "discovery");
    const currentSettings = focusedCandidate(restoredSettings, "settings");
    if (currentSettings === null) {
      throw new PackStop("replay-diverged", "The discovered Settings route did not restore its uniquely correlated semantic target.");
    }
    stage(
      "settings",
      playerExpansion.complete ? "passed" : "partial",
      playerExpansion.complete
        ? "A semantic Settings control was retained from complete local player expansion."
        : `A semantic Settings control was retained, but player expansion stopped at ${playerExpansion.reason}.`,
      settings.state.path,
      currentSettings.descriptor,
    );
    const beforeSettingsIdentity = semanticStateIdentity(restoredSettings);
    const settingsAction = await session.activate(settings.state.path, currentSettings.descriptor, "discovery");
    snapshot = await session.snapshot();
    journeySequence = [...settings.state.path, "SELECT"];
    const afterSettingsIdentity = semanticStateIdentity(snapshot);
    const settingsSurfaceConfirmed = beforeSettingsIdentity !== null
      && afterSettingsIdentity !== null
      && beforeSettingsIdentity !== afterSettingsIdentity
      && isPlayerSettingsSurface(snapshot);
    const captionsOnSettings = settingsSurfaceConfirmed
      ? rankSemanticCandidates(snapshot, "captions")[0] ?? null
      : null;
    if (!settingsSurfaceConfirmed || captionsOnSettings === null) {
      stages.splice(stages.findIndex((value) => value.stage === "settings"), 1);
      stage(
        "settings",
        "partial",
        "The Settings control activated, but no distinct semantic player-settings surface with Captions was confirmed.",
        journeySequence,
        currentSettings.descriptor,
      );
      throw new JourneyStop("Player Settings could not be confirmed.");
    }
    const settingsLatency = settingsAction.timing.screenSettledAtMs === undefined
      ? null
      : settingsAction.timing.screenSettledAtMs - settingsAction.timing.inputSentAtMs;
    stages.splice(stages.findIndex((value) => value.stage === "settings"), 1);
    stage("settings", playerExpansion.complete ? "passed" : "partial", settingsLatency === null
      ? "Player Settings opened and exposed Captions; response latency was unavailable."
      : `Player Settings opened and exposed Captions in ${String(Math.max(0, settingsLatency))} ms.`, journeySequence, captionsOnSettings.descriptor);
    const settingsSequence = journeySequence;

    const {
      captionsExpansion,
      expansion,
      textConclusive,
      nestedBackPassed,
      journeySequence: captionJourneySequence,
    } = await runCaptionJourney({
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
    });
    journeySequence = captionJourneySequence;

    const complete = playerExpansion.complete
      && captionsExpansion.complete
      && expansion.complete
      && volumeConclusive
      && textConclusive
      && nestedBackPassed
      && stages.every((result) => result.status === "passed" || result.status === "failed");
    if (!complete) {
      addSkippedStages(stages);
      const localReasons = [playerExpansion.reason, captionsExpansion.reason, expansion.reason];
      const terminationReason = localReasons.includes("max-local-states")
        ? "max-local-states"
        : localReasons.includes("max-local-depth")
          ? "max-local-depth"
          : "journey-partial";
      return {
        status: "partial",
        termination: {
          reason: terminationReason,
          complete: false,
          detail: "The semantic journey ran, but one or more remote, pointer, restoration, or replay observations remained inconclusive.",
        },
        budgets,
        stages,
        issues,
        appearanceControls,
        replays,
        volumeControl,
        pointerProbes,
        journeySequence,
        statistics: session.statistics(),
      };
    }

    return {
      status: "complete",
      termination: {
        reason: "complete",
        complete: true,
        detail: "The bounded semantic streaming journey, local Appearance expansion, and applicable focus replay completed.",
      },
      budgets,
      stages,
      issues,
      appearanceControls,
      replays,
      volumeControl,
      pointerProbes,
      journeySequence,
      statistics: session.statistics(),
    };
  } catch (error) {
    addSkippedStages(stages);
    if (error instanceof JourneyStop) {
      return {
        status: "partial",
        termination: { reason: error.reason, complete: false, detail: error.message },
        budgets,
        stages,
        issues,
        appearanceControls,
        replays,
        volumeControl,
        pointerProbes,
        journeySequence,
        statistics: session.statistics(),
      };
    }
    const stop = error instanceof PackStop
      ? error
      : new PackStop("driver-error", safeErrorMessage(error));
    return {
      status: stop.reason === "ui-tree-unavailable" ? "unobservable" : "error",
      termination: { reason: stop.reason, complete: false, detail: stop.message },
      budgets,
      stages,
      issues,
      appearanceControls,
      replays,
      volumeControl,
      pointerProbes,
      journeySequence,
      statistics: session.statistics(),
    };
  }
}
