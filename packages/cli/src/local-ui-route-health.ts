import { createHash } from "node:crypto";
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseTVDoctorReportJson } from "@tvdoctor/protocol";
import { inspectReport } from "./node-triage.js";
import type {
  PublicRouteHealthCaptureResult, PublicRouteHealthRoute,
} from "./public-route-health.js";
import type { PublicRouteHealthAcceptResult } from "./public-route-health-accept.js";

const CONFIG_VERSION = "tvdoctor.public-route-health-config/v1";
const SOURCE_VERSION = "tvdoctor.public-route-health-original/v1";
const SHA = /^[a-f0-9]{64}$/u;
const JOB = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ROUTE = /^\/(?:[A-Za-z0-9_~.-]+(?:\/[A-Za-z0-9_~.-]+)*)?\/?$/u;
const NAME_UNSAFE = /[<>\p{Cc}\p{Cf}]|(?:https?:\/\/|www\.|javascript:|data:|@|\\)/iu;
const MAX_CONFIG = 4_096;
const MAX_ORIGINAL = 4_096;
const MAX_ACCEPT = 32 * 1024;
const MAX_VERIFY = 4_096;
const MAX_QA = 128 * 1024;
const MAX_REPORT = 16 * 1024 * 1024;

export interface LocalRouteHealthRequest extends PublicRouteHealthRoute {
  readonly baseUrl: string;
  readonly path: string;
  readonly heading: string;
  readonly expectedMainTextSha256: string;
  readonly authorized: true;
}

export class LocalRouteHealthRequestError extends Error {
  readonly statusCode: 400 | 403;
  readonly reason: "invalid-route-health-request" | "route-health-authorization-required";
  constructor(statusCode: 400 | 403) {
    const reason = statusCode === 403
      ? "route-health-authorization-required" : "invalid-route-health-request";
    super(reason);
    this.statusCode = statusCode;
    this.reason = reason;
  }
}

export interface LocalRouteHealthConfig {
  readonly configPath: string;
  readonly configSha256: string;
  readonly route: PublicRouteHealthRoute;
}

export interface PublicLocalRouteHealthCapture {
  readonly status: "VERIFIED_ORIGINAL" | "INCONCLUSIVE";
  readonly originalSha256: string | null;
  readonly acceptReady: boolean;
  readonly links: Readonly<Partial<Record<"original", string>>>;
}

/** Public dispatcher output, never a substitute for the owned source witness. */
export interface LocalRouteHealthCommandCaptureResult {
  readonly schemaVersion: "tvdoctor.public-route-health-command/v1";
  readonly status: "VERIFIED_ORIGINAL" | "INCONCLUSIVE";
  readonly exitCode: number;
  readonly shouldFail: boolean;
  readonly originalSha256: string | null;
  readonly regressionChecked: boolean;
  readonly reason: string | null;
}

export interface PublicLocalRouteHealthAcceptance {
  readonly status: PublicRouteHealthAcceptResult["status"];
  readonly verification: PublicRouteHealthAcceptResult["verification"];
  readonly postRegressionVerification: PublicRouteHealthAcceptResult["postRegressionVerification"];
  readonly regression: PublicRouteHealthAcceptResult["regression"];
  readonly reason: string | null;
  readonly links: Readonly<Partial<Record<"summary" | "verification" | "regression" | "postRegressionVerification", string>>>;
}

const digest = (bytes: Buffer | string): string =>
  createHash("sha256").update(bytes).digest("hex");

