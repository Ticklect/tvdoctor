import {
  ARTIFACT_KINDS,
  type ArtifactDescriptor,
  type ArtifactKind,
} from "./artifact.js";
import { isCapability } from "./capability.js";
import type { ResetStrategy } from "./driver.js";
import {
  EVIDENCE_KINDS,
  ISSUE_CONFIDENCES,
  ISSUE_SEVERITIES,
  REPRODUCTION_CONFIDENCES,
  type TVDoctorIssue,
} from "./issue.js";
import { REMOTE_KEYS, type RemoteKey } from "./remote-key.js";
import { REPLAY_SCHEMA_VERSION, type TVDoctorReplayV1 } from "./replay.js";
import {
  COVERAGE_BUDGETS,
  PACK_COVERAGE_STATUSES,
  REPORT_SCHEMA_VERSION_V0,
  REPORT_SCHEMA_VERSION_V1,
  RUN_MODES,
  RUN_STATUSES,
  type TVDoctorReport,
  type TVDoctorReportV0,
  type TVDoctorReportV1,
} from "./report.js";

export const PROTOCOL_VALIDATION_LIMITS = {
  maxArtifacts: 10_000,
  maxArtifactPathLength: 1_024,
  maxEnvironmentEntries: 512,
  maxIssues: 10_000,
  maxJsonBytes: 8 * 1_024 * 1_024,
  maxListEntries: 10_000,
  maxRemoteRepeat: 10_000,
  maxRemoteSteps: 10_000,
  maxReplays: 10_000,
  maxStringLength: 65_536,
  maxTotalRemotePresses: 100_000,
} as const;

export class ProtocolValidationError extends TypeError {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ProtocolValidationError";
    this.path = path;
  }
}

type JsonRecord = Record<string, unknown>;

const RESET_STRATEGIES: readonly ResetStrategy[] = ["relaunch", "reload", "clear-data"];
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function fail(path: string, message: string): never {
  throw new ProtocolValidationError(path, message);
}

function record(value: unknown, path: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(path, "expected an object");
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(path, "expected a plain JSON object");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return fail(path, "symbol properties are not JSON-compatible");
  }
  return value as JsonRecord;
}

function exactRecord(value: unknown, path: string, keys: readonly string[]): JsonRecord {
  const parsed = record(value, path);
  const expected = new Set(keys);
  for (const key of Object.keys(parsed)) {
    if (!expected.has(key)) fail(`${path}.${key}`, "unexpected field");
  }
  for (const key of keys) {
    if (!Object.hasOwn(parsed, key)) fail(`${path}.${key}`, "missing required field");
  }
  return parsed;
}

function stringValue(
  value: unknown,
  path: string,
  options: { readonly allowEmpty?: boolean; readonly maxLength?: number } = {},
): string {
  if (typeof value !== "string") return fail(path, "expected a string");
  if (options.allowEmpty !== true && value.length === 0) fail(path, "must not be empty");
  if (value.length > (options.maxLength ?? PROTOCOL_VALIDATION_LIMITS.maxStringLength)) {
    fail(path, "string exceeds the protocol size limit");
  }
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  return value === null ? null : stringValue(value, path);
}

function identifier(value: unknown, path: string): string {
  const parsed = stringValue(value, path, { maxLength: 256 });
  if (!IDENTIFIER_PATTERN.test(parsed)) {
    fail(path, "must be a portable identifier containing only letters, digits, '.', '_', ':', or '-'");
  }
  return parsed;
}

function enumValue<T extends string>(value: unknown, path: string, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    return fail(path, `expected one of: ${values.join(", ")}`);
  }
  return value as T;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fail(path, "expected a finite number");
  }
  return value;
}

function nonNegativeInteger(value: unknown, path: string): number {
  const parsed = finiteNumber(value, path);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    fail(path, "expected a non-negative safe integer");
  }
  return parsed;
}

function positiveInteger(value: unknown, path: string, maximum: number): number {
  const parsed = finiteNumber(value, path);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    fail(path, `expected a positive safe integer no greater than ${String(maximum)}`);
  }
  return parsed;
}

