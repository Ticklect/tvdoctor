import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseTVDoctorReportJson } from "@tvdoctor/protocol";
import { inspectReport } from "./node-triage.js";
import {
  createChromiumPublicRouteHealthBrowser,
  type PublicRouteHealthBrowserFactory, type PublicRouteHealthContent,
  type PublicRouteHealthDocument,
} from "./public-route-health.js";
import { runPublicRouteHealthRegression } from "./public-route-health-regression.js";

const ORIGINAL_VERSION = "tvdoctor.boot-health-original/v1";
const CAPTURE_VERSION = "tvdoctor.boot-health-capture/v1";
const VERIFY_VERSION = "tvdoctor.boot-health-verification/v1";
const ACCEPT_VERSION = "tvdoctor.boot-health-accept/v1";
const SHA = /^[a-f0-9]{64}$/u;
const ROUTE = /^\/(?:[A-Za-z0-9_~.-]+(?:\/[A-Za-z0-9_~.-]+)*)?\/?$/u;
const DANGEROUS = /(?:^|\/)(?:api|auth|login|logout|signin|signout|account|user|users|admin|checkout|cart|buy|purchase|pay|payment|subscribe|delete|remove|create|edit|save|update|upload|submit|send|approve|revoke|reset|transfer|order)(?:\/|$)/iu;
const UNSAFE_TEXT = /[<>\\@\p{Cc}\p{Cf}]|(?:https?:\/\/|www\.|javascript:|data:|\b(?:password|secret|token|credential|apikey|private.key)\b)/iu;
const MAX_ORIGINAL = 4096;
const MAX_VERIFY = 4096;
const MAX_QA = 128 * 1024;
const MAX_REPORT = 16 * 1024 * 1024;
const GRACE_MS = 1800;
const CAVEAT = "PAGE_CONTENT_RESTORED means an exact, SHA-pinned HTTP 200 blank MAIN negative witness was followed by two independent fresh browser observations of the exact authored visible MAIN content, with complete noninteractive source-route QA between them and zero VERIFIED findings. An intentionally empty view may also have produced the blank original; no application defect is certified by capture. REVIEW and UNTESTED findings, other journeys, authentication and unrelated routes remain unverified. HTTP 200, a heading alone or a missing heuristic never proves a repair.";