function object(value: unknown): Record<string, unknown> | null {
  return value === null || typeof value !== "object" || Array.isArray(value)
    ? null : value as Record<string, unknown>;
}
function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(record).sort().join("|") === [...keys].sort().join("|");
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value)
    && value >= 0 && value <= 100_000;
}
function within(root: string, path: string): boolean {
  const diff = relative(root, path);
  return diff === "" || diff !== ".." && !diff.startsWith(`..${sep}`) && !isAbsolute(diff);
}
function absolutePath(path: unknown): path is string {
  return typeof path === "string" && isAbsolute(path) && path.length <= 4_096
    && path.trim() === path && !path.includes("\0") && resolve(path) === path;
}
async function directory(path: string): Promise<string> {
  const absolute = resolve(path);
  const entry = await lstat(absolute);
  if (absolute !== path || !entry.isDirectory() || entry.isSymbolicLink()
    || await realpath(absolute) !== absolute) throw new Error("unsafe-directory");
  return absolute;
}
async function pinned(path: string, max: number): Promise<{ bytes: Buffer; sha256: string }> {
  const absolute = resolve(path);
  if (absolute !== path || max < 1) throw new Error("unsafe-evidence-path");
  await directory(dirname(path));
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1
    || before.size > max || await realpath(path) !== path) throw new Error("unsafe-evidence");
  const handle = await open(path, "r");
  let bytes: Buffer;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error("changed-evidence");
    }
    bytes = Buffer.alloc(before.size);
    for (let position = 0; position < bytes.length;) {
      const part = await handle.read(bytes, position, bytes.length - position, position);
      if (part.bytesRead < 1) throw new Error("truncated-evidence");
      position += part.bytesRead;
    }
  } finally { await handle.close(); }
  const after = await lstat(path);
  if (!after.isFile() || after.isSymbolicLink() || after.size !== before.size
    || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs) {
    throw new Error("changed-evidence");
  }
  return { bytes, sha256: digest(bytes) };
}

/**
 * Strict localhost POST boundary. Does not accept a client-provided report
 * path, SHA, mode, HTML, selector or an alternate origin as an implicit route.
 */
export function parseLocalRouteHealthRequest(value: unknown): LocalRouteHealthRequest {
  const input = object(value);
  if (input === null || input["authorized"] !== true) {
    if (input !== null && input["authorized"] !== undefined
      && input["authorized"] !== true) throw new LocalRouteHealthRequestError(403);
    throw new LocalRouteHealthRequestError(input === null ? 400 : 403);
  }
  if (!exactKeys(input, ["authorized", "baseUrl", "path", "heading", "expectedMainTextSha256"])) {
    throw new LocalRouteHealthRequestError(400);
  }
  const { baseUrl, path, heading, expectedMainTextSha256 } = input;
  if (typeof baseUrl !== "string" || baseUrl.length === 0 || baseUrl.length > 2048
    || typeof path !== "string" || path.length === 0 || path.length > 512
    || typeof heading !== "string" || heading.length < 1 || heading.length > 128
    || typeof expectedMainTextSha256 !== "string" || !SHA.test(expectedMainTextSha256)
    || !ROUTE.test(path) || path.split("/").some((part) => part === "." || part === "..")
    || NAME_UNSAFE.test(heading) || heading.trim() !== heading) {
    throw new LocalRouteHealthRequestError(400);
  }
  let origin: URL | null = null;
  try { origin = new URL(baseUrl); } catch { /* invalid user input */ }
  if (origin === null || (origin.protocol !== "http:" && origin.protocol !== "https:")
    || origin.username !== "" || origin.password !== ""
    || origin.search !== "" || origin.hash !== "" || origin.pathname !== "/"
    || origin.href !== `${origin.origin}/`
    || (baseUrl !== origin.origin && baseUrl !== origin.href)
    || new URL(path, origin).origin !== origin.origin
    || new URL(path, origin).pathname !== path) {
    throw new LocalRouteHealthRequestError(400);
  }
  return { baseUrl, path, heading, expectedMainTextSha256, authorized: true };
}

/**
 * Private config is a sibling of UUID job folders, never in /reports/<id>.
 * The returned digest MUST be held in server memory, not accepted from POST.
 */