function arrayValue(value: unknown, path: string, maximum = PROTOCOL_VALIDATION_LIMITS.maxListEntries): readonly unknown[] {
  if (!Array.isArray(value)) return fail(path, "expected an array");
  if (value.length > maximum) fail(path, "array exceeds the protocol size limit");
  return value;
}

function canonicalTimestamp(value: unknown, path: string): string {
  const parsed = stringValue(value, path, { maxLength: 64 });
  const epoch = Date.parse(parsed);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== parsed) {
    fail(path, "expected a canonical ISO-8601 UTC timestamp");
  }
  return parsed;
}

function portableArtifactPath(value: unknown, path: string): string {
  const parsed = stringValue(value, path, {
    maxLength: PROTOCOL_VALIDATION_LIMITS.maxArtifactPathLength,
  });
  if (parsed !== parsed.trim()
    || parsed.includes("\\")
    || parsed.includes("%")
    || parsed.startsWith("/")
    || /^[A-Za-z]:/u.test(parsed)
    || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(parsed)
    || Array.from(parsed).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })) {
    fail(path, "expected a safe relative POSIX artifact path");
  }

  const decoded = parsed;
  if (decoded.includes("\\") || decoded.startsWith("/") || /^[A-Za-z]:/u.test(decoded)) {
    fail(path, "encoded path resolves to an absolute or non-POSIX path");
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(decoded)
    || Array.from(decoded).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })) {
    fail(path, "encoded path resolves to a URI or contains control characters");
  }
  const segments = decoded.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    fail(path, "path must not contain empty, current-directory, or traversal segments");
  }
  if (segments.some((segment) => (
    segment.length > 255
    || /[<>:"|?*]/u.test(segment)
    || /[. ]$/u.test(segment)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment)
  ))) {
    fail(path, "path contains a segment that is not portable across supported hosts");
  }
  return parsed;
}

function mediaType(value: unknown, path: string): string {
  const parsed = stringValue(value, path, { maxLength: 127 });
  if (!MEDIA_TYPE_PATTERN.test(parsed)) fail(path, "expected a lower-case media type without parameters");
  return parsed;
}

function validateRemoteSteps(value: unknown, path: string, requireNonEmpty: boolean): void {
  const steps = arrayValue(value, path, PROTOCOL_VALIDATION_LIMITS.maxRemoteSteps);
  if (requireNonEmpty && steps.length === 0) fail(path, "must include the demonstrating remote action");
  let totalPresses = 0;
  for (const [index, stepValue] of steps.entries()) {
    const stepPath = `${path}[${String(index)}]`;
    const step = exactRecord(stepValue, stepPath, ["key", "repeat"]);
    enumValue(step["key"], `${stepPath}.key`, REMOTE_KEYS);
    totalPresses += positiveInteger(
      step["repeat"],
      `${stepPath}.repeat`,
      PROTOCOL_VALIDATION_LIMITS.maxRemoteRepeat,
    );
    if (totalPresses > PROTOCOL_VALIDATION_LIMITS.maxTotalRemotePresses) {
      fail(path, "expanded remote sequence exceeds the protocol size limit");
    }
  }
}

function validateTransition(value: unknown, path: string): void {
  const transition = exactRecord(value, path, [
    "fromElement",
    "action",
    "expectedElement",
    "observedElement",
  ]);
  nullableString(transition["fromElement"], `${path}.fromElement`);
  enumValue(transition["action"], `${path}.action`, REMOTE_KEYS);
  nullableString(transition["expectedElement"], `${path}.expectedElement`);
  nullableString(transition["observedElement"], `${path}.observedElement`);
}

