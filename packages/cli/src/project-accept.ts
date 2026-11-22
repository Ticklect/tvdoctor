import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";
import { PROTOCOL_VALIDATION_LIMITS, REPORT_SCHEMA_VERSION_V1, parseTVDoctorReportJson } from "@tvdoctor/protocol";
import { assertPortableRelativePath, issueViolatesPolicy } from "@tvdoctor/reporters";

import { parseJourney } from "./journey.js";
import { inspectReport } from "./node-triage.js";
import { PROJECT_AUTH_READY_HASH_ENVIRONMENT_KEY, projectAuthReadyDigest } from "./project-auth-binding.js";
import { loadProjectManifest, type ProjectManifestV1 } from "./project-check.js";
import { runProjectVerify, type ProjectVerifyResult } from "./project-verify.js";

const MAX_SUMMARY = 64 * 1024;
const MAX_STDOUT = 1024 * 1024;
const MAX_JOURNEY = 64 * 1024;
const MAX_ARTIFACT = 64 * 1024 * 1024;
const MAX_PINNED_ARTIFACT_BYTES = 128 * 1024 * 1024;
const MAX_ACCEPTANCE = 64 * 1024;
const MAX_ISSUE_IDS_PER_ROUTE = 12;
const ID = /^[A-Za-z0-9_.:-]{1,256}$/u;
const CAVEAT = "PASS confirms independently FIXED original VERIFIED findings and no VERIFIED findings in complete bounded post-repair scans of the configured routes. New VERIFIED findings are observed post-repair failures, not proof that repairs caused them. REVIEW issues are not promoted to VERIFIED. This does not certify unconfigured routes, accessibility or a defect-free site.";

export interface ProjectAcceptOptions {
  readonly manifestPath: string;
  readonly originalSummaryPath: string;
  readonly outputRoot: string;
  readonly authorized: boolean;
  readonly executeVerify: (args: readonly string[]) => Promise<{ readonly exitCode: number; readonly stdout: string }>;
  /** Run the existing public `project --config ... --authorized --output ... --json` CLI. */
  readonly executeProject: (args: readonly string[]) => Promise<{ readonly exitCode: number; readonly stdout: string }>;
  /** The same private journey environment must be available to both public CLI callbacks. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface ProjectAcceptRouteVerification {
  readonly id: string;
  readonly originalReportSha256: string;
  readonly fixed: number;
  readonly reproduced: number;
  readonly inconclusive: number;
  readonly reproducedIssueIds: readonly string[];
  readonly inconclusiveIssueIds: readonly string[];
}

export interface ProjectAcceptRouteRegression {
  readonly id: string;
  readonly status: "PASS" | "REVIEW_REQUIRED" | "FINDINGS" | "INCONCLUSIVE";
  readonly verified: number;
  readonly review: number;
  readonly untested: number;
  readonly verifiedIssueIds: readonly string[];
  readonly omittedVerifiedIssueIds: number;
}

export interface ProjectAcceptResult {
  readonly schemaVersion: "tvdoctor.project-accept/v1";
  readonly status: "PASS" | "REPRODUCED" | "NEW_VERIFIED" | "INCONCLUSIVE" | "ERROR";
  readonly exitCode: 0 | 1 | 2 | 3 | 4;
  readonly shouldFail: boolean;
  /** A bounded machine reason, never raw error, app content, paths, or credentials. */
  readonly reason: string | null;
  readonly original: { readonly summarySha256: string | null; readonly routes: number; readonly verified: number };
  readonly verification: {
    readonly status: ProjectVerifyResult["status"] | "NOT_RUN";
    readonly fixed: number;
    readonly reproduced: number;
    readonly inconclusive: number;
    readonly routes: readonly ProjectAcceptRouteVerification[];
    readonly summaryPath: "verification/summary.json" | null;
  };
  readonly regression: {
    readonly status: "COMPLETED" | "INCOMPLETE" | "NOT_RUN";
    readonly verified: number;
    readonly review: number;
    readonly untested: number;
    readonly routes: readonly ProjectAcceptRouteRegression[];
    readonly summaryPath: "regression/summary.json" | null;
  };
  readonly acceptancePath: "project-accept.json" | null;
  readonly caveat: string;
}

