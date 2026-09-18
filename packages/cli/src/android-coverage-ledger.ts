import type { ExplorationBudgets } from "@tvdoctor/core";
import {
  isRemoteKey,
  type RemoteKey,
} from "@tvdoctor/protocol";

export const ANDROID_COVERAGE_LEDGER_SCHEMA = "tvdoctor.android-coverage/v1" as const;
export const ANDROID_MAX_COVERAGE_ENTRIES = 100_000;

export const ANDROID_COVERAGE_DISPOSITIONS = [
  "exercised",
  "verified-state-reuse",
  "boundary-restored",
  "operator-gated",
  "inaccessible",
  "failed",
] as const;

export type AndroidCoverageDisposition = (typeof ANDROID_COVERAGE_DISPOSITIONS)[number];
export type AndroidCoverageEvidenceStatus = "available" | "unavailable" | "not-collected";

/**
 * Restoration methods retained by the v1 Android coverage schema.
 *
 * Canonical core currently exposes restoration mode rather than the historical
 * per-attempt restoration-method type, so the persisted ledger owns this union.
 */
export type AndroidCoverageRestorationMethod = "live-state" | "verified-path" | "root-replay";

/** Strategies accepted by the v1 Android coverage schema. */
export type AndroidTraversalStrategy = "adaptive" | "brute-force";

export interface AndroidCoverageEvidence {
  readonly accessibility: AndroidCoverageEvidenceStatus;
  readonly screenshot: AndroidCoverageEvidenceStatus;
  readonly media: AndroidCoverageEvidenceStatus;
}

export interface AndroidCoverageRestoration {
  readonly method: AndroidCoverageRestorationMethod;
  readonly exactMatch: boolean;
  readonly fellBack: boolean;
}

export interface AndroidCoverageEntry {
  readonly entryId: string;
  readonly actionId: string;
  readonly screenStateId: string;
  readonly focusStateId: string;
  readonly action: RemoteKey;
  readonly disposition: AndroidCoverageDisposition;
  readonly reasonCode: string;
  readonly detail: string;
  readonly sourcePackage: string | null;
  readonly destinationPackage: string | null;
  readonly evidence: AndroidCoverageEvidence;
  readonly restoration?: AndroidCoverageRestoration;
}

export type AndroidCoverageEntryInput = AndroidCoverageEntry;

export interface AndroidCoverageLedger {
  readonly schema: typeof ANDROID_COVERAGE_LEDGER_SCHEMA;
  readonly strategy: AndroidTraversalStrategy;
  readonly targetPackage: string;
  readonly budgets: ExplorationBudgets;
  readonly entries: readonly AndroidCoverageEntry[];
  readonly counts: Readonly<Record<AndroidCoverageDisposition, number>>;
  readonly truncatedEntries: number;
  readonly remainingSafeFrontier: number;
}

export interface AndroidCoverageLedgerInput {
  readonly strategy: AndroidTraversalStrategy;
  readonly targetPackage: string;
  readonly budgets: ExplorationBudgets;
  readonly entries: readonly AndroidCoverageEntryInput[];
  readonly remainingSafeFrontier: number;
}

const EVIDENCE_STATUSES: readonly AndroidCoverageEvidenceStatus[] = [
  "available",
  "unavailable",
  "not-collected",
];
const RESTORATION_METHODS: readonly AndroidCoverageRestorationMethod[] = [
  "live-state",
  "verified-path",
  "root-replay",
];
const TRAVERSAL_STRATEGIES: readonly AndroidTraversalStrategy[] = ["adaptive", "brute-force"];
const PACKAGE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u;

function isAndroidTraversalStrategy(value: unknown): value is AndroidTraversalStrategy {
  return typeof value === "string"
    && (TRAVERSAL_STRATEGIES as readonly string[]).includes(value);
}

