/** Safe deterministic keys used by automatic navigation exploration. */
export const NAVIGATION_KEYS = [
  "UP",
  "DOWN",
  "LEFT",
  "RIGHT",
  "SELECT",
  "BACK",
] as const;

/** Explicit remote inputs accepted by drivers, startup actions, and replay. */
export const REMOTE_KEYS = [
  ...NAVIGATION_KEYS,
  "HOME",
  "PLAY_PAUSE",
  "PLAY",
  "PAUSE",
  "STOP",
  "NEXT",
  "PREVIOUS",
  "REWIND",
  "FAST_FORWARD",
] as const;

export type RemoteKey = (typeof REMOTE_KEYS)[number];

const REMOTE_KEY_SET: ReadonlySet<string> = new Set(REMOTE_KEYS);

export function isRemoteKey(value: unknown): value is RemoteKey {
  return typeof value === "string" && REMOTE_KEY_SET.has(value);
}
