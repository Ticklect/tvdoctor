import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { compareBaseline, createBaseline, type BaselineObservationInventory } from "@tvdoctor/baseline";
import { compileReplay } from "@tvdoctor/core";
import {
  PROTOCOL_VALIDATION_LIMITS,
  REPORT_SCHEMA_VERSION_V1,
  parseTVDoctorReportJson,
  type TVDoctorReportV1,
} from "@tvdoctor/protocol";
import type { CliOperations, ReplayCommandStatus, TestCommandRequest } from "./cli.js";
import {
  JOURNEY_HASH_ENVIRONMENT_KEY,
  loadJourney,
} from "./journey.js";
import {
  REPLAY_TARGET_OVERRIDE_ENVIRONMENT_KEY,
  REPLAY_TARGET_OVERRIDE_REQUIRED,
} from "./node-audit-contracts.js";
import { createNodeCliOperations } from "./node-replay.js";
import { PROJECT_AUTH_READY_HASH_ENVIRONMENT_KEY, projectAuthReadyDigest,
  type ProjectAuthReadyMarker } from "./project-auth-binding.js";

const INVENTORY_MAX_BYTES = 16 * 1024 * 1024;
const ORIGINAL_TRANSITION_MAX_BYTES = 1024 * 1024;
const JOURNEY_MAX_BYTES = 64 * 1024;
const HEX_SHA256 = /^[0-9a-f]{64}$/u;
const INDEPENDENT_KEYBOARD_ORACLES = {
  "keyboard.modal-focus-escape": "modal-focus-escape",
  "keyboard.modal-tab-focus-loss": "modal-tab-focus-loss",
  "keyboard.modal-open-focus-not-transferred": "modal-open-focus-not-transferred",
} as const;

function independentlyVerifiableKeyboardRule(rule: string):
    (typeof INDEPENDENT_KEYBOARD_ORACLES)[keyof typeof INDEPENDENT_KEYBOARD_ORACLES] | null {
  if (Object.prototype.hasOwnProperty.call(INDEPENDENT_KEYBOARD_ORACLES, rule)) {
    return INDEPENDENT_KEYBOARD_ORACLES[rule as keyof typeof INDEPENDENT_KEYBOARD_ORACLES];
  }
  return null;
}

export type VerifyWorkflowVerdict = "FIXED" | "REPRODUCED" | "INCONCLUSIVE";

export interface VerifyFreshScanOptions {
  /** A NEW output directory, exclusively reserved by the existing audit runner. */
  readonly outputPath: string;
  /** Only a complete, hash-verified inventory can support semantic comparison. */
  readonly compareToOriginal?: boolean;
  /** Override only when these settings were also used for the original run. */
  readonly screenshots?: boolean;
  readonly maxDurationMs?: number;
  readonly maxActions?: number;
}

export interface VerifyWorkflowRequest {
  readonly originalReportPath: string;
  readonly issueId: string;
  /** Explicit consent is required for browser navigation and replay. */
  readonly authorized: boolean;
  /** The actual currently running application, e.g. a rebuilt localhost server. */
  readonly targetOverride?: string;
  /** Optional external CI artifact checksum pin, never substituted for file validation. */
  readonly expectedOriginalSha256?: string;
  readonly journeyPath?: string;
  readonly authReady?: ProjectAuthReadyMarker;
  readonly freshScan?: VerifyFreshScanOptions;
  readonly signal?: AbortSignal;
}

export interface VerifyWorkflowComparison {
  readonly status: "no-regressions" | "regressed" | "inconclusive";
  readonly reason: string | null;
  readonly baselineRunId: string | null;
  readonly currentRunId: string | null;
  readonly newFindings: number | null;
  readonly noLongerObserved: number | null;
  /** A missing finding in a scan is NOT evidence of a fix. */
  readonly noLongerObservedMeansFixed: false;
  readonly blockers: readonly string[];
}

