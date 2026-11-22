import { createHash } from "node:crypto";
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseTVDoctorReportJson } from "@tvdoctor/protocol";
import { inspectReport } from "./node-triage.js";
import type { SpaRouteHealthConfig, SpaRouteHealthCaptureResult } from "./spa-route-health.js";
import type { SpaRouteHealthAcceptResult } from "./spa-route-health-accept.js";

const CONFIG_VERSION = "tvdoctor.spa-route-health-config/v1";
const ORIGINAL_VERSION = "tvdoctor.spa-route-health-original/v1";
const SHA = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ROUTE = /^\/(?:[A-Za-z0-9_~.-]+(?:\/[A-Za-z0-9_~.-]+)*)?\/?$/u;
const MUTATION = /(?:^|\/)(?:api|auth|login|logout|signin|signout|checkout|cart|buy|purchase|pay|payment|subscribe|delete|remove|create|edit|save|update|upload|submit|send|approve|revoke|reset|transfer|order)(?:\/|$)/iu;
const NAME_UNSAFE = /[<>\\@\p{Cc}\p{Cf}]|(?:https?:\/\/|www\.|javascript:|data:|\b(?:password|secret|token|credential|apikey|api.key|private.key)\b)/iu;
const LINK_ACTION = /\b(?:delete|remove|erase|create|edit|save|update|upload|submit|send|approve|revoke|reset|transfer|order|pay|purchase|checkout|login|logout|sign\s*(?:in|out)|download|subscribe|unsubscribe|confirm)\b/iu;
const MAX_CONFIG = 4096;
const MAX_ORIGINAL = 4096;
const MAX_ACCEPT = 32 * 1024;
const MAX_VERIFY = 4096;
const MAX_QA = 128 * 1024;
const MAX_REPORT = 16 * 1024 * 1024;
const REASON = /^[a-z][a-z0-9-]{0,159}$/u;

export interface LocalSpaRouteHealthRequest extends SpaRouteHealthConfig {
  readonly authorized: true;
}
export class LocalSpaRouteHealthRequestError extends Error {
  readonly statusCode: 400 | 403;
  readonly reason: "invalid-spa-route-health-request" | "spa-route-health-authorization-required";
  constructor(code: 400 | 403) {
    const reason = code === 403 ? "spa-route-health-authorization-required" : "invalid-spa-route-health-request";
    super(reason);
    this.statusCode = code;
    this.reason = reason;
  }
}
export interface LocalSpaRouteHealthConfig {
  readonly configPath: string;
  readonly configSha256: string;
  readonly route: SpaRouteHealthConfig;
}
export interface PublicLocalSpaRouteHealthCapture {
  readonly status: "VERIFIED_ORIGINAL" | "INCONCLUSIVE";
  readonly originalSha256: string | null;
  readonly acceptReady: boolean;
  readonly links: Readonly<Partial<Record<"original", string>>>;
}
export interface PublicLocalSpaRouteHealthAcceptance {
  readonly status: SpaRouteHealthAcceptResult["status"];
  readonly verification: SpaRouteHealthAcceptResult["verification"];
  readonly postRegressionVerification: SpaRouteHealthAcceptResult["postRegressionVerification"];
  readonly regression: SpaRouteHealthAcceptResult["regression"];
  readonly reason: string | null;
  readonly links: Readonly<Partial<Record<"summary" | "verification" | "regression" | "postRegressionVerification", string>>>;
}
export interface LocalSpaRouteHealthCommandCaptureResult {
  readonly schemaVersion: "tvdoctor.spa-route-health-command/v1";
  readonly status: "VERIFIED_ORIGINAL" | "INCONCLUSIVE";
  readonly exitCode: number;
  readonly shouldFail: boolean;
  readonly originalSha256: string | null;
  readonly regressionChecked: boolean;
  readonly reason: string | null;
  readonly caveat?: string;
}
const digest = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
function object(value: unknown): Record<string, unknown> | null {
  return value === null || typeof value !== "object" || Array.isArray(value) ? null : value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("|") === [...expected].sort().join("|");
}
function num(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 100_000;
}
function isPath(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value) && value.trim() === value
    && value.length <= 4096 && !value.includes("\0") && resolve(value) === value;
}
function inside(parent: string, child: string): boolean {
  const rest = relative(parent, child);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}
