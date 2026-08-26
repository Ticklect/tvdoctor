import type {
  AppReference,
  LogEntry,
  Observation,
  StateSnapshot,
  UiNodeSnapshot,
} from "@tvdoctor/protocol";

export interface AdbCommandOptions {
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
}

export interface AdbCommandResult {
  readonly stdout: Uint8Array;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Injectable process boundary used by unit tests and hardened hosts. */
export interface AdbCommandExecutor {
  execute(arguments_: readonly string[], options?: AdbCommandOptions): Promise<AdbCommandResult>;
}

export interface AndroidTvDriverOptions {
  /** `adb` executable path. Falls back to ANDROID_SDK_ROOT/ANDROID_HOME, then PATH. */
  readonly adbPath?: string;
  /** Explicit device serial. Omit only when exactly one online device exists. */
  readonly serial?: string;
  readonly commandTimeoutMs?: number;
  readonly hierarchyTimeoutMs?: number;
  readonly maxCommandOutputBytes?: number;
  readonly maxHierarchyBytes?: number;
  readonly maxHierarchyNodes?: number;
  readonly maxHierarchyDepth?: number;
  readonly maxLogEntries?: number;
  readonly maxScreenshotBytes?: number;
  readonly settleTimeoutMs?: number;
  readonly settlePollIntervalMs?: number;
  readonly settleStableSamples?: number;
  readonly noResponseGraceMs?: number;
  /**
   * How long the last settled hierarchy may be reused as the next action's
   * pre-input baseline. Zero disables reuse and always captures fresh.
   */
  readonly baselineReuseMs?: number;
  /**
   * Quiet window between screen-stability samples used to confirm a changed
   * UI without a second full hierarchy capture.
   */
  readonly stabilityProbeMs?: number;
  readonly executor?: AdbCommandExecutor;
}

export interface AndroidAppReference extends AppReference {
  /** Android application id/package name. */
  readonly id: string;
  /** Optional Android component (`package/.Activity`), not a web URL. */
  readonly launchUri?: string;
}

export interface AndroidDeviceMetadata {
  readonly serial: string;
  readonly manufacturer: string | null;
  readonly model: string | null;
  readonly sdkLevel: number | null;
  readonly release: string | null;
  readonly buildFingerprint: string | null;
  readonly characteristics: readonly string[];
  readonly supportedAbis: readonly string[];
  readonly displayWidth: number | null;
  readonly displayHeight: number | null;
  readonly displayDensityDpi: number | null;
  readonly isTelevision: boolean | null;
}

export interface AndroidAppMetadata {
  readonly packageName: string;
  readonly component: string | null;
  readonly pid: number | null;
  readonly versionName: string | null;
  readonly versionCode: number | null;
}

export interface AndroidUiNodeSnapshot extends UiNodeSnapshot {
  readonly className: string | null;
  readonly packageName: string | null;
  readonly clickable: boolean | null;
  readonly scrollable: boolean | null;
  readonly selected: boolean | null;
  readonly children: readonly AndroidUiNodeSnapshot[];
}

export interface AndroidHierarchyMetadata {
  readonly capturedNodeCount: number;
  readonly maxNodeCount: number;
  readonly maxDepth: number;
  readonly truncated: false;
}

export interface AndroidStateSnapshot extends StateSnapshot {
  readonly uiTree: Observation<readonly AndroidUiNodeSnapshot[]>;
  readonly device: Observation<AndroidDeviceMetadata>;
  readonly app: Observation<AndroidAppMetadata>;
  readonly hierarchyMetadata: Observation<AndroidHierarchyMetadata>;
}

export interface AndroidLogEntry extends LogEntry {
  readonly pid: number | null;
  readonly threadId: number | null;
  readonly tag: string | null;
}

export interface AndroidDeviceListEntry {
  readonly serial: string;
  readonly state: string;
  readonly product: string | null;
  readonly model: string | null;
  readonly device: string | null;
  readonly transportId: string | null;
}