export async function prepareLocalRouteHealthConfig(
  request: LocalRouteHealthRequest, outputRoot: string, jobId: string,
): Promise<LocalRouteHealthConfig> {
  if (!absolutePath(outputRoot) || !JOB.test(jobId)) throw new TypeError("invalid-route-health-config-options");
  const parsed = parseLocalRouteHealthRequest(request);
  const root = await directory(outputRoot);
  const privateRoot = join(root, ".route-health-configs");
  await mkdir(privateRoot, { mode: 0o700, recursive: true });
  await directory(privateRoot);
  const route: PublicRouteHealthRoute = { baseUrl: parsed.baseUrl, path: parsed.path,
    heading: parsed.heading, expectedMainTextSha256: parsed.expectedMainTextSha256 };
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: CONFIG_VERSION, ...route }) + "\n", "utf8");
  if (bytes.length > MAX_CONFIG) throw new TypeError("private-route-health-config-oversized");
  const configPath = join(privateRoot, `${jobId}.json`);
  await writeFile(configPath, bytes, { flag: "wx", mode: 0o600 });
  return { configPath, configSha256: digest(bytes), route };
}

async function configEvidence(
  jobRoot: string, jobId: string, request: LocalRouteHealthRequest, sha256: string,
): Promise<{ route: PublicRouteHealthRoute; url: string }> {
  if (!SHA.test(sha256) || !JOB.test(jobId) || !absolutePath(jobRoot)
    || basename(jobRoot) !== jobId) throw new Error("invalid-config-reference");
  const parent = await directory(dirname(jobRoot));
  const configRoot = await directory(join(parent, ".route-health-configs"));
  const source = await pinned(join(configRoot, `${jobId}.json`), MAX_CONFIG);
  if (source.sha256 !== sha256) throw new Error("changed-config");
  const parsed = parseLocalRouteHealthRequest(request);
  const json: unknown = JSON.parse(source.bytes.toString("utf8")) as unknown;
  const config = object(json);
  if (config === null || !exactKeys(config,
    ["schemaVersion", "baseUrl", "path", "heading", "expectedMainTextSha256"])
    || config["schemaVersion"] !== CONFIG_VERSION || config["baseUrl"] !== parsed.baseUrl
    || config["path"] !== parsed.path || config["heading"] !== parsed.heading
    || config["expectedMainTextSha256"] !== parsed.expectedMainTextSha256) {
    throw new Error("config-contract-drift");
  }
  return { route: { baseUrl: parsed.baseUrl, path: parsed.path, heading: parsed.heading,
    expectedMainTextSha256: parsed.expectedMainTextSha256 },
  url: new URL(parsed.path, parsed.baseUrl).href };
}

async function originalEvidence(root: string, originalSha256: string,
  route: PublicRouteHealthRoute): Promise<void> {
  if (!SHA.test(originalSha256)) throw new Error("missing-source-pin");
  const source = await pinned(join(root, "original.json"), MAX_ORIGINAL);
  if (source.sha256 !== originalSha256) throw new Error("original-witness-changed");
  const witness: unknown = JSON.parse(source.bytes.toString("utf8")) as unknown;
  const obj = object(witness);
  if (obj === null || !exactKeys(obj, [
    "schemaVersion", "source", "nonce", "routeSha256", "headingSha256",
    "expectedMainTextSha256", "originalStatus", "exactRoute", "redirects",
  ]) || obj["schemaVersion"] !== SOURCE_VERSION
    || obj["source"] !== "chromium-main-frame-document-get"
    || typeof obj["nonce"] !== "string" || !/^[a-f0-9-]{36}$/u.test(obj["nonce"])
    || (obj["originalStatus"] !== 404 && obj["originalStatus"] !== 410)
    || obj["exactRoute"] !== true || obj["redirects"] !== 0
    || obj["expectedMainTextSha256"] !== route.expectedMainTextSha256
    || obj["headingSha256"] !== digest(JSON.stringify(["heading", route.heading]))
    || obj["routeSha256"] !== digest(JSON.stringify([
      "public-document/v1", new URL(route.baseUrl).origin, route.path,
    ]))) throw new Error("invalid-source-witness");
}

function validJobRoot(path: string, jobId: string): boolean {
  return JOB.test(jobId) && absolutePath(path) && basename(path) === jobId;
}