function validateIssue(value: unknown, path: string): void {
  const issue = exactRecord(value, path, [
    "id",
    "rule",
    "title",
    "description",
    "severity",
    "confidence",
    "pack",
    "screen",
    "expected",
    "observed",
    "transition",
    "evidence",
    "reproduction",
  ]);
  identifier(issue["id"], `${path}.id`);
  identifier(issue["rule"], `${path}.rule`);
  stringValue(issue["title"], `${path}.title`);
  stringValue(issue["description"], `${path}.description`);
  enumValue(issue["severity"], `${path}.severity`, ISSUE_SEVERITIES);
  enumValue(issue["confidence"], `${path}.confidence`, ISSUE_CONFIDENCES);
  identifier(issue["pack"], `${path}.pack`);
  nullableString(issue["screen"], `${path}.screen`);
  stringValue(issue["expected"], `${path}.expected`);
  stringValue(issue["observed"], `${path}.observed`);
  if (issue["transition"] !== null) validateTransition(issue["transition"], `${path}.transition`);

  const evidence = arrayValue(issue["evidence"], `${path}.evidence`);
  for (const [index, evidenceValue] of evidence.entries()) {
    const evidencePath = `${path}.evidence[${String(index)}]`;
    const entry = exactRecord(evidenceValue, evidencePath, ["kind", "summary", "source", "artifact"]);
    enumValue(entry["kind"], `${evidencePath}.kind`, EVIDENCE_KINDS);
    stringValue(entry["summary"], `${evidencePath}.summary`);
    nullableString(entry["source"], `${evidencePath}.source`);
    if (entry["artifact"] !== null) portableArtifactPath(entry["artifact"], `${evidencePath}.artifact`);
  }

  const reproductionPath = `${path}.reproduction`;
  const reproductionRecord = record(issue["reproduction"], reproductionPath);
  const status = reproductionRecord["status"];
  if (status === "available") {
    const available = exactRecord(issue["reproduction"], reproductionPath, [
      "status",
      "resetStrategy",
      "originalSequence",
      "minimizedSequence",
      "confidence",
      "artifact",
    ]);
    enumValue(available["resetStrategy"], `${reproductionPath}.resetStrategy`, RESET_STRATEGIES);
    validateRemoteSteps(available["originalSequence"], `${reproductionPath}.originalSequence`, false);
    if (available["minimizedSequence"] !== null) {
      validateRemoteSteps(available["minimizedSequence"], `${reproductionPath}.minimizedSequence`, false);
    }
    enumValue(available["confidence"], `${reproductionPath}.confidence`, REPRODUCTION_CONFIDENCES);
    if (available["artifact"] !== null) {
      portableArtifactPath(available["artifact"], `${reproductionPath}.artifact`);
    }
  } else if (status === "unavailable") {
    const unavailable = exactRecord(issue["reproduction"], reproductionPath, ["status", "reason"]);
    stringValue(unavailable["reason"], `${reproductionPath}.reason`);
  } else {
    fail(`${reproductionPath}.status`, "expected available or unavailable");
  }
}

function validateRun(value: unknown, path: string): void {
  const run = exactRecord(value, path, [
    "id",
    "tvdoctorVersion",
    "mode",
    "status",
    "startedAt",
    "completedAt",
    "durationMs",
  ]);
  identifier(run["id"], `${path}.id`);
  stringValue(run["tvdoctorVersion"], `${path}.tvdoctorVersion`, { maxLength: 128 });
  enumValue(run["mode"], `${path}.mode`, RUN_MODES);
  enumValue(run["status"], `${path}.status`, RUN_STATUSES);
  const startedAt = canonicalTimestamp(run["startedAt"], `${path}.startedAt`);
  const completedAt = canonicalTimestamp(run["completedAt"], `${path}.completedAt`);
  nonNegativeInteger(run["durationMs"], `${path}.durationMs`);
  if (Date.parse(completedAt) < Date.parse(startedAt)) fail(`${path}.completedAt`, "must not precede startedAt");
}

function validateTarget(value: unknown, path: string): void {
  const target = exactRecord(value, path, ["name", "platform", "location", "environment"]);
  stringValue(target["name"], `${path}.name`);
  identifier(target["platform"], `${path}.platform`);
  stringValue(target["location"], `${path}.location`);
  const environment = record(target["environment"], `${path}.environment`);
  const entries = Object.entries(environment);
  if (entries.length > PROTOCOL_VALIDATION_LIMITS.maxEnvironmentEntries) {
    fail(`${path}.environment`, "too many environment entries");
  }
  for (const [key, environmentValue] of entries) {
    stringValue(key, `${path}.environment key`, { maxLength: 256 });
    if (key === "__proto__"
      || key === "prototype"
      || key === "constructor"
      || Array.from(key).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 0x1f || codePoint === 0x7f;
      })) {
      fail(`${path}.environment.${key}`, "unsafe environment key");
    }
    stringValue(environmentValue, `${path}.environment.${key}`, {
      allowEmpty: true,
      maxLength: 4_096,
    });
  }
}