export interface BootHealthConfig {
  readonly baseUrl: string;
  readonly path: string;
  readonly heading: string;
  readonly expectedMainTextSha256: string;
}
export interface BootHealthCaptureOptions {
  readonly authorized: boolean;
  readonly route: BootHealthConfig;
  readonly outputRoot: string;
  readonly createBrowser?: PublicRouteHealthBrowserFactory;
  readonly pause?: (milliseconds: number) => Promise<void>;
}
export interface BootHealthCaptureResult {
  readonly schemaVersion: typeof CAPTURE_VERSION;
  readonly classification: "VERIFIED_ORIGINAL" | "INCONCLUSIVE";
  readonly originalPath: string | null;
  readonly originalSha256: string | null;
  readonly reason: string | null;
}
export interface BootHealthVerifyOptions {
  readonly authorized: boolean;
  readonly route: BootHealthConfig;
  readonly originalPath: string;
  readonly expectedOriginalSha256: string;
  readonly outputRoot: string;
  readonly createBrowser?: PublicRouteHealthBrowserFactory;
  readonly pause?: (milliseconds: number) => Promise<void>;
}
export interface BootHealthVerifyResult {
  readonly schemaVersion: typeof VERIFY_VERSION;
  readonly classification: "PAGE_CONTENT_RESTORED" | "REPRODUCED" | "INCONCLUSIVE";
  readonly originalSha256: string | null;
  readonly regressionChecked: false;
  readonly reason: string | null;
}
interface VerificationStage {
  readonly status: BootHealthVerifyResult["classification"] | "NOT_RUN";
  readonly artifact: "verification/verification.json" | "post-regression-verification/verification.json" | null;
}
interface RegressionStage {
  readonly status: "COMPLETED" | "INCOMPLETE" | "FAILED" | "NOT_RUN";
  readonly verified: number;
  readonly review: number;
  readonly untested: number;
  readonly reportSha256: string | null;
  readonly artifact: "regression/qa-summary.json" | null;
}
export interface BootHealthAcceptOptions extends Omit<BootHealthVerifyOptions, "createBrowser"> {
  readonly createBrowser?: PublicRouteHealthBrowserFactory;
  readonly executeQa: (args: readonly string[]) => Promise<{
    readonly exitCode: number; readonly stdout: string;
  }>;
  /** Caller-provided private config recheck; required when config is a saved CLI file. */
  readonly checkAuthoredConfig?: () => Promise<boolean>;
}
export interface BootHealthAcceptResult {
  readonly schemaVersion: typeof ACCEPT_VERSION;
  readonly status: "PAGE_CONTENT_RESTORED" | "REPRODUCED" | "NEW_VERIFIED" | "INCONCLUSIVE" | "ERROR";
  readonly exitCode: 0 | 1 | 2 | 3 | 4;
  readonly shouldFail: boolean;
  readonly originalSha256: string | null;
  readonly reason: string | null;
  readonly verification: VerificationStage;
  readonly regression: RegressionStage;
  readonly postRegressionVerification: VerificationStage;
  readonly caveat: string;
}
interface ExpectedRoute {
  readonly url: string;
  readonly configSha256: string;
  readonly routeSha256: string;
  readonly headingSha256: string;
  readonly expectedMainTextSha256: string;
}
interface OriginalWitness {
  readonly schemaVersion: typeof ORIGINAL_VERSION;
  readonly browserAuthority: "isolated-chromium-exact-public-document-get";
  readonly nonce: string;
  readonly configSha256: string;
  readonly routeSha256: string;
  readonly headingSha256: string;
  readonly expectedMainTextSha256: string;
  readonly sourceDocumentStatus: 200;
  readonly sourceDocumentNavigations: 1;
  readonly blankMainObserved: true;
  readonly settledSamples: 3;
  readonly hydrationGraceMs: 1800;
  readonly noRedirects: true;
}
const hash = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
function record(value: unknown): Record<string, unknown> | null {
  return value === null || typeof value !== "object" || Array.isArray(value)
    ? null : value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, names: readonly string[]): boolean {
  return Object.keys(value).sort().join("|") === [...names].sort().join("|");
}
function expected(route: BootHealthConfig): ExpectedRoute {
  const raw = record(route);
  if (raw === null || !exactKeys(raw, ["baseUrl", "path", "heading", "expectedMainTextSha256"])
    || typeof route.baseUrl !== "string" || route.baseUrl.length < 1 || route.baseUrl.length > 2048
    || typeof route.path !== "string" || route.path.length > 512 || !ROUTE.test(route.path)
    || route.path.split("/").some((part) => part === "." || part === "..")
    || DANGEROUS.test(route.path)
    || typeof route.heading !== "string" || route.heading.length < 1 || route.heading.length > 128
    || route.heading.trim() !== route.heading || UNSAFE_TEXT.test(route.heading)
    || typeof route.expectedMainTextSha256 !== "string" || !SHA.test(route.expectedMainTextSha256)) {
    throw new TypeError("invalid-boot-health-route");
  }
  const base = new URL(route.baseUrl);
  if ((base.protocol !== "http:" && base.protocol !== "https:")
    || base.username !== "" || base.password !== "" || base.search !== "" || base.hash !== ""
    || base.pathname !== "/" || base.href !== `${base.origin}/`
    || (route.baseUrl !== base.origin && route.baseUrl !== base.href)) {
    throw new TypeError("invalid-boot-health-origin");
  }
  const page = new URL(route.path, base);
  if (page.pathname !== route.path || page.search !== "" || page.hash !== ""
    || page.origin !== base.origin) throw new TypeError("noncanonical-boot-health-path");
  return {
    url: page.href,
    configSha256: hash(JSON.stringify(["boot-config/v1", base.origin,
      route.path, route.heading, route.expectedMainTextSha256])),
    routeSha256: hash(JSON.stringify(["boot-document/v1", base.origin, route.path])),
    headingSha256: hash(JSON.stringify(["boot-heading/v1", route.heading])),
    expectedMainTextSha256: route.expectedMainTextSha256,
  };
}
function inside(parent: string, child: string): boolean {
  const rest = relative(parent, child);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}