async function directory(path: string): Promise<string> {
  if (!isPath(path)) throw new Error("noncanonical-directory");
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) {
    throw new Error("unsafe-directory");
  }
  return path;
}
interface Proof { readonly path: string; readonly sha256: string; readonly bytes: Buffer; readonly length: number }
async function pinned(path: string, max: number): Promise<Proof> {
  if (!isPath(path)) throw new Error("noncanonical-evidence");
  await directory(dirname(path));
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > max
    || await realpath(path) !== path) throw new Error("unsafe-evidence");
  const handle = await open(path, "r");
  let bytes: Buffer;
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.ino !== before.ino || current.size !== before.size) {
      throw new Error("changed-evidence");
    }
    bytes = Buffer.alloc(before.size);
    for (let at = 0; at < bytes.length;) {
      const chunk = await handle.read(bytes, at, bytes.length - at, at);
      if (chunk.bytesRead < 1) throw new Error("truncated-evidence");
      at += chunk.bytesRead;
    }
  } finally { await handle.close(); }
  const after = await lstat(path);
  if (!after.isFile() || after.isSymbolicLink() || after.size !== before.size
    || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs
    || await realpath(path) !== path) throw new Error("changed-evidence");
  return { path, bytes, sha256: digest(bytes), length: bytes.length };
}
async function unchanged(proof: Proof): Promise<boolean> {
  try {
    const latest = await pinned(proof.path, proof.length);
    return latest.sha256 === proof.sha256 && latest.length === proof.length;
  } catch { return false; }
}
const FIELDS = ["baseUrl", "sourcePath", "destinationPath", "linkName", "heading",
  "expectedMainTextSha256"] as const;
