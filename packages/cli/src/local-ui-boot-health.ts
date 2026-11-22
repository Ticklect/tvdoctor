import { createHash } from "node:crypto";
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseTVDoctorReportJson } from "@tvdoctor/protocol";
import { renderAgentRepairBrief } from "./agent-repair-brief.js";
import { createFirstRunHandoff } from "./first-run-handoff.js";
import { inspectReport } from "./node-triage.js";

const CONFIG_VERSION = "tvdoctor.boot-health-config/v1";
const ORIGINAL_VERSION = "tvdoctor.boot-health-original/v1";
const VERIFY_VERSION = "tvdoctor.boot-health-verification/v1";
const ACCEPT_VERSION = "tvdoctor.boot-health-accept/v1";
const SHA = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ROUTE = /^\/(?:[A-Za-z0-9_~.-]+(?:\/[A-Za-z0-9_~.-]+)*)?\/?$/u;
const MUTATION = /(?:^|\/)(?:api|auth|login|logout|signin|signout|account|user|users|admin|checkout|cart|buy|purchase|pay|payment|subscribe|delete|remove|create|edit|save|update|upload|submit|send|approve|revoke|reset|transfer|order)(?:\/|$)/iu;
const UNSAFE_HEADING = /[<>\\@\p{Cc}\p{Cf}]|(?:https?:\/\/|www\.|javascript:|data:|\b(?:password|secret|token|credential|apikey|api.key|private.key)\b)/iu;
const REASON = /^[a-z][a-z0-9-]{0,159}$/u;
const FIELDS = ["baseUrl", "path", "heading", "expectedMainTextSha256"] as const;
const MAX_CONFIG = 4096;
const MAX_ORIGINAL = 4096;
const MAX_VERIFY = 4096;
const MAX_ACCEPT = 32 * 1024;
const MAX_QA = 128 * 1024;
const MAX_REPORT = 16 * 1024 * 1024;

export interface LocalBootHealthRequest {
  readonly authorized: true;
  readonly baseUrl: string;
  readonly path: string;
  readonly heading: string;
  readonly expectedMainTextSha256: string;
}

export class LocalBootHealthRequestError extends Error {
  readonly statusCode: 400 | 403;
  readonly reason: "invalid-boot-health-request" | "boot-health-authorization-required";
  constructor(statusCode: 400 | 403) {
    const reason = statusCode === 403
      ? "boot-health-authorization-required" : "invalid-boot-health-request";
    super(reason);
    this.statusCode = statusCode;
    this.reason = reason;
  }
}

export interface LocalBootHealthConfig {
  readonly configPath: string;
  readonly configSha256: string;
  readonly route: Omit<LocalBootHealthRequest, "authorized">;
}

export interface PublicLocalBootHealthCapture {
  readonly status: "VERIFIED_ORIGINAL" | "INCONCLUSIVE";
  readonly originalSha256: string | null;
  readonly acceptReady: boolean;
  readonly links: Readonly<Partial<Record<"original", string>>>;
}

export interface PublicLocalBootHealthAcceptance {
  readonly status: "PAGE_CONTENT_RESTORED" | "REPRODUCED" | "NEW_VERIFIED" | "INCONCLUSIVE" | "ERROR";
  readonly verification: Readonly<{ status: string; artifact: string | null }>;
  readonly postRegressionVerification: Readonly<{ status: string; artifact: string | null }>;
  readonly regression: Readonly<{ status: string; verified: number; review: number; untested: number;
    reportSha256: string | null; artifact: string | null }>;
  readonly reason: string | null;
  readonly links: Readonly<Partial<Record<"summary" | "verification" | "regression" | "postRegressionVerification", string>>>;
}

