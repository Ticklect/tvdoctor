import { createHash } from "node:crypto";
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PROTOCOL_VALIDATION_LIMITS, REPORT_SCHEMA_VERSION_V1, parseTVDoctorReportJson } from "@tvdoctor/protocol";
import { issueViolatesPolicy } from "@tvdoctor/reporters";

import { inspectReport, type ReportTriage } from "./node-triage.js";
import {
  inspectProtectedRouteRedirect, inspectProtectedContentUnproven,
  inspectAuthenticatedJourneyFailure, parseProjectManifest,
  type ProjectCheckResult, type ProjectManifestV1,
} from "./project-check.js";
import type { ProjectAcceptResult } from "./project-accept.js";
import type { ProjectVerifyResult } from "./project-verify.js";

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ROUTE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const LOCAL_AUTH_ROLES = new Set(["heading", "region", "button"]);
const UNSAFE_AUTH_NAME = /[\\/<>\\\\]|:\/\/|(?:^|\s)(?:https?:|file:|token=|password=)/iu;
const ISSUE_ID = /^[A-Za-z0-9_.:-]{1,256}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_SUMMARY = 64 * 1024;
const MAX_MANIFEST = 64 * 1024;
const MAX_ISSUES = 100;
const SUPPORTED = new Set([
  "keyboard.modal-focus-escape",
  "keyboard.modal-tab-focus-loss",
  "keyboard.modal-open-focus-not-transferred",
]);

export interface PublicProjectCapture {
  readonly status: ProjectCheckResult["status"];
  readonly summary: Readonly<Pick<ProjectCheckResult["summary"],
    "routes" | "verified" | "review" | "untested" | "partial">>;
  readonly routes: readonly {
    readonly id: string;
    readonly status: ProjectCheckResult["routes"][number]["status"];
    readonly verified: number;
    readonly review: number;
    readonly untested: number;
    /** Trusted, allowlisted diagnostic token. Not a URL, selector or error text. */
    readonly reason?: "protected-route-redirected" | "protected-content-unproven"
      | "authentication-journey-failed" | "scan-incomplete";
    /** User-facing remediation category, not an instruction to log in automatically. */
    readonly remediation?: "configure-auth-journey" | "inspect-auth-ready-marker"
      | "repair-auth-journey" | "review-incomplete-coverage";
    readonly reportUrl?: string;
  }[];
  readonly summaryUrl: string;
  /** Eligible means 1..16 complete, supported, deterministic original VERIFIED findings. */
  readonly acceptReady: boolean;
}

export interface PublicProjectAcceptance {
  readonly status: ProjectAcceptResult["status"];
  readonly verification: {
    readonly status: ProjectAcceptResult["verification"]["status"];
    readonly fixed: number;
    readonly reproduced: number;
    readonly inconclusive: number;
    readonly routes: readonly {
      readonly id: string;
      readonly fixed: number;
      readonly reproduced: number;
      readonly inconclusive: number;
      readonly reproducedIssueIds: readonly string[];
      readonly inconclusiveIssueIds: readonly string[];
    }[];
  };
  readonly regression: {
    readonly status: ProjectAcceptResult["regression"]["status"];
    readonly verified: number;
    readonly review: number;
    readonly untested: number;
    readonly routes: readonly {
      readonly id: string;
      readonly status: ProjectAcceptResult["regression"]["routes"][number]["status"];
      readonly verified: number;
      readonly review: number;
      readonly untested: number;
      readonly verifiedIssueIds: readonly string[];
      readonly omittedVerifiedIssueIds: number;
      readonly reportUrl?: string;
    }[];
  };
  readonly links: Readonly<Partial<Record<"summary" | "verification" | "regression", string>>>;
  readonly originalSummaryUrl: string;
  readonly originalLinks: { readonly summary: string };
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function bounded(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 100_000;
}
function within(parent: string, candidate: string): boolean {
  const diff = relative(parent, candidate);
  return diff === "" || (diff !== ".." && !diff.startsWith(`..${sep}`) && !isAbsolute(diff));
}
function validRoot(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096
    && value === value.trim() && !value.includes("\0");
}
function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function canonicalDirectory(folder: string): Promise<string> {
  const path = resolve(folder);
  const meta = await lstat(path);
  if (!meta.isDirectory() || meta.isSymbolicLink() || await realpath(path) !== path) {
    throw new Error("unsafe-directory");
  }
  return path;
}
async function pinned(path: string, maximum: number): Promise<{ readonly bytes: Buffer; readonly sha256: string }> {
  const absolute = resolve(path);
  const before = await lstat(absolute);
  if (!before.isFile() || before.isSymbolicLink() || before.size <= 0 || before.size > maximum
    || await realpath(absolute) !== absolute) throw new Error("unsafe-file");
  const handle = await open(absolute, "r");
  let bytes: Buffer;
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.ino !== before.ino || current.size !== before.size) {
      throw new Error("changed-file");
    }
    bytes = Buffer.alloc(before.size);
    for (let at = 0; at < bytes.length;) {
      const part = await handle.read(bytes, at, bytes.length - at, at);
      if (part.bytesRead <= 0) throw new Error("truncated-file");
      at += part.bytesRead;
    }
  } finally { await handle.close(); }
  const after = await lstat(absolute);
  if (!after.isFile() || after.isSymbolicLink() || after.ino !== before.ino
    || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("changed-file");
  return { bytes, sha256: hash(bytes) };
}
async function jsonFile(path: string, maximum = MAX_SUMMARY): Promise<{
  readonly json: Record<string, unknown>; readonly sha256: string;
}> {
  const file = await pinned(path, maximum);
  const json = object(JSON.parse(file.bytes.toString("utf8")) as unknown);
  if (json === null) throw new Error("invalid-json");
  return { json, sha256: file.sha256 };
}