interface Pinned { readonly path: string; readonly sha256: string; readonly size: number }
interface Original {
  readonly root: string;
  readonly manifest: ProjectManifestV1;
  readonly pins: readonly Pinned[];
  readonly summarySha256: string;
  readonly reports: ReadonlyMap<string, string>;
  readonly journeySources: readonly { readonly name: string; readonly path: string }[];
  readonly verified: number;
}
type Verification = ProjectAcceptResult["verification"];
type Regression = ProjectAcceptResult["regression"];

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function safePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096
    && value.trim() === value && !value.includes("\0");
}
function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0 && value <= 100_000;
}
function savedSummaryLocation(value: unknown, current: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 4096
    && !value.includes("\0") && value.trim() === value
    && (win32.isAbsolute(value) || posix.isAbsolute(value))
    && (value === current || value.endsWith("/summary.json") || value.endsWith("\\summary.json"))
    && !value.split(/[\\/]/u).some((part) => part === "." || part === "..");
}
function inside(parent: string, candidate: string): boolean {
  const diff = relative(parent, candidate);
  return diff === "" || (diff !== ".." && !diff.startsWith(`..${sep}`) && !isAbsolute(diff));
}
async function canonicalDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  const metadata = await lstat(absolute);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(absolute) !== absolute) {
    throw new Error("unsafe-directory");
  }
  return absolute;
}
async function pin(path: string, max: number): Promise<Pinned> {
  const absolute = resolve(path);
  const before = await lstat(absolute);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > max
    || await realpath(absolute) !== absolute) throw new Error("unsafe-file");
  const handle = await open(absolute, "r");
  let bytes: Buffer;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error("changed-file");
    }
    bytes = Buffer.alloc(before.size);
    for (let cursor = 0; cursor < bytes.length;) {
      const part = await handle.read(bytes, cursor, bytes.length - cursor, cursor);
      if (part.bytesRead <= 0) throw new Error("truncated-file");
      cursor += part.bytesRead;
    }
  } finally { await handle.close(); }
  const after = await lstat(absolute);
  if (!after.isFile() || after.isSymbolicLink() || after.ino !== before.ino
    || after.mtimeMs !== before.mtimeMs || after.size !== before.size) {
    throw new Error("changed-file");
  }
  return { path: absolute, size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") };
}
async function pinArtifact(reportFolder: string, artifactPath: string): Promise<Pinned> {
  assertPortableRelativePath(artifactPath);
  const candidate = resolve(reportFolder, ...artifactPath.split("/"));
  if (!inside(reportFolder, candidate) || candidate === reportFolder) throw new Error("unsafe-artifact");
  return await pin(candidate, MAX_ARTIFACT);
}
async function preflight(options: ProjectAcceptOptions): Promise<Original> {
  // Capture the original author-declared content oracle before parsing it.
  // Otherwise an altered role/name during the read-to-pin window could be
  // paired with the old parsed marker while the new manifest is SHA-pinned.
  const manifestPin = await pin(options.manifestPath, MAX_SUMMARY);
  const manifest = await loadProjectManifest(options.manifestPath);
  if ((await pin(options.manifestPath, MAX_SUMMARY)).sha256 !== manifestPin.sha256) {
    throw new Error("project-manifest-changed-during-preflight");
  }
  const originalSummary = resolve(options.originalSummaryPath);
  const originalRoot = dirname(originalSummary);
  if (originalSummary !== join(originalRoot, "summary.json")) throw new Error("invalid-summary-path");
  await canonicalDirectory(originalRoot);
  const summaryPin = await pin(originalSummary, MAX_SUMMARY);
  const raw = JSON.parse(await readFile(originalSummary, "utf8")) as unknown;
  const summary = object(raw);
  const totals = object(summary?.["summary"]);
  const routes = summary?.["routes"];
  if (summary?.["schemaVersion"] !== "tvdoctor.project-check/v1"
    || !Array.isArray(routes) || routes.length !== manifest.routes.length
    || !savedSummaryLocation(summary["summaryPath"], originalSummary) || summary["reason"] !== null
    || !["PASS", "REVIEW_REQUIRED", "FINDINGS"].includes(String(summary["status"]))
    || !count(totals?.["verified"]) || !count(totals?.["review"])
    || !count(totals?.["untested"]) || totals?.["routes"] !== routes.length
    || totals?.["partial"] !== 0 || ![0, 1].includes(summary["exitCode"] as number)
    || summary["shouldFail"] !== (summary["exitCode"] !== 0)) throw new Error("invalid-original-summary");
  const pins: Pinned[] = [manifestPin, summaryPin];
  const reportHashes = new Map<string, string>();
  const journeySources: { name: string; path: string }[] = [];
  const env = options.env ?? process.env;
  let verified = 0;
  let review = 0;
  let untested = 0;
  let failedRoutes = 0;
  let reviewRoutes = 0;
  let pinnedArtifactBytes = 0;
  const seenArtifacts = new Set<string>();
  for (const [index, route] of manifest.routes.entries()) {
    const entry = object(routes[index]);
    const reportFolder = join(originalRoot, route.id);
    await canonicalDirectory(reportFolder);
    const reportPath = join(reportFolder, "report.json");
    if (entry?.["id"] !== route.id || entry["reportRelativePath"] !== `${route.id}/report.json`
      || !["PASS", "REVIEW_REQUIRED", "FINDINGS"].includes(String(entry["status"]))
      || !count(entry["verified"]) || !count(entry["review"]) || !count(entry["untested"])
      || entry["reason"] !== null || ![0, 1].includes(entry["exitCode"] as number)
      || (entry["status"] === "FINDINGS") !== (entry["exitCode"] === 1)) {
      throw new Error("invalid-original-route");
    }
    const reportPin = await pin(reportPath, PROTOCOL_VALIDATION_LIMITS.maxJsonBytes);
    pins.push(reportPin);
    const report = parseTVDoctorReportJson(await readFile(reportPath, "utf8"));
    const triage = await inspectReport(reportPath, { maxFindings: 100 });
    const expected = new URL(route.path, manifest.baseUrl).href;
    if (report.schemaVersion !== REPORT_SCHEMA_VERSION_V1
      || report.run.status !== "completed" || report.run.mode !== manifest.mode
      || report.target.platform !== "web" || report.target.location !== expected
      || report.target.environment["inputMode"] !== "keyboard"
      || triage.coverage.incomplete || triage.coverage.packsOmitted > 0
      || triage.summary.omitted !== 0 || ["degraded", "bounded"].includes(triage.integrity.evidence)
      || entry["verified"] !== triage.summary.VERIFIED
      || entry["review"] !== triage.summary.REVIEW || entry["untested"] !== triage.summary.UNTESTED) {
      throw new Error("invalid-original-report");
    }
    const policyFailure = triage.highestVerifiedSeverity !== null
      && issueViolatesPolicy(triage.highestVerifiedSeverity, manifest.failOn);
    const expectedStatus = policyFailure ? "FINDINGS"
      : triage.summary.REVIEW > 0 ? "REVIEW_REQUIRED" : "PASS";
    if (entry["status"] !== expectedStatus) throw new Error("original-threshold-mismatch");
    if (entry["status"] === "FINDINGS") failedRoutes += 1;
    if (entry["status"] === "REVIEW_REQUIRED") reviewRoutes += 1;
    if (route.journeyEnv === undefined) {
      if (report.target.environment["journeyConfigSha256"] !== undefined
        || report.target.environment[PROJECT_AUTH_READY_HASH_ENVIRONMENT_KEY] !== undefined) {
        throw new Error("unexpected-original-route-auth-binding");
      }
    } else {
      if (route.authReady === undefined
        || report.target.environment[PROJECT_AUTH_READY_HASH_ENVIRONMENT_KEY]
          !== projectAuthReadyDigest(route.authReady)) {
        throw new Error("original-protected-content-binding-invalid");
      }
      const journeyPath = env[route.journeyEnv];
      if (!safePath(journeyPath) || !isAbsolute(journeyPath)) throw new Error("missing-private-journey");
      const journeyPin = await pin(journeyPath, MAX_JOURNEY);
      pins.push(journeyPin);
      journeySources.push({ name: route.journeyEnv, path: journeyPin.path });
      const journey = parseJourney(JSON.parse(await readFile(journeyPath, "utf8")) as unknown);
      if (report.target.environment["journeyConfigSha256"] !== journey.sha256) throw new Error("journey-drift");
    }
    for (const artifact of report.artifacts) {
      if (artifact.status !== "available") continue;
      const target = resolve(reportFolder, ...artifact.path.split("/"));
      if (seenArtifacts.has(target)) continue;
      const artifactPin = await pinArtifact(reportFolder, artifact.path);
      pinnedArtifactBytes += artifactPin.size;
      if (pinnedArtifactBytes > MAX_PINNED_ARTIFACT_BYTES) throw new Error("excess-original-artifacts");
      seenArtifacts.add(target);
      pins.push(artifactPin);
    }
    reportHashes.set(route.id, reportPin.sha256);
    verified += triage.summary.VERIFIED;
    review += triage.summary.REVIEW;
    untested += triage.summary.UNTESTED;
  }
  if (verified !== totals["verified"] || review !== totals["review"]
    || untested !== totals["untested"] || verified > 24
    || (summary["status"] === "FINDINGS") !== (failedRoutes > 0)
    || (summary["exitCode"] === 1) !== (failedRoutes > 0)) throw new Error("original-counts-or-status-mismatch");
  const actualStatus = failedRoutes > 0 ? "FINDINGS" : reviewRoutes > 0 ? "REVIEW_REQUIRED" : "PASS";
  if (summary["status"] !== actualStatus) throw new Error("original-status-mismatch");
  return { root: originalRoot, manifest, pins, summarySha256: summaryPin.sha256,
    reports: reportHashes, journeySources, verified };
}
async function unchanged(original: Original, env: Readonly<Record<string, string | undefined>>): Promise<boolean> {
  try {
    await canonicalDirectory(original.root);
    for (const journey of original.journeySources) {
      if (env[journey.name] !== journey.path) return false;
    }
    for (const pinned of original.pins) {
      const now = await pin(pinned.path, pinned.size);
      if (now.sha256 !== pinned.sha256) return false;
    }
    return true;
  } catch { return false; }
}
function emptyVerification(): Verification {
  return { status: "NOT_RUN", fixed: 0, reproduced: 0, inconclusive: 0, routes: [], summaryPath: null };
}
function emptyRegression(): Regression {
  return { status: "NOT_RUN", verified: 0, review: 0, untested: 0, routes: [], summaryPath: null };
}
function response(code: ProjectAcceptResult["exitCode"], reason: string | null,
  original: Original | null, verification: Verification, regression: Regression,
  acceptancePath: ProjectAcceptResult["acceptancePath"] = null): ProjectAcceptResult {
  const reproduced = verification.reproduced > 0;
  return { schemaVersion: "tvdoctor.project-accept/v1", status: code === 0 ? "PASS"
    : code === 1 ? (reproduced ? "REPRODUCED" : "NEW_VERIFIED")
      : code === 4 ? "ERROR" : "INCONCLUSIVE",
  exitCode: code, shouldFail: code !== 0, reason,
  original: { summarySha256: original?.summarySha256 ?? null,
    routes: original?.manifest.routes.length ?? 0, verified: original?.verified ?? 0 },
  verification, regression, acceptancePath, caveat: CAVEAT };
}