function safeAbsolute(path: unknown): path is string {
  return typeof path === "string" && isAbsolute(path)
    && path.length > 0 && path.length <= 4096 && path.trim() === path
    && !path.includes("\0") && resolve(path) === path;
}
async function canonicalDirectory(path: string): Promise<void> {
  if (!safeAbsolute(path)) throw new Error("unsafe-directory-path");
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) {
    throw new Error("unsafe-directory");
  }
}
async function freshRoot(path: string): Promise<string> {
  if (!safeAbsolute(path)) throw new Error("invalid-output-root");
  await canonicalDirectory(dirname(path));
  await mkdir(path, { mode: 0o700 }); // no recursive and no pre-existing root
  await canonicalDirectory(path);
  return path;
}
interface Proof { readonly path: string; readonly bytes: Buffer; readonly sha256: string; readonly size: number }
async function pin(path: string, maximum: number): Promise<Proof> {
  if (!safeAbsolute(path)) throw new Error("invalid-evidence-path");
  await canonicalDirectory(dirname(path));
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1
    || before.size > maximum || await realpath(path) !== path) throw new Error("unsafe-evidence-file");
  const handle = await open(path, "r");
  let bytes: Buffer;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== before.ino || opened.size !== before.size) throw new Error("changed-evidence");
    bytes = Buffer.alloc(before.size);
    for (let at = 0; at < bytes.length;) {
      const result = await handle.read(bytes, at, bytes.length - at, at);
      if (result.bytesRead < 1) throw new Error("truncated-evidence");
      at += result.bytesRead;
    }
  } finally { await handle.close(); }
  const after = await lstat(path);
  if (!after.isFile() || after.isSymbolicLink() || after.ino !== before.ino
    || after.size !== before.size || after.mtimeMs !== before.mtimeMs
    || await realpath(path) !== path) throw new Error("changed-evidence");
  return { path, bytes, sha256: hash(bytes), size: bytes.length };
}
async function unchanged(proof: Proof): Promise<boolean> {
  try {
    const current = await pin(proof.path, proof.size);
    return current.sha256 === proof.sha256 && current.size === proof.size;
  } catch { return false; }
}
async function originalProof(path: string, originalSha256: string, route: ExpectedRoute): Promise<Proof> {
  if (!safeAbsolute(path) || basename(path) !== "original.json" || !SHA.test(originalSha256)) {
    throw new Error("invalid-original-reference");
  }
  const proof = await pin(path, MAX_ORIGINAL);
  if (proof.sha256 !== originalSha256) throw new Error("changed-original-sha");
  const raw = record(JSON.parse(proof.bytes.toString("utf8")) as unknown);
  const names = ["schemaVersion", "browserAuthority", "nonce", "configSha256", "routeSha256",
    "headingSha256", "expectedMainTextSha256", "sourceDocumentStatus",
    "sourceDocumentNavigations", "blankMainObserved", "settledSamples",
    "hydrationGraceMs", "noRedirects"];
  if (raw === null || !exactKeys(raw, names)
    || raw["schemaVersion"] !== ORIGINAL_VERSION
    || raw["browserAuthority"] !== "isolated-chromium-exact-public-document-get"
    || typeof raw["nonce"] !== "string" || !/^[a-f0-9-]{36}$/u.test(raw["nonce"])
    || raw["configSha256"] !== route.configSha256 || raw["routeSha256"] !== route.routeSha256
    || raw["headingSha256"] !== route.headingSha256
    || raw["expectedMainTextSha256"] !== route.expectedMainTextSha256
    || raw["sourceDocumentStatus"] !== 200 || raw["sourceDocumentNavigations"] !== 1
    || raw["blankMainObserved"] !== true || raw["settledSamples"] !== 3
    || raw["hydrationGraceMs"] !== GRACE_MS || raw["noRedirects"] !== true) {
    throw new Error("original-source-or-content-mismatch");
  }
  return proof;
}
function documentExact(doc: PublicRouteHealthDocument, url: string): boolean {
  return doc !== null && doc.requestUrl === url && doc.responseUrl === url
    && doc.finalUrl === url && doc.status === 200 && doc.method === "GET"
    && doc.mainFrameDocument === true && doc.navigationCount === 1
    && doc.redirectCount === 0 && typeof doc.contentType === "string"
    && /^text\/html(?:\s*;|$)/iu.test(doc.contentType);
}
function blank(value: PublicRouteHealthContent, url: string): boolean {
  return value !== null && value.finalUrl === url && value.navigationCount === 1
    && value.mainCount === 1 && value.headingCount === 0
    && value.headingInMainCount === 0 && value.headingVisible === false
    && value.headingInMainVisible === false && value.headingContextSha256 === null
    && value.mainTextLength === 0 && value.mainTextSha256 === null
    && value.errorOrLoginShell === false;
}
function healthy(value: PublicRouteHealthContent, url: string, route: BootHealthConfig): boolean {
  return value !== null && value.finalUrl === url && value.navigationCount === 1
    && value.mainCount === 1 && value.headingCount === 1 && value.headingInMainCount === 1
    && value.headingVisible === true && value.headingInMainVisible === true
    && value.sameHeadingNode === true && value.errorOrLoginShell === false
    && typeof value.headingContextSha256 === "string" && SHA.test(value.headingContextSha256)
    && Number.isSafeInteger(value.mainTextLength)
    && value.mainTextLength >= Math.max(64, route.heading.length + 24)
    && value.mainTextSha256 === route.expectedMainTextSha256;
}
const wait = async (ms: number): Promise<void> => {
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, ms));
};
function invalidCapture(reason: string): BootHealthCaptureResult {
  return { schemaVersion: CAPTURE_VERSION, classification: "INCONCLUSIVE",
    originalPath: null, originalSha256: null, reason };
}
function verification(
  classification: BootHealthVerifyResult["classification"],
  originalSha256: string | null, reason: string | null,
): BootHealthVerifyResult {
  return { schemaVersion: VERIFY_VERSION, classification, originalSha256,
    regressionChecked: false, reason };
}
async function observeBlank(
  browser: Awaited<ReturnType<PublicRouteHealthBrowserFactory>>, route: BootHealthConfig,
  url: string, pause: (milliseconds: number) => Promise<void>,
): Promise<boolean> {
  const first = await browser.inspect(route.heading);
  if (!blank(first, url)) return false;
  await pause(GRACE_MS);
  const second = await browser.inspect(route.heading);
  if (!blank(second, url)) return false;
  await pause(180);
  const third = await browser.inspect(route.heading);
  return blank(third, url) && JSON.stringify(first) === JSON.stringify(second)
    && JSON.stringify(second) === JSON.stringify(third);
}
async function observeHealthy(
  browser: Awaited<ReturnType<PublicRouteHealthBrowserFactory>>, route: BootHealthConfig,
  url: string, pause: (milliseconds: number) => Promise<void>,
): Promise<boolean> {
  const first = await browser.inspect(route.heading);
  if (!healthy(first, url, route)) return false;
  await pause(220);
  const second = await browser.inspect(route.heading);
  return healthy(second, url, route) && first.headingContextSha256 === second.headingContextSha256
    && first.mainTextLength === second.mainTextLength
    && JSON.stringify(first) === JSON.stringify(second);
}