export interface VerifyWorkflowResult {
  readonly schemaVersion: "tvdoctor.verify-workflow/v1";
  readonly classification: VerifyWorkflowVerdict;
  readonly fixed: boolean | null;
  /** CI must fail on uncertainty, an observed failure or unrelated new regressions. */
  readonly shouldFail: boolean;
  readonly reason: string | null;
  readonly original: {
    readonly runId: string | null;
    readonly issueId: string;
    readonly rule: string | null;
    readonly reportSha256: string | null;
    readonly reportByteLength: number | null;
    readonly inputMode: "keyboard" | null;
    readonly targetOverridden: boolean;
  };
  readonly replay: {
    readonly status: ReplayCommandStatus | null;
    readonly stableFixConfirmationRequested: boolean;
    readonly originalSequenceReused: boolean;
  };
  readonly freshScan: {
    readonly status: "completed" | "partial" | "failed" | "unavailable";
    readonly runId: string | null;
    readonly reportSha256: string | null;
  } | null;
  readonly comparison: VerifyWorkflowComparison | null;
}

export interface VerifyWorkflowDependencies {
  readonly operations?: Pick<CliOperations, "replayIssue" | "testTarget">;
}

type Original = VerifyWorkflowResult["original"];
type Fresh = VerifyWorkflowResult["freshScan"];

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeTarget(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:")
    || url.username !== "" || url.password !== "") {
    throw new TypeError("Only credential-free HTTP(S) targets are supported.");
  }
  return url.href;
}

async function boundedFile(path: string, limit: number): Promise<Buffer> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > limit) {
    throw new TypeError("The evidence file is absent, empty or exceeds its limit.");
  }
  const bytes = await readFile(path);
  if (bytes.length <= 0 || bytes.length > limit || bytes.length !== metadata.size) {
    throw new TypeError("The evidence changed during reading.");
  }
  return bytes;
}

async function loadReport(path: string): Promise<{
  readonly report: TVDoctorReportV1; readonly digest: string; readonly length: number;
  /** The exact immutable initial bytes, used for a private replay snapshot. */
  readonly bytes: Buffer;
}> {
  const bytes = await boundedFile(path, PROTOCOL_VALIDATION_LIMITS.maxJsonBytes);
  const parsed = parseTVDoctorReportJson(bytes.toString("utf8"));
  if (parsed.schemaVersion !== REPORT_SCHEMA_VERSION_V1) {
    throw new TypeError("Independent verification requires a v1 original report.");
  }
  return { report: parsed, digest: sha256(bytes), length: bytes.length, bytes };
}

async function unchangedFile(path: string, digest: string, length: number, limit: number): Promise<boolean> {
  try {
    const bytes = await boundedFile(path, limit);
    return bytes.length === length && sha256(bytes) === digest;
  } catch {
    return false;
  }
}

function unchangedReport(path: string, digest: string, length: number): Promise<boolean> {
  return unchangedFile(path, digest, length, PROTOCOL_VALIDATION_LIMITS.maxJsonBytes);
}

/**
 * Reporter evidence capture attaches a checksummed transition artifact to the
 * original machine-readable modal/open witness. The compiler validates the
 * original issue's semantic JSON, but only the report-bundle boundary can
 * independently prove that the attached file still belongs to the issue and
 * matches its sealed descriptor. Reject moved files, symlinks and forged slots.
 */