async function validatedVerification(run: ProjectVerifyResult, original: Original,
  output: string): Promise<Verification | null> {
  if (run.schemaVersion !== "tvdoctor.project-verify/v1"
    || ![0, 1, 3, 4].includes(run.exitCode)
    || run.shouldFail !== (run.exitCode !== 0)
    || run.summaryPath !== join(output, "summary.json")
    || run.summary.routes !== original.manifest.routes.length
    || run.summary.verifiedOriginal !== original.verified
    || run.summary.fixed + run.summary.reproduced + run.summary.inconclusive !== original.verified
    || run.routes.length !== original.manifest.routes.length
    || (run.exitCode === 0) !== (run.status === "PASS" && run.summary.fixed === original.verified)
    || (run.exitCode === 1) !== (run.status === "REPRODUCED" && run.summary.reproduced > 0)
    || (run.exitCode === 3 && !["INCONCLUSIVE", "NO_ELIGIBLE"].includes(run.status))) return null;
  let verified = 0;
  const routes: ProjectAcceptRouteVerification[] = [];
  for (const [index, expected] of original.manifest.routes.entries()) {
    const route = run.routes[index];
    if (route?.id !== expected.id || route.originalReportSha256 !== original.reports.get(expected.id)
      || route.reason !== null || !Array.isArray(route.findings)) return null;
    const ids = new Set<string>();
    for (const finding of route.findings) {
      if (!ID.test(finding.id) || !ID.test(finding.rule)
        || !["FIXED", "REPRODUCED", "INCONCLUSIVE"].includes(finding.classification)
        || ids.has(finding.id)) return null;
      ids.add(finding.id);
    }
    verified += ids.size;
    routes.push({ id: route.id, originalReportSha256: route.originalReportSha256,
      fixed: route.findings.filter((finding) => finding.classification === "FIXED").length,
      reproduced: route.findings.filter((finding) => finding.classification === "REPRODUCED").length,
      inconclusive: route.findings.filter((finding) => finding.classification === "INCONCLUSIVE").length,
      reproducedIssueIds: route.findings.filter((finding) => finding.classification === "REPRODUCED")
        .map((finding) => finding.id).slice(0, MAX_ISSUE_IDS_PER_ROUTE),
      inconclusiveIssueIds: route.findings.filter((finding) => finding.classification === "INCONCLUSIVE")
        .map((finding) => finding.id).slice(0, MAX_ISSUE_IDS_PER_ROUTE) });
  }
  if (verified !== original.verified || routes.reduce((s, route) => s + route.fixed, 0) !== run.summary.fixed
    || routes.reduce((s, route) => s + route.reproduced, 0) !== run.summary.reproduced
    || routes.reduce((s, route) => s + route.inconclusive, 0) !== run.summary.inconclusive) return null;
  try {
    const savedPath = join(output, "summary.json");
    await canonicalDirectory(output);
    await pin(savedPath, MAX_SUMMARY);
    const saved = JSON.parse(await readFile(savedPath, "utf8")) as unknown;
    if (JSON.stringify(saved) !== JSON.stringify(run)) return null;
  } catch { return null; }
  return { status: run.status, fixed: run.summary.fixed,
    reproduced: run.summary.reproduced, inconclusive: run.summary.inconclusive,
    routes, summaryPath: "verification/summary.json" };
}

