import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, resolve, win32 } from "node:path";
import { PROTOCOL_VALIDATION_LIMITS, parseTVDoctorReportJson } from "@tvdoctor/protocol";

import { parseJourney } from "./journey.js";
import { inspectReport } from "./node-triage.js";
import { PROJECT_AUTH_READY_HASH_ENVIRONMENT_KEY, projectAuthReadyDigest,
  type ProjectAuthReadyMarker } from "./project-auth-binding.js";
import { loadProjectManifest, type ProjectCheckResult, type ProjectRouteResult } from "./project-check.js";

const MAX_SUMMARY_BYTES = 64 * 1024;
const MAX_JOURNEY_BYTES = 64 * 1024;
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_VERIFIED = 24;
const SUPPORTED_RULES = new Set([
  "keyboard.modal-focus-escape",
  "keyboard.modal-tab-focus-loss",
  "keyboard.modal-open-focus-not-transferred",
]);

export interface ProjectVerifyExecution {
  readonly exitCode: number;
  readonly stdout: string;
}

export interface ProjectVerifyOptions {
  readonly manifestPath: string;
  readonly originalSummaryPath: string;
  readonly outputRoot: string;
  readonly authorized: boolean;
  /** Explicit CI artifact relocation: accept historical absolute summaryPath
   * metadata, but revalidate all current owned files/routes and original SHA.
   * Default off to preserve the strict standalone comparison contract. */
  readonly allowRelocatedOriginal?: boolean;
  /** Inject runCli(['verify-fix', ...], context) with its stdout captured in memory. */
  readonly executeVerify: (args: readonly string[]) => Promise<ProjectVerifyExecution>;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface ProjectVerifiedFinding {
  readonly id: string;
  readonly rule: string;
  readonly classification: "FIXED" | "REPRODUCED" | "INCONCLUSIVE";
  readonly reason: string | null;
}

export interface ProjectVerifiedRoute {
  readonly id: string;
  readonly originalReportSha256: string | null;
  readonly findings: readonly ProjectVerifiedFinding[];
  readonly reason: string | null;
}

export interface ProjectVerifyResult {
  readonly schemaVersion: "tvdoctor.project-verify/v1";
  readonly status: "PASS" | "REPRODUCED" | "INCONCLUSIVE" | "NO_ELIGIBLE";
  readonly shouldFail: boolean;
  readonly exitCode: number;
  readonly reason: string | null;
  readonly summaryPath: string | null;
  readonly summary: {
    readonly routes: number;
    readonly verifiedOriginal: number;
    readonly fixed: number;
    readonly reproduced: number;
    readonly inconclusive: number;
  };
  readonly routes: readonly ProjectVerifiedRoute[];
  readonly caveat: string;
}

const CAVEAT = "Only independently replayed, originally VERIFIED findings can be marked FIXED; untested conditions and new defects remain outside this verification.";
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
}
function sha256(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

/** Resolve only canonical children of an ordinary report directory. Reject junctions too. */
async function safeBundlePath(root: string, segments: readonly string[], file: boolean): Promise<string> {
  const rootMeta = await lstat(root);
  if (!rootMeta.isDirectory() || rootMeta.isSymbolicLink() || await realpath(root) !== root) {
    throw new TypeError("invalid-original-project-directory");
  }
  let current = root;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (typeof segment !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?:\.json)?$/u.test(segment)
      || segment === "." || segment === "..") throw new TypeError("invalid-project-child-path");
    current = join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink() || (i === segments.length - 1 && file
      ? !metadata.isFile() : !metadata.isDirectory()) || await realpath(current) !== current) {
      throw new TypeError("unsafe-project-child-path");
    }
  }
  return current;
}