/** Never accept result JSON alone: check canonical original.json + PRIVATE config pin. */
export async function inspectLocalRouteHealthCapture(
  captureRoot: string, jobId: string,
  result: PublicRouteHealthCaptureResult | LocalRouteHealthCommandCaptureResult,
  request: LocalRouteHealthRequest, configSha256: string,
): Promise<PublicLocalRouteHealthCapture | null> {
  try {
    if (!validJobRoot(captureRoot, jobId)) return null;
    await directory(captureRoot);
    const { route } = await configEvidence(captureRoot, jobId, request, configSha256);
    const command = result.schemaVersion === "tvdoctor.public-route-health-command/v1";
    if (!command && result.schemaVersion !== "tvdoctor.public-route-health-capture/v1") return null;
    const status = command ? result.status : result.classification;
    if (status !== "INCONCLUSIVE" && status !== "VERIFIED_ORIGINAL") return null;
    if (command && (result.exitCode !== (status === "VERIFIED_ORIGINAL" ? 1 : 3)
      || result.shouldFail !== true || result.regressionChecked !== false)) return null;
    if (status === "VERIFIED_ORIGINAL") {
      if (result.reason !== null || typeof result.originalSha256 !== "string"
        || (!command && result.originalPath !== join(captureRoot, "original.json"))) return null;
      await originalEvidence(captureRoot, result.originalSha256, route);
      return { status: "VERIFIED_ORIGINAL", originalSha256: result.originalSha256,
        acceptReady: true, links: { original: `/reports/${jobId}/original.json` } };
    }
    if ((!command && result.originalPath !== null) || result.originalSha256 !== null
      || typeof result.reason !== "string"
      || !/^[a-z][a-z0-9-]{0,127}$/u.test(result.reason)) return null;
    return { status: "INCONCLUSIVE", originalSha256: null, acceptReady: false, links: {} };
  } catch { return null; }
}

function validVerification(
  raw: unknown, sha256: string, expected: "FIXED" | "REPRODUCED" | "INCONCLUSIVE",
): boolean {
  const doc = object(raw);
  return doc !== null && exactKeys(doc, [
    "schemaVersion", "classification", "originalSha256", "regressionChecked", "reason",
  ]) && doc["schemaVersion"] === "tvdoctor.public-route-health-verification/v1"
    && doc["classification"] === expected && doc["originalSha256"] === sha256
    && doc["regressionChecked"] === false
    && (doc["reason"] === null || typeof doc["reason"] === "string"
      && /^[a-z][a-z0-9-]{0,127}$/u.test(doc["reason"]))
    && (expected === "INCONCLUSIVE" || doc["reason"] === null);
}

function validAcceptanceResult(value: PublicRouteHealthAcceptResult, sha256: string): boolean {
  const { verification, regression, postRegressionVerification } = value;
  if (value.schemaVersion !== "tvdoctor.public-route-health-accept/v1"
    || value.originalSha256 !== sha256
    || value.acceptancePath !== "route-health-accept.json"
    || value.shouldFail !== (value.exitCode !== 0)
    || !["ROUTE_RESTORED", "REPRODUCED", "NEW_VERIFIED", "INCONCLUSIVE", "ERROR"].includes(value.status)
    || ![0, 1, 2, 3, 4].includes(value.exitCode)
    || !["FIXED", "REPRODUCED", "INCONCLUSIVE", "NOT_RUN"].includes(verification.status)
    || !["FIXED", "REPRODUCED", "INCONCLUSIVE", "NOT_RUN"].includes(postRegressionVerification.status)
    || !["COMPLETED", "INCOMPLETE", "FAILED", "NOT_RUN"].includes(regression.status)
    || ![regression.verified, regression.review, regression.untested].every(count)
    || typeof value.caveat !== "string"
    || (value.reason !== null && (typeof value.reason !== "string"
      || !/^[a-z][a-z0-9-]{0,159}$/u.test(value.reason)))) return false;
  if (value.status === "ROUTE_RESTORED") {
    return value.exitCode === 0 && value.reason === null
      && verification.status === "FIXED"
      && verification.artifact === "verification/verification.json"
      && postRegressionVerification.status === "FIXED"
      && postRegressionVerification.artifact === "post-regression-verification/verification.json"
      && regression.status === "COMPLETED" && regression.verified === 0
      && regression.artifact === "regression/qa-summary.json"
      && typeof regression.reportSha256 === "string" && SHA.test(regression.reportSha256);
  }
  if (value.status === "REPRODUCED") {
    return value.exitCode === 1 && (verification.status === "REPRODUCED"
      || postRegressionVerification.status === "REPRODUCED");
  }
  if (value.status === "NEW_VERIFIED") {
    return value.exitCode === 1 && regression.status === "COMPLETED" && regression.verified > 0;
  }
  return value.status === "ERROR" ? value.exitCode === 4
    : value.exitCode === 2 || value.exitCode === 3;
}

