import type { RemoteKey, TVDoctorDriver } from "@tvdoctor/protocol";

import {
  focusedCandidate,
  isPlayerSettingsSurface,
  playbackProgressObservation,
  rankSemanticCandidates,
  semanticStateIdentity,
} from "./semantics.js";
import { expandSurface, findSemanticTarget } from "./streaming-search.js";
import { PackStop, StreamingSession, safeErrorMessage } from "./streaming-runtime.js";
import { validateStreamingOptions } from "./streaming-options.js";
import type {
  StreamingPackOptions,
  StreamingPackStatistics,
} from "./types.js";

export interface StreamingSettingsRouteResult {
  readonly status: "found" | "unavailable";
  /** Exact reset-relative sequence that opens the confirmed Player Settings surface. */
  readonly sequence: readonly RemoteKey[] | null;
  readonly detail: string;
  readonly statistics: StreamingPackStatistics;
}

function unavailable(
  session: StreamingSession,
  detail: string,
): StreamingSettingsRouteResult {
  return {
    status: "unavailable",
    sequence: null,
    detail,
    statistics: session.statistics(),
  };
}

/**
 * Discovers only the reset-relative Player Settings route required by web
 * layout/performance checks. It preserves the streaming pack's safe SELECT
 * checkpoint rules and stops before pause/seek/caption mutation probes.
 */
export async function discoverStreamingSettingsRoute(
  driver: TVDoctorDriver,
  options: StreamingPackOptions = {},
): Promise<StreamingSettingsRouteResult> {
  const budgets = validateStreamingOptions(options);
  const session = new StreamingSession(
    driver,
    budgets,
    options.resetStrategy ?? "reload",
    options.restoreInitialState,
    options.monotonicNow ?? (() => performance.now()),
  );

  try {
    const capabilities = await session.capabilities();
    if (!capabilities.has("remote-input")) {
      return unavailable(session, "The driver does not advertise remote-input capability.");
    }
    if (!capabilities.has("ui-tree")) {
      return unavailable(session, "The driver does not advertise UI-tree capability.");
    }

    const home = await session.restoreAndReplay([], "discovery");
    if (home.uiTree.status !== "available") {
      return unavailable(session, home.uiTree.reason);
    }

    const content = await findSemanticTarget(session, [], "content");
    if (content.status !== "found" || content.candidate === null) {
      return unavailable(session, content.detail);
    }
    await session.activate(content.sequence, content.candidate.descriptor, "discovery");
    const details = await session.snapshot();
    const playVisible = rankSemanticCandidates(details, "play")[0] ?? null;
    if (playVisible === null) {
      return unavailable(session, "Safe content activation did not expose a semantic Play or Resume control.");
    }

    const detailsSequence: readonly RemoteKey[] = [...content.sequence, "SELECT"];
    const play = await findSemanticTarget(session, detailsSequence, "play");
    if (play.status !== "found" || play.candidate === null) {
      return unavailable(session, play.detail);
    }
    await session.activate(play.sequence, play.candidate.descriptor, "discovery");
    const player = await session.snapshot();
    if (rankSemanticCandidates(player, "toggle-play")[0] === undefined
      && playbackProgressObservation(player) === null) {
      return unavailable(session, "Play activation did not expose observable player semantics.");
    }

    const playerSequence: readonly RemoteKey[] = [...play.sequence, "SELECT"];
    const playerExpansion = await expandSurface(session, playerSequence);
    const settings = playerExpansion.states.find((state) => (
      focusedCandidate(state.snapshot, "settings") !== null
    ));
    if (settings === undefined) {
      return unavailable(
        session,
        `Player Settings was not proven remote reachable; expansion stopped at ${playerExpansion.reason}.`,
      );
    }

    const restoredSettings = await session.restoreAndReplay(settings.path, "discovery");
    const currentSettings = focusedCandidate(restoredSettings, "settings");
    if (currentSettings === null) {
      return unavailable(session, "The discovered Settings route did not restore its unique semantic target.");
    }
    const beforeIdentity = semanticStateIdentity(restoredSettings);
    await session.activate(settings.path, currentSettings.descriptor, "discovery");
    const openedSettings = await session.snapshot();
    const afterIdentity = semanticStateIdentity(openedSettings);
    const captions = rankSemanticCandidates(openedSettings, "captions")[0] ?? null;
    if (beforeIdentity === null
      || afterIdentity === null
      || beforeIdentity === afterIdentity
      || !isPlayerSettingsSurface(openedSettings)
      || captions === null) {
      return unavailable(
        session,
        "Settings activation did not prove a distinct Player Settings surface with Captions.",
      );
    }

    return {
      status: "found",
      sequence: [...settings.path, "SELECT"],
      detail: playerExpansion.complete
        ? "A complete bounded player expansion discovered and confirmed Player Settings."
        : `Player Settings was confirmed before bounded expansion stopped at ${playerExpansion.reason}.`,
      statistics: session.statistics(),
    };
  } catch (error) {
    const detail = error instanceof PackStop
      ? error.message
      : `Player Settings route discovery failed: ${safeErrorMessage(error)}`;
    return unavailable(session, detail);
  }
}