/**
 * Private manifest is a sibling of every job folder. The report HTTP handler
 * only serves UUID job folders, so a manifest (and journey environment names)
 * never becomes a browser-accessible report.
 */
export async function prepareLocalProjectManifest(input: unknown, outputRoot: string,
  jobId: string): Promise<{ manifestPath: string; manifest: ProjectManifestV1 }> {
  try {
    if (!validRoot(outputRoot) || !JOB_ID.test(jobId)) throw new Error("invalid-options");
    const raw = object(input);
    if (raw === null || Object.keys(raw).some((key) =>
      !["schemaVersion", "baseUrl", "mode", "failOn", "interactions", "routes"].includes(key))) {
      throw new Error("invalid-form");
    }
    // The public manifest parser validates types and roles. The localhost
    // browser form has an additional privacy rule: never accept secrets, URLs
    // or filesystem selectors in the accessible marker name.
    if (Array.isArray(raw["routes"]) && raw["routes"].some((entry: unknown) => {
      const route = object(entry);
      if (route === null || route["authReady"] === undefined) return false;
      const marker = object(route["authReady"]);
      if (marker === null || !LOCAL_AUTH_ROLES.has(String(marker["role"]))
        || typeof marker["name"] !== "string") return true;
      const name = marker["name"];
      return name.length < 1 || name.length > 128 || name.trim() !== name
        || /[\p{Cc}\p{Cf}]/u.test(name) || UNSAFE_AUTH_NAME.test(name);
    })) throw new Error("invalid-auth-marker");
    const manifest = parseProjectManifest({ ...raw, schemaVersion: "tvdoctor.project/v1" });
    if (raw["schemaVersion"] !== undefined && raw["schemaVersion"] !== manifest.schemaVersion) {
      throw new Error("invalid-schema");
    }
    const serialized = JSON.stringify(manifest, null, 2) + "\n";
    if (Buffer.byteLength(serialized) > MAX_MANIFEST) throw new Error("oversized-manifest");
    const root = resolve(outputRoot);
    await mkdir(root, { recursive: true });
    await canonicalDirectory(root);
    const privateDir = join(root, ".project-manifests");
    await mkdir(privateDir, { mode: 0o700, recursive: true });
    await canonicalDirectory(privateDir);
    const manifestPath = join(privateDir, `${jobId}.json`);
    await writeFile(manifestPath, serialized, { flag: "wx", mode: 0o600 });
    return { manifestPath, manifest };
  } catch {
    // Do not emit private filesystem paths, target URLs or raw parser errors.
    throw new TypeError("Invalid project configuration or unavailable private manifest location.");
  }
}