/**
 * A stable blank HTTP 200 MAIN is solely a negative observation, not proof that
 * the author intended nonempty content. Login/error shells, a visible MAIN
 * message, ambiguous heading, redirect or delayed hydration fail closed.
 */
export async function runBootHealthCapture(
  options: BootHealthCaptureOptions,
): Promise<BootHealthCaptureResult> {
  if (options?.authorized !== true) return invalidCapture("authorization-required");
  let route: ExpectedRoute;
  try { route = expected(options.route); }
  catch { return invalidCapture("invalid-authored-public-route"); }
  let browser: Awaited<ReturnType<PublicRouteHealthBrowserFactory>> | null = null;
  try {
    browser = await (options.createBrowser?.() ?? createChromiumPublicRouteHealthBrowser());
    const doc = await browser.navigate(route.url);
    if (!documentExact(doc, route.url)) return invalidCapture("source-http200-document-not-exact");
    const observed = await observeBlank(browser, options.route, route.url, options.pause ?? wait);
    if (!observed) return invalidCapture("stable-blank-main-or-hydration-unproven");
    const witness: OriginalWitness = {
      schemaVersion: ORIGINAL_VERSION, browserAuthority: "isolated-chromium-exact-public-document-get",
      nonce: randomUUID(), configSha256: route.configSha256, routeSha256: route.routeSha256,
      headingSha256: route.headingSha256, expectedMainTextSha256: route.expectedMainTextSha256,
      sourceDocumentStatus: 200, sourceDocumentNavigations: 1, blankMainObserved: true,
      settledSamples: 3, hydrationGraceMs: GRACE_MS, noRedirects: true,
    };
    const bytes = Buffer.from(JSON.stringify(witness, null, 2) + "\n", "utf8");
    if (bytes.length > MAX_ORIGINAL) return invalidCapture("oversized-original-witness");
    const root = await freshRoot(options.outputRoot);
    const originalPath = join(root, "original.json");
    await writeFile(originalPath, bytes, { flag: "wx", mode: 0o600 });
    return { schemaVersion: CAPTURE_VERSION, classification: "VERIFIED_ORIGINAL",
      originalPath, originalSha256: hash(bytes), reason: null };
  } catch { return invalidCapture("capture-execution-or-evidence-failed"); }
  finally { await browser?.close().catch(() => undefined); }
}