async function verifiedStage(root: string, stage: "verification" | "post-regression-verification",
  status: PublicRouteHealthAcceptResult["verification"]["status"], artifact: string | null,
  originalSha256: string): Promise<boolean> {
  if (status === "NOT_RUN") return artifact === null;
  if (artifact !== `${stage}/verification.json`) return false;
  await directory(join(root, stage));
  const source = await pinned(join(root, stage, "verification.json"), MAX_VERIFY);
  return validVerification(JSON.parse(source.bytes.toString("utf8")) as unknown,
    originalSha256, status);
}

async function checkedRegression(root: string, result: PublicRouteHealthAcceptResult["regression"],
  target: string): Promise<boolean> {
  if (result.status === "NOT_RUN") return result.artifact === null
    && result.reportSha256 === null && result.verified === 0
    && result.review === 0 && result.untested === 0;
  if (result.status !== "COMPLETED") return result.artifact === null
    || result.artifact === "regression/qa-summary.json";
  if (result.artifact !== "regression/qa-summary.json"
    || typeof result.reportSha256 !== "string" || !SHA.test(result.reportSha256)) return false;
  await directory(join(root, "regression"));
  await directory(join(root, "regression", "original"));
  const saved = await pinned(join(root, "regression", "qa-summary.json"), MAX_QA);
  const source = await pinned(join(root, "regression", "original", "report.json"), MAX_REPORT);
  if (source.sha256 !== result.reportSha256) return false;
  const qa = object(JSON.parse(saved.bytes.toString("utf8")) as unknown);
  const report = parseTVDoctorReportJson(source.bytes.toString("utf8"));
  if (qa === null || qa["schemaVersion"] !== "tvdoctor.qa/v1" || qa["source"] !== "url"
    || qa["reason"] !== null || qa["exitCode"] !== (result.verified > 0 ? 1 : 0)
    || qa["shouldFail"] !== (result.verified > 0)
    || qa["originalPath"] !== join(root, "regression", "original", "report.json")
    || qa["summaryPath"] !== join(root, "regression", "qa-summary.json")
    || report.schemaVersion !== "tvdoctor.report/v1"
    || report.target.platform !== "web" || report.target.location !== target
    || report.target.environment["browser"] !== "chromium"
    || report.target.environment["inputMode"] !== "keyboard"
    || report.target.environment["keyboardInteractions"] !== "disabled"
    || report.target.environment["safeLinkNavigation"] !== "disabled"
    || report.target.environment["journeyConfigSha256"] !== undefined
    || report.target.environment["authReadySha256"] !== undefined
    || report.run.mode !== "quick" || report.run.status !== "completed") return false;
  const policy = object(qa["scanPolicy"]);
  const summary = object(qa["summary"]);
  if (policy === null || summary === null
    || policy["schemaVersion"] !== "tvdoctor.qa-scan-policy/v1"
    || policy["mode"] !== "quick" || policy["failOn"] !== "any"
    || policy["safeInteractions"] !== false || policy["safeLinks"] !== false
    || policy["reportSha256"] !== source.sha256
    || summary["routes"] !== 1 || summary["incompleteRoutes"] !== 0
    || summary["verified"] !== result.verified || summary["review"] !== result.review
    || summary["untested"] !== result.untested) return false;
  const triage = await inspectReport(join(root, "regression", "original", "report.json"), { maxFindings: 100 });
  if (triage.coverage.incomplete || triage.coverage.packsOmitted !== 0
    || triage.summary.omitted !== 0 || triage.integrity.evidence === "degraded"
    || triage.integrity.evidence === "bounded"
    || triage.integrity.artifactsRejected !== 0 || triage.integrity.artifactsNotChecked !== 0
    || triage.summary.VERIFIED !== result.verified || triage.summary.REVIEW !== result.review
    || triage.summary.UNTESTED !== result.untested) return false;
  return (await pinned(join(root, "regression", "original", "report.json"), MAX_REPORT)).sha256
    === source.sha256;
}