async function verifiedModalOpenTransitionArtifact(reportPath: string, report: TVDoctorReportV1,
  issueId: string): Promise<{ readonly path: string; readonly digest: string; readonly length: number } | null> {
  const item = report.issues.find((issue) => issue.id === issueId);
  const witnesses = item?.evidence.filter((entry) => entry.kind === "verified-fact"
    && entry.source === "tvdoctor.keyboard.modal-open/v1") ?? [];
  if (witnesses.length !== 1) return null;
  const witness = witnesses[0];
  const expectedPath = `evidence/${issueId}/transition.json`;
  if (witness?.artifact !== expectedPath || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(issueId)) {
    return null;
  }
  const descriptors = report.artifacts.filter((artifact) => artifact.id === `${issueId}:transition`);
  const descriptor = descriptors[0];
  if (descriptors.length !== 1 || descriptor?.status !== "available"
    || descriptor.kind !== "transition" || descriptor.mediaType !== "application/json"
    || descriptor.path !== expectedPath || descriptor.sha256 === null
    || !HEX_SHA256.test(descriptor.sha256) || descriptor.byteLength <= 0
    || descriptor.byteLength > ORIGINAL_TRANSITION_MAX_BYTES) return null;
  try {
    const directory = resolve(dirname(reportPath));
    const evidenceDirectory = join(directory, "evidence");
    const ownerDirectory = join(evidenceDirectory, issueId);
    const filePath = join(ownerDirectory, "transition.json");
    for (const entry of [directory, evidenceDirectory, ownerDirectory]) {
      const metadata = await lstat(entry);
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(entry) !== entry) return null;
    }
    const fileMetadata = await lstat(filePath);
    if (!fileMetadata.isFile() || fileMetadata.isSymbolicLink() || await realpath(filePath) !== filePath) return null;
    const bytes = await boundedFile(filePath, ORIGINAL_TRANSITION_MAX_BYTES);
    if (bytes.length !== descriptor.byteLength || sha256(bytes) !== descriptor.sha256) return null;
    return { path: filePath, digest: descriptor.sha256, length: bytes.length };
  } catch { return null; }
}

function complete(report: TVDoctorReportV1): boolean {
  return report.run.status === "completed"
    && report.coverage.budget.exhausted.length === 0
    && report.coverage.packs.length > 0
    && report.coverage.packs.every((pack) => pack.status === "completed")
    && report.coverage.packs.some((pack) => pack.pack === "navigation")
    && report.coverage.screenStatesDiscovered > 0
    && report.coverage.focusStatesDiscovered > 0;
}

function conditionsMatch(before: TVDoctorReportV1, after: TVDoctorReportV1): boolean {
  const sorted = (values: readonly string[]) => JSON.stringify([...values].sort());
  const sameValues = (left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>) => (
    sorted(Object.keys(left)) === sorted(Object.keys(right))
    && Object.keys(left).every((key) => left[key] === right[key])
  );
  const beforeBudget = before.coverage.budget;
  const afterBudget = after.coverage.budget;
  return before.run.id !== after.run.id
    && before.target.platform === after.target.platform
    && before.target.location === after.target.location
    && before.run.mode === after.run.mode
    && before.run.tvdoctorVersion === after.run.tvdoctorVersion
    && before.target.environment["inputMode"] === "keyboard"
    && after.target.environment["inputMode"] === "keyboard"
    && sameValues(before.target.environment, after.target.environment)
    && beforeBudget.maxActions === afterBudget.maxActions
    && beforeBudget.maxStates === afterBudget.maxStates
    && beforeBudget.maxDepth === afterBudget.maxDepth
    && beforeBudget.maxDurationMs === afterBudget.maxDurationMs
    && beforeBudget.maxRepetitiveItems === afterBudget.maxRepetitiveItems
    && sorted(beforeBudget.exhausted) === sorted(afterBudget.exhausted)
    && sorted(before.coverage.capabilitiesObserved) === sorted(after.coverage.capabilitiesObserved)
    && sorted(before.coverage.packs.map((pack) => pack.pack))
      === sorted(after.coverage.packs.map((pack) => pack.pack));
}

async function verifiedInventory(reportPath: string, report: TVDoctorReportV1): Promise<{
  readonly inventory: BaselineObservationInventory; readonly digest: string;
} | null> {
  const matches = report.artifacts.filter((artifact) => artifact.id === "run:inventory");
  const artifact = matches[0];
  if (matches.length !== 1 || artifact?.kind !== "report" || artifact.status !== "available"
    || artifact.path !== "inventory.json" || artifact.mediaType !== "application/json"
    || artifact.byteLength <= 0 || artifact.byteLength > INVENTORY_MAX_BYTES
    || artifact.sha256 === null || !HEX_SHA256.test(artifact.sha256)) return null;
  try {
    const parent = await realpath(dirname(resolve(reportPath)));
    const expected = resolve(parent, "inventory.json");
    const actual = await realpath(expected);
    // Do not follow a moved inventory or a symlink out of the report bundle.
    if (expected !== actual) return null;
    const bytes = await boundedFile(actual, INVENTORY_MAX_BYTES);
    if (bytes.length !== artifact.byteLength || sha256(bytes) !== artifact.sha256) return null;
    const inventory = JSON.parse(bytes.toString("utf8")) as BaselineObservationInventory;
    if (inventory?.status !== "complete" || !Array.isArray(inventory.screens)
      || !Array.isArray(inventory.focusTargets)
      || inventory.screens.length !== report.coverage.screenStatesDiscovered
      || inventory.focusTargets.length !== report.coverage.focusStatesDiscovered) return null;
    return { inventory, digest: artifact.sha256 };
  } catch {
    return null;
  }
}

