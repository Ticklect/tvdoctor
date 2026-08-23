import type {
  Capability,
  IssueConfidence,
  IssueSeverity,
  RemoteKey,
  ReportSchemaVersionV1,
} from "@tvdoctor/protocol";

export const BASELINE_SCHEMA_VERSION_V1 = "tvdoctor.baseline/v1" as const;
export const COMPARISON_SCHEMA_VERSION_V1 = "tvdoctor.comparison/v1" as const;

export interface BaselineScreenObservation {
  /** Stable semantic key; never a traversal-order index. */
  readonly key: string;
  readonly label: string | null;
}

export interface BaselineFocusObservation {
  /** Stable semantic key within the screen. */
  readonly key: string;
  readonly screenKey: string;
  readonly role: string | null;
  readonly name: string | null;
}

export interface BaselineTransitionObservation {
  /** Stable identity for the source semantic state and action. */
  readonly key: string;
  readonly fromScreenKey: string;
  readonly fromFocusKey: string | null;
  readonly action: RemoteKey;
  readonly toScreenKey: string;
  readonly toFocusKey: string | null;
}

export interface BaselineLatencyObservation {
  readonly key: string;
  readonly operation: string;
  readonly measuredMs: number;
}

export interface BaselineObservationInventory {
  /** Partial inventories can be inspected, but can never be compared as clean. */
  readonly status: "complete" | "partial";
  readonly screens: readonly BaselineScreenObservation[];
  readonly focusTargets: readonly BaselineFocusObservation[];
  readonly transitions: readonly BaselineTransitionObservation[];
  readonly latencies: readonly BaselineLatencyObservation[];
}

export interface BaselineIssueObservation {
  readonly id: string;
  readonly rule: string;
  readonly pack: string;
  readonly severity: IssueSeverity;
  readonly confidence: IssueConfidence;
}

export interface BaselineSource {
  readonly reportSchemaVersion: ReportSchemaVersionV1;
  readonly runId: string;
  readonly runMode: "quick" | "standard" | "deep";
}

export interface BaselineObservability {
  readonly capabilities: readonly Capability[];
  readonly completedPacks: readonly string[];
  readonly inventoryStatus: "complete";
}

export interface TVDoctorBaselineV1 {
  readonly schemaVersion: typeof BASELINE_SCHEMA_VERSION_V1;
  readonly createdAt: string;
  readonly tvdoctorVersion: string;
  readonly targetId: string;
  readonly platform: string;
  readonly source: BaselineSource;
  readonly observability: BaselineObservability;
  readonly issues: readonly BaselineIssueObservation[];
  readonly inventory: BaselineObservationInventory & { readonly status: "complete" };
}

export interface ComparisonBlocker {
  readonly code:
    | "baseline-invalid"
    | "baseline-incompatible"
    | "current-report-partial"
    | "current-inventory-partial"
    | "capability-missing"
    | "pack-incomplete"
    | "observation-missing";
  readonly detail: string;
}

export interface TransitionChange {
  readonly key: string;
  readonly before: BaselineTransitionObservation;
  readonly after: BaselineTransitionObservation;
}

export interface LatencyRegression {
  readonly key: string;
  readonly operation: string;
  readonly baselineMs: number;
  readonly currentMs: number;
  readonly increaseMs: number;
  readonly ratio: number;
}

export interface BaselineComparisonChanges {
  readonly newIssues: readonly BaselineIssueObservation[];
  readonly resolvedIssues: readonly BaselineIssueObservation[];
  readonly screensAdded: readonly BaselineScreenObservation[];
  readonly screensRemoved: readonly BaselineScreenObservation[];
  readonly focusAdded: readonly BaselineFocusObservation[];
  readonly focusRemoved: readonly BaselineFocusObservation[];
  readonly transitionsAdded: readonly BaselineTransitionObservation[];
  readonly transitionsRemoved: readonly BaselineTransitionObservation[];
  readonly transitionsChanged: readonly TransitionChange[];
  readonly latencyRegressions: readonly LatencyRegression[];
}

export interface TVDoctorBaselineComparisonV1 {
  readonly schemaVersion: typeof COMPARISON_SCHEMA_VERSION_V1;
  readonly baselineRunId: string;
  readonly currentRunId: string;
  readonly status: "identical" | "changed" | "regressed" | "failed-closed";
  readonly shouldFail: boolean;
  readonly blockers: readonly ComparisonBlocker[];
  readonly changes: BaselineComparisonChanges;
}

export interface CreateBaselineOptions {
  /** Defaults to a query/hash-free web URL identity or platform + location. */
  readonly targetId?: string;
  readonly createdAt?: string;
}

export interface CompareBaselineOptions {
  readonly targetId?: string;
  /** Both absolute and relative thresholds must be crossed. Defaults: 100ms and 1.20. */
  readonly latencyAbsoluteToleranceMs?: number;
  readonly latencyRatioThreshold?: number;
}