async function freshProject(child: unknown, output: string, original: Original): Promise<Regression | null> {
  const run = object(child);
  if (run === null || ![0, 1, 3, 4].includes(run["exitCode"] as number)
    || typeof run["stdout"] !== "string" || run["stdout"].length > MAX_STDOUT) return null;
  let printed: unknown;
  try { printed = JSON.parse(run["stdout"].trim()) as unknown; } catch { return null; }
  const summary = object(printed);
  const counts = object(summary?.["summary"]);
  const printedRoutes = summary?.["routes"];
  if (summary?.["schemaVersion"] !== "tvdoctor.project-check/v1"
    || !Array.isArray(printedRoutes) || printedRoutes.length !== original.manifest.routes.length
    || summary["summaryPath"] !== join(output, "summary.json")
    || !["PASS", "REVIEW_REQUIRED", "FINDINGS", "INCONCLUSIVE"].includes(String(summary["status"]))
    || !count(counts?.["verified"]) || !count(counts?.["review"])
    || !count(counts?.["untested"]) || counts?.["routes"] !== printedRoutes.length
    || !count(counts?.["partial"]) || counts["partial"] > printedRoutes.length
    || summary["shouldFail"] !== (run["exitCode"] !== 0)
    || summary["exitCode"] !== run["exitCode"] || ![0, 1, 3, 4].includes(run["exitCode"] as number)) return null;
  await canonicalDirectory(output);
  const summaryPath = join(output, "summary.json");
  const summaryPin = await pin(summaryPath, MAX_SUMMARY);
  if (JSON.stringify(JSON.parse(await readFile(summaryPath, "utf8")) as unknown) !== JSON.stringify(printed)) {
    return null;
  }
  const routes: ProjectAcceptRouteRegression[] = [];
  let verified = 0;
  let review = 0;
  let untested = 0;
  let partial = 0;
  for (const [index, route] of original.manifest.routes.entries()) {
    const childRoute = object(printedRoutes[index]);
    if (childRoute?.["id"] !== route.id || !count(childRoute["verified"])
      || !count(childRoute["review"]) || !count(childRoute["untested"])) return null;
    if (childRoute["status"] === "INCONCLUSIVE") {
      if (childRoute["reportRelativePath"] !== null || ![3, 4].includes(childRoute["exitCode"] as number)) return null;
      partial += 1;
      routes.push({ id: route.id, status: "INCONCLUSIVE", verified: 0,
        review: 0, untested: 0, verifiedIssueIds: [], omittedVerifiedIssueIds: 0 });
      continue;
    }
    if (!["PASS", "REVIEW_REQUIRED", "FINDINGS"].includes(String(childRoute["status"]))
      || childRoute["reportRelativePath"] !== `${route.id}/report.json`
      || childRoute["reason"] !== null || (childRoute["status"] === "FINDINGS") !== (childRoute["exitCode"] === 1)
      || ![0, 1].includes(childRoute["exitCode"] as number)) return null;
    const reportFolder = join(output, route.id);
    await canonicalDirectory(reportFolder);
    const reportPath = join(reportFolder, "report.json");
    const reportPin = await pin(reportPath, PROTOCOL_VALIDATION_LIMITS.maxJsonBytes);
    const report = parseTVDoctorReportJson(await readFile(reportPath, "utf8"));
    const triage = await inspectReport(reportPath, { maxFindings: 100 });
    const expectedUrl = new URL(route.path, original.manifest.baseUrl).href;
    const expectedOriginal = await readFile(join(original.root, route.id, "report.json"), "utf8");
    const originalReport = parseTVDoctorReportJson(expectedOriginal);
    if (report.schemaVersion !== REPORT_SCHEMA_VERSION_V1
      || report.target.platform !== "web" || report.target.location !== expectedUrl
      || report.target.environment["inputMode"] !== "keyboard" || report.run.mode !== original.manifest.mode
      || report.target.environment["journeyConfigSha256"]
        !== originalReport.target.environment["journeyConfigSha256"]
      || (route.journeyEnv === undefined
        ? report.target.environment[PROJECT_AUTH_READY_HASH_ENVIRONMENT_KEY] !== undefined
          || originalReport.target.environment[PROJECT_AUTH_READY_HASH_ENVIRONMENT_KEY] !== undefined
        : route.authReady === undefined
          || originalReport.target.environment[PROJECT_AUTH_READY_HASH_ENVIRONMENT_KEY]
            !== projectAuthReadyDigest(route.authReady)
          || report.target.environment[PROJECT_AUTH_READY_HASH_ENVIRONMENT_KEY]
            !== projectAuthReadyDigest(route.authReady))
      || childRoute["verified"] !== triage.summary.VERIFIED
      || childRoute["review"] !== triage.summary.REVIEW
      || childRoute["untested"] !== triage.summary.UNTESTED
      || ["degraded", "bounded"].includes(triage.integrity.evidence)
      || triage.summary.omitted > 0 || triage.coverage.packsOmitted > 0) return null;
    const incomplete = triage.coverage.incomplete || report.run.status !== "completed";
    if (incomplete) partial += 1;
    const policyFailure = triage.highestVerifiedSeverity !== null
      && issueViolatesPolicy(triage.highestVerifiedSeverity, original.manifest.failOn);
    const expectedStatus = policyFailure ? "FINDINGS"
      : triage.summary.REVIEW > 0 ? "REVIEW_REQUIRED" : "PASS";
    if (!incomplete && childRoute["status"] !== expectedStatus) return null;
    const allIds = triage.findings.filter((finding) => finding.classification === "VERIFIED")
      .map((finding) => finding.id);
    if (allIds.length !== triage.summary.VERIFIED || allIds.some((id) => !ID.test(id))
      || new Set(allIds).size !== allIds.length) return null;
    verified += triage.summary.VERIFIED;
    review += triage.summary.REVIEW;
    untested += triage.summary.UNTESTED;
    routes.push({ id: route.id, status: incomplete ? "INCONCLUSIVE"
      : childRoute["status"] as ProjectAcceptRouteRegression["status"],
    verified: triage.summary.VERIFIED, review: triage.summary.REVIEW,
    untested: triage.summary.UNTESTED,
    verifiedIssueIds: allIds.slice(0, MAX_ISSUE_IDS_PER_ROUTE),
    omittedVerifiedIssueIds: Math.max(0, allIds.length - MAX_ISSUE_IDS_PER_ROUTE) });
    if ((await pin(reportPath, PROTOCOL_VALIDATION_LIMITS.maxJsonBytes)).sha256 !== reportPin.sha256) return null;
  }
  if (verified !== counts["verified"] || review !== counts["review"]
    || untested !== counts["untested"] || partial !== counts["partial"]
    || (await pin(summaryPath, MAX_SUMMARY)).sha256 !== summaryPin.sha256) return null;
  const routeFailed = routes.some((route) => route.status === "FINDINGS");
  const routeReview = routes.some((route) => route.status === "REVIEW_REQUIRED");
  const expectedStatus = partial > 0 ? "INCONCLUSIVE" : routeFailed ? "FINDINGS"
    : routeReview ? "REVIEW_REQUIRED" : "PASS";
  const expectedExit = partial > 0 ? printedRoutes.some((route) => object(route)?.["exitCode"] === 4) ? 4 : 3
    : routeFailed ? 1 : 0;
  if (summary["status"] !== expectedStatus || run["exitCode"] !== expectedExit
    || summary["reason"] !== (partial > 0 ? "one-or-more-routes-inconclusive" : null)) return null;
  return { status: partial > 0 ? "INCOMPLETE" : "COMPLETED",
    verified, review, untested, routes, summaryPath: "regression/summary.json" };
}

