export const REMOTE_KEYS = [
  "UP",
  "DOWN",
  "LEFT",
  "RIGHT",
  "SELECT",
  "BACK",
] as const;

export type RemoteKey = (typeof REMOTE_KEYS)[number];

const REMOTE_KEY_SET: ReadonlySet<string> = new Set(REMOTE_KEYS);

export function isRemoteKey(value: unknown): value is RemoteKey {
  return typeof value === "string" && REMOTE_KEY_SET.has(value);
}