/** Compatibility export for the local UI HTTP capture adapter. */
export const captureBootHealthOriginal = runBootHealthCapture;

function separatedRoot(outputRoot: string, originalPath: string): boolean {
  if (!safeAbsolute(outputRoot) || !safeAbsolute(originalPath)) return false;
  const sourceRoot = dirname(originalPath);
  return !inside(outputRoot, sourceRoot) && !inside(sourceRoot, outputRoot);
}

async function sourceProof(options: {
  readonly route: BootHealthConfig;
  readonly originalPath: string;
  readonly expectedOriginalSha256: string;
  readonly outputRoot: string;
}): Promise<{ expected: ExpectedRoute; original: Proof }> {
  const route = expected(options.route);
  if (!separatedRoot(options.outputRoot, options.originalPath)) throw new Error("overlapping-original-output");
  return { expected: route, original: await originalProof(options.originalPath,
    options.expectedOriginalSha256, route) };
}

/** Fresh isolated browser: the exact authored MAIN fingerprint, not absence of a finding. */
export async function runBootHealthVerify(options: BootHealthVerifyOptions): Promise<BootHealthVerifyResult> {
  if (options?.authorized !== true) return verification("INCONCLUSIVE", null, "authorization-required");
  let source: Awaited<ReturnType<typeof sourceProof>>;
  try { source = await sourceProof(options); }
  catch { return verification("INCONCLUSIVE", null, "original-source-or-configuration-invalid"); }
  let browser: Awaited<ReturnType<PublicRouteHealthBrowserFactory>> | null = null;
  let result: BootHealthVerifyResult;
  try {
    browser = await (options.createBrowser?.() ?? createChromiumPublicRouteHealthBrowser());
    const document = await browser.navigate(source.expected.url);
    if (!documentExact(document, source.expected.url)) {
      result = verification("INCONCLUSIVE", options.expectedOriginalSha256, "source-http200-document-drift");
    } else if (await observeHealthy(browser, options.route, source.expected.url, options.pause ?? wait)) {
      result = verification("PAGE_CONTENT_RESTORED", options.expectedOriginalSha256, null);
    } else if (await observeBlank(browser, options.route, source.expected.url, options.pause ?? wait)) {
      result = verification("REPRODUCED", options.expectedOriginalSha256, null);
    } else {
      result = verification("INCONCLUSIVE", options.expectedOriginalSha256, "authored-visible-main-content-unproven");
    }
  } catch {
    result = verification("INCONCLUSIVE", options.expectedOriginalSha256, "verification-observation-failed");
  } finally { await browser?.close().catch(() => undefined); }
  // A changed original must never be credited with any repaired/failing outcome.
  if (!await unchanged(source.original)) {
    return verification("INCONCLUSIVE", null, "original-witness-changed-after-observation");
  }
  try {
    const root = await freshRoot(options.outputRoot);
    await writeFile(join(root, "verification.json"), JSON.stringify(result, null, 2) + "\n",
      { flag: "wx", mode: 0o600 });
    if (!await unchanged(source.original)) {
      return verification("INCONCLUSIVE", null, "original-witness-changed-after-writing");
    }
    return result;
  } catch {
    return verification("INCONCLUSIVE", null, "verification-evidence-write-failed");
  }
}