function validateCoverage(value: unknown, path: string): void {
  const coverage = exactRecord(value, path, [
    "screenStatesDiscovered",
    "focusStatesDiscovered",
    "transitionsTested",
    "actionsSent",
    "capabilitiesObserved",
    "packs",
    "budget",
  ]);
  for (const field of [
    "screenStatesDiscovered",
    "focusStatesDiscovered",
    "transitionsTested",
    "actionsSent",
  ] as const) {
    nonNegativeInteger(coverage[field], `${path}.${field}`);
  }
  const capabilities = arrayValue(coverage["capabilitiesObserved"], `${path}.capabilitiesObserved`);
  const observedCapabilities = new Set<string>();
  for (const [index, capability] of capabilities.entries()) {
    if (!isCapability(capability)) fail(`${path}.capabilitiesObserved[${String(index)}]`, "unknown capability");
    if (observedCapabilities.has(capability)) fail(`${path}.capabilitiesObserved[${String(index)}]`, "duplicate capability");
    observedCapabilities.add(capability);
  }
  const packs = arrayValue(coverage["packs"], `${path}.packs`);
  const observedPacks = new Set<string>();
  for (const [index, packValue] of packs.entries()) {
    const packPath = `${path}.packs[${String(index)}]`;
    const pack = exactRecord(packValue, packPath, ["pack", "status"]);
    const packId = identifier(pack["pack"], `${packPath}.pack`);
    if (observedPacks.has(packId)) fail(`${packPath}.pack`, "duplicate pack");
    observedPacks.add(packId);
    enumValue(pack["status"], `${packPath}.status`, PACK_COVERAGE_STATUSES);
  }
  const budgetPath = `${path}.budget`;
  const budget = exactRecord(coverage["budget"], budgetPath, [
    "maxActions",
    "maxStates",
    "maxDepth",
    "maxDurationMs",
    "maxRepetitiveItems",
    "exhausted",
  ]);
  for (const field of [
    "maxActions",
    "maxStates",
    "maxDepth",
    "maxDurationMs",
    "maxRepetitiveItems",
  ] as const) {
    if (budget[field] !== null) nonNegativeInteger(budget[field], `${budgetPath}.${field}`);
  }
  const exhausted = arrayValue(budget["exhausted"], `${budgetPath}.exhausted`);
  const exhaustedSet = new Set<string>();
  for (const [index, exhaustedValue] of exhausted.entries()) {
    const exhaustedBudget = enumValue(
      exhaustedValue,
      `${budgetPath}.exhausted[${String(index)}]`,
      COVERAGE_BUDGETS,
    );
    if (exhaustedSet.has(exhaustedBudget)) {
      fail(`${budgetPath}.exhausted[${String(index)}]`, "duplicate exhausted budget");
    }
    exhaustedSet.add(exhaustedBudget);
  }
}

function validateIssues(value: unknown, path: string): ReadonlySet<string> {
  const issues = arrayValue(value, path, PROTOCOL_VALIDATION_LIMITS.maxIssues);
  const issueIds = new Set<string>();
  for (const [index, issueValue] of issues.entries()) {
    const issuePath = `${path}[${String(index)}]`;
    validateIssue(issueValue, issuePath);
    const issue = issueValue as TVDoctorIssue;
    if (issueIds.has(issue.id)) fail(`${issuePath}.id`, "duplicate issue id");
    issueIds.add(issue.id);
  }
  return issueIds;
}

function validateReportCommon(report: JsonRecord, path: string): ReadonlySet<string> {
  validateRun(report["run"], `${path}.run`);
  validateTarget(report["target"], `${path}.target`);
  validateCoverage(report["coverage"], `${path}.coverage`);
  return validateIssues(report["issues"], `${path}.issues`);
}

