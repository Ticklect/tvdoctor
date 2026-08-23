import type { ResetStrategy } from "./driver.js";
import type { RemotePressStep } from "./issue.js";
import type { RemoteKey } from "./remote-key.js";

export const REPLAY_SCHEMA_VERSION = "tvdoctor.replay/v1" as const;

export type ReplaySchemaVersion = typeof REPLAY_SCHEMA_VERSION;

export interface ReplayReset {
  readonly strategy: ResetStrategy;
}

export interface ReplayTransitionAssertion {
  readonly type: "transition";
  readonly fromElement: string | null;
  readonly action: RemoteKey;
  readonly expectedElement: string | null;
  readonly observedElement: string | null;
}

/** A platform-neutral, portable sequence that reproduces one issue. */
export interface TVDoctorReplayV1 {
  readonly schemaVersion: ReplaySchemaVersion;
  readonly id: string;
  readonly issueId: string;
  readonly reset: ReplayReset;
  /** Includes the final action that demonstrates the assertion. */
  readonly steps: readonly RemotePressStep[];
  readonly assertion: ReplayTransitionAssertion;
}