function inconclusive(original: Original, reason: string, replayStatus: ReplayCommandStatus | null = null,
  freshScan: Fresh = null, comparison: VerifyWorkflowComparison | null = null): VerifyWorkflowResult {
  return {
    schemaVersion: "tvdoctor.verify-workflow/v1", classification: "INCONCLUSIVE", fixed: null,
    shouldFail: true, reason, original,
    replay: { status: replayStatus, stableFixConfirmationRequested: replayStatus !== null,
      // An inconclusive or errored replay might stop before dispatching inputs.
      originalSequenceReused: replayStatus === "fixed" || replayStatus === "reproduced" },
    freshScan, comparison,
  };
}

function inconclusiveComparison(reason: string, before: TVDoctorReportV1,
  after?: TVDoctorReportV1): VerifyWorkflowComparison {
  return {
    status: "inconclusive", reason,
    baselineRunId: before.run.id, currentRunId: after?.run.id ?? null,
    newFindings: null, noLongerObserved: null, noLongerObservedMeansFixed: false,
    blockers: [reason],
  };
}

/**
 * CLI/CI analogue of the independent MCP fix verification workflow.
 * No coding-agent side effects or assumption that an absent finding proves a fix.
 * Returned object is JSON-safe; the entrypoint owns formatting and exit codes.
 */