/**
 * Validate the FULL saved acceptance from its ORIGINAL pinned source. All
 * browser and QA callbacks have already run; this observer does not run them.
 * Never infer successful repair from JSON alone or from zero QA findings.
 */
export async function inspectLocalRouteHealthAcceptance(
  acceptRoot: string, jobId: string, result: PublicRouteHealthAcceptResult,
  originalRoot: string, originalSha256: string, request: LocalRouteHealthRequest,
  configSha256: string,
): Promise<PublicLocalRouteHealthAcceptance | null> {
  try {
    if (!validJobRoot(acceptRoot, jobId) || !absolutePath(originalRoot)
      || !SHA.test(originalSha256)
      || within(acceptRoot, originalRoot) || within(originalRoot, acceptRoot)) return null;
    await directory(acceptRoot);
    await directory(originalRoot);
    // The trusted config was written for the ORIGINAL capture job, not for the
    // distinct acceptance job. Never silently replace that original config.
    const sourceId = basename(originalRoot);
    if (!JOB.test(sourceId) || dirname(originalRoot) !== dirname(acceptRoot)) return null;
    const { route, url } = await configEvidence(originalRoot, sourceId, request, configSha256);
    await originalEvidence(originalRoot, originalSha256, route);
    if (!validAcceptanceResult(result, originalSha256)) return null;
    const summary = await pinned(join(acceptRoot, "route-health-accept.json"), MAX_ACCEPT);
    const saved = JSON.parse(summary.bytes.toString("utf8")) as unknown;
    if (JSON.stringify(saved) !== JSON.stringify(result)) return null;
    if (!await verifiedStage(acceptRoot, "verification", result.verification.status,
      result.verification.artifact, originalSha256)
      || !await verifiedStage(acceptRoot, "post-regression-verification",
        result.postRegressionVerification.status, result.postRegressionVerification.artifact,
        originalSha256)
      || !await checkedRegression(acceptRoot, result.regression, url)) return null;
    await originalEvidence(originalRoot, originalSha256, route);
    if ((await pinned(join(acceptRoot, "route-health-accept.json"), MAX_ACCEPT)).sha256
      !== summary.sha256
      || (await configEvidence(originalRoot, sourceId, request, configSha256)).url !== url) return null;
    const links: Record<string, string> = { summary: `/reports/${jobId}/route-health-accept.json` };
    if (result.verification.artifact !== null) {
      links["verification"] = `/reports/${jobId}/verification/verification.json`;
    }
    if (result.postRegressionVerification.artifact !== null) {
      links["postRegressionVerification"] =
        `/reports/${jobId}/post-regression-verification/verification.json`;
    }
    if (result.regression.artifact !== null && result.regression.status === "COMPLETED") {
      links["regression"] = `/reports/${jobId}/regression/qa-summary.json`;
    }
    return { status: result.status, verification: result.verification,
      postRegressionVerification: result.postRegressionVerification,
      regression: result.regression, reason: result.reason, links };
  } catch { return null; }
}