async function boundedFile(path: string, maximum: number): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > maximum) {
    throw new TypeError("invalid-bounded-file");
  }
  const handle = await open(path, "r");
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.size !== before.size || current.ino !== before.ino) {
      throw new TypeError("changed-bounded-file");
    }
    const bytes = Buffer.alloc(before.size);
    let cursor = 0;
    while (cursor < bytes.length) {
      const chunk = await handle.read(bytes, cursor, bytes.length - cursor, cursor);
      if (chunk.bytesRead < 1) throw new TypeError("truncated-bounded-file");
      cursor += chunk.bytesRead;
    }
    const after = await lstat(path);
    if (!after.isFile() || after.isSymbolicLink() || after.size !== before.size
      || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs) {
      throw new TypeError("changed-bounded-file");
    }
    return bytes;
  } finally { await handle.close(); }
}

function validHistoricalSummaryPath(value: unknown, expectedPath: string,
  allowRelocatedOriginal: boolean): boolean {
  if (value === expectedPath) return true;
  if (!allowRelocatedOriginal || typeof value !== "string" || value.length < 13
    || value.length > 4096 || value.includes("\0") || value.trim() !== value
    || !/[\\/]summary\.json$/u.test(value)
    || !(posix.isAbsolute(value) || win32.isAbsolute(value))) return false;
  // Downloading a previous run's artifact changes its parent path, not its
  // contents. Historical locations are metadata only; all current relative
  // report paths, evidence hashes and route/target identities remain checked.
  return !value.split(/[\\/]/u).some((part) => part === ".." || part === ".");
}

function verifiedProjectSummary(value: unknown, expectedPath: string,
  routeIds: readonly string[], allowRelocatedOriginal = false): ProjectCheckResult {
  const summary = object(value);
  const totals = object(summary?.["summary"]);
  const routes = summary?.["routes"];
  if (summary?.["schemaVersion"] !== "tvdoctor.project-check/v1"
    || !["PASS", "REVIEW_REQUIRED", "FINDINGS"].includes(String(summary["status"]))
    || !Array.isArray(routes) || routes.length !== routeIds.length
    || !validHistoricalSummaryPath(summary["summaryPath"], expectedPath, allowRelocatedOriginal)
    || !count(totals?.["routes"]) || totals["routes"] !== routeIds.length
    || !count(totals["verified"]) || !count(totals["review"])
    || !count(totals["untested"]) || totals["partial"] !== 0
    || (summary["exitCode"] !== 0 && summary["exitCode"] !== 1)
    || summary["shouldFail"] !== (summary["exitCode"] !== 0)
    || (summary["status"] === "FINDINGS") !== (summary["exitCode"] === 1)) {
    throw new TypeError("original-project-summary-incomplete-or-invalid");
  }
  const seen: ProjectRouteResult[] = [];
  for (let index = 0; index < routeIds.length; index += 1) {
    const route = object(routes[index]);
    const id = routeIds[index];
    if (route === null || route["id"] !== id || route["reportRelativePath"] !== `${id}/report.json`
      || !["PASS", "REVIEW_REQUIRED", "FINDINGS"].includes(String(route["status"]))
      || !count(route["verified"]) || !count(route["review"]) || !count(route["untested"])
      || (route["status"] === "FINDINGS") !== (route["exitCode"] === 1)
      || (route["exitCode"] !== 0 && route["exitCode"] !== 1)
      || route["reason"] !== null) {
      throw new TypeError("original-project-route-incomplete-or-invalid");
    }
    seen.push(route as unknown as ProjectRouteResult);
  }
  for (const key of ["verified", "review", "untested"] as const) {
    if (seen.reduce((total, route) => total + route[key], 0) !== totals[key]) {
      throw new TypeError("original-project-counts-mismatch");
    }
  }
  const expectedStatus = seen.some((route) => route.status === "FINDINGS") ? "FINDINGS"
    : seen.some((route) => route.status === "REVIEW_REQUIRED") ? "REVIEW_REQUIRED" : "PASS";
  if (summary["status"] !== expectedStatus || summary["reason"] !== null) {
    throw new TypeError("original-project-aggregate-mismatch");
  }
  return summary as unknown as ProjectCheckResult;
}

