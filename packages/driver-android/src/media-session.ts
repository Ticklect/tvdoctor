import type { AndroidMediaSessionMetadata } from "./types.js";

export const MAX_MEDIA_SESSION_DUMP_BYTES = 512 * 1024;
const MAX_SESSION_RECORD_CHARACTERS = 64 * 1024;
const PACKAGE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u;

const PLAYBACK_STATES: Readonly<Record<string, string>> = {
  "0": "none",
  "1": "stopped",
  "2": "paused",
  "3": "playing",
  "4": "fast-forwarding",
  "5": "rewinding",
  "6": "buffering",
  "7": "error",
  "8": "connecting",
  "9": "skipping-to-previous",
  "10": "skipping-to-next",
  "11": "skipping-to-queue-item",
  NONE: "none",
  STOPPED: "stopped",
  PAUSED: "paused",
  PLAYING: "playing",
  FAST_FORWARDING: "fast-forwarding",
  REWINDING: "rewinding",
  BUFFERING: "buffering",
  ERROR: "error",
  CONNECTING: "connecting",
  SKIPPING_TO_PREVIOUS: "skipping-to-previous",
  SKIPPING_TO_NEXT: "skipping-to-next",
  SKIPPING_TO_QUEUE_ITEM: "skipping-to-queue-item",
};

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function playbackState(record: string): string | null {
  const wrapped = /\b(?:state|playbackState)\s*=\s*PlaybackState\s*\{[^}\r\n]{0,2048}\bstate\s*=\s*(?:STATE_)?([A-Z_]+|\d+)/iu.exec(record)?.[1];
  const direct = /\bplaybackState\s*=\s*(?:STATE_)?([A-Z_]+|\d+)/iu.exec(record)?.[1];
  const token = (wrapped ?? direct)?.toUpperCase();
  return token === undefined ? null : PLAYBACK_STATES[token] ?? null;
}

export function parseMediaSessionDump(
  text: string,
  targetPackage: string,
): AndroidMediaSessionMetadata | null {
  if (!PACKAGE_PATTERN.test(targetPackage)) {
    throw new TypeError("Android media-session target package is invalid.");
  }
  if (typeof text !== "string"
    || Buffer.byteLength(text, "utf8") > MAX_MEDIA_SESSION_DUMP_BYTES) {
    return null;
  }

  const starts = [...text.matchAll(/^[ \t]*MediaSessionRecord\b/gmu)].map((match) => match.index);
  const packageExpression = new RegExp(
    `\\b(?:package|packageName)\\s*=\\s*${escapeRegularExpression(targetPackage)}(?=[\\s,)])`,
    "u",
  );
  const candidates: AndroidMediaSessionMetadata[] = [];
  for (const [index, start] of starts.entries()) {
    const end = starts[index + 1] ?? text.length;
    if (end - start > MAX_SESSION_RECORD_CHARACTERS) continue;
    const record = text.slice(start, end);
    if (!packageExpression.test(record)) continue;
    const activeMatch = /\bactive\s*=\s*(true|false)\b/iu.exec(record);
    if (activeMatch === null) continue;
    candidates.push({
      packageName: targetPackage,
      active: activeMatch[1]?.toLowerCase() === "true",
      playbackState: playbackState(record),
    });
  }
  return candidates.find((candidate) => candidate.active) ?? candidates[0] ?? null;
}
