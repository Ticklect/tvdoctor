export const CAPABILITIES = [
  "remote-input",
  "ui-tree",
  "accessibility-tree",
  "screenshot",
  "video-capture",
  "logs",
  "install",
  "launch",
  "performance",
  "network",
  "player-state",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const CAPABILITY_SET: ReadonlySet<string> = new Set(CAPABILITIES);

export function isCapability(value: unknown): value is Capability {
  return typeof value === "string" && CAPABILITY_SET.has(value);
}