function boundedString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string.`);
  const sanitized = value
    // eslint-disable-next-line no-control-regex -- persisted evidence must not contain terminal controls.
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "")
    .trim()
    .slice(0, maximum);
  if (sanitized.length === 0) throw new TypeError(`${name} must not be empty.`);
  return sanitized;
}

function optionalBoundedString(value: unknown, name: string, maximum: number): string | null {
  if (value === null) return null;
  return boundedString(value, name, maximum);
}

function nonNegativeInteger(value: unknown, name: string, allowZero = true): number {
  if (!Number.isSafeInteger(value)
    || (allowZero ? (value as number) < 0 : (value as number) <= 0)) {
    throw new TypeError(`${name} must be a ${allowZero ? "non-negative" : "positive"} finite integer.`);
  }
  return value as number;
}

function normaliseBudgets(budgets: ExplorationBudgets): ExplorationBudgets {
  if (typeof budgets !== "object" || budgets === null || Array.isArray(budgets)) {
    throw new TypeError("budgets must be an object.");
  }
  return {
    maxActions: nonNegativeInteger(budgets.maxActions, "maxActions", false),
    maxStates: nonNegativeInteger(budgets.maxStates, "maxStates", false),
    maxDepth: nonNegativeInteger(budgets.maxDepth, "maxDepth"),
    maxDurationMs: nonNegativeInteger(budgets.maxDurationMs, "maxDurationMs", false),
  };
}

function normaliseEvidence(value: AndroidCoverageEvidence): AndroidCoverageEvidence {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("entry evidence must be an object.");
  }
  const status = (candidate: unknown, channel: string): AndroidCoverageEvidenceStatus => {
    if (!EVIDENCE_STATUSES.includes(candidate as AndroidCoverageEvidenceStatus)) {
      throw new TypeError(`entry evidence ${channel} status is invalid.`);
    }
    return candidate as AndroidCoverageEvidenceStatus;
  };
  return {
    accessibility: status(value.accessibility, "accessibility"),
    screenshot: status(value.screenshot, "screenshot"),
    media: status(value.media, "media"),
  };
}

function normaliseRestoration(
  value: AndroidCoverageRestoration | undefined,
): AndroidCoverageRestoration | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || !RESTORATION_METHODS.includes(value.method)
    || typeof value.exactMatch !== "boolean"
    || typeof value.fellBack !== "boolean") {
    throw new TypeError("entry restoration metadata is invalid.");
  }
  return {
    method: value.method,
    exactMatch: value.exactMatch,
    fellBack: value.fellBack,
  };
}

function normaliseEntry(value: AndroidCoverageEntryInput): AndroidCoverageEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("coverage entry must be an object.");
  }
  if (!ANDROID_COVERAGE_DISPOSITIONS.includes(value.disposition)) {
    throw new TypeError("coverage entry disposition is invalid.");
  }
  if (!isRemoteKey(value.action)) throw new TypeError("coverage entry action is invalid.");
  const restoration = normaliseRestoration(value.restoration);
  return {
    entryId: boundedString(value.entryId, "entryId", 256),
    actionId: boundedString(value.actionId, "actionId", 256),
    screenStateId: boundedString(value.screenStateId, "screenStateId", 256),
    focusStateId: boundedString(value.focusStateId, "focusStateId", 256),
    action: value.action,
    disposition: value.disposition,
    reasonCode: boundedString(value.reasonCode, "reasonCode", 512),
    detail: boundedString(value.detail, "detail", 512),
    sourcePackage: optionalBoundedString(value.sourcePackage, "sourcePackage", 256),
    destinationPackage: optionalBoundedString(value.destinationPackage, "destinationPackage", 256),
    evidence: normaliseEvidence(value.evidence),
    ...(restoration === undefined ? {} : { restoration }),
  };
}

function stableValue(value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("Coverage ledger cannot contain non-finite numbers.");
  }
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, candidate]) => [key, stableValue(candidate)]));
  }
  return value;
}

function stableEntryKey(entry: AndroidCoverageEntry): string {
  return JSON.stringify(stableValue(entry));
}

export function buildAndroidCoverageLedger(
  input: AndroidCoverageLedgerInput,
): AndroidCoverageLedger {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("Android coverage ledger input must be an object.");
  }
  if (!isAndroidTraversalStrategy(input.strategy)) {
    throw new TypeError("Android coverage strategy is invalid.");
  }
  const targetPackage = boundedString(input.targetPackage, "targetPackage", 256);
  if (!PACKAGE_PATTERN.test(targetPackage)) throw new TypeError("targetPackage is invalid.");
  if (!Array.isArray(input.entries)) throw new TypeError("entries must be an array.");
  const sortedEntries = input.entries.map(normaliseEntry)
    .sort((left, right) => (
      left.entryId.localeCompare(right.entryId)
      || left.actionId.localeCompare(right.actionId)
      || stableEntryKey(left).localeCompare(stableEntryKey(right))
    ));
  const entries = sortedEntries.slice(0, ANDROID_MAX_COVERAGE_ENTRIES);
  const counts: Record<AndroidCoverageDisposition, number> = {
    exercised: 0,
    "verified-state-reuse": 0,
    "boundary-restored": 0,
    "operator-gated": 0,
    inaccessible: 0,
    failed: 0,
  };
  for (const entry of entries) counts[entry.disposition] += 1;
  return {
    schema: ANDROID_COVERAGE_LEDGER_SCHEMA,
    strategy: input.strategy,
    targetPackage,
    budgets: normaliseBudgets(input.budgets),
    entries,
    counts,
    truncatedEntries: sortedEntries.length - entries.length,
    remainingSafeFrontier: nonNegativeInteger(
      input.remainingSafeFrontier,
      "remainingSafeFrontier",
    ),
  };
}

export function serialiseAndroidCoverageLedger(ledger: AndroidCoverageLedger): string {
  return JSON.stringify(stableValue(ledger));
}

export function hasIncompleteSafeCoverage(ledger: AndroidCoverageLedger): boolean {
  return ledger.remainingSafeFrontier > 0
    || ledger.truncatedEntries > 0
    || ledger.counts.inaccessible > 0
    || ledger.counts.failed > 0;
}