export function parseLocalSpaRouteHealthRequest(value: unknown): LocalSpaRouteHealthRequest {
  const input = object(value);
  if (input === null) throw new LocalSpaRouteHealthRequestError(400);
  if (input["authorized"] !== true) throw new LocalSpaRouteHealthRequestError(403);
  if (!keys(input, ["authorized", ...FIELDS])) throw new LocalSpaRouteHealthRequestError(400);
  const { baseUrl, sourcePath, destinationPath, linkName, heading, expectedMainTextSha256 } = input;
  if (typeof baseUrl !== "string" || baseUrl.length < 1 || baseUrl.length > 2048
    || typeof sourcePath !== "string" || typeof destinationPath !== "string"
    || sourcePath.length > 512 || destinationPath.length > 512
    || !ROUTE.test(sourcePath) || !ROUTE.test(destinationPath)
    || [sourcePath, destinationPath].some((p) => p.split("/").some((part) => part === "." || part === "..")
      || MUTATION.test(p)) || sourcePath === destinationPath
    || typeof linkName !== "string" || typeof heading !== "string"
    || [linkName, heading].some((name) => name.length < 1 || name.length > 128
      || name.trim() !== name || NAME_UNSAFE.test(name))
    || LINK_ACTION.test(linkName)
    || typeof expectedMainTextSha256 !== "string" || !SHA.test(expectedMainTextSha256)) {
    throw new LocalSpaRouteHealthRequestError(400);
  }
  let base: URL | null = null;
  try { base = new URL(baseUrl); } catch { /* invalid */ }
  if (base === null || (base.protocol !== "http:" && base.protocol !== "https:")
    || base.username !== "" || base.password !== "" || base.search !== "" || base.hash !== ""
    || base.pathname !== "/" || base.href !== `${base.origin}/`
    || (baseUrl !== base.origin && baseUrl !== base.href)
    || new URL(sourcePath, base).pathname !== sourcePath
    || new URL(destinationPath, base).pathname !== destinationPath) {
    throw new LocalSpaRouteHealthRequestError(400);
  }
  return { authorized: true, baseUrl, sourcePath, destinationPath, linkName, heading,
    expectedMainTextSha256 };
}
function routeFrom(request: LocalSpaRouteHealthRequest): SpaRouteHealthConfig {
  return { baseUrl: request.baseUrl, sourcePath: request.sourcePath,
    destinationPath: request.destinationPath, linkName: request.linkName,
    heading: request.heading, expectedMainTextSha256: request.expectedMainTextSha256 };
}
/** Private immutable config is a sibling of job folders, never a report asset. */
export async function prepareLocalSpaRouteHealthConfig(request: LocalSpaRouteHealthRequest,
  outputRoot: string, jobId: string): Promise<LocalSpaRouteHealthConfig> {
  if (!isPath(outputRoot) || !UUID.test(jobId)) throw new TypeError("invalid-spa-route-health-config-options");
  const route = routeFrom(parseLocalSpaRouteHealthRequest(request));
  const root = await directory(outputRoot);
  const privateRoot = join(root, ".spa-route-health-configs");
  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  await directory(privateRoot);
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: CONFIG_VERSION, ...route }) + "\n", "utf8");
  if (bytes.length > MAX_CONFIG) throw new TypeError("oversized-spa-private-config");
  const configPath = join(privateRoot, `${jobId}.json`);
  await writeFile(configPath, bytes, { flag: "wx", mode: 0o600 });
  return { configPath, configSha256: digest(bytes), route };
}
async function configProof(jobRoot: string, jobId: string, request: LocalSpaRouteHealthRequest,
  configSha256: string): Promise<{ route: SpaRouteHealthConfig; proof: Proof }> {
  if (!isPath(jobRoot) || basename(jobRoot) !== jobId || !UUID.test(jobId)
    || !SHA.test(configSha256)) throw new Error("invalid-private-config-reference");
  const parent = await directory(dirname(jobRoot));
  const privateRoot = await directory(join(parent, ".spa-route-health-configs"));
  const proof = await pinned(join(privateRoot, `${jobId}.json`), MAX_CONFIG);
  if (proof.sha256 !== configSha256) throw new Error("config-pin-changed");
  const route = routeFrom(parseLocalSpaRouteHealthRequest(request));
  const saved = object(JSON.parse(proof.bytes.toString("utf8")) as unknown);
  if (saved === null || !keys(saved, ["schemaVersion", ...FIELDS])
    || saved["schemaVersion"] !== CONFIG_VERSION
    || FIELDS.some((key) => saved[key] !== route[key])) throw new Error("config-changed");
  return { route, proof };
}
function originalFields(route: SpaRouteHealthConfig): Record<string, unknown> {
  const origin = new URL(route.baseUrl).origin;
  return {
    configSha256: digest(JSON.stringify(["spa-config/v1", origin, route.sourcePath,
      route.destinationPath, route.linkName, route.heading, route.expectedMainTextSha256])),
    sourceRouteSha256: digest(JSON.stringify(["spa-source/v1", origin, route.sourcePath])),
    destinationRouteSha256: digest(JSON.stringify(["spa-destination/v1", origin, route.destinationPath])),
    linkNameSha256: digest(JSON.stringify(["spa-link/v1", route.linkName])),
    headingSha256: digest(JSON.stringify(["spa-heading/v1", route.heading])),
    expectedMainTextSha256: route.expectedMainTextSha256,
  };
}
async function originalProof(root: string, sha256: string, route: SpaRouteHealthConfig): Promise<Proof> {
  if (!SHA.test(sha256)) throw new Error("invalid-original-pin");
  const proof = await pinned(join(root, "original.json"), MAX_ORIGINAL);
  if (proof.sha256 !== sha256) throw new Error("original-sha-changed");
  const json = object(JSON.parse(proof.bytes.toString("utf8")) as unknown);
  const expectation = originalFields(route);
  if (json === null || !keys(json, ["schemaVersion", "browserAuthority", "nonce",
    ...Object.keys(expectation), "sourceDocumentStatus", "sourceDocumentNavigations",
    "sourceSubstantiveMainObserved", "destinationBlankMainObserved", "sameDocument",
    "exactHistoryPushes", "noRedirectsOrBlockedRequests"])
    || json["schemaVersion"] !== ORIGINAL_VERSION
    || json["browserAuthority"] !== "isolated-chromium-source-get-and-history-push"
    || typeof json["nonce"] !== "string" || !/^[a-f0-9-]{36}$/u.test(json["nonce"])
    || Object.keys(expectation).some((key) => json[key] !== expectation[key])
    || json["sourceDocumentStatus"] !== 200 || json["sourceDocumentNavigations"] !== 1
    || json["sourceSubstantiveMainObserved"] !== true || json["destinationBlankMainObserved"] !== true
    || json["sameDocument"] !== true || json["exactHistoryPushes"] !== 1
    || json["noRedirectsOrBlockedRequests"] !== true) throw new Error("unproven-blank-original");
  return proof;
}
function jobRoot(root: string, id: string): boolean {
  return isPath(root) && UUID.test(id) && basename(root) === id;
}
/** Never trust a command status without its exact protected source witness. */
export async function inspectLocalSpaRouteHealthCapture(captureRoot: string, jobId: string,
  result: SpaRouteHealthCaptureResult | LocalSpaRouteHealthCommandCaptureResult,
  request: LocalSpaRouteHealthRequest, configSha256: string): Promise<PublicLocalSpaRouteHealthCapture | null> {
  try {
    if (!jobRoot(captureRoot, jobId)) return null;
    await directory(captureRoot);
    const { route, proof } = await configProof(captureRoot, jobId, request, configSha256);
    const command = result.schemaVersion === "tvdoctor.spa-route-health-command/v1";
    if (!command && result.schemaVersion !== "tvdoctor.spa-route-health-capture/v1") return null;
    const status = command ? result.status : result.classification;
    if (status !== "VERIFIED_ORIGINAL" && status !== "INCONCLUSIVE") return null;
    if (command && (result.exitCode !== (status === "VERIFIED_ORIGINAL" ? 1 : 3)
      || result.shouldFail !== true || result.regressionChecked !== false
      || (result.caveat !== undefined && typeof result.caveat !== "string"))) return null;
    if (status === "VERIFIED_ORIGINAL") {
      if (result.reason !== null || typeof result.originalSha256 !== "string"
        || (!command && result.originalPath !== join(captureRoot, "original.json"))) return null;
      const original = await originalProof(captureRoot, result.originalSha256, route);
      if (!await unchanged(proof) || !await unchanged(original)) return null;
      return { status: "VERIFIED_ORIGINAL", originalSha256: result.originalSha256,
        acceptReady: true, links: { original: `/reports/${jobId}/original.json` } };
    }
    if ((!command && result.originalPath !== null) || result.originalSha256 !== null
      || typeof result.reason !== "string" || !REASON.test(result.reason)
      || !await unchanged(proof)) return null;
    return { status: "INCONCLUSIVE", originalSha256: null, acceptReady: false, links: {} };
  } catch { return null; }
}