function checkSavedProject(saved: Record<string, unknown>, outcome: ProjectCheckResult,
  root: string, routeCountLimit = 8): boolean {
  const summary = object(saved["summary"]);
  const routes = saved["routes"];
  if (saved["schemaVersion"] !== "tvdoctor.project-check/v1"
    || saved["summaryPath"] !== join(root, "summary.json")
    || JSON.stringify(saved) !== JSON.stringify(outcome)
    || saved["status"] !== outcome.status || saved["exitCode"] !== outcome.exitCode
    || saved["shouldFail"] !== (outcome.exitCode !== 0)
    || saved["reason"] !== (outcome.summary.partial > 0 ? "one-or-more-routes-inconclusive" : null)
    || !Array.isArray(routes) || routes.length < 1 || routes.length > routeCountLimit
    || !bounded(summary?.["routes"]) || summary["routes"] !== routes.length
    || !bounded(summary["verified"]) || !bounded(summary["review"])
    || !bounded(summary["untested"]) || !bounded(summary["partial"])) return false;
  const failed = outcome.routes.some((route) => route.status === "FINDINGS");
  const review = outcome.routes.some((route) => route.status === "REVIEW_REQUIRED");
  const partial = outcome.routes.filter((route) => route.status === "INCONCLUSIVE").length;
  const expectedStatus = partial > 0 ? "INCONCLUSIVE" : failed ? "FINDINGS"
    : review ? "REVIEW_REQUIRED" : "PASS";
  const expectedExit = partial > 0
    ? outcome.routes.some((route) => route.exitCode === 4) ? 4 : 3 : failed ? 1 : 0;
  return saved["status"] === expectedStatus && saved["exitCode"] === expectedExit
    && summary["partial"] === partial
    && outcome.routes.every((route) => ROUTE_ID.test(route.id));
}
function eligible(finding: ReportTriage["findings"][number]): boolean {
  return finding.classification === "VERIFIED"
    && finding.pack === "navigation" && SUPPORTED.has(finding.rule)
    && finding.reproduction.status === "deterministic";
}
function verifiedIds(triage: ReportTriage): readonly string[] | null {
  const ids = triage.findings.filter((finding) => finding.classification === "VERIFIED")
    .map((finding) => finding.id);
  return ids.length === triage.summary.VERIFIED && ids.every((id) => ISSUE_ID.test(id))
    && new Set(ids).size === ids.length ? ids : null;
}
async function routeReport(path: string): Promise<{
  readonly json: ReturnType<typeof parseTVDoctorReportJson>;
  readonly triage: ReportTriage;
  readonly sha256: string;
}> {
  const reportFile = await pinned(path, PROTOCOL_VALIDATION_LIMITS.maxJsonBytes);
  const json = parseTVDoctorReportJson(reportFile.bytes.toString("utf8"));
  if (json.schemaVersion !== REPORT_SCHEMA_VERSION_V1 || json.target.platform !== "web"
    || json.target.environment["inputMode"] !== "keyboard") throw new Error("wrong-report-kind");
  const triage = await inspectReport(path, { maxFindings: MAX_ISSUES });
  if (triage.summary.omitted !== 0 || triage.coverage.packsOmitted !== 0
    || ["bounded", "degraded"].includes(triage.integrity.evidence)
    || verifiedIds(triage) === null) throw new Error("incomplete-report-evidence");
  if ((await pinned(path, PROTOCOL_VALIDATION_LIMITS.maxJsonBytes)).sha256 !== reportFile.sha256) {
    throw new Error("report-changed");
  }
  return { json, triage, sha256: reportFile.sha256 };
}
async function optionalHtml(root: string, relativePath: string, jobId: string): Promise<string | undefined> {
  const path = join(root, relativePath);
  try {
    const parent = await canonicalDirectory(dirname(path));
    const meta = await lstat(path);
    if (parent !== dirname(path) || !meta.isFile() || meta.isSymbolicLink()
      || meta.size < 1 || meta.size > 64 * 1024 * 1024
      || await realpath(path) !== path || !within(root, path)) return undefined;
    return `/reports/${jobId}/${relativePath.replaceAll("\\", "/")}`;
  } catch { return undefined; }
}

