import type {
  AppReference,
  LogEntry,
  Observation,
  StateSnapshot,
  UiNodeSnapshot,
} from "@tvdoctor/protocol";
import type { AndroidObserverAsset } from "./observer-asset.js";
import type { AndroidObserverClientOptions, AndroidObserverConnection } from "./observer-client.js";

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
  readonly maxCommandOutputBytes?: number;
  readonly maxLogEntries?: number;
  readonly maxScreenshotBytes?: number;
  /** Bounded observer settle deadline for a normal remote action. */
  readonly settleTimeoutMs?: number;
  /** Event quiet window required before a changed state is returned. */
  readonly quietWindowMs?: number;
  /** Event-free period before bounded canonical no-op confirmation begins. */
  readonly noResponseGraceMs?: number;
  readonly observerConnectTimeoutMs?: number;
  readonly observerRequestTimeoutMs?: number;
  /** Cooperative cancellation shared by ADB setup, input, and observer requests. */
  readonly signal?: AbortSignal;
  readonly executor?: AdbCommandExecutor;
  /** Test/release injection seams; normal callers should use the packaged observer. */
  readonly observerAsset?: AndroidObserverAsset;
  readonly createObserverClient?: (options: AndroidObserverClientOptions) => Promise<AndroidObserverConnection>;
  readonly tokenFactory?: () => string;
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
  readonly truncated: boolean;
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

export interface AndroidObserverMetrics {
  readonly stateMessages: number;
  readonly fullTreeMessages: number;
  readonly lightweightStateMessages: number;
  readonly canonicalPayloadBytes: number;
  readonly transport: {
    readonly bytesSent: number;
    readonly bytesReceived: number;
    readonly framesSent: number;
    readonly framesReceived: number;
  } | null;
}
