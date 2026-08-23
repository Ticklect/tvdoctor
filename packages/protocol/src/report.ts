import type { Capability } from "./capability.js";
import type { ArtifactDescriptor } from "./artifact.js";
import type { TVDoctorIssue } from "./issue.js";
import type { TVDoctorReplayV1 } from "./replay.js";

export const REPORT_SCHEMA_VERSION_V0 = "tvdoctor.report/v0" as const;

/** Compatibility alias retained for existing v0 producers. */
export const REPORT_SCHEMA_VERSION = REPORT_SCHEMA_VERSION_V0;

export const REPORT_SCHEMA_VERSION_V1 = "tvdoctor.report/v1" as const;

export const REPORT_SCHEMA_VERSIONS = [
  REPORT_SCHEMA_VERSION_V0,
  REPORT_SCHEMA_VERSION_V1,
] as const;

export type ReportSchemaVersion = typeof REPORT_SCHEMA_VERSION;

export type ReportSchemaVersionV1 = typeof REPORT_SCHEMA_VERSION_V1;

export type AnyReportSchemaVersion = (typeof REPORT_SCHEMA_VERSIONS)[number];

export const RUN_MODES = ["quick", "standard", "deep"] as const;

export type RunMode = (typeof RUN_MODES)[number];

export const RUN_STATUSES = ["completed", "partial", "failed"] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export interface ReportRunSummary {
  readonly id: string;
  readonly tvdoctorVersion: string;
  readonly mode: RunMode;
  readonly status: RunStatus;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
}

export interface ReportTargetSummary {
  readonly name: string;
  readonly platform: string;
  readonly location: string;
  readonly environment: Readonly<Record<string, string>>;
}

export const PACK_COVERAGE_STATUSES = [
  "completed",
  "partial",
  "skipped",
] as const;

export type PackCoverageStatus = (typeof PACK_COVERAGE_STATUSES)[number];

export interface PackCoverageSummary {
  readonly pack: string;
  readonly status: PackCoverageStatus;
}

export const COVERAGE_BUDGETS = [
  "actions",
  "states",
  "depth",
  "duration",
  "repetitive-items",
] as const;

export type CoverageBudget = (typeof COVERAGE_BUDGETS)[number];

export interface CoverageBudgetSummary {
  readonly maxActions: number | null;
  readonly maxStates: number | null;
  readonly maxDepth: number | null;
  readonly maxDurationMs: number | null;
  readonly maxRepetitiveItems: number | null;
  readonly exhausted: readonly CoverageBudget[];
}

export interface ReportCoverageSummary {
  readonly screenStatesDiscovered: number;
  readonly focusStatesDiscovered: number;
  readonly transitionsTested: number;
  readonly actionsSent: number;
  readonly capabilitiesObserved: readonly Capability[];
  readonly packs: readonly PackCoverageSummary[];
  readonly budget: CoverageBudgetSummary;
}

export interface TVDoctorReportV0 {
  readonly schemaVersion: ReportSchemaVersion;
  readonly run: ReportRunSummary;
  readonly target: ReportTargetSummary;
  readonly coverage: ReportCoverageSummary;
  readonly issues: readonly TVDoctorIssue[];
}

export interface TVDoctorReportV1 {
  readonly schemaVersion: ReportSchemaVersionV1;
  readonly run: ReportRunSummary;
  readonly target: ReportTargetSummary;
  readonly coverage: ReportCoverageSummary;
  readonly issues: readonly TVDoctorIssue[];
  readonly artifacts: readonly ArtifactDescriptor[];
  readonly replays: readonly TVDoctorReplayV1[];
}

export type TVDoctorReport = TVDoctorReportV0 | TVDoctorReportV1;