/** Return only independently checked counts and local, owned artifact links. */
export async function inspectLocalProjectCapture(outputPath: string, jobId: string,
  outcome: ProjectCheckResult): Promise<PublicProjectCapture | null> {
  try {
    if (!validRoot(outputPath) || !JOB_ID.test(jobId)) return null;
    const root = await canonicalDirectory(outputPath);
    if (root !== resolve(outputPath) || root !== join(dirname(root), jobId)) return null;
    const saved = await jsonFile(join(root, "summary.json"));
    if (!checkSavedProject(saved.json, outcome, root)) return null;
    const privateDirectory = await canonicalDirectory(join(dirname(root), ".project-manifests"));
    const sourceManifest = await jsonFile(join(privateDirectory, `${jobId}.json`), MAX_MANIFEST);
    const manifest = parseProjectManifest(sourceManifest.json);
    if (manifest.routes.length !== outcome.routes.length) return null;
    let verified = 0;
    let review = 0;
    let untested = 0;
    let routeEligible = true;
    let origin: string | null = null;
    const urls = new Set<string>();
    const routes: PublicProjectCapture["routes"][number][] = [];
    for (const [index, route] of outcome.routes.entries()) {
      const expectedRoute = manifest.routes[index];
      if (expectedRoute?.id !== route.id || !bounded(route.verified)
        || !bounded(route.review) || !bounded(route.untested)) return null;
      if (route.status === "INCONCLUSIVE") {
        // Project-check withholds a report pointer for incomplete routes. Its
        // zero counters mean uncounted work, never evidence of a clean route.
        if (route.reportRelativePath !== null || route.verified !== 0
          || route.review !== 0 || route.untested !== 0
          || ![1, 2, 3, 4].includes(route.exitCode)
          || typeof route.reason !== "string"
          || !/^[a-z][a-z0-9-]{0,159}$/u.test(route.reason)) return null;
        const redirected = route.reason === "protected-route-redirected";
        const missingContent = route.reason === "protected-content-unproven";
        const failedJourney = route.reason === "authentication-journey-failed";
        if (redirected && !await inspectProtectedRouteRedirect(
          join(root, route.id, "report.json"),
          new URL(expectedRoute.path, manifest.baseUrl).href, manifest.mode,
        )) return null;
        if (missingContent && (expectedRoute.authReady === undefined
          || !await inspectProtectedContentUnproven(
            join(root, route.id, "report.json"),
            new URL(expectedRoute.path, manifest.baseUrl).href, manifest.mode,
          ))) return null;
        if (failedJourney && (expectedRoute.journeyEnv === undefined
          || expectedRoute.authReady === undefined
          || !await inspectAuthenticatedJourneyFailure(
            join(root, route.id, "report.json"),
            new URL(expectedRoute.path, manifest.baseUrl).href, manifest.mode,
          ))) return null;
        routes.push({ id: route.id, status: "INCONCLUSIVE",
          verified: 0, review: 0, untested: 0,
          reason: redirected ? "protected-route-redirected"
            : missingContent ? "protected-content-unproven"
              : failedJourney ? "authentication-journey-failed" : "scan-incomplete",
          remediation: redirected ? "configure-auth-journey"
            : missingContent ? "inspect-auth-ready-marker"
              : failedJourney ? "repair-auth-journey" : "review-incomplete-coverage" });
        continue;
      }
      if (route.reason !== null || route.reportRelativePath !== `${route.id}/report.json`
        || !["PASS", "REVIEW_REQUIRED", "FINDINGS"].includes(route.status)
        || !bounded(route.verified) || !bounded(route.review) || !bounded(route.untested)
        || route.exitCode !== (route.status === "FINDINGS" ? 1 : 0)) return null;
      const folder = await canonicalDirectory(join(root, route.id));
      const reportPath = join(folder, "report.json");
      const report = await routeReport(reportPath);
      const { triage, json } = report;
      const target = new URL(json.target.location);
      if (json.target.location !== new URL(expectedRoute.path, manifest.baseUrl).href
        || json.run.mode !== manifest.mode) return null;
      if (target.protocol !== "http:" && target.protocol !== "https:"
        || target.username !== "" || target.password !== "" || target.hash !== ""
        || target.search !== "" || urls.has(target.href)) return null;
      if (origin !== null && origin !== target.origin) return null;
      origin = target.origin;
      urls.add(target.href);
      if (triage.coverage.incomplete || json.run.status !== "completed"
        || triage.summary.VERIFIED !== route.verified
        || triage.summary.REVIEW !== route.review || triage.summary.UNTESTED !== route.untested) {
        return null;
      }
      const policyFailure = triage.highestVerifiedSeverity !== null
        && issueViolatesPolicy(triage.highestVerifiedSeverity, manifest.failOn);
      const expectedStatus = policyFailure ? "FINDINGS"
        : triage.summary.REVIEW > 0 ? "REVIEW_REQUIRED" : "PASS";
      if (expectedStatus !== route.status) return null;
      if (expectedRoute.journeyEnv === undefined
        && json.target.environment["journeyConfigSha256"] !== undefined) return null;
      if (expectedRoute.journeyEnv !== undefined
        && !SHA256.test(String(json.target.environment["journeyConfigSha256"]))) return null;
      routeEligible &&= triage.findings.every((finding) =>
        finding.classification !== "VERIFIED" || eligible(finding));
      verified += route.verified;
      review += route.review;
      untested += route.untested;
      routes.push({ id: route.id, status: route.status,
        verified: route.verified, review: route.review, untested: route.untested,
        ...(await optionalHtml(root, `${route.id}/report.html`, jobId) === undefined
          ? {} : { reportUrl: `/reports/${jobId}/${route.id}/report.html` }) });
    }
    if (outcome.summary.routes !== routes.length || verified !== outcome.summary.verified
      || review !== outcome.summary.review || untested !== outcome.summary.untested
      || outcome.summary.partial !== routes.filter((route) => route.status === "INCONCLUSIVE").length
      || (await pinned(join(root, "summary.json"), MAX_SUMMARY)).sha256 !== saved.sha256
      || (await pinned(join(privateDirectory, `${jobId}.json`), MAX_MANIFEST)).sha256
        !== sourceManifest.sha256) return null;
    return { status: outcome.status,
      summary: { routes: routes.length, verified, review, untested,
        partial: outcome.summary.partial },
      routes, summaryUrl: `/reports/${jobId}/summary.json`,
      acceptReady: outcome.summary.partial === 0 && verified >= 1 && verified <= 16 && routeEligible };
  } catch { return null; }
}

function equalIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function boundedIds(values: readonly string[]): boolean {
  return values.length <= 12 && values.every((id) => ISSUE_ID.test(id))
    && new Set(values).size === values.length;
}
function unchangedResult(value: unknown, result: unknown): boolean {
  return JSON.stringify(value) === JSON.stringify(result);
}
function validAcceptanceVerdict(value: ProjectAcceptResult, eligibleOriginal: PublicProjectCapture): boolean {
  const verifiedOriginal = eligibleOriginal.summary.verified;
  const { verification, regression } = value;
  if (value.schemaVersion !== "tvdoctor.project-accept/v1"
    || value.shouldFail !== (value.exitCode !== 0)
    || ![0, 1, 2, 3, 4].includes(value.exitCode)
    || !["PASS", "REPRODUCED", "NEW_VERIFIED", "INCONCLUSIVE", "ERROR"].includes(value.status)
    || (value.reason !== null && !/^[a-z][a-z0-9-]{0,159}$/u.test(value.reason))
    || value.original.routes !== eligibleOriginal.summary.routes
    || value.original.verified !== verifiedOriginal
    || !SHA256.test(String(value.original.summarySha256))
    || !["PASS", "REPRODUCED", "INCONCLUSIVE", "NO_ELIGIBLE", "NOT_RUN"].includes(verification.status)
    || !["COMPLETED", "INCOMPLETE", "NOT_RUN"].includes(regression.status)
    || ![verification.fixed, verification.reproduced, verification.inconclusive,
      regression.verified, regression.review, regression.untested].every(bounded)
    || !Array.isArray(verification.routes) || !Array.isArray(regression.routes)) return false;
  const originalReproduced = verification.reproduced > 0;
  const verificationIncomplete = verification.inconclusive > 0
    || verification.status === "INCONCLUSIVE" || verification.status === "NO_ELIGIBLE"
    || verification.status === "NOT_RUN";
  const regressionIncomplete = regression.status !== "COMPLETED";
  if (value.status === "PASS") {
    return value.exitCode === 0 && value.reason === null
      && verification.status === "PASS" && verification.fixed === verifiedOriginal
      && !verificationIncomplete && !originalReproduced
      && regression.status === "COMPLETED" && regression.verified === 0;
  }
  if (value.status === "REPRODUCED") return value.exitCode === 1 && originalReproduced;
  if (value.status === "NEW_VERIFIED") {
    return value.exitCode === 1 && regression.verified > 0 && !originalReproduced
      && !verificationIncomplete && !regressionIncomplete
      && verification.status === "PASS" && verification.fixed === verifiedOriginal;
  }
  if (value.status === "INCONCLUSIVE") {
    return (value.exitCode === 2 || value.exitCode === 3)
      && !originalReproduced
      && (verificationIncomplete || regressionIncomplete);
  }
  return value.status === "ERROR" && value.exitCode === 4;
}

