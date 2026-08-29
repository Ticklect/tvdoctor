import {
  isCapability,
  parseTVDoctorReportV1,
  REMOTE_KEYS,
  type Capability,
  type IssueConfidence,
  type IssueSeverity,
  type RemoteKey,
  type TVDoctorReportV1,
} from "@tvdoctor/protocol";
import {
  BASELINE_SCHEMA_VERSION_V1,
  COMPARISON_SCHEMA_VERSION_V1,
  type BaselineComparisonChanges,
  type BaselineFocusObservation,
  type BaselineIssueObservation,
  type BaselineLatencyObservation,
  type BaselineObservationInventory,
  type BaselineScreenObservation,
  type BaselineTransitionObservation,
  type CompareBaselineOptions,
  type ComparisonBlocker,
  type CreateBaselineOptions,
  type LatencyRegression,
  type TVDoctorBaselineComparisonV1,
  type TVDoctorBaselineV1,
  type TransitionChange,
} from "./types.js";

const IDENTIFIER_LIMIT = 512;
const TEXT_LIMIT = 4_000;
const MAX_ITEMS = 20_000;
const REMOTE_KEY_SET: ReadonlySet<string> = new Set(REMOTE_KEYS);
const SEVERITIES: ReadonlySet<string> = new Set(["critical", "high", "medium", "low", "info"]);
const CONFIDENCES: ReadonlySet<string> = new Set(["deterministic", "heuristic", "inference", "unobservable"]);
const BIDI_FORMAT_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

type JsonRecord = Record<string, unknown>;