function validVerification(json: unknown, status: SpaRouteHealthAcceptResult["verification"]["status"],
  sourceSha256: string): boolean {
  const value = object(json);
  return value !== null && keys(value, [
    "schemaVersion", "classification", "originalSha256", "regressionChecked", "reason",
  ]) && value["schemaVersion"] === "tvdoctor.spa-route-health-verification/v1"
    && value["classification"] === status && value["originalSha256"] === sourceSha256
    && value["regressionChecked"] === false
    && (status === "INCONCLUSIVE" ? typeof value["reason"] === "string"
      && REASON.test(value["reason"]) : value["reason"] === null);
}
async function stageProof(acceptRoot: string, stage: "verification" | "post-regression-verification",
  value: SpaRouteHealthAcceptResult["verification"], originalSha256: string): Promise<Proof | null> {
  if (value.status === "NOT_RUN") {
    if (value.artifact !== null) throw new Error("unexpected-verification-artifact");
    return null;
  }
  if (!["ROUTE_CONTENT_RESTORED", "REPRODUCED", "INCONCLUSIVE"].includes(value.status)
    || value.artifact !== `${stage}/verification.json`) throw new Error("invalid-verification-path");
  await directory(join(acceptRoot, stage));
  const proof = await pinned(join(acceptRoot, stage, "verification.json"), MAX_VERIFY);
  if (!validVerification(JSON.parse(proof.bytes.toString("utf8")) as unknown, value.status, originalSha256)) {
    throw new Error("untrusted-verification");
  }
  return proof;
}
function validAcceptanceResult(value: SpaRouteHealthAcceptResult, sha256: string): boolean {
  const raw = object(value);
  if (raw === null || !keys(raw, ["schemaVersion", "status", "exitCode", "shouldFail",
    "originalSha256", "reason", "verification", "regression", "postRegressionVerification", "caveat"])
    || raw["schemaVersion"] !== "tvdoctor.spa-route-health-accept/v1"
    || value.originalSha256 !== sha256 || ![0, 1, 2, 3, 4].includes(value.exitCode)
    || value.shouldFail !== (value.exitCode !== 0)
    || !["ROUTE_CONTENT_RESTORED", "REPRODUCED", "NEW_VERIFIED", "INCONCLUSIVE", "ERROR"].includes(value.status)
    || (value.reason !== null && (typeof value.reason !== "string" || !REASON.test(value.reason)))
    || typeof value.caveat !== "string" || value.caveat.length < 32 || value.caveat.length > 2048
    || !value.caveat.includes("REVIEW")) return false;
  const verification = object(value.verification);
  const final = object(value.postRegressionVerification);
  const regression = object(value.regression);
  if (verification === null || final === null || regression === null
    || !keys(verification, ["status", "artifact"]) || !keys(final, ["status", "artifact"])
    || !keys(regression, ["status", "verified", "review", "untested", "reportSha256", "artifact"])
    || !["ROUTE_CONTENT_RESTORED", "REPRODUCED", "INCONCLUSIVE", "NOT_RUN"].includes(value.verification.status)
    || !["ROUTE_CONTENT_RESTORED", "REPRODUCED", "INCONCLUSIVE", "NOT_RUN"].includes(value.postRegressionVerification.status)
    || !["COMPLETED", "INCOMPLETE", "FAILED", "NOT_RUN"].includes(value.regression.status)
    || ![value.regression.verified, value.regression.review, value.regression.untested].every(num)) return false;
  if (value.status === "ROUTE_CONTENT_RESTORED") {
    return value.exitCode === 0 && value.reason === null
      && value.verification.status === "ROUTE_CONTENT_RESTORED"
      && value.verification.artifact === "verification/verification.json"
      && value.postRegressionVerification.status === "ROUTE_CONTENT_RESTORED"
      && value.postRegressionVerification.artifact === "post-regression-verification/verification.json"
      && value.regression.status === "COMPLETED" && value.regression.verified === 0
      && value.regression.artifact === "regression/qa-summary.json"
      && typeof value.regression.reportSha256 === "string" && SHA.test(value.regression.reportSha256);
  }
  if (value.status === "REPRODUCED") return value.exitCode === 1
    && (value.verification.status === "REPRODUCED"
      || value.postRegressionVerification.status === "REPRODUCED");
  if (value.status === "NEW_VERIFIED") return value.exitCode === 1
    && value.regression.status === "COMPLETED" && value.regression.verified > 0;
  return value.status === "ERROR" ? value.exitCode === 4
    : value.exitCode === 2 || value.exitCode === 3;
}
async function regressionProof(root: string, regression: SpaRouteHealthAcceptResult["regression"],
  sourceUrl: string): Promise<Proof[]> {
  if (regression.status === "NOT_RUN") {
    if (regression.artifact !== null || regression.reportSha256 !== null
      || regression.verified !== 0 || regression.review !== 0 || regression.untested !== 0) {
      throw new Error("unrun-regression-has-results");
    }
    return [];
  }
  if (regression.status === "FAILED") {
    if (regression.artifact !== null || regression.reportSha256 !== null
      || regression.verified !== 0 || regression.review !== 0 || regression.untested !== 0) {
      throw new Error("failed-regression-has-claimed-evidence");
    }
    return [];
  }
  if (regression.status !== "COMPLETED" && regression.status !== "INCOMPLETE") {
    throw new Error("unknown-regression-status");
  }
  // INCOMPLETE can still have a genuine saved QA report and SHA. Validate its
  // source/policy and publish a redacted INCONCLUSIVE status, never a positive.
  const complete = regression.status === "COMPLETED";
  if (regression.artifact !== "regression/qa-summary.json"
    || typeof regression.reportSha256 !== "string" || !SHA.test(regression.reportSha256)) {
    throw new Error("invalid-regression-reference");
  }
  await directory(join(root, "regression"));
  await directory(join(root, "regression", "original"));
  const qa = await pinned(join(root, "regression", "qa-summary.json"), MAX_QA);
  const original = await pinned(join(root, "regression", "original", "report.json"), MAX_REPORT);
  if (original.sha256 !== regression.reportSha256) throw new Error("source-report-pin-changed");
  const saved = object(JSON.parse(qa.bytes.toString("utf8")) as unknown);
  const report = parseTVDoctorReportJson(original.bytes.toString("utf8"));
  if (saved === null || saved["schemaVersion"] !== "tvdoctor.qa/v1"
    || saved["source"] !== "url" || saved["reason"] !== null
    || saved["exitCode"] !== (complete ? regression.verified > 0 ? 1 : 0 : 3)
    || saved["shouldFail"] !== (!complete || regression.verified > 0)
    || saved["originalPath"] !== original.path || saved["summaryPath"] !== qa.path
    || report.schemaVersion !== "tvdoctor.report/v1"
    || report.target.platform !== "web" || report.target.location !== sourceUrl
    || report.target.environment["browser"] !== "chromium"
    || report.target.environment["inputMode"] !== "keyboard"
    || report.target.environment["keyboardInteractions"] !== "disabled"
    || report.target.environment["safeLinkNavigation"] !== "disabled"
    || report.target.environment["journeyConfigSha256"] !== undefined
    || report.target.environment["authReadySha256"] !== undefined
    || report.run.mode !== "quick" || (complete && report.run.status !== "completed")) {
    throw new Error("qa-source-or-policy-invalid");
  }
  const policy = object(saved["scanPolicy"]);
  const summary = object(saved["summary"]);
  if (policy === null || summary === null
    || policy["schemaVersion"] !== "tvdoctor.qa-scan-policy/v1"
    || policy["mode"] !== "quick" || policy["failOn"] !== "any"
    || policy["safeInteractions"] !== false || policy["safeLinks"] !== false
    || policy["reportSha256"] !== original.sha256
    || summary["routes"] !== 1 || summary["incompleteRoutes"] !== (complete ? 0 : 1)
    || summary["verified"] !== regression.verified
    || summary["review"] !== regression.review || summary["untested"] !== regression.untested) {
    throw new Error("qa-count-or-policy-mismatch");
  }
  const expectedStatus = complete
    ? regression.verified > 0 ? "ACTION_REQUIRED"
      : regression.review > 0 ? "REVIEW_REQUIRED" : "NO_VERIFIED_FAILURES_IN_COVERAGE"
    : "INCONCLUSIVE";
  if (saved["status"] !== expectedStatus) throw new Error("qa-status-contradiction");
  const triage = await inspectReport(original.path, { maxFindings: 100 });
  if ((complete && triage.coverage.incomplete)
    || (!complete && report.run.status === "completed"
      && !triage.coverage.incomplete
      && triage.coverage.exhaustedBudgets.length === 0)
    || triage.coverage.packsOmitted !== 0
    || triage.summary.omitted !== 0 || triage.integrity.evidence === "degraded"
    || triage.integrity.evidence === "bounded"
    || triage.integrity.artifactsRejected !== 0 || triage.integrity.artifactsNotChecked !== 0
    || triage.summary.VERIFIED !== regression.verified
    || triage.summary.REVIEW !== regression.review
    || triage.summary.UNTESTED !== regression.untested
    || !(await unchanged(original))) throw new Error("qa-coverage-incomplete");
  return [qa, original];
}
/**
 * Revalidate every saved browser and QA artifact against a pinned original and
 * private authored config. No missing REVIEW issue or zero-findings scan
 * upgrades an SPA route to an accepted repair.
 */