/**
 * Acceptance is only displayed when source evidence remains identical and the
 * original replay + fresh independent scan artifacts substantiate the summary.
 */
export async function inspectLocalProjectAcceptance(outputPath: string, jobId: string,
  outcome: ProjectAcceptResult, original: PublicProjectCapture): Promise<PublicProjectAcceptance | null> {
  try {
    if (!validRoot(outputPath) || !JOB_ID.test(jobId) || !original.acceptReady
      || outcome.acceptancePath !== "project-accept.json") return null;
    const root = await canonicalDirectory(outputPath);
    if (root !== resolve(outputPath) || root !== join(dirname(root), jobId)) return null;
    const sourceMatch = /^\/reports\/([0-9a-f-]{36})\/summary\.json$/iu.exec(original.summaryUrl);
    const originalId = sourceMatch?.[1];
    if (originalId === undefined || !JOB_ID.test(originalId) || originalId === jobId) return null;
    const originalRoot = await canonicalDirectory(join(dirname(root), originalId));
    if (originalRoot === root) return null;
    const originalSaved = await jsonFile(join(originalRoot, "summary.json"));
    const originalOutcome = originalSaved.json as unknown as ProjectCheckResult;
    const confirmedOriginal = await inspectLocalProjectCapture(originalRoot, originalId, originalOutcome);
    if (confirmedOriginal === null || !unchangedResult(confirmedOriginal, original)) return null;
    const privateDir = await canonicalDirectory(join(dirname(originalRoot), ".project-manifests"));
    const privateManifest = await jsonFile(join(privateDir, `${originalId}.json`), MAX_MANIFEST);
    const manifest = parseProjectManifest(privateManifest.json);
    const savedAcceptance = await jsonFile(join(root, "project-accept.json"));
    if (!unchangedResult(savedAcceptance.json, outcome) || !validAcceptanceVerdict(outcome, original)
      || outcome.original.summarySha256 !== originalSaved.sha256) return null;

    const originalReports = new Map<string, Awaited<ReturnType<typeof routeReport>>>();
    const expectedIssueIds = new Map<string, Map<string, string>>();
    for (const route of original.routes) {
      const reportPath = join(originalRoot, route.id, "report.json");
      const report = await routeReport(reportPath);
      const issues = new Map(report.triage.findings.filter((finding) => finding.classification === "VERIFIED")
        .map((finding) => [finding.id, finding.rule]));
      if (issues.size !== route.verified) return null;
      originalReports.set(route.id, report);
      expectedIssueIds.set(route.id, issues);
    }

    const { verification, regression } = outcome;
    const links: Record<"summary" | "verification" | "regression", string> = {
      summary: `/reports/${jobId}/project-accept.json`,
      verification: "", regression: "",
    };
    if (verification.summaryPath === null) {
      if (verification.status !== "NOT_RUN" || verification.routes.length !== 0
        || verification.fixed !== 0 || verification.reproduced !== 0
        || verification.inconclusive !== 0) return null;
    } else {
      if (verification.summaryPath !== "verification/summary.json") return null;
      const folder = await canonicalDirectory(join(root, "verification"));
      const savedVerification = await jsonFile(join(folder, "summary.json"));
      const result = savedVerification.json as unknown as ProjectVerifyResult;
      if (result.schemaVersion !== "tvdoctor.project-verify/v1"
        || result.summaryPath !== join(folder, "summary.json")
        || result.status !== verification.status
        || (result.status === "PASS" && result.reason !== null)
        || result.shouldFail !== (result.exitCode !== 0)
        || (result.status === "PASS" && (result.exitCode !== 0
          || result.summary.reproduced !== 0 || result.summary.inconclusive !== 0))
        || (result.status === "REPRODUCED" && (result.exitCode !== 1
          || result.summary.reproduced === 0))
        || (result.status === "INCONCLUSIVE" && result.exitCode !== 3 && result.exitCode !== 4)
        || (result.status === "NO_ELIGIBLE" && result.exitCode !== 3)
        || result.summary.routes !== original.routes.length
        || result.summary.verifiedOriginal !== original.summary.verified
        || result.summary.fixed !== verification.fixed
        || result.summary.reproduced !== verification.reproduced
        || result.summary.inconclusive !== verification.inconclusive
        || result.summary.fixed + result.summary.reproduced
          + result.summary.inconclusive !== original.summary.verified
        || result.routes.length !== original.routes.length
        || verification.routes.length !== original.routes.length) return null;
      for (const [index, route] of verification.routes.entries()) {
        const source = original.routes[index];
        const verifiedRoute = result.routes[index];
        if (source?.id !== route.id || verifiedRoute?.id !== route.id
          || verifiedRoute.reason !== null
          || !SHA256.test(route.originalReportSha256)
          || route.originalReportSha256 !== originalReports.get(route.id)?.sha256
          || verifiedRoute.originalReportSha256 !== route.originalReportSha256
          || !Array.isArray(verifiedRoute.findings)
          || verifiedRoute.findings.length !== source.verified
          || !bounded(route.fixed) || !bounded(route.reproduced) || !bounded(route.inconclusive)
          || !boundedIds(route.reproducedIssueIds) || !boundedIds(route.inconclusiveIssueIds)
          || route.fixed + route.reproduced + route.inconclusive !== source.verified) return null;
        const issues = expectedIssueIds.get(route.id);
        const seen = new Set<string>();
        for (const finding of verifiedRoute.findings) {
          if (issues?.get(finding.id) !== finding.rule || seen.has(finding.id)
            || !["FIXED", "REPRODUCED", "INCONCLUSIVE"].includes(finding.classification)
            || (finding.classification !== "INCONCLUSIVE" && finding.reason !== null)) return null;
          seen.add(finding.id);
        }
        const matched = (classification: string): string[] => verifiedRoute.findings
          .filter((finding) => finding.classification === classification).map((finding) => finding.id);
        if (matched("FIXED").length !== route.fixed
          || matched("REPRODUCED").length !== route.reproduced
          || matched("INCONCLUSIVE").length !== route.inconclusive
          || !equalIds(matched("REPRODUCED").slice(0, 12), route.reproducedIssueIds)
          || !equalIds(matched("INCONCLUSIVE").slice(0, 12), route.inconclusiveIssueIds)) return null;
      }
      if (verification.routes.reduce((sum, route) => sum + route.fixed, 0) !== verification.fixed
        || verification.routes.reduce((sum, route) => sum + route.reproduced, 0) !== verification.reproduced
        || verification.routes.reduce((sum, route) => sum + route.inconclusive, 0) !== verification.inconclusive
        || (await pinned(join(folder, "summary.json"), MAX_SUMMARY)).sha256 !== savedVerification.sha256) {
        return null;
      }
      links.verification = `/reports/${jobId}/verification/summary.json`;
    }

    const publicRoutes: PublicProjectAcceptance["regression"]["routes"][number][] = [];
    if (regression.summaryPath === null) {
      if (regression.status !== "NOT_RUN" || regression.routes.length !== 0
        || regression.verified !== 0 || regression.review !== 0 || regression.untested !== 0) return null;
    } else {
      if (regression.summaryPath !== "regression/summary.json") return null;
      const folder = await canonicalDirectory(join(root, "regression"));
      const savedRegression = await jsonFile(join(folder, "summary.json"));
      const run = savedRegression.json as unknown as ProjectCheckResult;
      if (!checkSavedProject(savedRegression.json, run, folder)
        || run.summary.routes !== original.routes.length
        || run.routes.length !== regression.routes.length
        || regression.routes.length !== original.routes.length
        || run.summary.verified !== regression.verified
        || run.summary.review !== regression.review
        || run.summary.untested !== regression.untested
        || (regression.status === "COMPLETED") !== (run.summary.partial === 0)) return null;
      let verified = 0;
      let review = 0;
      let untested = 0;
      for (const [index, route] of regression.routes.entries()) {
        const source = original.routes[index];
        const scanned = run.routes[index];
        const expectedRoute = manifest.routes[index];
        if (source?.id !== route.id || scanned?.id !== route.id
          || expectedRoute?.id !== route.id
          || !bounded(route.verified) || !bounded(route.review) || !bounded(route.untested)
          || !bounded(route.omittedVerifiedIssueIds) || !boundedIds(route.verifiedIssueIds)
          || !["PASS", "REVIEW_REQUIRED", "FINDINGS", "INCONCLUSIVE"].includes(route.status)) return null;
        if (scanned.status === "INCONCLUSIVE") {
          if (route.status !== "INCONCLUSIVE" || route.verified !== 0
            || route.review !== 0 || route.untested !== 0 || route.verifiedIssueIds.length !== 0
            || route.omittedVerifiedIssueIds !== 0 || scanned.reportRelativePath !== null) return null;
          publicRoutes.push({ id: route.id, status: route.status,
            verified: 0, review: 0, untested: 0, verifiedIssueIds: [], omittedVerifiedIssueIds: 0 });
          continue;
        }
        if (scanned.reportRelativePath !== `${route.id}/report.json`
          || scanned.status !== route.status
          || scanned.verified !== route.verified
          || scanned.review !== route.review || scanned.untested !== route.untested
          || scanned.reason !== null || scanned.exitCode !== (scanned.status === "FINDINGS" ? 1 : 0)) {
          return null;
        }
        const reportFolder = await canonicalDirectory(join(folder, route.id));
        const report = await routeReport(join(reportFolder, "report.json"));
        const originalReport = originalReports.get(route.id)?.json;
        if (originalReport === undefined
          || report.json.target.location !== originalReport.target.location
          || report.json.run.mode !== originalReport.run.mode
          || report.json.target.environment["journeyConfigSha256"]
            !== originalReport.target.environment["journeyConfigSha256"]
          || report.triage.summary.VERIFIED !== route.verified
          || report.triage.summary.REVIEW !== route.review
          || report.triage.summary.UNTESTED !== route.untested) return null;
        const policyFailure = report.triage.highestVerifiedSeverity !== null
          && issueViolatesPolicy(report.triage.highestVerifiedSeverity, manifest.failOn);
        const policyStatus = policyFailure ? "FINDINGS"
          : report.triage.summary.REVIEW > 0 ? "REVIEW_REQUIRED" : "PASS";
        if (scanned.status !== policyStatus) return null;
        const ids = verifiedIds(report.triage);
        if (ids === null || route.verifiedIssueIds.length !== Math.min(ids.length, 12)
          || !equalIds(ids.slice(0, 12), route.verifiedIssueIds)
          || route.omittedVerifiedIssueIds !== Math.max(0, ids.length - 12)
          || report.triage.coverage.incomplete) return null;
        const htmlUrl = await optionalHtml(reportFolder, "report.html", jobId);
        publicRoutes.push({ id: route.id, status: route.status,
          verified: route.verified, review: route.review, untested: route.untested,
          verifiedIssueIds: [...route.verifiedIssueIds],
          omittedVerifiedIssueIds: route.omittedVerifiedIssueIds,
          ...(htmlUrl === undefined ? {} : { reportUrl: `/reports/${jobId}/regression/${route.id}/report.html` }) });
        verified += route.verified; review += route.review; untested += route.untested;
      }
      if (verified !== regression.verified || review !== regression.review
        || untested !== regression.untested
        || (await pinned(join(folder, "summary.json"), MAX_SUMMARY)).sha256 !== savedRegression.sha256) {
        return null;
      }
      links.regression = `/reports/${jobId}/regression/summary.json`;
    }
    if ((await pinned(join(root, "project-accept.json"), MAX_SUMMARY)).sha256 !== savedAcceptance.sha256
      || (await pinned(join(originalRoot, "summary.json"), MAX_SUMMARY)).sha256 !== originalSaved.sha256
      || (await pinned(join(privateDir, `${originalId}.json`), MAX_MANIFEST)).sha256
        !== privateManifest.sha256) {
      return null;
    }
    return {
      status: outcome.status,
      verification: { status: verification.status, fixed: verification.fixed,
        reproduced: verification.reproduced, inconclusive: verification.inconclusive,
        routes: verification.routes.map((route) => ({
          id: route.id, fixed: route.fixed, reproduced: route.reproduced,
          inconclusive: route.inconclusive, reproducedIssueIds: [...route.reproducedIssueIds],
          inconclusiveIssueIds: [...route.inconclusiveIssueIds],
        })) },
      regression: { status: regression.status, verified: regression.verified,
        review: regression.review, untested: regression.untested, routes: publicRoutes },
      links: { summary: links.summary, ...(links.verification ? { verification: links.verification } : {}),
        ...(links.regression ? { regression: links.regression } : {}) },
      originalSummaryUrl: original.summaryUrl,
      originalLinks: { summary: original.summaryUrl },
    };
  } catch { return null; }
}
