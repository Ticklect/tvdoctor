import { createReadStream } from "node:fs";
import { lstat, realpath, rm } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { compileIssueReplay } from "@tvdoctor/core";
import type { PlaywrightWebDriver } from "@tvdoctor/driver-web";
import type { AvailableArtifactDescriptor, TVDoctorIssue } from "@tvdoctor/protocol";
import type { ArtifactStore } from "@tvdoctor/reporters";
import type { CapturedIssue, NodeAuditDriverOptions } from "./node-audit-contracts.js";
import type { TestCommandRequest } from "./cli.js";
import { freshEvidenceDriftReason } from "./node-audit-evidence.js";
import { createSafeExplorationDriver } from "./node-audit-navigation.js";
import { safeKeyboardDriver } from "./keyboard-actions.js";

const MAX_CLIP_ACTIONS = 48;
const MAX_VIDEO_BYTES = 64 * 1024 * 1024;
const CLIP_TIMEOUT_MS = 25_000;

/** Attach at most three replay-verified clips; recording is always opt-in. */
export async function attachIssueReplayVideos(
  store: ArtifactStore,
  captured: readonly CapturedIssue[],
  request: TestCommandRequest,
  createDriver: (options?: NodeAuditDriverOptions) => PlaywrightWebDriver,
): Promise<readonly CapturedIssue[]> {
  if (request.recordVideo !== true || request.signal?.aborted === true) return captured;
  const clips = new Map<string, AvailableArtifactDescriptor>();
  let attempted = 0;
  for (const entry of captured) {
    if (attempted >= 3) break;
    if (entry.failed || entry.issue.confidence !== "deterministic"
      || entry.issue.reproduction.status !== "available") continue;
    attempted += 1;
    const clip = await captureIssueReplayVideo(store, request.target, entry.issue, createDriver, {
      keyboardInteractions: request.inputMode === "keyboard" && request.keyboardInteractions === true,
      fixtureProfileSelection: request.fixtureProfileSelection === true,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (clip !== null) clips.set(entry.issue.id, clip);
  }
  return captured.map((entry) => {
    const clip = clips.get(entry.issue.id);
    return clip === undefined ? entry : {
      ...entry,
      issue: { ...entry.issue, evidence: [...entry.issue.evidence, {
        kind: "verified-fact" as const,
        summary: "A separate, bounded video replay witnessed this issue's transition. Video may contain sensitive target content.",
        source: "Playwright Chromium fresh issue replay", artifact: clip.path,
      }] },
      artifacts: [...entry.artifacts, clip],
    };
  });
}

/**
 * Records a fresh, bounded, issue-specific visual replay. These clips contain
 * the whole short replay, not a guessed slice from the exploratory recording.
 * Never emit evidence if the witness diverges from the saved transition.
 */
export async function captureIssueReplayVideo(
  store: ArtifactStore,
  target: string,
  issue: TVDoctorIssue,
  createDriver: (options?: NodeAuditDriverOptions) => PlaywrightWebDriver,
  options: {
    readonly keyboardInteractions?: boolean;
    readonly fixtureProfileSelection?: boolean;
    readonly signal?: AbortSignal;
  } = {},
): Promise<AvailableArtifactDescriptor | null> {
  if (options.signal?.aborted === true || issue.confidence !== "deterministic"
    || issue.reproduction.status !== "available"
    || issue.reproduction.confidence !== "deterministic"
    || !/^TVDOCTOR-[A-Za-z0-9-]{1,180}$/u.test(issue.id)) return null;
  const compiled = compileIssueReplay(issue);
  if (compiled.status !== "compiled" || compiled.plan.totalActions < 1
    || compiled.plan.totalActions > MAX_CLIP_ACTIONS) return null;
  const sequence = compiled.plan.replay.steps.flatMap(({ key, repeat }) => Array.from({ length: repeat }, () => key));
  if (sequence.length === 0 || sequence.length > MAX_CLIP_ACTIONS) return null;

  const staging = resolve(store.outputRoot, "clip-staging", issue.id);
  const expected = resolve(staging, "audit-session.webm");
  const descriptorPath = `evidence/${issue.id}/issue-video.webm`;
  const driver = createDriver({ recordVideoDirectory: staging });
  const policyDriver = createSafeExplorationDriver(driver, { fixtureProfileSelection: options.fixtureProfileSelection === true });
  const keyboardDriver = options.keyboardInteractions === true ? safeKeyboardDriver(policyDriver) : policyDriver;
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error("Issue replay video timed out.")), CLIP_TIMEOUT_MS);
  const cleanup = async (): Promise<void> => {
    const relativeStaging = relative(resolve(store.outputRoot), staging);
    if (relativeStaging === `clip-staging${sep}${issue.id}`) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  };
  let witnessed = false;
  try {
    await driver.launch({ id: `issue-clip-${issue.id}`, launchUri: target }, { signal: controller.signal });
    for (const key of sequence.slice(0, -1)) {
      controller.signal.throwIfAborted();
      const action = await keyboardDriver.press(key, { signal: controller.signal });
      if (action.outcome !== "applied") return null;
    }
    const before = await driver.snapshot({ signal: controller.signal });
    const finalAction = sequence.at(-1);
    if (finalAction === undefined) return null;
    const action = await keyboardDriver.press(finalAction, { signal: controller.signal });
    if (action.outcome !== "applied") return null;
    const after = await driver.snapshot({ signal: controller.signal });
    witnessed = freshEvidenceDriftReason(issue, { before, after, action }) === null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
    await driver.close().catch(() => undefined);
    if (!witnessed) await cleanup();
  }
  if (!witnessed || controller.signal.aborted) {
    await cleanup();
    return null;
  }

  try {
    if (resolve(driver.getRecordedVideoPath() ?? "") !== expected) return null;
    const video = await lstat(expected);
    if (!video.isFile() || video.isSymbolicLink()
      || video.size === 0 || video.size > MAX_VIDEO_BYTES) return null;
    const realRoot = await realpath(store.outputRoot);
    const realVideo = await realpath(expected);
    const difference = relative(realRoot, realVideo);
    if (difference === ".." || difference.startsWith(`..${sep}`)) return null;
    const saved = await store.writeBundleFileStream(descriptorPath, createReadStream(realVideo));
    return {
      id: `${issue.id}:issue-video`, kind: "video", status: "available",
      path: descriptorPath, mediaType: "video/webm", byteLength: saved.byteLength,
      sha256: saved.sha256,
    };
  } catch {
    return null;
  } finally {
    // Only the exact deterministic staging leaf is deleted; immutable copied
    // evidence is separately owned by the report store.
    await cleanup();
  }
}