async function verificationProof(
  root: string, stage: "verification" | "post-regression-verification",
  result: BootHealthVerifyResult, originalSha256: string,
): Promise<Proof> {
  if (result.schemaVersion !== VERIFY_VERSION || result.originalSha256 !== originalSha256
    || result.regressionChecked !== false
    || !["PAGE_CONTENT_RESTORED", "REPRODUCED", "INCONCLUSIVE"].includes(result.classification)
    || (result.classification === "INCONCLUSIVE"
      ? typeof result.reason !== "string" || !/^[a-z][a-z0-9-]{0,127}$/u.test(result.reason)
      : result.reason !== null)) throw new Error("untrusted-verification-result");
  await canonicalDirectory(join(root, stage));
  const proof = await pin(join(root, stage, "verification.json"), MAX_VERIFY);
  if (JSON.stringify(JSON.parse(proof.bytes.toString("utf8")) as unknown) !== JSON.stringify(result)) {
    throw new Error("verification-artifact-diverges-from-result");
  }
  return proof;
}

async function regressionProof(root: string, summary: RegressionStage, url: string): Promise<Proof[]> {
  if (summary.status !== "COMPLETED" || summary.artifact !== "regression/qa-summary.json"
    || typeof summary.reportSha256 !== "string" || !SHA.test(summary.reportSha256)) {
    throw new Error("fresh-qa-incomplete");
  }
  await canonicalDirectory(join(root, "regression"));
  await canonicalDirectory(join(root, "regression", "original"));
  const saved = await pin(join(root, "regression", "qa-summary.json"), MAX_QA);
  const report = await pin(join(root, "regression", "original", "report.json"), MAX_REPORT);
  const handoff = await pin(join(root, "regression", "handoff.json"), 256 * 1024);
  const brief = await pin(join(root, "regression", "AGENT_REPAIR_BRIEF.md"), 64 * 1024);
  if (report.sha256 !== summary.reportSha256) throw new Error("fresh-report-sha-changed");
  const qa = record(JSON.parse(saved.bytes.toString("utf8")) as unknown);
  const parsed = parseTVDoctorReportJson(report.bytes.toString("utf8"));
  const policy = record(qa?.["scanPolicy"]);
  const counts = record(qa?.["summary"]);
  if (qa === null || policy === null || counts === null
    || qa["schemaVersion"] !== "tvdoctor.qa/v1" || qa["source"] !== "url"
    || qa["exitCode"] !== (summary.verified > 0 ? 1 : 0)
    || qa["shouldFail"] !== (summary.verified > 0) || qa["reason"] !== null
    || qa["summaryPath"] !== saved.path || qa["originalPath"] !== report.path
    || qa["handoffPath"] !== handoff.path || qa["agentBriefPath"] !== brief.path
    || policy["schemaVersion"] !== "tvdoctor.qa-scan-policy/v1"
    || policy["mode"] !== "quick" || policy["failOn"] !== "any"
    || policy["safeInteractions"] !== false || policy["safeLinks"] !== false
    || policy["reportSha256"] !== report.sha256
    || counts["routes"] !== 1 || counts["incompleteRoutes"] !== 0
    || counts["verified"] !== summary.verified
    || counts["review"] !== summary.review || counts["untested"] !== summary.untested
    || parsed.target.platform !== "web" || parsed.target.location !== url
    || parsed.target.environment["browser"] !== "chromium"
    || parsed.target.environment["inputMode"] !== "keyboard"
    || parsed.target.environment["keyboardInteractions"] !== "disabled"
    || parsed.target.environment["safeLinkNavigation"] !== "disabled"
    || parsed.target.environment["journeyConfigSha256"] !== undefined
    || parsed.target.environment["authReadySha256"] !== undefined
    || parsed.run.mode !== "quick" || parsed.run.status !== "completed"
    || qa["status"] !== (summary.verified > 0 ? "ACTION_REQUIRED"
      : summary.review > 0 ? "REVIEW_REQUIRED" : "NO_VERIFIED_FAILURES_IN_COVERAGE")) {
    throw new Error("fresh-qa-source-policy-drift");
  }
  const triage = await inspectReport(report.path, { maxFindings: 100 });
  if (triage.coverage.incomplete || triage.coverage.packsOmitted !== 0 || triage.summary.omitted !== 0
    || triage.integrity.evidence === "bounded" || triage.integrity.evidence === "degraded"
    || triage.integrity.artifactsRejected !== 0 || triage.integrity.artifactsNotChecked !== 0
    || triage.summary.VERIFIED !== summary.verified
    || triage.summary.REVIEW !== summary.review || triage.summary.UNTESTED !== summary.untested
    || !(await unchanged(report))) throw new Error("fresh-qa-report-coverage-or-integrity");
  return [saved, report, handoff, brief];
}

