import type { RemoteKey, TVDoctorDriver } from "@tvdoctor/protocol";
import {
  focusedCandidate,
  isPlayerSettingsSurface,
  playbackProgressObservation,
  rankSemanticCandidates,
  semanticStateIdentity,
} from "./semantics.js";
import { validateStreamingOptions } from "./streaming-options.js";
import { findSemanticTarget, focusDescriptor } from "./streaming-search.js";
import {
  PackStop,
  safeErrorMessage,
  StreamingSession,
} from "./streaming-runtime.js";
import type {
  StreamingPackBudgets,
  StreamingPackOptions,
  StreamingPackStatistics,
} from "./types.js";

export interface StreamingSettingsRouteResult {
  readonly status: "found" | "unavailable" | "error";
  /** Exact reset-relative sequence that opens the confirmed Player Settings surface. */
  readonly sequence?: readonly RemoteKey[];
  readonly detail: string;
  readonly budgets: StreamingPackBudgets;
  readonly statistics: StreamingPackStatistics;
}

/**
 * Discovers only the safe route needed by web layout/performance diagnostics.
 * It stops immediately after proving that Settings opens a distinct semantic
 * player-settings surface containing Captions; the rest of the streaming audit
 * is deliberately not executed.
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
  const unavailable = (detail: string): StreamingSettingsRouteResult => ({
    status: "unavailable",
    detail,
    budgets,
    statistics: session.statistics(),
  });

  try {
    const capabilities = await session.capabilities();
    if (!capabilities.has("remote-input")) {
      return unavailable("The driver does not advertise remote-input capability.");
    }
    if (!capabilities.has("ui-tree")) {
      return unavailable("The driver does not advertise UI-tree capability.");
    }

    const home = await session.restoreAndReplay([], "discovery");
    if (home.uiTree.status !== "available") return unavailable(home.uiTree.reason);
    if (focusDescriptor(home) === null) {
      return unavailable("The reset root did not expose one uniquely correlated stable remote focus.");
    }

    const content = await findSemanticTarget(session, [], "content");
    if (content.status !== "found" || content.candidate === null) return unavailable(content.detail);
    await session.activate(content.sequence, content.candidate.descriptor, "discovery");
    const detailsSequence: readonly RemoteKey[] = [...content.sequence, "SELECT"];

    const play = await findSemanticTarget(session, detailsSequence, "play");
    if (play.status !== "found" || play.candidate === null) return unavailable(play.detail);
    await session.activate(play.sequence, play.candidate.descriptor, "discovery");
    const playerSequence: readonly RemoteKey[] = [...play.sequence, "SELECT"];
    const player = await session.snapshot();
    if (rankSemanticCandidates(player, "toggle-play").length === 0
      && playbackProgressObservation(player) === null) {
      return unavailable("Play was activated, but the player surface could not be semantically confirmed.");
    }

    const settings = await findSemanticTarget(session, playerSequence, "settings");
    if (settings.status !== "found" || settings.candidate === null) return unavailable(settings.detail);
    const restoredSettings = await session.restoreAndReplay(settings.sequence, "discovery");
    const currentSettings = focusedCandidate(restoredSettings, "settings");
    if (currentSettings === null) {
      return unavailable("The discovered Settings route no longer restored its uniquely correlated semantic target.");
    }
    const beforeIdentity = semanticStateIdentity(restoredSettings);
    await session.activate(settings.sequence, currentSettings.descriptor, "discovery");
    const settingsSurface = await session.snapshot();
    const afterIdentity = semanticStateIdentity(settingsSurface);
    const confirmed = beforeIdentity !== null
      && afterIdentity !== null
      && beforeIdentity !== afterIdentity
      && isPlayerSettingsSurface(settingsSurface)
      && rankSemanticCandidates(settingsSurface, "captions").length > 0;
    if (!confirmed) {
      return unavailable(
        "The Settings control activated, but no distinct semantic player-settings surface with Captions was confirmed.",
      );
    }

    return {
      status: "found",
      sequence: [...settings.sequence, "SELECT"],
      detail: "A safe exact Player Settings route was discovered and confirmed on a distinct captions-bearing settings surface.",
      budgets,
      statistics: session.statistics(),
    };
  } catch (error) {
    const detail = error instanceof PackStop ? error.message : safeErrorMessage(error);
    return {
      status: error instanceof PackStop && (error.reason === "ui-tree-unavailable"
        || error.reason === "remote-input-unavailable") ? "unavailable" : "error",
      detail,
      budgets,
      statistics: session.statistics(),
    };
  }
}