function record(value: unknown, path: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be a plain JSON object.`);
  }
  return value as JsonRecord;
}

function exact(value: unknown, path: string, keys: readonly string[]): JsonRecord {
  const result = record(value, path);
  const expected = new Set(keys);
  for (const key of Object.keys(result)) {
    if (!expected.has(key)) throw new TypeError(`${path}.${key} is not supported.`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(result, key)) throw new TypeError(`${path}.${key} is required.`);
  }
  return result;
}

function text(value: unknown, path: string, maximum = TEXT_LIMIT): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value !== value.trim()) {
    throw new TypeError(`${path} must be bounded non-empty text.`);
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 32 || codePoint === 127) throw new TypeError(`${path} contains a control character.`);
  }
  return value;
}

function nullableText(value: unknown, path: string): string | null {
  return value === null ? null : text(value, path);
}

function sanitiseUntrustedText(value: string, maximum = TEXT_LIMIT): string {
  const withoutTerminalSequences = value
    // These patterns intentionally name terminal control bytes so hostile
    // labels cannot alter CI output or a rendered baseline diff.
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
  const printable = Array.from(withoutTerminalSequences)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 9 || code === 10 || (code >= 32 && code !== 127 && !(code >= 128 && code <= 159));
    })
    .join("")
    .replace(BIDI_FORMAT_CONTROLS, "")
    .replace(/https?:\/\/[^\s<>"']+/giu, (candidate) => {
      try {
        const url = new URL(candidate);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString();
      } catch {
        return candidate;
      }
    })
    .replace(
      /\b(authorization|proxy-authorization|cookie|set-cookie)(\s*:\s*)[^\n]*/giu,
      (_match, header: string, separator: string) => `${header}${separator}[REDACTED]`,
    )
    .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
    .replace(/\bBasic\s+[A-Za-z0-9+/_=.:-]+/giu, "Basic [REDACTED]")
    .replace(
      /(["']?)([A-Za-z0-9_-]*(?:(?:api|access|refresh|auth)[-_ ]?(?:key|token)|authorization|cookie|password|passwd|secret|session(?:[-_ ]?(?:id|key|token))?|token)[A-Za-z0-9_-]*)\1(\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/giu,
      (_match, quote: string, key: string, separator: string) => `${quote}${key}${quote}${separator}${quote}[REDACTED]${quote}`,
    );
  return Array.from(printable).slice(0, maximum).join("").trim();
}

function untrustedText(value: unknown, path: string, maximum = TEXT_LIMIT): string {
  if (typeof value !== "string") throw new TypeError(`${path} must be bounded non-empty text.`);
  return text(sanitiseUntrustedText(value, maximum), path, maximum);
}

function nullableUntrustedText(value: unknown, path: string): string | null {
  return value === null ? null : untrustedText(value, path);
}

function finiteNonNegative(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${path} must be a finite non-negative number.`);
  }
  return value;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) {
    throw new TypeError(`${path} must be a bounded array.`);
  }
  return value;
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string, path: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const identity = key(value);
    if (seen.has(identity)) throw new TypeError(`${path} contains duplicate identity ${identity}.`);
    seen.add(identity);
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalise(entry));
  if (typeof value !== "object" || value === null) return value;
  const source = value as Readonly<Record<string, unknown>>;
  return Object.fromEntries(Object.keys(source).sort(compareText).map((key) => [key, canonicalise(source[key])]));
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalise(value), null, 2)}\n`;
}

function parseScreen(value: unknown, path: string): BaselineScreenObservation {
  const item = exact(value, path, ["key", "label"]);
  return {
    key: text(item["key"], `${path}.key`, IDENTIFIER_LIMIT),
    label: nullableUntrustedText(item["label"], `${path}.label`),
  };
}

function parseFocus(value: unknown, path: string): BaselineFocusObservation {
  const item = exact(value, path, ["key", "screenKey", "role", "name"]);
  return {
    key: text(item["key"], `${path}.key`, IDENTIFIER_LIMIT),
    screenKey: text(item["screenKey"], `${path}.screenKey`, IDENTIFIER_LIMIT),
    role: nullableUntrustedText(item["role"], `${path}.role`),
    name: nullableUntrustedText(item["name"], `${path}.name`),
  };
}

function parseTransition(value: unknown, path: string): BaselineTransitionObservation {
  const item = exact(value, path, [
    "key",
    "fromScreenKey",
    "fromFocusKey",
    "action",
    "toScreenKey",
    "toFocusKey",
  ]);
  const action = text(item["action"], `${path}.action`, 16);
  if (!REMOTE_KEY_SET.has(action)) throw new TypeError(`${path}.action is not a remote key.`);
  return {
    key: text(item["key"], `${path}.key`, IDENTIFIER_LIMIT),
    fromScreenKey: text(item["fromScreenKey"], `${path}.fromScreenKey`, IDENTIFIER_LIMIT),
    fromFocusKey: nullableText(item["fromFocusKey"], `${path}.fromFocusKey`),
    action: action as RemoteKey,
    toScreenKey: text(item["toScreenKey"], `${path}.toScreenKey`, IDENTIFIER_LIMIT),
    toFocusKey: nullableText(item["toFocusKey"], `${path}.toFocusKey`),
  };
}

function parseLatency(value: unknown, path: string): BaselineLatencyObservation {
  const item = exact(value, path, ["key", "operation", "measuredMs"]);
  return {
    key: text(item["key"], `${path}.key`, IDENTIFIER_LIMIT),
    operation: untrustedText(item["operation"], `${path}.operation`),
    measuredMs: finiteNonNegative(item["measuredMs"], `${path}.measuredMs`),
  };
}

function parseInventory(
  value: unknown,
  path: string,
  requireComplete: boolean,
): BaselineObservationInventory {
  const item = exact(value, path, ["status", "screens", "focusTargets", "transitions", "latencies"]);
  if (item["status"] !== "complete" && item["status"] !== "partial") {
    throw new TypeError(`${path}.status must be complete or partial.`);
  }
  if (requireComplete && item["status"] !== "complete") {
    throw new TypeError(`${path}.status must be complete for a baseline.`);
  }
  const screens = array(item["screens"], `${path}.screens`).map((entry, index) => (
    parseScreen(entry, `${path}.screens[${String(index)}]`)
  )).sort((left, right) => compareText(left.key, right.key));
  const focusTargets = array(item["focusTargets"], `${path}.focusTargets`).map((entry, index) => (
    parseFocus(entry, `${path}.focusTargets[${String(index)}]`)
  )).sort((left, right) => compareText(`${left.screenKey}\u001f${left.key}`, `${right.screenKey}\u001f${right.key}`));
  const transitions = array(item["transitions"], `${path}.transitions`).map((entry, index) => (
    parseTransition(entry, `${path}.transitions[${String(index)}]`)
  )).sort((left, right) => compareText(left.key, right.key));
  const latencies = array(item["latencies"], `${path}.latencies`).map((entry, index) => (
    parseLatency(entry, `${path}.latencies[${String(index)}]`)
  )).sort((left, right) => compareText(left.key, right.key));
  uniqueBy(screens, (entry) => entry.key, `${path}.screens`);
  uniqueBy(focusTargets, (entry) => `${entry.screenKey}\u001f${entry.key}`, `${path}.focusTargets`);
  uniqueBy(transitions, (entry) => entry.key, `${path}.transitions`);
  uniqueBy(latencies, (entry) => entry.key, `${path}.latencies`);
  const screenKeys = new Set(screens.map((entry) => entry.key));
  for (const focus of focusTargets) {
    if (!screenKeys.has(focus.screenKey)) throw new TypeError(`${path}.focusTargets references an unknown screen.`);
  }
  for (const transition of transitions) {
    if (!screenKeys.has(transition.fromScreenKey) || !screenKeys.has(transition.toScreenKey)) {
      throw new TypeError(`${path}.transitions references an unknown screen.`);
    }
  }
  return { status: item["status"], screens, focusTargets, transitions, latencies };
}

function parseIssue(value: unknown, path: string): BaselineIssueObservation {
  const item = exact(value, path, ["id", "rule", "pack", "severity", "confidence"]);
  const severity = text(item["severity"], `${path}.severity`, 32);
  const confidence = text(item["confidence"], `${path}.confidence`, 32);
  if (!SEVERITIES.has(severity)) throw new TypeError(`${path}.severity is invalid.`);
  if (!CONFIDENCES.has(confidence)) throw new TypeError(`${path}.confidence is invalid.`);
  return {
    id: text(item["id"], `${path}.id`, IDENTIFIER_LIMIT),
    rule: text(item["rule"], `${path}.rule`, IDENTIFIER_LIMIT),
    pack: text(item["pack"], `${path}.pack`, IDENTIFIER_LIMIT),
    severity: severity as IssueSeverity,
    confidence: confidence as IssueConfidence,
  };
}

function parseDate(value: unknown, path: string): string {
  const raw = text(value, path, 64);
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError(`${path} must be an ISO timestamp.`);
  return parsed.toISOString();
}

export function parseBaseline(value: unknown): TVDoctorBaselineV1 {
  const root = exact(value, "$baseline", [
    "schemaVersion",
    "createdAt",
    "tvdoctorVersion",
    "targetId",
    "platform",
    "source",
    "observability",
    "issues",
    "inventory",
  ]);
  if (root["schemaVersion"] !== BASELINE_SCHEMA_VERSION_V1) {
    throw new TypeError("$baseline.schemaVersion is incompatible.");
  }
  const source = exact(root["source"], "$baseline.source", ["reportSchemaVersion", "runId", "runMode"]);
  if (source["reportSchemaVersion"] !== "tvdoctor.report/v1") {
    throw new TypeError("$baseline.source.reportSchemaVersion is incompatible.");
  }
  if (source["runMode"] !== "quick" && source["runMode"] !== "standard" && source["runMode"] !== "deep") {
    throw new TypeError("$baseline.source.runMode is invalid.");
  }
  const observability = exact(root["observability"], "$baseline.observability", [
    "capabilities",
    "completedPacks",
    "inventoryStatus",
  ]);
  if (observability["inventoryStatus"] !== "complete") {
    throw new TypeError("$baseline.observability.inventoryStatus must be complete.");
  }
  const capabilities = array(observability["capabilities"], "$baseline.observability.capabilities")
    .map((entry, index) => text(entry, `$baseline.observability.capabilities[${String(index)}]`, 64));
  if (capabilities.some((entry) => !isCapability(entry))) {
    throw new TypeError("$baseline.observability.capabilities contains an invalid capability.");
  }
  const completedPacks = array(observability["completedPacks"], "$baseline.observability.completedPacks")
    .map((entry, index) => text(entry, `$baseline.observability.completedPacks[${String(index)}]`, IDENTIFIER_LIMIT));
  uniqueBy(capabilities, (entry) => entry, "$baseline.observability.capabilities");
  uniqueBy(completedPacks, (entry) => entry, "$baseline.observability.completedPacks");
  const issues = array(root["issues"], "$baseline.issues").map((entry, index) => (
    parseIssue(entry, `$baseline.issues[${String(index)}]`)
  )).sort((left, right) => compareText(`${left.rule}\u001f${left.id}`, `${right.rule}\u001f${right.id}`));
  uniqueBy(issues, (entry) => `${entry.rule}\u001f${entry.id}`, "$baseline.issues");
  const inventory = parseInventory(root["inventory"], "$baseline.inventory", true);
  if (inventory.status !== "complete") throw new TypeError("$baseline.inventory must be complete.");
  return {
    schemaVersion: BASELINE_SCHEMA_VERSION_V1,
    createdAt: parseDate(root["createdAt"], "$baseline.createdAt"),
    tvdoctorVersion: text(root["tvdoctorVersion"], "$baseline.tvdoctorVersion", IDENTIFIER_LIMIT),
    targetId: text(root["targetId"], "$baseline.targetId", IDENTIFIER_LIMIT),
    platform: text(root["platform"], "$baseline.platform", IDENTIFIER_LIMIT),
    source: {
      reportSchemaVersion: "tvdoctor.report/v1",
      runId: text(source["runId"], "$baseline.source.runId", IDENTIFIER_LIMIT),
      runMode: source["runMode"],
    },
    observability: {
      capabilities: [...capabilities].sort(compareText).filter(isCapability) as Capability[],
      completedPacks: [...completedPacks].sort(compareText),
      inventoryStatus: "complete",
    },
    issues,
    inventory: { ...inventory, status: "complete" },
  };
}

export function defaultTargetId(platform: string, location: string): string {
  const safePlatform = text(platform, "platform", IDENTIFIER_LIMIT);
  if (safePlatform === "web") {
    try {
      const url = new URL(location);
      if ((url.protocol === "http:" || url.protocol === "https:")
        && url.username.length === 0 && url.password.length === 0) {
        url.search = "";
        url.hash = "";
        return `${safePlatform}:${url.href}`;
      }
    } catch {
      // Fall through to the bounded platform/location identity.
    }
  }
  return untrustedText(`${safePlatform}:${location}`, "targetId", IDENTIFIER_LIMIT);
}

function validateCompleteSource(report: TVDoctorReportV1, inventory: BaselineObservationInventory): void {
  if (report.run.status !== "completed") throw new TypeError("A baseline requires a completed report run.");
  if (report.coverage.budget.exhausted.length > 0) {
    throw new TypeError("A baseline cannot be created from exhausted coverage budgets.");
  }
  const incomplete = report.coverage.packs.filter((pack) => pack.status !== "completed");
  if (incomplete.length > 0) throw new TypeError("A baseline requires every recorded pack to be completed.");
  if (inventory.status !== "complete") throw new TypeError("A baseline requires a complete observation inventory.");
}

export function createBaseline(
  sourceReport: TVDoctorReportV1,
  sourceInventory: BaselineObservationInventory,
  options: CreateBaselineOptions = {},
): TVDoctorBaselineV1 {
  const report = parseTVDoctorReportV1(sourceReport);
  const inventory = parseInventory(sourceInventory, "$inventory", true);
  validateCompleteSource(report, inventory);
  if (inventory.status !== "complete") throw new TypeError("A baseline requires a complete inventory.");
  const createdAt = options.createdAt === undefined ? new Date().toISOString() : parseDate(options.createdAt, "createdAt");
  const targetId = options.targetId === undefined
    ? defaultTargetId(report.target.platform, report.target.location)
    : untrustedText(options.targetId, "targetId", IDENTIFIER_LIMIT);
  const baseline: TVDoctorBaselineV1 = {
    schemaVersion: BASELINE_SCHEMA_VERSION_V1,
    createdAt,
    tvdoctorVersion: report.run.tvdoctorVersion,
    targetId,
    platform: report.target.platform,
    source: {
      reportSchemaVersion: report.schemaVersion,
      runId: report.run.id,
      runMode: report.run.mode,
    },
    observability: {
      capabilities: [...report.coverage.capabilitiesObserved].sort(compareText),
      completedPacks: report.coverage.packs.map((pack) => pack.pack).sort(compareText),
      inventoryStatus: "complete",
    },
    issues: report.issues.map((issue) => ({
      id: issue.id,
      rule: issue.rule,
      pack: issue.pack,
      severity: issue.severity,
      confidence: issue.confidence,
    })).sort((left, right) => compareText(`${left.rule}\u001f${left.id}`, `${right.rule}\u001f${right.id}`)),
    inventory: { ...inventory, status: "complete" },
  };
  return parseBaseline(baseline);
}

function emptyChanges(): BaselineComparisonChanges {
  return {
    newIssues: [],
    resolvedIssues: [],
    screensAdded: [],
    screensRemoved: [],
    focusAdded: [],
    focusRemoved: [],
    transitionsAdded: [],
    transitionsRemoved: [],
    transitionsChanged: [],
    latencyRegressions: [],
  };
}

function failedClosed(
  baselineRunId: string,
  currentRunId: string,
  blockers: readonly ComparisonBlocker[],
): TVDoctorBaselineComparisonV1 {
  return {
    schemaVersion: COMPARISON_SCHEMA_VERSION_V1,
    baselineRunId,
    currentRunId,
    status: "failed-closed",
    shouldFail: true,
    blockers,
    changes: emptyChanges(),
  };
}

function difference<T>(
  baseline: readonly T[],
  current: readonly T[],
  key: (value: T) => string,
): { readonly added: readonly T[]; readonly removed: readonly T[] } {
  const baselineKeys = new Set(baseline.map(key));
  const currentKeys = new Set(current.map(key));
  return {
    added: current.filter((entry) => !baselineKeys.has(key(entry))),
    removed: baseline.filter((entry) => !currentKeys.has(key(entry))),
  };
}

function transitionSignature(value: BaselineTransitionObservation): string {
  return canonicalJson(value);
}

function safeThreshold(value: number | undefined, fallback: number, label: string): number {
  const candidate = value ?? fallback;
  if (!Number.isFinite(candidate) || candidate < 0) throw new TypeError(`${label} must be finite and non-negative.`);
  return candidate;
}

export function compareBaseline(
  baselineInput: unknown,
  currentReportInput: TVDoctorReportV1,
  currentInventoryInput: BaselineObservationInventory,
  options: CompareBaselineOptions = {},
): TVDoctorBaselineComparisonV1 {
  let report: TVDoctorReportV1;
  try {
    report = parseTVDoctorReportV1(currentReportInput);
  } catch (error) {
    return failedClosed("unavailable", "unavailable", [{
      code: "current-report-partial",
      detail: `The current report was invalid: ${error instanceof Error ? error.message : String(error)}`,
    }]);
  }
  let baseline: TVDoctorBaselineV1;
  try {
    baseline = parseBaseline(baselineInput);
  } catch (error) {
    return failedClosed("unavailable", report.run.id, [{
      code: "baseline-invalid",
      detail: `The baseline was invalid: ${error instanceof Error ? error.message : String(error)}`,
    }]);
  }
  let inventory: BaselineObservationInventory;
  try {
    inventory = parseInventory(currentInventoryInput, "$currentInventory", false);
  } catch (error) {
    return failedClosed(baseline.source.runId, report.run.id, [{
      code: "current-inventory-partial",
      detail: `The current observation inventory was invalid: ${error instanceof Error ? error.message : String(error)}`,
    }]);
  }
  const blockers: ComparisonBlocker[] = [];
  const targetId = options.targetId === undefined
    ? defaultTargetId(report.target.platform, report.target.location)
    : (() => {
        try {
          return text(options.targetId, "targetId", IDENTIFIER_LIMIT);
        } catch (error) {
          return `invalid:${error instanceof Error ? error.message : String(error)}`;
        }
      })();
  if (baseline.platform !== report.target.platform || baseline.targetId !== targetId) {
    blockers.push({
      code: "baseline-incompatible",
      detail: "The baseline target identity or platform does not match the current run.",
    });
  }
  if (report.run.status !== "completed" || report.coverage.budget.exhausted.length > 0) {
    blockers.push({
      code: "current-report-partial",
      detail: "The current run was partial, failed, or exhausted a coverage budget.",
    });
  }
  if (inventory.status !== "complete") {
    blockers.push({ code: "current-inventory-partial", detail: "The current observation inventory is partial." });
  }
  const capabilities = new Set(report.coverage.capabilitiesObserved);
  for (const capability of baseline.observability.capabilities) {
    if (!capabilities.has(capability)) {
      blockers.push({ code: "capability-missing", detail: `Current run did not observe required capability ${capability}.` });
    }
  }
  const packs = new Map(report.coverage.packs.map((pack) => [pack.pack, pack.status]));
  for (const pack of baseline.observability.completedPacks) {
    if (packs.get(pack) !== "completed") {
      blockers.push({ code: "pack-incomplete", detail: `Current run did not complete baseline pack ${pack}.` });
    }
  }
  const currentLatencies = new Map(inventory.latencies.map((entry) => [entry.key, entry]));
  for (const latency of baseline.inventory.latencies) {
    if (!currentLatencies.has(latency.key)) {
      blockers.push({ code: "observation-missing", detail: `Current run omitted baseline latency observation ${latency.key}.` });
    }
  }
  if (blockers.length > 0) return failedClosed(baseline.source.runId, report.run.id, blockers);

  const currentIssues: BaselineIssueObservation[] = report.issues.map((issue) => ({
    id: issue.id,
    rule: issue.rule,
    pack: issue.pack,
    severity: issue.severity,
    confidence: issue.confidence,
  }));
  const issueDifference = difference(baseline.issues, currentIssues, (entry) => `${entry.rule}\u001f${entry.id}`);
  const screenDifference = difference(baseline.inventory.screens, inventory.screens, (entry) => entry.key);
  const focusDifference = difference(
    baseline.inventory.focusTargets,
    inventory.focusTargets,
    (entry) => `${entry.screenKey}\u001f${entry.key}`,
  );
  const baselineTransitions = new Map(baseline.inventory.transitions.map((entry) => [entry.key, entry]));
  const currentTransitions = new Map(inventory.transitions.map((entry) => [entry.key, entry]));
  const transitionDifference = difference(baseline.inventory.transitions, inventory.transitions, (entry) => entry.key);
  const transitionsChanged: TransitionChange[] = [];
  for (const [key, before] of baselineTransitions) {
    const after = currentTransitions.get(key);
    if (after !== undefined && transitionSignature(before) !== transitionSignature(after)) {
      transitionsChanged.push({ key, before, after });
    }
  }
  const absoluteTolerance = safeThreshold(options.latencyAbsoluteToleranceMs, 100, "latencyAbsoluteToleranceMs");
  const ratioThreshold = safeThreshold(options.latencyRatioThreshold, 1.2, "latencyRatioThreshold");
  if (ratioThreshold < 1) throw new TypeError("latencyRatioThreshold must be at least 1.");
  const latencyRegressions: LatencyRegression[] = [];
  for (const before of baseline.inventory.latencies) {
    const after = currentLatencies.get(before.key);
    if (after === undefined) continue;
    const increaseMs = after.measuredMs - before.measuredMs;
    const ratio = before.measuredMs === 0
      ? after.measuredMs === 0 ? 1 : Number.MAX_VALUE
      : after.measuredMs / before.measuredMs;
    if (increaseMs > absoluteTolerance && ratio > ratioThreshold) {
      latencyRegressions.push({
        key: before.key,
        operation: after.operation,
        baselineMs: before.measuredMs,
        currentMs: after.measuredMs,
        increaseMs,
        ratio,
      });
    }
  }
  const changes: BaselineComparisonChanges = {
    newIssues: [...issueDifference.added].sort((left, right) => compareText(left.id, right.id)),
    resolvedIssues: [...issueDifference.removed].sort((left, right) => compareText(left.id, right.id)),
    screensAdded: [...screenDifference.added].sort((left, right) => compareText(left.key, right.key)),
    screensRemoved: [...screenDifference.removed].sort((left, right) => compareText(left.key, right.key)),
    focusAdded: [...focusDifference.added].sort((left, right) => compareText(left.key, right.key)),
    focusRemoved: [...focusDifference.removed].sort((left, right) => compareText(left.key, right.key)),
    transitionsAdded: [...transitionDifference.added].sort((left, right) => compareText(left.key, right.key)),
    transitionsRemoved: [...transitionDifference.removed].sort((left, right) => compareText(left.key, right.key)),
    transitionsChanged: transitionsChanged.sort((left, right) => compareText(left.key, right.key)),
    latencyRegressions: latencyRegressions.sort((left, right) => compareText(left.key, right.key)),
  };
  const regressed = changes.newIssues.length > 0
    || changes.screensRemoved.length > 0
    || changes.focusRemoved.length > 0
    || changes.transitionsRemoved.length > 0
    || changes.transitionsChanged.length > 0
    || changes.latencyRegressions.length > 0;
  const changed = Object.values(changes).some((entries) => entries.length > 0);
  return {
    schemaVersion: COMPARISON_SCHEMA_VERSION_V1,
    baselineRunId: baseline.source.runId,
    currentRunId: report.run.id,
    status: regressed ? "regressed" : changed ? "changed" : "identical",
    shouldFail: regressed,
    blockers: [],
    changes,
  };
}

export function renderBaselineJson(baseline: TVDoctorBaselineV1): string {
  return canonicalJson(parseBaseline(baseline));
}

export function renderComparisonJson(comparison: TVDoctorBaselineComparisonV1): string {
  return canonicalJson(comparison);
}