/** Exactly two independently saved repaired-content observations around complete fresh QA. */
export async function runBootHealthAccept(options: BootHealthAcceptOptions): Promise<BootHealthAcceptResult> {
  let first: VerificationStage = { status: "NOT_RUN", artifact: null };
  let final: VerificationStage = { status: "NOT_RUN", artifact: null };
  let regression: RegressionStage = { status: "NOT_RUN", verified: 0,
    review: 0, untested: 0, reportSha256: null, artifact: null };
  const response = (code: BootHealthAcceptResult["exitCode"], reason: string | null): BootHealthAcceptResult => {
    const status = code === 0 ? "PAGE_CONTENT_RESTORED" : code === 1
      ? first.status === "REPRODUCED" || final.status === "REPRODUCED" ? "REPRODUCED" : "NEW_VERIFIED"
      : code === 4 ? "ERROR" : "INCONCLUSIVE";
    return { schemaVersion: ACCEPT_VERSION, status, exitCode: code, shouldFail: code !== 0,
      originalSha256: SHA.test(options?.expectedOriginalSha256 ?? "") ? options.expectedOriginalSha256 : null,
      reason, verification: first, regression, postRegressionVerification: final, caveat: CAVEAT };
  };
  if (options?.authorized !== true || typeof options.executeQa !== "function"
    || (options.checkAuthoredConfig !== undefined && typeof options.checkAuthoredConfig !== "function")) {
    return response(2, "unauthorized-or-invalid-options");
  }
  let source: Awaited<ReturnType<typeof sourceProof>>;
  try {
    source = await sourceProof(options);
    if (options.checkAuthoredConfig !== undefined && !await options.checkAuthoredConfig()) {
      return response(3, "private-authored-configuration-drift");
    }
  } catch { return response(3, "original-source-or-configuration-invalid"); }
  let root: string;
  try { root = await freshRoot(options.outputRoot); }
  catch { return response(4, "acceptance-output-not-fresh-or-unsafe"); }
  let code: BootHealthAcceptResult["exitCode"] = 3;
  let reason: string | null;
  try {
    const initial = await runBootHealthVerify({ authorized: true, route: options.route,
      originalPath: options.originalPath, expectedOriginalSha256: options.expectedOriginalSha256,
      outputRoot: join(root, "verification"),
      ...(options.createBrowser === undefined ? {} : { createBrowser: options.createBrowser }),
      ...(options.pause === undefined ? {} : { pause: options.pause }) });
    const initialProof = await verificationProof(root, "verification", initial, options.expectedOriginalSha256);
    first = { status: initial.classification, artifact: "verification/verification.json" };
    if (!await unchanged(source.original)
      || options.checkAuthoredConfig !== undefined && !await options.checkAuthoredConfig()) {
      code = 3; reason = "original-or-authored-config-changed-after-first-proof";
    } else if (initial.classification === "REPRODUCED") {
      code = 1; reason = "original-blank-main-still-reproduced";
    } else if (initial.classification !== "PAGE_CONTENT_RESTORED") {
      reason = "independent-authored-main-content-not-proven";
    } else {
      const qa = await runPublicRouteHealthRegression({
        target: source.expected.url, outputRoot: join(root, "regression"),
        executeQa: options.executeQa,
      });
      regression = {
        status: qa.status, verified: qa.verified, review: qa.review, untested: qa.untested,
        reportSha256: qa.reportSha256, artifact: qa.summaryPath === null ? null : "regression/qa-summary.json",
      };
      if (!await unchanged(source.original) || !await unchanged(initialProof)
        || options.checkAuthoredConfig !== undefined && !await options.checkAuthoredConfig()) {
        reason = "original-verification-or-authored-config-drift-during-qa";
      } else if (qa.status !== "COMPLETED") {
        reason = "fresh-qa-evidence-incomplete";
      } else {
        const qaProofs = await regressionProof(root, regression, source.expected.url);
        if (qa.verified > 0) {
          code = 1; reason = "new-verified-failure-in-fresh-qa";
        } else {
          const repeated = await runBootHealthVerify({ authorized: true, route: options.route,
            originalPath: options.originalPath, expectedOriginalSha256: options.expectedOriginalSha256,
            outputRoot: join(root, "post-regression-verification"),
            ...(options.createBrowser === undefined ? {} : { createBrowser: options.createBrowser }),
            ...(options.pause === undefined ? {} : { pause: options.pause }) });
          const finalProof = await verificationProof(
            root, "post-regression-verification", repeated, options.expectedOriginalSha256);
          final = { status: repeated.classification,
            artifact: "post-regression-verification/verification.json" };
          const pinsUnchanged = (await Promise.all([source.original, initialProof, finalProof, ...qaProofs]
            .map((proof) => unchanged(proof)))).every(Boolean);
          if (!pinsUnchanged || options.checkAuthoredConfig !== undefined
            && !await options.checkAuthoredConfig()) {
            reason = "source-positive-or-regression-proof-changed";
          } else if (repeated.classification === "PAGE_CONTENT_RESTORED") {
            code = 0; reason = null;
          } else if (repeated.classification === "REPRODUCED") {
            code = 1; reason = "blank-main-observed-after-regression";
          } else {
            reason = "final-authored-main-content-not-proven";
          }
        }
      }
    }
  } catch {
    code = 3; reason = "independent-proof-or-fresh-qa-unavailable";
  }
  // An original with changed bytes must not produce a positive or REPRODUCED
  // outcome. Even if an earlier gate was green, this is now INCONCLUSIVE.
  if (!await unchanged(source.original)
    || options.checkAuthoredConfig !== undefined && !await options.checkAuthoredConfig().catch(() => false)) {
    code = 3; reason = "original-or-private-authored-config-changed";
  }
  if (code === 0 && (first.status !== "PAGE_CONTENT_RESTORED"
    || final.status !== "PAGE_CONTENT_RESTORED"
    || regression.status !== "COMPLETED" || regression.verified !== 0)) {
    code = 3; reason = "positive-or-regression-gate-unproven";
  }
  const result = response(code, reason);
  try {
    await writeFile(join(root, "boot-health-accept.json"), JSON.stringify(result, null, 2) + "\n",
      { mode: 0o600, flag: "wx" });
    return result;
  } catch { return response(4, "acceptance-summary-write-failed"); }
}