function validateReplay(value: unknown, path: string): void {
  const replay = exactRecord(value, path, [
    "schemaVersion",
    "id",
    "issueId",
    "reset",
    "steps",
    "assertion",
  ]);
  if (replay["schemaVersion"] !== REPLAY_SCHEMA_VERSION) {
    fail(`${path}.schemaVersion`, `expected ${REPLAY_SCHEMA_VERSION}`);
  }
  identifier(replay["id"], `${path}.id`);
  identifier(replay["issueId"], `${path}.issueId`);
  const reset = exactRecord(replay["reset"], `${path}.reset`, ["strategy"]);
  enumValue(reset["strategy"], `${path}.reset.strategy`, RESET_STRATEGIES);
  validateRemoteSteps(replay["steps"], `${path}.steps`, true);
  const assertionPath = `${path}.assertion`;
  const assertion = exactRecord(replay["assertion"], assertionPath, [
    "type",
    "fromElement",
    "action",
    "expectedElement",
    "observedElement",
  ]);
  if (assertion["type"] !== "transition") fail(`${assertionPath}.type`, "expected transition");
  nullableString(assertion["fromElement"], `${assertionPath}.fromElement`);
  const assertionAction = enumValue(assertion["action"], `${assertionPath}.action`, REMOTE_KEYS);
  nullableString(assertion["expectedElement"], `${assertionPath}.expectedElement`);
  nullableString(assertion["observedElement"], `${assertionPath}.observedElement`);
  const steps = replay["steps"] as readonly { readonly key: RemoteKey }[];
  if (steps.at(-1)?.key !== assertionAction) {
    fail(`${assertionPath}.action`, "must match the final replay step");
  }
}

function validateArtifactDescriptor(value: unknown, path: string): ArtifactDescriptor {
  const initial = record(value, path);
  const status = initial["status"];
  if (status === "available") {
    const artifact = exactRecord(value, path, [
      "id",
      "kind",
      "status",
      "path",
      "mediaType",
      "byteLength",
      "sha256",
    ]);
    identifier(artifact["id"], `${path}.id`);
    enumValue(artifact["kind"], `${path}.kind`, ARTIFACT_KINDS);
    portableArtifactPath(artifact["path"], `${path}.path`);
    mediaType(artifact["mediaType"], `${path}.mediaType`);
    nonNegativeInteger(artifact["byteLength"], `${path}.byteLength`);
    if (artifact["sha256"] !== null
      && (typeof artifact["sha256"] !== "string" || !SHA256_PATTERN.test(artifact["sha256"]))) {
      fail(`${path}.sha256`, "expected null or 64 lower-case hexadecimal characters");
    }
  } else if (status === "unavailable" || status === "failed") {
    const artifact = exactRecord(value, path, ["id", "kind", "status", "reason"]);
    identifier(artifact["id"], `${path}.id`);
    enumValue(artifact["kind"], `${path}.kind`, ARTIFACT_KINDS);
    stringValue(artifact["reason"], `${path}.reason`);
  } else {
    fail(`${path}.status`, "expected available, unavailable, or failed");
  }
  return value as ArtifactDescriptor;
}

export function parseArtifactDescriptor(value: unknown): ArtifactDescriptor {
  return validateArtifactDescriptor(value, "$artifact");
}

export function parseTVDoctorReplayV1(value: unknown): TVDoctorReplayV1 {
  validateReplay(value, "$replay");
  return value as TVDoctorReplayV1;
}

function parseJsonText(json: string, path: string): unknown {
  if (typeof json !== "string") return fail(path, "expected JSON text");
  if (new TextEncoder().encode(json).byteLength > PROTOCOL_VALIDATION_LIMITS.maxJsonBytes) {
    fail(path, "JSON exceeds the protocol size limit");
  }
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return fail(path, "invalid JSON");
  }
}

export function parseTVDoctorReplayJson(json: string): TVDoctorReplayV1 {
  return parseTVDoctorReplayV1(parseJsonText(json, "$replay"));
}

export function parseTVDoctorReport(value: unknown): TVDoctorReport {
  const initial = record(value, "$report");
  const version = initial["schemaVersion"];
  if (version === REPORT_SCHEMA_VERSION_V0) {
    const report = exactRecord(value, "$report", ["schemaVersion", "run", "target", "coverage", "issues"]);
    validateReportCommon(report, "$report");
    return value as TVDoctorReportV0;
  }
  if (version === REPORT_SCHEMA_VERSION_V1) {
    return parseTVDoctorReportV1(value);
  }
  fail("$report.schemaVersion", "unknown or missing report schema version");
}