export async function inspectLocalSpaRouteHealthAcceptance(
  acceptRoot: string, jobId: string, result: SpaRouteHealthAcceptResult,
  originalRoot: string, originalSha256: string, request: LocalSpaRouteHealthRequest,
  configSha256: string,
): Promise<PublicLocalSpaRouteHealthAcceptance | null> {
  try {
    if (!jobRoot(acceptRoot, jobId) || !isPath(originalRoot) || !SHA.test(originalSha256)
      || inside(acceptRoot, originalRoot) || inside(originalRoot, acceptRoot)
      || dirname(originalRoot) !== dirname(acceptRoot) || !UUID.test(basename(originalRoot))) return null;
    await directory(acceptRoot);
    await directory(originalRoot);
    const { route, proof: config } = await configProof(originalRoot, basename(originalRoot),
      request, configSha256);
    const original = await originalProof(originalRoot, originalSha256, route);
    if (!validAcceptanceResult(result, originalSha256)) return null;
    const summary = await pinned(join(acceptRoot, "spa-route-health-accept.json"), MAX_ACCEPT);
    const saved = JSON.parse(summary.bytes.toString("utf8")) as unknown;
    if (JSON.stringify(saved) !== JSON.stringify(result)) return null;
    const verification = await stageProof(acceptRoot, "verification", result.verification, originalSha256);
    const post = await stageProof(acceptRoot, "post-regression-verification",
      result.postRegressionVerification, originalSha256);
    const regression = await regressionProof(acceptRoot, result.regression,
      new URL(route.sourcePath, route.baseUrl).href);
    // Two independently saved positive Chromium checks + complete QA between
    // them are indispensable for a ROUTE_CONTENT_RESTORED result.
    if (result.status === "ROUTE_CONTENT_RESTORED"
      && (verification === null || post === null || regression.length !== 2
        || result.regression.verified !== 0)) return null;
    for (const proof of [config, original, summary, verification, post, ...regression]) {
      if (proof !== null && !await unchanged(proof)) return null;
    }
    // Re-evaluate the trust roots at the end, after reading QA and verification
    // artifacts, to reject changed config/source during inspection.
    const checked = await configProof(originalRoot, basename(originalRoot), request, configSha256);
    const checkedOriginal = await originalProof(originalRoot, originalSha256, checked.route);
    if (checked.proof.sha256 !== config.sha256 || checkedOriginal.sha256 !== original.sha256) return null;
    const links: Record<string, string> = {
      summary: `/reports/${jobId}/spa-route-health-accept.json`,
    };
    if (verification !== null) links["verification"] = `/reports/${jobId}/verification/verification.json`;
    if (post !== null) links["postRegressionVerification"] =
      `/reports/${jobId}/post-regression-verification/verification.json`;
    if (regression.length === 2) links["regression"] = `/reports/${jobId}/regression/qa-summary.json`;
    return { status: result.status, verification: result.verification,
      postRegressionVerification: result.postRegressionVerification,
      regression: result.regression, reason: result.reason, links };
  } catch { return null; }
}