const sha = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
function object(value: unknown): Record<string, unknown> | null {
  return value === null || typeof value !== "object" || Array.isArray(value)
    ? null : value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("|") === [...expected].sort().join("|");
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 100_000;
}
function canonicalPath(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value) && value.length <= 4096
    && value.trim() === value && !value.includes("\0") && resolve(value) === value;
}
function inside(parent: string, child: string): boolean {
  const remainder = relative(parent, child);
  return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${sep}`)
    && !isAbsolute(remainder));
}
async function directory(path: string): Promise<string> {
  if (!canonicalPath(path)) throw new Error("noncanonical-directory");
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) {
    throw new Error("unsafe-directory");
  }
  return path;
}
interface Proof { readonly path: string; readonly sha256: string; readonly bytes: Buffer; readonly length: number }
async function pinned(path: string, max: number): Promise<Proof> {
  if (!canonicalPath(path)) throw new Error("noncanonical-evidence");
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
    for (let index = 0; index < bytes.length;) {
      const next = await handle.read(bytes, index, bytes.length - index, index);
      if (next.bytesRead < 1) throw new Error("truncated-evidence");
      index += next.bytesRead;
    }
  } finally { await handle.close(); }
  const after = await lstat(path);
  if (!after.isFile() || after.isSymbolicLink() || after.ino !== before.ino
    || after.size !== before.size || after.mtimeMs !== before.mtimeMs
    || await realpath(path) !== path) throw new Error("changed-evidence");
  return { path, sha256: sha(bytes), bytes, length: bytes.length };
}
async function unchanged(source: Proof): Promise<boolean> {
  try {
    const fresh = await pinned(source.path, source.length);
    return fresh.sha256 === source.sha256 && fresh.length === source.length;
  } catch { return false; }
}

/** The local UI accepts only an authorized, exact, public GET URL. */
export function parseLocalBootHealthRequest(value: unknown): LocalBootHealthRequest {
  const input = object(value);
  if (input === null) throw new LocalBootHealthRequestError(400);
  if (input["authorized"] !== true) throw new LocalBootHealthRequestError(403);
  if (!exact(input, ["authorized", ...FIELDS])) throw new LocalBootHealthRequestError(400);
  const { baseUrl, path, heading, expectedMainTextSha256 } = input;
  if (typeof baseUrl !== "string" || baseUrl.length < 1 || baseUrl.length > 2048
    || typeof path !== "string" || path.length < 1 || path.length > 512
    || !ROUTE.test(path) || path.split("/").some((part) => part === "." || part === "..")
    || MUTATION.test(path)
    || typeof heading !== "string" || heading.length < 1 || heading.length > 128
    || heading !== heading.trim() || UNSAFE_HEADING.test(heading)
    || typeof expectedMainTextSha256 !== "string" || !SHA.test(expectedMainTextSha256)) {
    throw new LocalBootHealthRequestError(400);
  }
  let url: URL | null = null;
  try { url = new URL(baseUrl); } catch { /* invalid URL */ }
  if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username !== "" || url.password !== "" || url.pathname !== "/"
    || url.search !== "" || url.hash !== "" || url.href !== `${url.origin}/`
    || (baseUrl !== url.origin && baseUrl !== url.href)
    || new URL(path, url).origin !== url.origin
    || new URL(path, url).pathname !== path) throw new LocalBootHealthRequestError(400);
  return { authorized: true, baseUrl, path, heading, expectedMainTextSha256 };
}

function route(request: LocalBootHealthRequest): LocalBootHealthConfig["route"] {
  return { baseUrl: request.baseUrl, path: request.path, heading: request.heading,
    expectedMainTextSha256: request.expectedMainTextSha256 };
}

/** Kept outside public report roots; new files are never overwritten. */
export async function prepareLocalBootHealthConfig(request: LocalBootHealthRequest,
  outputRoot: string, jobId: string): Promise<LocalBootHealthConfig> {
  if (!canonicalPath(outputRoot) || !UUID.test(jobId)) {
    throw new TypeError("invalid-boot-health-config-options");
  }
  const parsed = route(parseLocalBootHealthRequest(request));
  const root = await directory(outputRoot);
  const privateRoot = join(root, ".boot-health-configs");
  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  await directory(privateRoot);
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: CONFIG_VERSION, ...parsed }) + "\n", "utf8");
  if (bytes.length > MAX_CONFIG) throw new TypeError("oversized-boot-health-config");
  const configPath = join(privateRoot, `${jobId}.json`);
  await writeFile(configPath, bytes, { flag: "wx", mode: 0o600 });
  return { configPath, configSha256: sha(bytes), route: parsed };
}

async function configProof(root: string, jobId: string, request: LocalBootHealthRequest,
  sha256: string): Promise<{ route: LocalBootHealthConfig["route"]; proof: Proof }> {
  if (!canonicalPath(root) || basename(root) !== jobId || !UUID.test(jobId)
    || !SHA.test(sha256)) throw new Error("invalid-config-reference");
  const parent = await directory(dirname(root));
  const privateRoot = await directory(join(parent, ".boot-health-configs"));
  const proof = await pinned(join(privateRoot, `${jobId}.json`), MAX_CONFIG);
  if (proof.sha256 !== sha256) throw new Error("changed-config-pin");
  const parsed = route(parseLocalBootHealthRequest(request));
  const saved = object(JSON.parse(proof.bytes.toString("utf8")) as unknown);
  if (saved === null || !exact(saved, ["schemaVersion", ...FIELDS])
    || saved["schemaVersion"] !== CONFIG_VERSION
    || FIELDS.some((field) => saved[field] !== parsed[field])) throw new Error("config-changed");
  return { route: parsed, proof };
}

interface BootCaptureResult {
  readonly schemaVersion: "tvdoctor.boot-health-capture/v1";
  readonly classification: "VERIFIED_ORIGINAL" | "INCONCLUSIVE";
  readonly originalPath: string | null;
  readonly originalSha256: string | null;
  readonly reason: string | null;
}
interface BootCommandCaptureResult {
  readonly schemaVersion: "tvdoctor.boot-health-command/v1";
  readonly status: "VERIFIED_ORIGINAL" | "INCONCLUSIVE";
  readonly exitCode: number;
  readonly shouldFail: boolean;
  readonly originalSha256: string | null;
  readonly regressionChecked: boolean;
  readonly reason: string | null;
  readonly caveat?: string;
}

interface Stage { readonly status: "PAGE_CONTENT_RESTORED" | "REPRODUCED" | "INCONCLUSIVE" | "NOT_RUN";
  readonly artifact: string | null }
interface Regression { readonly status: "COMPLETED" | "INCOMPLETE" | "FAILED" | "NOT_RUN";
  readonly verified: number; readonly review: number; readonly untested: number;
  readonly reportSha256: string | null; readonly artifact: string | null }
interface BootAcceptResult {
  readonly schemaVersion: "tvdoctor.boot-health-accept/v1";
  readonly status: PublicLocalBootHealthAcceptance["status"];
  readonly exitCode: number;
  readonly shouldFail: boolean;
  readonly originalSha256: string | null;
  readonly reason: string | null;
  readonly verification: Stage;
  readonly regression: Regression;
  readonly postRegressionVerification: Stage;
  readonly caveat: string;
}

function originalFields(config: LocalBootHealthConfig["route"]): Record<string, unknown> {
  const origin = new URL(config.baseUrl).origin;
  return {
    configSha256: sha(JSON.stringify(["boot-config/v1", origin, config.path,
      config.heading, config.expectedMainTextSha256])),
    routeSha256: sha(JSON.stringify(["boot-document/v1", origin, config.path])),
    headingSha256: sha(JSON.stringify(["boot-heading/v1", config.heading])),
    expectedMainTextSha256: config.expectedMainTextSha256,
  };
}

async function originalProof(root: string, expectedSha256: string,
  route: LocalBootHealthConfig["route"]): Promise<Proof> {
  if (!SHA.test(expectedSha256)) throw new Error("invalid-original-pin");
  const proof = await pinned(join(root, "original.json"), MAX_ORIGINAL);
  if (proof.sha256 !== expectedSha256) throw new Error("changed-original-pin");
  const original = object(JSON.parse(proof.bytes.toString("utf8")) as unknown);
  const fields = originalFields(route);
  if (original === null || !exact(original, ["schemaVersion", "browserAuthority", "nonce",
    ...Object.keys(fields), "sourceDocumentStatus", "sourceDocumentNavigations", "blankMainObserved",
    "settledSamples", "hydrationGraceMs", "noRedirects"])
    || original["schemaVersion"] !== ORIGINAL_VERSION
    || original["browserAuthority"] !== "isolated-chromium-exact-public-document-get"
    || typeof original["nonce"] !== "string" || !UUID.test(original["nonce"])
    || Object.keys(fields).some((key) => original[key] !== fields[key])
    || original["sourceDocumentStatus"] !== 200
    || original["sourceDocumentNavigations"] !== 1
    || original["blankMainObserved"] !== true
    || original["settledSamples"] !== 3
    || original["hydrationGraceMs"] !== 1800
    || original["noRedirects"] !== true) {
    throw new Error("unproven-original-blank-main");
  }
  return proof;
}

function validJobRoot(root: string, id: string): boolean {
  return canonicalPath(root) && UUID.test(id) && basename(root) === id;
}

/** A claim about blank MAIN is only published with an exact saved browser witness. */
export async function inspectLocalBootHealthCapture(
  captureRoot: string, jobId: string,
  result: BootCaptureResult | BootCommandCaptureResult,
  request: LocalBootHealthRequest, configSha256: string,
): Promise<PublicLocalBootHealthCapture | null> {
  try {
    if (!validJobRoot(captureRoot, jobId)) return null;
    await directory(captureRoot);
    const { route: config, proof } = await configProof(captureRoot, jobId, request, configSha256);
    const command = result.schemaVersion === "tvdoctor.boot-health-command/v1";
    if (!command && result.schemaVersion !== "tvdoctor.boot-health-capture/v1") return null;
    const status = command ? result.status : result.classification;
    if (status !== "VERIFIED_ORIGINAL" && status !== "INCONCLUSIVE") return null;
    if (command && (result.exitCode !== (status === "VERIFIED_ORIGINAL" ? 1 : 3)
      || result.shouldFail !== true || result.regressionChecked !== false
      || (result.caveat !== undefined && (typeof result.caveat !== "string"
        || result.caveat.length > 2048)))) return null;
    if (status === "VERIFIED_ORIGINAL") {
      if (result.reason !== null || typeof result.originalSha256 !== "string"
        || (!command && result.originalPath !== join(captureRoot, "original.json"))) return null;
      const original = await originalProof(captureRoot, result.originalSha256, config);
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

function validStage(value: unknown, name: "verification" | "post-regression-verification"): value is Stage {
  const stage = object(value);
  return stage !== null && exact(stage, ["status", "artifact"])
    && typeof stage["status"] === "string"
    && ["PAGE_CONTENT_RESTORED", "REPRODUCED", "INCONCLUSIVE", "NOT_RUN"].includes(stage["status"])
    && stage["artifact"] === (stage["status"] === "NOT_RUN" ? null : `${name}/verification.json`);
}
function validRegression(value: unknown): value is Regression {
  const regression = object(value);
  return regression !== null && exact(regression, ["status", "verified", "review", "untested",
    "reportSha256", "artifact"])
    && typeof regression["status"] === "string"
    && ["COMPLETED", "INCOMPLETE", "FAILED", "NOT_RUN"].includes(regression["status"])
    && [regression["verified"], regression["review"], regression["untested"]].every(count)
    && (regression["status"] === "COMPLETED" || regression["status"] === "INCOMPLETE"
      ? regression["artifact"] === "regression/qa-summary.json"
        && typeof regression["reportSha256"] === "string" && SHA.test(regression["reportSha256"])
      : regression["artifact"] === null && regression["reportSha256"] === null
        && regression["verified"] === 0 && regression["review"] === 0
        && regression["untested"] === 0);
}

function validAcceptance(value: BootAcceptResult, originalSha256: string): boolean {
  const raw = object(value);
  if (raw === null || !exact(raw, ["schemaVersion", "status", "exitCode", "shouldFail",
    "originalSha256", "reason", "verification", "regression", "postRegressionVerification", "caveat"])
    || value.schemaVersion !== ACCEPT_VERSION || value.originalSha256 !== originalSha256
    || !["PAGE_CONTENT_RESTORED", "REPRODUCED", "NEW_VERIFIED", "INCONCLUSIVE", "ERROR"].includes(value.status)
    || ![0, 1, 2, 3, 4].includes(value.exitCode)
    || value.shouldFail !== (value.exitCode !== 0)
    || (value.reason !== null && (typeof value.reason !== "string" || !REASON.test(value.reason)))
    || typeof value.caveat !== "string" || !value.caveat.includes("REVIEW")
    || value.caveat.length < 32 || value.caveat.length > 2048
    || !validStage(value.verification, "verification")
    || !validStage(value.postRegressionVerification, "post-regression-verification")
    || !validRegression(value.regression)) return false;
  if (value.status === "PAGE_CONTENT_RESTORED") return value.exitCode === 0
    && value.reason === null && value.verification.status === "PAGE_CONTENT_RESTORED"
    && value.postRegressionVerification.status === "PAGE_CONTENT_RESTORED"
    && value.regression.status === "COMPLETED" && value.regression.verified === 0;
  if (value.status === "REPRODUCED") return value.exitCode === 1
    && (value.verification.status === "REPRODUCED"
      && value.regression.status === "NOT_RUN"
      && value.postRegressionVerification.status === "NOT_RUN"
      || value.verification.status === "PAGE_CONTENT_RESTORED"
        && value.regression.status === "COMPLETED"
        && value.regression.verified === 0
        && value.postRegressionVerification.status === "REPRODUCED");
  if (value.status === "NEW_VERIFIED") return value.exitCode === 1
    && value.verification.status === "PAGE_CONTENT_RESTORED"
    && value.regression.status === "COMPLETED" && value.regression.verified > 0
    && value.postRegressionVerification.status === "NOT_RUN";
  return value.status === "ERROR" ? value.exitCode === 4
    : value.exitCode === 2 || value.exitCode === 3;
}

async function verifiedStage(root: string, name: "verification" | "post-regression-verification",
  stage: Stage, originalSha256: string): Promise<Proof | null> {
  if (stage.status === "NOT_RUN") return null;
  await directory(join(root, name));
  const proof = await pinned(join(root, name, "verification.json"), MAX_VERIFY);
  const value = object(JSON.parse(proof.bytes.toString("utf8")) as unknown);
  if (value === null || !exact(value, ["schemaVersion", "classification", "originalSha256",
    "regressionChecked", "reason"])
    || value["schemaVersion"] !== VERIFY_VERSION || value["classification"] !== stage.status
    || value["originalSha256"] !== originalSha256 || value["regressionChecked"] !== false
    || (stage.status === "INCONCLUSIVE" ? typeof value["reason"] !== "string"
      || !REASON.test(value["reason"]) : value["reason"] !== null)) {
    throw new Error("untrusted-browser-verification");
  }
  return proof;
}

/** Recompute QA findings and coverage from the actual saved source report. */
async function regressionProof(root: string, regression: Regression, targetUrl: string): Promise<Proof[]> {
  if (regression.status === "NOT_RUN" || regression.status === "FAILED") return [];
  const complete = regression.status === "COMPLETED";
  await directory(join(root, "regression"));
  await directory(join(root, "regression", "original"));
  const summary = await pinned(join(root, "regression", "qa-summary.json"), MAX_QA);
  const original = await pinned(join(root, "regression", "original", "report.json"), MAX_REPORT);
  const handoff = await pinned(join(root, "regression", "handoff.json"), 256 * 1024);
  const brief = await pinned(join(root, "regression", "AGENT_REPAIR_BRIEF.md"), 64 * 1024);
  if (original.sha256 !== regression.reportSha256) throw new Error("changed-qa-source-pin");
  const qa = object(JSON.parse(summary.bytes.toString("utf8")) as unknown);
  const report = parseTVDoctorReportJson(original.bytes.toString("utf8"));
  if (qa === null || qa["schemaVersion"] !== "tvdoctor.qa/v1"
    || qa["source"] !== "url" || qa["reason"] !== null
    || qa["exitCode"] !== (complete ? regression.verified > 0 ? 1 : 0 : 3)
    || qa["shouldFail"] !== (!complete || regression.verified > 0)
    || qa["originalPath"] !== original.path || qa["summaryPath"] !== summary.path
    || qa["handoffPath"] !== handoff.path || qa["agentBriefPath"] !== brief.path
    || report.schemaVersion !== "tvdoctor.report/v1"
    || report.target.platform !== "web" || report.target.location !== targetUrl
    || report.target.environment["browser"] !== "chromium"
    || report.target.environment["inputMode"] !== "keyboard"
    || report.target.environment["keyboardInteractions"] !== "disabled"
    || report.target.environment["safeLinkNavigation"] !== "disabled"
    || report.target.environment["journeyConfigSha256"] !== undefined
    || report.target.environment["authReadySha256"] !== undefined
    || report.run.mode !== "quick"
    || (complete && report.run.status !== "completed")) {
    throw new Error("qa-source-or-policy-invalid");
  }
  const policy = object(qa["scanPolicy"]);
  const counts = object(qa["summary"]);
  if (policy === null || counts === null
    || policy["schemaVersion"] !== "tvdoctor.qa-scan-policy/v1"
    || policy["mode"] !== "quick" || policy["failOn"] !== "any"
    || policy["safeInteractions"] !== false || policy["safeLinks"] !== false
    || policy["reportSha256"] !== original.sha256
    || counts["routes"] !== 1 || counts["incompleteRoutes"] !== (complete ? 0 : 1)
    || counts["verified"] !== regression.verified
    || counts["review"] !== regression.review || counts["untested"] !== regression.untested) {
    throw new Error("qa-count-or-policy-invalid");
  }
  const expectedStatus = complete
    ? regression.verified > 0 ? "ACTION_REQUIRED"
      : regression.review > 0 ? "REVIEW_REQUIRED" : "NO_VERIFIED_FAILURES_IN_COVERAGE"
    : "INCONCLUSIVE";
  if (qa["status"] !== expectedStatus) throw new Error("qa-summary-status-invalid");
  const triage = await inspectReport(original.path, { maxFindings: 100 });
  if ((complete && triage.coverage.incomplete)
    || (!complete && report.run.status === "completed"
      && !triage.coverage.incomplete && triage.coverage.exhaustedBudgets.length === 0)
    || triage.coverage.packsOmitted !== 0 || triage.summary.omitted !== 0
    || triage.integrity.evidence === "degraded" || triage.integrity.evidence === "bounded"
    || triage.integrity.artifactsRejected !== 0 || triage.integrity.artifactsNotChecked !== 0
    || triage.summary.VERIFIED !== regression.verified
    || triage.summary.REVIEW !== regression.review
    || triage.summary.UNTESTED !== regression.untested) throw new Error("qa-coverage-invalid");
  const derivedHandoff = await createFirstRunHandoff({ reportPath: original.path });
  if (JSON.stringify(JSON.parse(handoff.bytes.toString("utf8")) as unknown)
    !== JSON.stringify(derivedHandoff)
    || brief.bytes.toString("utf8") !== renderAgentRepairBrief(derivedHandoff)
    || JSON.stringify(counts) !== JSON.stringify(derivedHandoff.summary)
    || qa["status"] !== derivedHandoff.status) throw new Error("qa-handoff-invalid");
  return [summary, original, handoff, brief];
}

/**
 * Recheck the exact original, both independently saved Chromium results,
 * and the actual policy/coverage/source of the intervening fresh QA scan.
 * A partial scan is an INCONCLUSIVE result and never a repaired page.
 */
export async function inspectLocalBootHealthAcceptance(
  acceptRoot: string, jobId: string, result: BootAcceptResult,
  originalRoot: string, originalSha256: string, request: LocalBootHealthRequest,
  configSha256: string,
): Promise<PublicLocalBootHealthAcceptance | null> {
  try {
    if (!validJobRoot(acceptRoot, jobId) || !canonicalPath(originalRoot)
      || !UUID.test(basename(originalRoot)) || !SHA.test(originalSha256)
      || inside(acceptRoot, originalRoot) || inside(originalRoot, acceptRoot)
      || dirname(acceptRoot) !== dirname(originalRoot)) return null;
    await directory(acceptRoot);
    await directory(originalRoot);
    const sourceId = basename(originalRoot);
    const { route: authored, proof: config } = await configProof(originalRoot, sourceId,
      request, configSha256);
    const original = await originalProof(originalRoot, originalSha256, authored);
    if (!validAcceptance(result, originalSha256)) return null;
    const summary = await pinned(join(acceptRoot, "boot-health-accept.json"), MAX_ACCEPT);
    if (JSON.stringify(JSON.parse(summary.bytes.toString("utf8")) as unknown)
      !== JSON.stringify(result)) return null;
    const verification = await verifiedStage(acceptRoot, "verification",
      result.verification, originalSha256);
    const final = await verifiedStage(acceptRoot, "post-regression-verification",
      result.postRegressionVerification, originalSha256);
    const qa = await regressionProof(acceptRoot, result.regression,
      new URL(authored.path, authored.baseUrl).href);
    if (result.status === "PAGE_CONTENT_RESTORED"
      && (verification === null || final === null || qa.length !== 4
        || result.regression.status !== "COMPLETED" || result.regression.verified !== 0)) return null;
    for (const proof of [config, original, summary, verification, final, ...qa]) {
      if (proof !== null && !await unchanged(proof)) return null;
    }
    const rechecked = await configProof(originalRoot, sourceId, request, configSha256);
    const recheckedOriginal = await originalProof(originalRoot, originalSha256, rechecked.route);
    if (rechecked.proof.sha256 !== config.sha256
      || recheckedOriginal.sha256 !== original.sha256) return null;
    const links: Record<string, string> = { summary: `/reports/${jobId}/boot-health-accept.json` };
    if (verification !== null) links["verification"] = `/reports/${jobId}/verification/verification.json`;
    if (final !== null) links["postRegressionVerification"] =
      `/reports/${jobId}/post-regression-verification/verification.json`;
    if (qa.length === 4) links["regression"] = `/reports/${jobId}/regression/qa-summary.json`;
    return { status: result.status, verification: result.verification,
      postRegressionVerification: result.postRegressionVerification,
      regression: result.regression, reason: result.reason, links };
  } catch { return null; }
}
