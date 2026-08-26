import type {
  ElementBounds,
  LogEntry,
  Observation,
  StateSnapshot,
  UiNodeSnapshot,
} from "@tvdoctor/protocol";
import type { BrowserContextOptions, LaunchOptions } from "playwright";

export interface WebSettleOptions {
  /** Maximum time allowed for an action to become observably stable. */
  readonly timeoutMs?: number;
  /** Required quiet period after the last meaningful mutation or focus event. */
  readonly quietWindowMs?: number;
  /** Grace period for inputs that legitimately make no observable change. */
  readonly noResponseGraceMs?: number;
  /**
   * Opt in to ending the wait early on pre-existing high-frequency DOM churn.
   * Canonical fingerprints and replay remain the caller's correctness gates.
   */
  readonly ambientChurnEscape?: boolean;
}

export interface PlaywrightWebDriverOptions {
  readonly artifactsDirectory?: string;
  readonly browserLaunchOptions?: LaunchOptions;
  readonly contextOptions?: BrowserContextOptions;
  readonly headless?: boolean;
  readonly maxLogEntries?: number;
  /** Maximum DOM depth inspected while constructing a UI snapshot. */
  readonly maxUiDepth?: number;
  readonly maxUiNodes?: number;
  /** Maximum elements inspected, including non-semantic wrapper elements. */
  readonly maxUiScanNodes?: number;
  /** Maximum source text characters inspected while deriving labels and text. */
  readonly maxUiTextChars?: number;
  /** Maximum in-flight requests retained strongly for status correlation. */
  readonly maxPendingNetworkRequests?: number;
  readonly navigationTimeoutMs?: number;
  readonly recentNetworkEntries?: number;
  readonly settle?: WebSettleOptions;
}

export interface WebDomNodeSnapshot extends UiNodeSnapshot {
  readonly tagName: string;
  readonly enabled: boolean | null;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly WebDomNodeSnapshot[];
}

export interface WebUiTreeMetadata {
  readonly capturedNodeCount: number;
  /** Elements inspected across the main document, open shadow roots, and same-origin frames. */
  readonly domElementCount: number;
  readonly maxDepth: number;
  readonly maxNodeCount: number;
  readonly maxScannedNodeCount: number;
  readonly maxTextChars: number;
  readonly scannedNodeCount: number;
  readonly textCharsRead: number;
  /** Nodes inspected while deriving bounded accessible names and direct text. */
  readonly textNodesScanned: number;
  readonly truncationReasons: readonly ("captured-nodes" | "depth" | "scanned-nodes" | "text")[];
  readonly truncated: boolean;
}

export interface WebObservationTimings {
  readonly browserEvaluationMs: number;
  readonly domEnumerationMs: number;
  readonly semanticAnalysisMs: number;
  readonly auxiliaryObservationMs: number;
  readonly transportAndSanitisationMs: number;
  readonly browserRoundTripAndQueueingMs: number;
}

/** Cumulative, process-local driver timings for profiling an audit run. */
export interface WebDriverPerformanceProfile {
  readonly resetCount: number;
  readonly resetMs: number;
  readonly pressCount: number;
  /** Includes dispatch plus the driver's DOM/focus settling boundary. */
  readonly pressMs: number;
  readonly snapshotCount: number;
  /** End-to-end page observation wall time. */
  readonly snapshotMs: number;
  readonly observation: WebObservationTimings;
}

export interface WebViewportSnapshot {
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
  readonly scrollX: number;
  readonly scrollY: number;
}

export interface WebMediaTimeRange {
  readonly startSeconds: number;
  readonly endSeconds: number;
}

export interface WebMediaElementSnapshot {
  readonly stableId: string | null;
  readonly kind: "audio" | "video";
  readonly source: string | null;
  readonly bounds: ElementBounds | null;
  readonly visible: boolean;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly muted: boolean;
  readonly volume: number;
  readonly playbackRate: number;
  readonly currentTimeSeconds: number;
  readonly durationSeconds: number | null;
  readonly readyState: number;
  readonly networkState: number;
  readonly buffered: readonly WebMediaTimeRange[];
}

export type WebLogSource = "browser" | "console" | "page-error";

export interface WebLogEntry extends LogEntry {
  readonly source: WebLogSource;
  readonly location: string | null;
  readonly stack: string | null;
}

export type WebNetworkOutcome = "failed" | "pending" | "succeeded";

export interface WebNetworkEntry {
  readonly method: string;
  readonly url: string;
  readonly resourceType: string;
  readonly outcome: WebNetworkOutcome;
  readonly status: number | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly failure: string | null;
}

export interface WebNetworkSnapshot {
  readonly requestsStarted: number;
  readonly requestsSucceeded: number;
  readonly requestsFailed: number;
  readonly requestsInFlight: number;
  /** In-flight requests still held strongly for bounded status correlation. */
  readonly pendingRequestsTracked: number;
  /** Requests evicted from that bounded retention set while still in flight. */
  readonly pendingRequestsDropped: number;
  readonly recentEntries: readonly WebNetworkEntry[];
}

export interface WebNavigationTimingSnapshot {
  readonly type: string;
  readonly redirectCount: number;
  readonly timeToFirstByteMs: number | null;
  readonly responseDownloadMs: number | null;
  readonly domInteractiveMs: number | null;
  readonly domContentLoadedMs: number | null;
  readonly loadEventMs: number | null;
}

export interface WebPerformanceSnapshot {
  readonly navigation: WebNavigationTimingSnapshot | null;
  readonly resourceCount: number;
}

export interface WebStateSnapshot extends StateSnapshot {
  readonly uiTree: Observation<readonly WebDomNodeSnapshot[]>;
  readonly uiTreeMetadata: Observation<WebUiTreeMetadata>;
  readonly viewport: Observation<WebViewportSnapshot>;
  readonly mediaElements: Observation<readonly WebMediaElementSnapshot[]>;
  readonly network: Observation<WebNetworkSnapshot>;
  readonly performance: Observation<WebPerformanceSnapshot>;
}