function responseVerdict(execution: ProjectVerifyExecution, id: string, rule: string,
  digest: string, length: number, runId: string): {
    classification: ProjectVerifiedFinding["classification"]; reason: string | null;
  } | null {
  if (typeof execution.stdout !== "string" || Buffer.byteLength(execution.stdout, "utf8") > MAX_STDOUT_BYTES
    || ![0, 1, 3].includes(execution.exitCode)) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(execution.stdout.trim()) as unknown; } catch { return null; }
  const response = object(parsed);
  const original = object(response?.["original"]);
  const replay = object(response?.["replay"]);
  const classification = response?.["classification"];
  const confirmed = classification === "FIXED" || classification === "REPRODUCED";
  if (response?.["schemaVersion"] !== "tvdoctor.verify-workflow/v1"
    || !["FIXED", "REPRODUCED", "INCONCLUSIVE"].includes(String(classification))
    || original?.["issueId"] !== id || original["rule"] !== rule
    || original["runId"] !== runId || original["reportSha256"] !== digest
    || original["reportByteLength"] !== length
    || original["inputMode"] !== "keyboard"
    || original["targetOverridden"] !== true
    || replay === null || typeof replay["stableFixConfirmationRequested"] !== "boolean"
    || typeof replay["originalSequenceReused"] !== "boolean"
    || (confirmed && (replay["stableFixConfirmationRequested"] !== true
      || replay["originalSequenceReused"] !== true))
    || (classification === "FIXED" && replay["status"] !== "fixed")
    || (classification === "REPRODUCED" && replay["status"] !== "reproduced")
    || (confirmed && response["reason"] !== null)
    || response["fixed"] !== (classification === "INCONCLUSIVE" ? null : classification === "FIXED")
    || response["shouldFail"] !== (classification !== "FIXED")
    || execution.exitCode !== (classification === "FIXED" ? 0 : classification === "REPRODUCED" ? 1 : 3)) {
    return null;
  }
  const reason = response["reason"];
  return { classification: classification as ProjectVerifiedFinding["classification"],
    reason: !confirmed && typeof reason === "string" && /^[a-z][a-z0-9-]{0,179}$/u.test(reason)
      ? reason : null };
}

function result(routes: readonly ProjectVerifiedRoute[], reason: string | null, executionFailed: boolean,
  outputPath: string | null): ProjectVerifyResult {
  const findings = routes.flatMap((route) => route.findings);
  const fixed = findings.filter((item) => item.classification === "FIXED").length;
  const reproduced = findings.filter((item) => item.classification === "REPRODUCED").length;
  const inconclusive = findings.filter((item) => item.classification === "INCONCLUSIVE").length;
  const noEligible = findings.length === 0;
  const exitCode = executionFailed ? 4 : reproduced > 0 ? 1 : reason !== null || inconclusive > 0 || noEligible ? 3 : 0;
  const status = executionFailed || reason !== null ? "INCONCLUSIVE"
    : reproduced > 0 ? "REPRODUCED" : noEligible ? "NO_ELIGIBLE"
    : exitCode === 0 ? "PASS" : "INCONCLUSIVE";
  return { schemaVersion: "tvdoctor.project-verify/v1", status, shouldFail: exitCode !== 0,
    exitCode, reason: reason ?? (noEligible ? "no-original-verified-findings" : null), summaryPath: outputPath,
    summary: { routes: routes.length, verifiedOriginal: findings.length, fixed, reproduced, inconclusive },
    routes, caveat: CAVEAT };
}