export async function verifyOriginalFindingWorkflow(
  request: VerifyWorkflowRequest,
  dependencies: VerifyWorkflowDependencies = {},
): Promise<VerifyWorkflowResult> {
  let original: Original = {
    runId: null, issueId: request.issueId, rule: null, reportSha256: null,
    reportByteLength: null, inputMode: null, targetOverridden: request.targetOverride !== undefined,
  };
  if (request.authorized !== true) return inconclusive(original, "authorization-required");
  if (typeof request.issueId !== "string" || request.issueId.length < 1 || request.issueId.length > 256
    || !/^[A-Za-z0-9_.:-]+$/u.test(request.issueId)) return inconclusive(original, "invalid-issue-id");
  if (request.signal?.aborted) return inconclusive(original, "cancelled");
  if (request.expectedOriginalSha256 !== undefined && !HEX_SHA256.test(request.expectedOriginalSha256)) {
    return inconclusive(original, "invalid-report-sha256-pin");
  }
  if (request.freshScan !== undefined
    && (typeof request.freshScan.outputPath !== "string"
      || request.freshScan.outputPath.trim() === ""
      || resolve(request.freshScan.outputPath) === resolve(dirname(request.originalReportPath)))) {
    return inconclusive(original, "invalid-scan-output");
  }
  let loaded: Awaited<ReturnType<typeof loadReport>>;
  try { loaded = await loadReport(request.originalReportPath); }
  catch { return inconclusive(original, "original-report-invalid-or-unavailable"); }
  const { report, digest, length } = loaded;
  original = {
    ...original, runId: report.run.id, reportSha256: digest, reportByteLength: length,
    inputMode: report.target.environment["inputMode"] === "keyboard" ? "keyboard" : null,
  };
  if (request.expectedOriginalSha256 !== undefined && request.expectedOriginalSha256 !== digest) {
    return inconclusive(original, "original-report-sha256-mismatch");
  }
  if (report.target.platform !== "web" || !complete(report)
    || report.target.environment["inputMode"] !== "keyboard") {
    return inconclusive(original, "unsupported-or-incomplete-original-scan");
  }
  const issues = report.issues.filter((issue) => issue.id === request.issueId);
  const issue = issues[0];
  if (issues.length !== 1 || issue === undefined) return inconclusive(original, "original-finding-not-unique");
  original = { ...original, rule: issue.rule };
  // Rule eligibility is an explicit, narrow registry, AND the trusted core
  // compiler must produce that rule's independent oracle from original evidence.
  // A generic replay predicate or a vanished finding is never sufficient.
  const requiredOracle = independentlyVerifiableKeyboardRule(issue.rule);
  if (requiredOracle === null || issue.pack !== "navigation"
    || issue.confidence !== "deterministic"
    || issue.reproduction.status !== "available"
    || issue.reproduction.confidence !== "deterministic") {
    return inconclusive(original, "unsupported-rule-or-reproduction");
  }
  const replays = report.replays.filter((replay) => replay.issueId === request.issueId);
  const replay = replays[0];
  if (replays.length !== 1 || replay === undefined || replay.reset.strategy !== "reload"
    || (requiredOracle === "modal-open-focus-not-transferred"
      ? replay.assertion.action !== "SELECT"
      : replay.assertion.action !== "TAB" && replay.assertion.action !== "SHIFT_TAB")) {
    return inconclusive(original, "unsupported-or-ambiguous-replay");
  }
  const attachedOriginalEvidence = requiredOracle === "modal-open-focus-not-transferred"
    && issue.evidence.some((entry) => entry.source === "tvdoctor.keyboard.modal-open/v1"
      && entry.artifact !== null);
  const originalTransitionArtifact = attachedOriginalEvidence
    ? await verifiedModalOpenTransitionArtifact(request.originalReportPath, report, issue.id) : null;
  if (attachedOriginalEvidence && originalTransitionArtifact === null) {
    return inconclusive(original, "original-rule-evidence-invalid-or-changed");
  }
  const unchangedOriginalTransitionArtifact = async (): Promise<boolean> => originalTransitionArtifact === null
    || await unchangedFile(originalTransitionArtifact.path, originalTransitionArtifact.digest,
      originalTransitionArtifact.length, ORIGINAL_TRANSITION_MAX_BYTES);
  const compiled = compileReplay(replay, { sourceIssue: issue });
  const oracleAssertionsValid = compiled.status === "compiled" && (
    requiredOracle === "modal-open-focus-not-transferred"
      ? compiled.plan.keyboardModalOpenIdentity !== null
        && compiled.plan.keyboardModalOpenIdentity.modal.stableId === replay.assertion.expectedElement
        && compiled.plan.keyboardModalOpenIdentity.opener.stableId === replay.assertion.fromElement
        && replay.assertion.observedElement === replay.assertion.fromElement
      : compiled.plan.elementStateAssertions.some((assertion) =>
        assertion.checkpoint?.containsFocus === true
        && assertion.reproduced !== undefined
        && (requiredOracle === "modal-focus-escape"
          ? assertion.reproduced.containsFocus === false
          : assertion.reproduced.focusAbsent === true)
        && assertion.reproduced.sameAsCheckpoint === true
        && assertion.reproduced.sameLocationAsCheckpoint === true
        && assertion.fixed?.containsFocus === true
        && assertion.fixed.sameAsCheckpoint === true
        && assertion.fixed.sameLocationAsCheckpoint === true)
  );
  if (compiled.status !== "compiled" || compiled.plan.confidence !== "deterministic"
    || compiled.plan.keyboardOracle !== requiredOracle
    || compiled.plan.totalActions > 250
    || !oracleAssertionsValid) {
    return inconclusive(original, "invalid-rule-specific-replay");
  }
  if (report.target.environment[JOURNEY_HASH_ENVIRONMENT_KEY] !== undefined
    && request.journeyPath === undefined) return inconclusive(original, "original-journey-required");
  if (report.target.environment[JOURNEY_HASH_ENVIRONMENT_KEY] === undefined
    && request.journeyPath !== undefined) return inconclusive(original, "unexpected-journey");
  const protectedMarkerDigest = report.target.environment[PROJECT_AUTH_READY_HASH_ENVIRONMENT_KEY];
  if (protectedMarkerDigest !== undefined || report.target.environment[JOURNEY_HASH_ENVIRONMENT_KEY] !== undefined) {
    if (request.authReady === undefined || typeof protectedMarkerDigest !== "string") {
      return inconclusive(original, "original-protected-content-assertion-required");
    }
    try {
      if (projectAuthReadyDigest(request.authReady) !== protectedMarkerDigest) {
        return inconclusive(original, "original-protected-content-assertion-changed");
      }
    } catch { return inconclusive(original, "original-protected-content-assertion-invalid"); }
  } else if (request.authReady !== undefined) {
    return inconclusive(original, "unexpected-protected-content-assertion");
  }
  // Pin the original journey's exact bytes as well as its canonical, secret-free
  // configuration hash. A changed setup between replay and the new scan cannot
  // establish comparable authenticated application state.
  let journeyBytes: Buffer | null = null;
  let journeyDigest: string | null = null;
  if (request.journeyPath !== undefined) {
    try {
      journeyBytes = await boundedFile(request.journeyPath, JOURNEY_MAX_BYTES);
      journeyDigest = sha256(journeyBytes);
      const parsed = await loadJourney(request.journeyPath);
      if (parsed.sha256 !== report.target.environment[JOURNEY_HASH_ENVIRONMENT_KEY]
        || !await unchangedFile(request.journeyPath, journeyDigest, journeyBytes.length, JOURNEY_MAX_BYTES)) {
        return inconclusive(original, "original-journey-invalid-or-mismatch");
      }
    } catch {
      return inconclusive(original, "original-journey-invalid-or-mismatch");
    }
  }
  const unchangedJourney = async (): Promise<boolean> => (
    request.journeyPath === undefined || (journeyBytes !== null && journeyDigest !== null
      && await unchangedFile(request.journeyPath, journeyDigest, journeyBytes.length, JOURNEY_MAX_BYTES))
  );
  if (report.target.environment[REPLAY_TARGET_OVERRIDE_ENVIRONMENT_KEY] === REPLAY_TARGET_OVERRIDE_REQUIRED
    && request.targetOverride === undefined) return inconclusive(original, "target-override-required");
  let target: string;
  try { target = safeTarget(request.targetOverride ?? report.target.location); }
  catch { return inconclusive(original, "invalid-target-url"); }
  if (request.targetOverride !== undefined) {
    try {
      const recorded = new URL(report.target.location);
      const chosen = new URL(target);
      const recordedRouteRedacted = report.target.environment[REPLAY_TARGET_OVERRIDE_ENVIRONMENT_KEY]
        === REPLAY_TARGET_OVERRIDE_REQUIRED
        && recorded.pathname === "/" && recorded.search === "" && recorded.hash === "";
      if (!recordedRouteRedacted
        && (recorded.pathname !== chosen.pathname || recorded.search !== chosen.search
          || recorded.hash !== chosen.hash)) {
        return inconclusive(original, "target-route-differs");
      }
    } catch {
      return inconclusive(original, "invalid-recorded-target");
    }
  }
  const operations = dependencies.operations ?? createNodeCliOperations();
  if (!await unchangedReport(request.originalReportPath, digest, length)
    || !await unchangedOriginalTransitionArtifact() || !await unchangedJourney()) {
    return inconclusive(original, "original-evidence-or-journey-changed-before-replay");
  }
  let replayStatus: ReplayCommandStatus | null = null;
  let replayProblem: string | null = null;
  let privateDirectory: string | null = null;
  try {
    // The generic CLI replay operation necessarily reparses a pathname. Pass
    // it a private byte-for-byte copy of the *initially validated* report,
    // never a mutable original pathname with a check/open race.
    privateDirectory = await mkdtemp(join(tmpdir(), "tvdoctor-verify-replay-"));
    const privateReportPath = join(privateDirectory, "report.json");
    await writeFile(privateReportPath, loaded.bytes, { flag: "wx", mode: 0o600 });
    let privateJourneyPath: string | undefined;
    if (journeyBytes !== null) {
      privateJourneyPath = join(privateDirectory, "journey.json");
      await writeFile(privateJourneyPath, journeyBytes, { flag: "wx", mode: 0o600 });
      const journeySnapshot = await loadJourney(privateJourneyPath);
      if (journeySnapshot.sha256 !== report.target.environment[JOURNEY_HASH_ENVIRONMENT_KEY]) {
        throw new TypeError("The private original journey does not match its sealed configuration.");
      }
    }
    const privateBytes = await boundedFile(privateReportPath, PROTOCOL_VALIDATION_LIMITS.maxJsonBytes);
    if (privateBytes.length !== length || sha256(privateBytes) !== digest) {
      replayProblem = "private-replay-snapshot-mismatch";
    } else {
    const result = await operations.replayIssue({
      issueId: issue.id, reportPath: privateReportPath,
      targetOverride: target, confirmStableFix: true,
      ...(privateJourneyPath === undefined ? {} : { journeyPath: privateJourneyPath }),
      ...(request.authReady === undefined ? {} : { authReady: request.authReady }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    replayStatus = result.status;
    }
  } catch {
    replayProblem = "independent-replay-failed";
  } finally {
    if (privateDirectory !== null) {
      try {
        await rm(privateDirectory, {
          recursive: true, force: true, maxRetries: 5, retryDelay: 100,
        });
      } catch {
        // Failure to remove the private evidence copy must fail closed, even
        // when the replay returned a plausible FIXED status.
        replayProblem = "private-replay-cleanup-failed";
      }
    }
  }
  if (replayProblem !== null) return inconclusive(original, replayProblem, replayStatus);
  if (request.signal?.aborted || !await unchangedReport(request.originalReportPath, digest, length)
    || !await unchangedOriginalTransitionArtifact()
    || !await unchangedJourney()) {
    return inconclusive(original, "cancelled-or-original-evidence-changed", replayStatus);
  }
  if (replayStatus !== "fixed" && replayStatus !== "reproduced") {
    return inconclusive(original, "independent-replay-inconclusive", replayStatus);
  }

  let freshScan: Fresh = null;
  let comparison: VerifyWorkflowComparison | null = null;
  if (request.freshScan !== undefined) {
    const options = request.freshScan;
    if (operations.testTarget === undefined) {
      return inconclusive(original, "fresh-scan-unavailable", replayStatus,
        { status: "unavailable", runId: null, reportSha256: null });
    }
    if (!await unchangedJourney()) return inconclusive(original, "original-journey-changed-before-fresh-scan", replayStatus);
    // The comparison is not supportable when the original has additional packs
    // or an unknown run configuration. No attempt to infer them from new findings.
    const scanRequest: TestCommandRequest = {
      target, packs: ["navigation"], inputMode: "keyboard", mode: report.run.mode,
      outputPath: options.outputPath, searchQuery: "",
      // `tvdoctor scan` intentionally disables repetition compression. Preserve
      // that choice when it was recorded or a purportedly equal scan differs.
      ...(report.coverage.budget.maxRepetitiveItems === null
        ? { disableRepetitionCompression: true } : {}),
      ...(options.screenshots === undefined ? {} : { screenshots: options.screenshots }),
      ...(options.maxDurationMs === undefined ? {} : { maxDurationMs: options.maxDurationMs }),
      ...(options.maxActions === undefined ? {} : { navigationBudgets: { maxActions: options.maxActions } }),
      ...(request.journeyPath === undefined ? {} : { journeyPath: request.journeyPath }),
      ...(request.authReady === undefined ? {} : {
        requireTargetRoute: true,
        authReady: request.authReady,
      }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    };
    let scanResult: Awaited<ReturnType<NonNullable<CliOperations["testTarget"]>>>;
    try { scanResult = await operations.testTarget(scanRequest); }
    catch {
      return inconclusive(original, "fresh-scan-failed", replayStatus,
        { status: "failed", runId: null, reportSha256: null });
    }
    if (scanResult.status !== "completed" || scanResult.reportPath === null || request.signal?.aborted) {
      return inconclusive(original, "fresh-scan-incomplete", replayStatus,
        { status: scanResult.status, runId: null, reportSha256: null });
    }
    if (resolve(scanResult.reportPath) !== resolve(options.outputPath, "report.json")) {
      return inconclusive(original, "fresh-report-path-mismatch", replayStatus,
        { status: "unavailable", runId: null, reportSha256: null });
    }
    let current: Awaited<ReturnType<typeof loadReport>>;
    try { current = await loadReport(scanResult.reportPath); }
    catch {
      return inconclusive(original, "fresh-report-invalid", replayStatus,
        { status: "unavailable", runId: null, reportSha256: null });
    }
    freshScan = {
      status: "completed", runId: current.report.run.id,
      reportSha256: current.digest,
    };
    if (!complete(current.report)) {
      return inconclusive(original, "fresh-report-coverage-incomplete", replayStatus, freshScan);
    }
    if (current.report.target.environment[PROJECT_AUTH_READY_HASH_ENVIRONMENT_KEY]
      !== protectedMarkerDigest) {
      return inconclusive(original, "fresh-protected-content-policy-differs", replayStatus, freshScan);
    }
    if (replayStatus === "fixed" && current.report.issues.some((finding) => (
      finding.rule === issue.rule
      && finding.confidence === "deterministic"
      && finding.pack === issue.pack
    ))) {
      return inconclusive(original, "fresh-scan-contradicts-fixed-replay", replayStatus, freshScan);
    }
    if (options.compareToOriginal === true) {
      if (!conditionsMatch(report, current.report)) {
        comparison = inconclusiveComparison("scan-conditions-or-target-differ", report, current.report);
      } else {
        const before = await verifiedInventory(request.originalReportPath, report);
        const after = await verifiedInventory(scanResult.reportPath, current.report);
        if (before === null || after === null) {
          comparison = inconclusiveComparison("inventory-missing-or-checksum-mismatch", report, current.report);
        } else {
          try {
            const baseline = createBaseline(report, before.inventory);
            const compared = compareBaseline(baseline, current.report, after.inventory);
            comparison = compared.status === "failed-closed"
              ? { ...inconclusiveComparison("semantic-baseline-failed-closed", report, current.report),
                blockers: compared.blockers.map((blocker) => blocker.code) }
              : {
                  status: compared.shouldFail ? "regressed" : "no-regressions",
                  reason: null, baselineRunId: report.run.id, currentRunId: current.report.run.id,
                  newFindings: compared.changes.newIssues.length,
                  noLongerObserved: compared.changes.resolvedIssues.length,
                  noLongerObservedMeansFixed: false, blockers: [],
                };
          } catch {
            comparison = inconclusiveComparison("semantic-baseline-invalid", report, current.report);
          }
        }
      }
      if (comparison?.status === "inconclusive") {
        return inconclusive(original, "comparison-inconclusive", replayStatus, freshScan, comparison);
      }
    }
    if (!await unchangedReport(scanResult.reportPath, current.digest, current.length)
      || !await unchangedOriginalTransitionArtifact() || !await unchangedJourney()) {
      return inconclusive(original, "fresh-evidence-changed", replayStatus, freshScan, comparison);
    }
  }
  if (!await unchangedReport(request.originalReportPath, digest, length)
    || !await unchangedOriginalTransitionArtifact()
    || !await unchangedJourney() || request.signal?.aborted) {
    return inconclusive(original, "cancelled-or-original-evidence-changed", replayStatus, freshScan, comparison);
  }
  const classification = replayStatus === "fixed" ? "FIXED" : "REPRODUCED";
  return {
    schemaVersion: "tvdoctor.verify-workflow/v1", classification,
    fixed: classification === "FIXED", reason: null,
    shouldFail: classification !== "FIXED" || comparison?.status === "regressed",
    original,
    replay: { status: replayStatus, stableFixConfirmationRequested: true, originalSequenceReused: true },
    freshScan, comparison,
  };
}