/** Compose independently replayed originals with a fresh public project audit. */
export async function runProjectAccept(options: ProjectAcceptOptions): Promise<ProjectAcceptResult> {
  let verification = emptyVerification();
  let regression = emptyRegression();
  if (options.authorized !== true || !safePath(options.manifestPath)
    || !safePath(options.originalSummaryPath) || !safePath(options.outputRoot)
    || typeof options.executeVerify !== "function" || typeof options.executeProject !== "function") {
    return response(2, "invalid-options", null, verification, regression);
  }
  const source = resolve(options.originalSummaryPath);
  const originalRoot = dirname(source);
  const output = resolve(options.outputRoot);
  const manifestPath = resolve(options.manifestPath);
  if (inside(originalRoot, output) || inside(output, originalRoot)
    || inside(output, manifestPath) || inside(manifestPath, output)) {
    return response(2, "output-overlaps-input", null, verification, regression);
  }
  let original: Original;
  try { original = await preflight(options); }
  catch { return response(3, "original-project-evidence-invalid", null, verification, regression); }
  try {
    await mkdir(dirname(output), { recursive: true });
    const parent = await canonicalDirectory(dirname(output));
    if (inside(original.root, parent) || inside(parent, original.root) && parent === original.root
      || inside(output, original.root) || inside(output, manifestPath)) {
      throw new Error("unsafe-output-parent");
    }
    await mkdir(output, { mode: 0o700 });
    await canonicalDirectory(output);
  } catch { return response(4, "output-root-not-fresh-or-unsafe", original, verification, regression); }

  const env = options.env ?? process.env;
  let code: ProjectAcceptResult["exitCode"] = 3;
  let reason: string | null;
  try {
    if (!await unchanged(original, env)) {
      reason = "original-or-journey-changed";
    } else {
      const verified = await runProjectVerify({
        manifestPath: options.manifestPath, originalSummaryPath: source,
        outputRoot: join(output, "verification"), authorized: true,
        allowRelocatedOriginal: true,
        executeVerify: options.executeVerify, ...(options.env === undefined ? {} : { env: options.env }),
      });
      if (!await unchanged(original, env)) {
        reason = "original-or-journey-changed";
      } else {
        const checked = await validatedVerification(verified, original, join(output, "verification"));
        if (checked === null) {
          code = verified.exitCode === 4 ? 4 : 3;
          reason = "verification-evidence-invalid";
        } else {
          verification = checked;
          if (verified.exitCode === 4) {
            code = 4; reason = "verification-execution-failed";
          } else {
            const child = await options.executeProject([
              "project", "--config", manifestPath, "--authorized", "--output",
              join(output, "regression"), "--json",
            ]);
            if (!await unchanged(original, env)) {
              reason = "original-or-journey-changed";
            } else {
              const fresh = await freshProject(child, join(output, "regression"), original).catch(() => null);
              if (fresh === null) {
                code = child?.exitCode === 4 ? 4 : 3;
                reason = "fresh-project-evidence-invalid";
              } else {
                regression = fresh;
                if (child.exitCode === 4) {
                  code = 4; reason = "fresh-project-execution-failed";
                } else if (verification.reproduced > 0) {
                  // An independently reproduced original is conclusive failure
                  // evidence even if other original replays or routes are incomplete.
                  code = 1; reason = "original-failures-reproduced";
                } else if (fresh.status === "INCOMPLETE" || verification.inconclusive > 0
                  || verified.exitCode === 3) {
                  // Fresh VERIFIED findings remain in regression counts/IDs, but
                  // cannot resolve inconclusive independent original verification.
                  code = 3;
                  reason = regression.verified > 0
                    ? "verification-or-coverage-incomplete-with-observed-verified"
                    : "verification-or-coverage-incomplete";
                } else if (regression.verified > 0) {
                  code = 1; reason = "post-repair-verified-failures-observed";
                } else if (verified.exitCode === 0 && verification.fixed === original.verified
                  && original.verified > 0 && fresh.status === "COMPLETED") {
                  code = 0; reason = null;
                } else {
                  code = 3; reason = "no-original-verified-fix-proof";
                }
              }
            }
          }
        }
      }
    }
  } catch {
    code = 4; reason = "child-execution-failed";
  }
  if (!await unchanged(original, env)) { code = 3; reason = "original-or-journey-changed"; }
  const outcome = response(code, reason, original, verification, regression, "project-accept.json");
  try {
    const serialized = JSON.stringify(outcome, null, 2) + "\n";
    if (Buffer.byteLength(serialized) > MAX_ACCEPTANCE) throw new Error("oversized-acceptance");
    await writeFile(join(output, "project-accept.json"), serialized, { flag: "wx", mode: 0o600 });
    return outcome;
  } catch { return response(4, "acceptance-summary-write-failed", original, verification, regression); }
}