/** Post-fix batch verification over an existing complete project-check bundle. */
export async function runProjectVerify(options: ProjectVerifyOptions): Promise<ProjectVerifyResult> {
  const bad = (reason: string, code = 3) => result([], reason, code === 4, null);
  if (options.authorized !== true || typeof options.executeVerify !== "function"
    || typeof options.originalSummaryPath !== "string" || options.originalSummaryPath.length > 4096
    || options.originalSummaryPath.includes("\0")
    || typeof options.outputRoot !== "string" || options.outputRoot.length < 1
    || options.outputRoot.length > 4096 || options.outputRoot.includes("\0")) {
    return bad("invalid-project-verify-options");
  }
  const manifestPath = resolve(options.manifestPath);
  let manifest: Awaited<ReturnType<typeof loadProjectManifest>>;
  let manifestSha: string;
  try {
    // Pin the authored oracle BEFORE parsing it. A manifest changed while it
    // is being parsed must not be permitted to rebind original route evidence.
    const initial = await boundedFile(manifestPath, MAX_SUMMARY_BYTES);
    manifestSha = sha256(initial);
    manifest = await loadProjectManifest(manifestPath);
    if (sha256(await boundedFile(manifestPath, MAX_SUMMARY_BYTES)) !== manifestSha) {
      throw new TypeError("project-manifest-changed-during-preflight");
    }
  }
  catch { return bad("invalid-project-manifest"); }
  const originalPath = resolve(options.originalSummaryPath);
  const originalRoot = dirname(originalPath);
  let summary: ProjectCheckResult;
  let summarySha: string;
  try {
    if (!isAbsolute(originalPath) || originalPath !== join(originalRoot, "summary.json")) {
      throw new TypeError("invalid-summary-path");
    }
    await safeBundlePath(originalRoot, ["summary.json"], true);
    const bytes = await boundedFile(originalPath, MAX_SUMMARY_BYTES);
    summarySha = sha256(bytes);
    summary = verifiedProjectSummary(JSON.parse(bytes.toString("utf8")) as unknown,
      originalPath, manifest.routes.map((route) => route.id), options.allowRelocatedOriginal === true);
  } catch { return bad("invalid-or-incomplete-original-project-summary"); }

  const routePreflight: { id: string; digest: string; reportPath: string; runId: string;
    length: number; findings: { id: string; rule: string; supported: boolean }[];
    journey?: Buffer; journeyPath?: string; journeyEnv?: string;
    authReady?: ProjectAuthReadyMarker; target: string }[] = [];
  const env = options.env ?? process.env;
  let totalVerified = 0;
  try {
    for (const [index, route] of manifest.routes.entries()) {
      const reportPath = await safeBundlePath(originalRoot, [route.id, "report.json"], true);
      const bytes = await boundedFile(reportPath, PROTOCOL_VALIDATION_LIMITS.maxJsonBytes);
      const report = parseTVDoctorReportJson(bytes.toString("utf8"));
      const triage = await inspectReport(reportPath, { maxFindings: 100 });
      const expectedTarget = new URL(route.path, manifest.baseUrl).href;
      if (report.target.platform !== "web" || report.target.location !== expectedTarget
        || report.run.mode !== manifest.mode
        || report.target.environment["inputMode"] !== "keyboard"
        || triage.coverage.incomplete || triage.integrity.evidence === "degraded"
        || triage.summary.omitted !== 0 || triage.summary.VERIFIED !== summary.routes[index]?.verified
        || triage.summary.REVIEW !== summary.routes[index]?.review
        || triage.summary.UNTESTED !== summary.routes[index]?.untested) {
        throw new TypeError("original-route-report-not-comparable");
      }
      const findings = triage.findings.filter((finding) => finding.classification === "VERIFIED")
        .map((finding) => ({ id: finding.id, rule: finding.rule,
          supported: SUPPORTED_RULES.has(finding.rule) && finding.pack === "navigation"
            && finding.reproduction.status === "deterministic" }));
      totalVerified += findings.length;
      if (totalVerified > MAX_VERIFIED) throw new TypeError("too-many-original-verified-findings");
      let journey: Buffer | undefined;
      let journeyPath: string | undefined;
      if (route.journeyEnv !== undefined) {
        // Protected legacy originals cannot establish what authenticated content
        // was observed. Never accept a newly added/changed manifest assertion.
        if (route.authReady === undefined
          || report.target.environment[PROJECT_AUTH_READY_HASH_ENVIRONMENT_KEY]
            !== projectAuthReadyDigest(route.authReady)) {
          throw new TypeError("original-protected-content-binding-invalid");
        }
        journeyPath = env[route.journeyEnv];
        if (typeof journeyPath !== "string" || !isAbsolute(journeyPath)) {
          throw new TypeError("original-journey-unavailable");
        }
        journey = await boundedFile(journeyPath, MAX_JOURNEY_BYTES);
        const parsed = parseJourney(JSON.parse(journey.toString("utf8")) as unknown);
        if (report.target.environment["journeyConfigSha256"] !== parsed.sha256) {
          throw new TypeError("original-journey-binding-invalid");
        }
      } else if (report.target.environment["journeyConfigSha256"] !== undefined
        || report.target.environment[PROJECT_AUTH_READY_HASH_ENVIRONMENT_KEY] !== undefined) {
        throw new TypeError("original-unprotected-route-binding-invalid");
      }
      routePreflight.push({ id: route.id, reportPath, digest: sha256(bytes), length: bytes.length,
        runId: report.run.id,
        findings, ...(journey === undefined ? {} : { journey }),
        ...(journeyPath === undefined ? {} : { journeyPath, journeyEnv: route.journeyEnv }),
        ...(route.authReady === undefined ? {} : { authReady: route.authReady }), target: expectedTarget });
    }
  } catch { return bad("original-project-evidence-incomplete-or-invalid"); }

  const globalInputsUnchanged = async (): Promise<boolean> => {
    try {
      if (sha256(await boundedFile(manifestPath, MAX_SUMMARY_BYTES)) !== manifestSha
        || sha256(await boundedFile(originalPath, MAX_SUMMARY_BYTES)) !== summarySha) return false;
      for (const route of routePreflight) {
        if (route.journey !== undefined && (route.journeyPath === undefined
          || route.journeyEnv === undefined || env[route.journeyEnv] !== route.journeyPath
          || sha256(await boundedFile(route.journeyPath, MAX_JOURNEY_BYTES))
            !== sha256(route.journey))) return false;
      }
      return true;
    } catch { return false; }
  };

  const routeReportUnchanged = async (route: (typeof routePreflight)[number]): Promise<boolean> => {
    try {
      return sha256(await boundedFile(route.reportPath, PROTOCOL_VALIDATION_LIMITS.maxJsonBytes))
        === route.digest;
    } catch { return false; }
  };

  if (!await globalInputsUnchanged()
    || (await Promise.all(routePreflight.map(routeReportUnchanged))).some((valid) => !valid)) {
    return bad("original-project-input-changed");
  }

  const outputRoot = resolve(options.outputRoot);
  if (outputRoot === originalRoot || outputRoot.startsWith(`${originalRoot}\\`)
    || outputRoot.startsWith(`${originalRoot}/`)) return bad("output-overlaps-original-evidence");
  try {
    await mkdir(dirname(outputRoot), { recursive: true });
    await mkdir(outputRoot, { mode: 0o700 });
  } catch { return bad("output-directory-not-fresh"); }
  let stagingDirectory: string | null = null;
  const routes: ProjectVerifiedRoute[] = [];
  let failed = false;
  let reason: string | null = null;
  let originalDrift = false;
  const changedReports = new Set<string>();
  try {
    if (routePreflight.some((route) => route.journey !== undefined)) {
      stagingDirectory = await mkdtemp(join(tmpdir(), "tvdoctor-project-verify-"));
    }
    for (const route of routePreflight) {
      let stagedJourney: string | undefined;
      if (route.journey !== undefined && stagingDirectory !== null) {
        stagedJourney = join(stagingDirectory, `${route.id}.json`);
        await writeFile(stagedJourney, route.journey, { mode: 0o600, flag: "wx" });
      }
      const findings: ProjectVerifiedFinding[] = [];
      for (const finding of route.findings) {
        if (!await globalInputsUnchanged()) {
          originalDrift = true;
          break;
        }
        if (!await routeReportUnchanged(route)) {
          changedReports.add(route.id);
          findings.push({ id: finding.id, rule: finding.rule, classification: "INCONCLUSIVE",
            reason: "original-report-changed" });
          continue;
        }
        if (!finding.supported) {
          findings.push({ id: finding.id, rule: finding.rule, classification: "INCONCLUSIVE",
            reason: "unsupported-independent-verification-rule" });
          continue;
        }
        // Reject a changed original between preflight and each replay.
        if (sha256(await boundedFile(route.reportPath, PROTOCOL_VALIDATION_LIMITS.maxJsonBytes)) !== route.digest) {
          findings.push({ id: finding.id, rule: finding.rule, classification: "INCONCLUSIVE",
            reason: "original-report-changed" });
          continue;
        }
        const args = ["verify-fix", finding.id, "--report", route.reportPath,
          "--authorized", "--sha256", route.digest, "--target", route.target,
          ...(stagedJourney === undefined ? [] : ["--journey", stagedJourney]),
          ...(route.authReady === undefined ? [] : ["--auth-ready-role", route.authReady.role,
            "--auth-ready-name", route.authReady.name])];
        try {
          const execution = await options.executeVerify(args);
          if (!await globalInputsUnchanged()) {
            originalDrift = true;
            break;
          }
          if (!await routeReportUnchanged(route)) {
            changedReports.add(route.id);
            findings.push({ id: finding.id, rule: finding.rule, classification: "INCONCLUSIVE",
              reason: "original-report-changed" });
            continue;
          }
          const verdict = responseVerdict(execution, finding.id, finding.rule,
            route.digest, route.length, route.runId);
          if (verdict === null) {
            failed = true;
            findings.push({ id: finding.id, rule: finding.rule, classification: "INCONCLUSIVE",
              reason: "verify-fix-response-invalid" });
          } else findings.push({ id: finding.id, rule: finding.rule, ...verdict });
        } catch {
          failed = true;
          findings.push({ id: finding.id, rule: finding.rule, classification: "INCONCLUSIVE",
            reason: "verify-fix-execution-failed" });
        }
      }
      routes.push({ id: route.id, originalReportSha256: route.digest, findings, reason: null });
      if (originalDrift) break;
    }
  } catch {
    failed = true;
    reason = "verification-staging-or-evidence-failed";
  }
  if (stagingDirectory !== null) {
    try { await rm(stagingDirectory, { recursive: true }); }
    catch { failed = true; reason = "private-journey-cleanup-failed"; }
  }
  if (!await globalInputsUnchanged()) originalDrift = true;
  for (const route of routePreflight) {
    if (!await routeReportUnchanged(route)) changedReports.add(route.id);
  }
  if (originalDrift) {
    // A replay verdict cannot remain FIXED after the source manifest, original
    // report, summary, or private journey changed mid-verification.
    routes.splice(0, routes.length, ...routePreflight.map((route) => ({
      id: route.id, originalReportSha256: route.digest, reason: null,
      findings: route.findings.map((finding) => ({ id: finding.id, rule: finding.rule,
        classification: "INCONCLUSIVE" as const, reason: "original-project-input-changed" })),
    })));
    reason = "original-project-input-changed";
  } else if (changedReports.size > 0) {
    // A different route's report may change after an earlier valid replay.
    // Retain that route's justified result, but never keep FIXED on a route
    // whose ORIGINAL report bytes changed during this verification session.
    routes.splice(0, routes.length, ...routePreflight.map((route) => {
      const captured = routes.find((entry) => entry.id === route.id);
      return !changedReports.has(route.id) && captured !== undefined ? captured : {
        id: route.id, originalReportSha256: route.digest, reason: null,
        findings: route.findings.map((finding) => ({ id: finding.id, rule: finding.rule,
          classification: "INCONCLUSIVE" as const, reason: "original-report-changed" })),
      };
    }));
    reason = "original-project-input-changed";
  }
  // Never record a successful result until secret-bearing staging is removed.
  let outcome = result(routes, reason, failed, join(outputRoot, "summary.json"));
  try {
    await writeFile(outcome.summaryPath ?? "", `${JSON.stringify(outcome, null, 2)}\n`,
      { mode: 0o600, flag: "wx" });
  } catch { outcome = result(routes, "verification-summary-write-failed", true, null); }
  return outcome;
}