export function parseTVDoctorReportV1(value: unknown): TVDoctorReportV1 {
  const report = exactRecord(value, "$report", [
    "schemaVersion",
    "run",
    "target",
    "coverage",
    "issues",
    "artifacts",
    "replays",
  ]);
  if (report["schemaVersion"] !== REPORT_SCHEMA_VERSION_V1) {
    fail("$report.schemaVersion", `expected ${REPORT_SCHEMA_VERSION_V1}`);
  }
  const issueIds = validateReportCommon(report, "$report");
  const artifacts = arrayValue(
    report["artifacts"],
    "$report.artifacts",
    PROTOCOL_VALIDATION_LIMITS.maxArtifacts,
  );
  const artifactIds = new Set<string>();
  for (const [index, artifactValue] of artifacts.entries()) {
    const artifactPath = `$report.artifacts[${String(index)}]`;
    const artifact = validateArtifactDescriptor(artifactValue, artifactPath);
    if (artifactIds.has(artifact.id)) fail(`${artifactPath}.id`, "duplicate artifact id");
    artifactIds.add(artifact.id);
  }
  const replays = arrayValue(report["replays"], "$report.replays", PROTOCOL_VALIDATION_LIMITS.maxReplays);
  const replayIds = new Set<string>();
  const replayIssueIds = new Set<string>();
  const issues = report["issues"] as readonly TVDoctorIssue[];
  const issuesById = new Map(issues.map((issue) => [issue.id, issue]));
  for (const [index, replayValue] of replays.entries()) {
    const replayPath = `$report.replays[${String(index)}]`;
    validateReplay(replayValue, replayPath);
    const replay = replayValue as TVDoctorReplayV1;
    if (replayIds.has(replay.id)) fail(`${replayPath}.id`, "duplicate replay id");
    if (!issueIds.has(replay.issueId)) fail(`${replayPath}.issueId`, "does not reference a report issue");
    if (replayIssueIds.has(replay.issueId)) {
      fail(`${replayPath}.issueId`, "duplicate replay for the same issue");
    }
    const issue = issuesById.get(replay.issueId);
    if (issue === undefined) fail(`${replayPath}.issueId`, "does not reference a report issue");
    if (issue.reproduction.status !== "available") {
      fail(`${replayPath}.issueId`, "references an issue without an available reproduction");
    }
    if (replay.reset.strategy !== issue.reproduction.resetStrategy) {
      fail(`${replayPath}.reset.strategy`, "does not match the issue reproduction");
    }
    const matchesSteps = (
      candidate: typeof issue.reproduction.originalSequence,
    ): boolean => candidate.length === replay.steps.length
      && candidate.every((step, stepIndex) => {
        const replayStep = replay.steps[stepIndex];
        return replayStep !== undefined
          && step.key === replayStep.key
          && step.repeat === replayStep.repeat;
      });
    if (!matchesSteps(issue.reproduction.originalSequence)) {
      fail(`${replayPath}.steps`, "does not match the issue original reproduction sequence");
    }
    if (issue.transition === null) {
      fail(`${replayPath}.assertion`, "references an issue without a transition assertion");
    }
    for (const field of [
      "fromElement",
      "action",
      "expectedElement",
      "observedElement",
    ] as const) {
      if (replay.assertion[field] !== issue.transition[field]) {
        fail(`${replayPath}.assertion.${field}`, "does not match the issue transition");
      }
    }
    replayIds.add(replay.id);
    replayIssueIds.add(replay.issueId);
  }
  for (const issue of issues) {
    if (issue.reproduction.status === "available" && !replayIssueIds.has(issue.id)) {
      fail("$report.replays", `missing replay for available issue ${issue.id}`);
    }
  }
  return value as TVDoctorReportV1;
}

export function parseTVDoctorReportJson(json: string): TVDoctorReport {
  return parseTVDoctorReport(parseJsonText(json, "$report"));
}

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return typeof value === "string" && ARTIFACT_KINDS.includes(value as ArtifactKind);
}
