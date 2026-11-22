import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

import { safeTarget, type TestCommandResult, type TestRunMode } from "./cli.js";
import { renderLocalUiPage } from "./local-ui-page.js";
import { readLocalTriage, type TriageSummary } from "./local-ui-triage.js";
import { inspectReport } from "./node-triage.js";
import { parseTVDoctorReportJson, REPORT_SCHEMA_VERSION_V1 } from "@tvdoctor/protocol";
import { createFirstRunHandoff, formatFirstRunHandoff } from "./first-run-handoff.js";
import type { QaWorkflowResult } from "./qa-workflow.js";
import type { QaAcceptResult } from "./qa-accept.js";
import { preflightProjectJourneys, type ProjectCheckResult } from "./project-check.js";
import type { ProjectAcceptResult } from "./project-accept.js";
import type { PublicRouteHealthAcceptResult } from "./public-route-health-accept.js";
import type { SpaRouteHealthAcceptResult } from "./spa-route-health-accept.js";
import type { BootHealthAcceptResult } from "./boot-health-accept.js";
import {
  parseLocalBootHealthRequest,
  prepareLocalBootHealthConfig,
  inspectLocalBootHealthCapture,
  inspectLocalBootHealthAcceptance,
  LocalBootHealthRequestError,
  type LocalBootHealthRequest, type PublicLocalBootHealthAcceptance,
} from "./local-ui-boot-health.js";
import {
  parseLocalSpaRouteHealthRequest,
  prepareLocalSpaRouteHealthConfig,
  inspectLocalSpaRouteHealthCapture,
  inspectLocalSpaRouteHealthAcceptance,
  LocalSpaRouteHealthRequestError,
  type LocalSpaRouteHealthRequest, type PublicLocalSpaRouteHealthAcceptance,
} from "./local-ui-spa-route-health.js";
import {
  parseLocalRouteHealthRequest,
  prepareLocalRouteHealthConfig,
  inspectLocalRouteHealthCapture,
  inspectLocalRouteHealthAcceptance,
  LocalRouteHealthRequestError,
  type LocalRouteHealthRequest, type PublicLocalRouteHealthAcceptance,
} from "./local-ui-route-health.js";
import {
  prepareLocalProjectManifest, inspectLocalProjectCapture, inspectLocalProjectAcceptance,
  type PublicProjectCapture, type PublicProjectAcceptance,
} from "./local-ui-project.js";

type InputMode = "keyboard" | "remote";
export type LocalUiScanType = "navigation" | "site" | "responsive";
type JobState = "idle" | "running" | "cancelling" | "completed" | "partial" | "failed" | "cancelled";

export interface LocalUiScanRequest {
  readonly target: string;
  readonly type: LocalUiScanType;
  readonly input: InputMode;
  readonly mode: TestRunMode;
  readonly recordVideo: boolean;
  /** Experimental site discovery, explicitly opt-in; host runner supplies its implementation. */
  readonly exploreSpa?: boolean;
  /** Bounded upper limit requested by the user, not a claim about discovered routes. */
  readonly maxRoutes?: number;
  /** Requested responsive profiles; an actual scan may end partial before reaching them all. */
  readonly viewportProfile?: "mobile" | "tablet" | "desktop" | "all";
  /** Cancels an in-process scanner cooperatively, without killing a child process. */
  readonly signal: AbortSignal;
  readonly outputPath: string;
}

export interface LocalUiScanMetrics {
  readonly routesVisited?: number;
  readonly routesLimit?: number;
  readonly routesDiscovered?: number;
  readonly viewportsTested?: number;
  readonly viewportsRequested?: number;
}

export interface LocalUiScanOutcome {
  readonly exitCode: number;
  readonly result: TestCommandResult | null;
  /** Only real observed counts belong here. No inferred coverage percentages. */
  readonly metrics?: LocalUiScanMetrics;
  /** Optional relative artifact paths, always revalidated against this job's report directory. */
  readonly evidencePaths?: readonly string[];
}

/** Passed to the production public `qa` command by the CLI host. */
export interface LocalUiQaRequest {
  readonly target: string;
  readonly mode: TestRunMode;
  readonly safeInteractions: boolean;
  readonly safeLinks: boolean;
  readonly signal: AbortSignal;
  /** Fresh, uncreated run directory under the UI output root. */
  readonly outputPath: string;
}

export interface LocalUiQaAcceptRequest {
  /** Server-owned original QA run directory. Never supplied by a browser request. */
  readonly originalQaPath: string;
  /** The original private target, retained only in server memory. */
  readonly target: string;
  /** Fresh sibling run directory, disjoint from the original evidence. */
  readonly outputPath: string;
  readonly signal: AbortSignal;
}

export interface LocalUiProjectRequest {
  /** A server-created manifest, never an arbitrary browser-supplied pathname. */
  readonly manifestPath: string;
  /** A fresh report directory distinct from the manifest and prior runs. */
  readonly outputPath: string;
  readonly signal: AbortSignal;
}

export interface LocalUiProjectAcceptRequest extends LocalUiProjectRequest {
  /** A server-owned, immutable original capture; never supplied by the browser. */
  readonly originalSummaryPath: string;
}

export interface LocalUiRouteHealthRequest {
  readonly action: "capture" | "accept";
  /** Server-generated, SHA-pinned PRIVATE authored config, never a browser filename. */
  readonly configPath: string;
  /** New directory, disjoint from any original artifacts. */
  readonly outputPath: string;
  readonly signal: AbortSignal;
  readonly originalPath?: string;
  readonly originalSha256?: string;
}
export interface LocalUiRouteHealthCommandResult {
  readonly schemaVersion: "tvdoctor.public-route-health-command/v1";
  readonly status: "VERIFIED_ORIGINAL" | "INCONCLUSIVE" | "REPRODUCED" | "FIXED";
  readonly originalSha256: string | null;
  readonly exitCode: number;
  readonly shouldFail: boolean;
  readonly regressionChecked: false;
  readonly reason: string | null;
}

export interface LocalUiSpaRouteHealthRequest {
  readonly action: "capture" | "accept";
  /** Server-generated private config pinned to the exact original authored fields. */
  readonly configPath: string;
  readonly outputPath: string;
  readonly signal: AbortSignal;
  readonly originalPath?: string;
  readonly originalSha256?: string;
}
export interface LocalUiSpaRouteHealthCommandResult {
  readonly schemaVersion: "tvdoctor.spa-route-health-command/v1";
  /** The dashboard invokes capture, never standalone verify. */
  readonly status: "VERIFIED_ORIGINAL" | "INCONCLUSIVE";
  readonly originalSha256: string | null;
  readonly exitCode: number;
  readonly shouldFail: boolean;
  readonly regressionChecked: false;
  readonly reason: string | null;
  readonly caveat: string;
}

/** All private boot content expectations remain server-owned. */
export interface LocalUiBootHealthRequest {
  readonly action: "capture" | "accept";
  readonly configPath: string;
  readonly outputPath: string;
  readonly signal: AbortSignal;
  readonly originalPath?: string;
  readonly originalSha256?: string;
}
export interface LocalUiBootHealthCommandResult {
  readonly schemaVersion: "tvdoctor.boot-health-command/v1";
  readonly status: "VERIFIED_ORIGINAL" | "INCONCLUSIVE";
  readonly originalSha256: string | null;
  readonly exitCode: number;
  readonly shouldFail: boolean;
  readonly regressionChecked: false;
  readonly reason: string | null;
  readonly caveat: string;
}

type QaStatus = QaWorkflowResult["status"];
type QaCounts = NonNullable<QaWorkflowResult["summary"]>;
interface PublicQaResult {
  readonly status: QaStatus;
  readonly summary: QaCounts | null;
  readonly links: Readonly<Partial<Record<"brief" | "handoff" | "summary" | "report", string>>>;
}
interface PublicQaAcceptance {
  readonly status: QaAcceptResult["status"];
  readonly verification: Pick<QaAcceptResult["verification"], "status" | "fixed" | "reproduced" | "inconclusive">;
  readonly regression: Pick<QaAcceptResult["regression"], "status" | "verified" | "review" | "untested">;
  readonly links: Readonly<Partial<Record<"summary" | "verification" | "regression", string>>>;
  readonly originalLinks: PublicQaResult["links"];
}

export interface LocalUiOptions {
  readonly port?: number;
  /** An isolated parent folder for generated reports; no other directories are served. */
  readonly outputRoot?: string;
  /** Must execute TVDoctor's real scanner. Injected for deterministic server tests. */
  readonly runScan: (request: LocalUiScanRequest) => Promise<LocalUiScanOutcome>;
  /** Real first-run QA workflow, via the CLI host's public `qa` entry point. */
  readonly runQa?: (request: LocalUiQaRequest) => Promise<QaWorkflowResult>;
  /** Production qa-accept: original issue replay AND a fresh post-repair QA scan. */
  readonly runQaAccept?: (request: LocalUiQaAcceptRequest) => Promise<QaAcceptResult>;
  /** Executes the PUBLIC project command with an internally validated manifest. */
  readonly runProject?: (request: LocalUiProjectRequest) => Promise<ProjectCheckResult>;
  /** Executes PUBLIC project-accept with the saved server-owned original. */
  readonly runProjectAccept?: (request: LocalUiProjectAcceptRequest) => Promise<ProjectAcceptResult>;
  /** Public route-health CLI capture and acceptance with server-owned private config. */
  readonly runRouteHealth?: (request: LocalUiRouteHealthRequest) => Promise<
    LocalUiRouteHealthCommandResult | PublicRouteHealthAcceptResult>;
  /** Separate authored browser History/SPA missing-content capture and acceptance. */
  readonly runSpaRouteHealth?: (request: LocalUiSpaRouteHealthRequest) => Promise<
    LocalUiSpaRouteHealthCommandResult | SpaRouteHealthAcceptResult>;
  /** Exact HTTP200 initial-blank-page capture and independent post-repair proof. */
  readonly runBootHealth?: (request: LocalUiBootHealthRequest) => Promise<
    LocalUiBootHealthCommandResult | BootHealthAcceptResult>;
  /** Aborts active scans when the caller closes its session. */
  readonly signal?: AbortSignal;
}

export interface LocalUiServer {
  readonly url: string;
  close(): Promise<void>;
}

interface Job {
  readonly id: string;
  readonly type: LocalUiScanType | "qa" | "qa-accept" | "project" | "project-accept"
    | "route-health" | "route-health-accept" | "spa-route-health" | "spa-route-health-accept"
    | "boot-health" | "boot-health-accept";
  readonly mode: TestRunMode;
  readonly input: InputMode;
  readonly recordVideo: boolean;
  readonly exploreSpa?: boolean;
  /** A private, request-bound launch-route digest; never returned by the local API. */
  readonly spaTargetIdentity?: string;
  readonly maxRoutes?: number;
  readonly viewportProfile?: "mobile" | "tablet" | "desktop" | "all";
  readonly controller: AbortController;
  readonly startedAt: string;
  state: JobState;
  finishedAt?: string;
  issueCount?: number;
  highestSeverity?: TestCommandResult["highestSeverity"];
  reportDirectory?: string;
  graphUrl?: string;
  videoUrl?: string;
  evidenceUrls?: readonly string[];
  metrics?: LocalUiScanMetrics;
  triage?: TriageSummary;
  qa?: PublicQaResult;
  /** Private: never returned by the local API, logs, or HTML. */
  qaTarget?: string;
  /** Private original QA report pin, rechecked before an acceptance browser runs. */
  qaOriginalSha256?: string;
  /** Private QA summary pin; immutable source classification/policy at acceptance. */
  qaSummarySha256?: string;
  acceptance?: PublicQaAcceptance;
  project?: PublicProjectCapture;
  projectAcceptance?: PublicProjectAcceptance;
  /** A validated offline coding-agent handoff, local-only and potentially containing app content. */
  projectHandoffUrl?: string;
  /** User-requested reusable config download; no secrets, raw env values or file paths. */
  projectConfigUrl?: string;
  /** Private, checked, server-generated manifest; never returned to clients. */
  manifestPath?: string;
  /** Byte pin for the UI-created manifest; drift cannot authorize a different project. */
  manifestSha256?: string;
  /** Authored public route fields and config remain private, not returned via status. */
  routeHealthConfigPath?: string;
  routeHealthConfigSha256?: string;
  routeHealthOriginalSha256?: string;
  /** Original trusted capture UUID for retry after an INCONCLUSIVE repair check. */
  routeHealthOriginalId?: string;
  routeHealthRequest?: LocalRouteHealthRequest;
  routeHealth?: { readonly status: "VERIFIED_ORIGINAL" | "INCONCLUSIVE";
    readonly originalSha256: string | null; readonly acceptReady: boolean;
    readonly links: Readonly<Partial<Record<"original", string>>>;
    readonly configDownloadUrl?: string };
  routeHealthAcceptance?: PublicLocalRouteHealthAcceptance;
  /** SPA route authored config and source witness are private, never returned as URL/text. */
  spaRouteHealthConfigPath?: string;
  spaRouteHealthConfigSha256?: string;
  spaRouteHealthOriginalSha256?: string;
  spaRouteHealthOriginalId?: string;
  spaRouteHealthRequest?: LocalSpaRouteHealthRequest;
  spaRouteHealth?: { readonly status: "VERIFIED_ORIGINAL" | "INCONCLUSIVE";
    readonly originalSha256: string | null; readonly acceptReady: boolean;
    readonly links: Readonly<Partial<Record<"original", string>>>;
    readonly configDownloadUrl?: string };
  spaRouteHealthAcceptance?: PublicLocalSpaRouteHealthAcceptance;
  /** Server-owned source route/authored content and original SHA (never in status JSON). */
  bootHealthConfigPath?: string;
  bootHealthConfigSha256?: string;
  bootHealthOriginalSha256?: string;
  bootHealthOriginalId?: string;
  bootHealthRequest?: LocalBootHealthRequest;
  bootHealth?: { readonly status: "VERIFIED_ORIGINAL" | "INCONCLUSIVE";
    readonly originalSha256: string | null; readonly acceptReady: boolean;
    readonly links: Readonly<Partial<Record<"original", string>>>;
    readonly configDownloadUrl?: string };
  bootHealthAcceptance?: PublicLocalBootHealthAcceptance;
  acceptReady?: boolean;
  message?: string;
}

const BODY_LIMIT = 4096;
const REPORT_LIMIT = 64 * 1024 * 1024;
const REPORT_EXTENSIONS = new Set([
  ".html", ".css", ".js", ".json", ".png", ".jpg", ".jpeg", ".webp",
  ".svg", ".md", ".txt", ".webm", ".mp4",
]);
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
};

class RequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function inside(parent: string, child: string): boolean {
  const remainder = relative(parent, child);
  return remainder === "" || (remainder !== ".."
    && !remainder.startsWith(`..${sep}`)
    && !remainder.startsWith("/")
    && !remainder.startsWith("\\")
    && !/^[A-Za-z]:/u.test(remainder));
}

function json(res: ServerResponse, status: number, value: object): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

function parseScanRequest(value: unknown): Omit<LocalUiScanRequest, "outputPath" | "signal"> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError(400, "Invalid scan request.");
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !["url", "type", "input", "mode", "recordVideo", "maxRoutes", "viewportProfile", "exploreSpa"].includes(key))) {
    throw new RequestError(400, "Unknown scan fields.");
  }
  const { url, type = "navigation", input, mode, recordVideo = false, maxRoutes, viewportProfile, exploreSpa = false } = body;
  if (typeof url !== "string" || url.length === 0 || url.length > 2048
    || url !== url.trim() || [...url].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })) {
    throw new RequestError(400, "Enter a valid HTTP(S) URL without credentials.");
  }
  const target = safeTarget(url);
  if (target === null) {
    throw new RequestError(400, "Enter a valid HTTP(S) URL without credentials.");
  }
  if (type !== "navigation" && type !== "site" && type !== "responsive") {
    throw new RequestError(400, "Choose navigation, site, or responsive scan.");
  }
  if (input !== "keyboard" && input !== "remote") {
    throw new RequestError(400, "Choose keyboard or remote input.");
  }
  if (mode !== "quick" && mode !== "standard" && mode !== "deep") {
    throw new RequestError(400, "Choose quick, standard, or deep scan.");
  }
  if (typeof recordVideo !== "boolean") {
    throw new RequestError(400, "Choose whether to record video.");
  }
  if (typeof exploreSpa !== "boolean" || (type !== "site" && exploreSpa)) {
    throw new RequestError(400, "Experimental UI discovery is available for site scans only.");
  }
  if (type !== "navigation" && recordVideo) {
    throw new RequestError(400, "Video recording is currently available for navigation scans only.");
  }
  if (type !== "navigation" && input !== "keyboard") {
    throw new RequestError(400, "Site and responsive scans currently require keyboard input.");
  }
  if (maxRoutes !== undefined && (type !== "site" || !Number.isSafeInteger(maxRoutes)
    || typeof maxRoutes !== "number" || maxRoutes < 1 || maxRoutes > 20)) {
    throw new RequestError(400, "Site route limit must be an integer between 1 and 20.");
  }
  if (type === "site" && maxRoutes === undefined) {
    throw new RequestError(400, "Choose a site route limit between 1 and 20.");
  }
  if (type === "site" && (new URL(target).search !== "" || new URL(target).hash !== "")) {
    throw new RequestError(400, "Site exploration requires a URL without query parameters or fragments.");
  }
  if (viewportProfile !== undefined && (type !== "responsive"
    || viewportProfile !== "all")) {
    throw new RequestError(400, "Responsive scans currently test all three standard viewports.");
  }
  if (type === "responsive" && viewportProfile === undefined) {
    throw new RequestError(400, "Choose a responsive viewport profile.");
  }
  return {
    target, type, input, mode, recordVideo,
    ...(exploreSpa ? { exploreSpa: true } : {}),
    ...(typeof maxRoutes === "number" ? { maxRoutes } : {}),
    ...(viewportProfile === "all" ? { viewportProfile: "all" as const } : {}),
  };
}

function parseQaRequest(value: unknown): Omit<LocalUiQaRequest, "outputPath" | "signal"> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError(400, "Invalid QA request.");
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !["url", "mode", "safeInteractions", "safeLinks"].includes(key))) {
    throw new RequestError(400, "Unknown QA fields.");
  }
  const { url, mode = "standard", safeInteractions = true, safeLinks = false } = body;
  if (typeof url !== "string" || url.length === 0 || url.length > 2048 || url.trim() !== url
    || [...url].some((character) => (character.codePointAt(0) ?? 0) < 32
      || character.codePointAt(0) === 127)) {
    throw new RequestError(400, "Enter an HTTP(S) URL without credentials, query or fragment.");
  }
  const target = safeTarget(url);
  if (target === null || new URL(target).search !== "" || new URL(target).hash !== "") {
    throw new RequestError(400, "QA requires an HTTP(S) URL without credentials, query or fragment.");
  }
  if (mode !== "quick" && mode !== "standard" && mode !== "deep") {
    throw new RequestError(400, "Choose quick, standard, or deep QA.");
  }
  if (typeof safeInteractions !== "boolean" || typeof safeLinks !== "boolean"
    || (safeLinks && !safeInteractions)) {
    throw new RequestError(400, "Safe link checks require enabled restricted interactions.");
  }
  return { target, mode, safeInteractions, safeLinks };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (req.headers["content-type"] !== "application/json") {
    throw new RequestError(415, "JSON requests are required.");
  }
  const length = req.headers["content-length"];
  if (length !== undefined && (!/^\d+$/u.test(length) || Number(length) > BODY_LIMIT)) {
    throw new RequestError(413, "Request body is too large.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > BODY_LIMIT) throw new RequestError(413, "Request body is too large.");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new RequestError(400, "Invalid JSON request.");
  }
}

function tokenMatches(expected: string, candidate: string | string[] | undefined): boolean {
  if (typeof candidate !== "string" || candidate.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(candidate));
}

function publicMetrics(value: LocalUiScanMetrics | undefined): LocalUiScanMetrics | undefined {
  if (value === undefined) return undefined;
  const metrics: Record<string, number> = {};
  for (const key of [
    "routesVisited", "routesLimit", "routesDiscovered", "viewportsTested", "viewportsRequested",
  ] as const) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0) {
      metrics[key] = candidate;
    }
  }
  return Object.keys(metrics).length > 0 ? metrics : undefined;
}

function presentJob(job: Job | null): object {
  if (job === null) return { state: "idle" };
  return {
    id: job.id,
    state: job.state,
    type: job.type,
    mode: job.mode,
    input: job.input,
    recordVideo: job.recordVideo,
    ...(job.exploreSpa ? { exploreSpa: true } : {}),
    ...(job.maxRoutes === undefined ? {} : { maxRoutes: job.maxRoutes }),
    ...(job.viewportProfile === undefined ? {} : { viewportProfile: job.viewportProfile }),
    startedAt: job.startedAt,
    ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
    ...(job.issueCount === undefined ? {} : { issueCount: job.issueCount }),
    ...(job.highestSeverity === undefined ? {} : { highestSeverity: job.highestSeverity }),
    ...(job.message === undefined ? {} : { message: job.message }),
    ...(job.metrics === undefined ? {} : { metrics: job.metrics }),
    ...(job.triage === undefined ? {} : { triage: job.triage }),
    ...(job.qa === undefined ? {} : { qa: job.qa }),
    ...(job.acceptance === undefined ? {} : { acceptance: job.acceptance }),
    ...(job.project === undefined ? {} : { project: job.project }),
    ...(job.projectAcceptance === undefined ? {} : { projectAcceptance: job.projectAcceptance }),
    ...(job.routeHealth === undefined ? {} : { routeHealth: job.routeHealth }),
    ...(job.routeHealthAcceptance === undefined ? {} : { routeHealthAcceptance: job.routeHealthAcceptance }),
    ...(job.routeHealthOriginalId === undefined ? {} : { routeHealthOriginalId: job.routeHealthOriginalId }),
    ...(job.spaRouteHealth === undefined ? {} : { spaRouteHealth: job.spaRouteHealth }),
    ...(job.spaRouteHealthAcceptance === undefined ? {} : { spaRouteHealthAcceptance: job.spaRouteHealthAcceptance }),
    ...(job.spaRouteHealthOriginalId === undefined ? {} : { spaRouteHealthOriginalId: job.spaRouteHealthOriginalId }),
    ...(job.bootHealth === undefined ? {} : { bootHealth: job.bootHealth }),
    ...(job.bootHealthAcceptance === undefined ? {} : { bootHealthAcceptance: job.bootHealthAcceptance }),
    ...(job.bootHealthOriginalId === undefined ? {} : { bootHealthOriginalId: job.bootHealthOriginalId }),
    ...(job.projectHandoffUrl === undefined ? {} : { projectHandoffUrl: job.projectHandoffUrl }),
    ...(job.projectConfigUrl === undefined ? {} : { projectConfigUrl: job.projectConfigUrl }),
    ...(job.acceptReady ? { acceptReady: true } : {}),
    ...(job.reportDirectory === undefined || ["qa", "qa-accept", "project", "project-accept", "route-health", "route-health-accept", "spa-route-health", "spa-route-health-accept", "boot-health", "boot-health-accept"].includes(job.type)
      ? {} : { reportUrl: `/reports/${job.id}/report.html` }),
    ...(job.graphUrl === undefined ? {} : { graphUrl: job.graphUrl }),
    ...(job.videoUrl === undefined ? {} : { videoUrl: job.videoUrl }),
    ...(job.evidenceUrls === undefined ? {} : { evidenceUrls: job.evidenceUrls }),
  };
}

/** Session-local history metadata, never raw routes, configuration, browser text or paths. */
function presentHistoryRow(job: Job): object {
  const publicStatus = job.qa?.status ?? job.acceptance?.status ?? job.project?.status
    ?? job.projectAcceptance?.status ?? job.routeHealth?.status
    ?? job.routeHealthAcceptance?.status ?? null;
  const spaStatus = job.bootHealth?.status ?? job.bootHealthAcceptance?.status
    ?? job.spaRouteHealth?.status ?? job.spaRouteHealthAcceptance?.status ?? publicStatus;
  const qaCounts = job.qa?.summary;
  const freshCounts = job.bootHealthAcceptance?.regression
    ?? job.routeHealthAcceptance?.regression ?? job.spaRouteHealthAcceptance?.regression;
  const projectCounts = job.project?.summary;
  return {
    id: job.id, type: job.type, state: job.state, startedAt: job.startedAt,
    ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
    ...(spaStatus === null ? {} : { status: spaStatus }),
    ...(qaCounts === null || qaCounts === undefined ? {} : {
      summary: { verified: qaCounts.verified, review: qaCounts.review, untested: qaCounts.untested },
    }),
    ...(freshCounts === undefined ? {} : {
      summary: { verified: freshCounts.verified, review: freshCounts.review,
        untested: freshCounts.untested },
    }),
    ...(projectCounts === undefined ? {} : {
      summary: { verified: projectCounts.verified, review: projectCounts.review },
    }),
  };
}

function qaCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
}

/**
 * Trust the saved production QA summary only when it agrees with its host result
 * and has actual, bounded, same-run evidence. Never turn a missing output into PASS.
 * The API intentionally returns no URL, filesystem path, browser text or issue prose.
 */
async function inspectQaResult(root: string, jobId: string,
  result: QaWorkflowResult, request: Pick<LocalUiQaRequest, "target" | "mode" | "safeInteractions" | "safeLinks">,
): Promise<PublicQaResult | null> {
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) return null;
    const summaryPath = join(root, "qa-summary.json");
    if (result.summaryPath !== summaryPath) return null;
    const metadata = await lstat(summaryPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > 128 * 1024
      || await realpath(summaryPath) !== summaryPath) return null;
    const saved = JSON.parse(await readFile(summaryPath, "utf8")) as unknown;
    if (saved === null || typeof saved !== "object" || Array.isArray(saved)) return null;
    const row = saved as Record<string, unknown>;
    if (row["schemaVersion"] !== "tvdoctor.qa/v1" || row["source"] !== "url"
      || row["status"] !== result.status || row["exitCode"] !== result.exitCode
      || row["shouldFail"] !== result.shouldFail || row["summaryPath"] !== summaryPath
      || row["reason"] !== result.reason || row["originalPath"] !== result.originalPath
      || row["handoffPath"] !== result.handoffPath
      || row["agentBriefPath"] !== result.agentBriefPath) return null;
    const status = result.status;
    if (!["ACTION_REQUIRED", "REVIEW_REQUIRED", "NO_VERIFIED_FAILURES_IN_COVERAGE", "INCONCLUSIVE"].includes(status)
      || ![0, 1, 3, 4].includes(result.exitCode)
      || result.shouldFail !== (result.exitCode !== 0)) return null;
    const summary = result.summary;
    if (summary === null) {
      if (status !== "INCONCLUSIVE" || row["summary"] !== null || result.exitCode === 0
        || result.originalPath !== null || result.handoffPath !== null
        || result.agentBriefPath !== null) return null;
      return { status, summary: null, links: { summary: `/reports/${jobId}/qa-summary.json` } };
    }
    if (typeof row["summary"] !== "object" || row["summary"] === null
      || Object.keys(summary).some((key) => !["routes", "verified", "review", "untested", "incompleteRoutes", "selected"].includes(key))) return null;
    const savedSummary = row["summary"] as Record<string, unknown>;
    for (const key of ["routes", "verified", "review", "untested", "incompleteRoutes", "selected"] as const) {
      if (!qaCount(summary[key]) || savedSummary[key] !== summary[key]) return null;
    }
    if (status !== "INCONCLUSIVE" && summary.incompleteRoutes !== 0) return null;
    if (status === "REVIEW_REQUIRED" && summary.review === 0) return null;
    if (status === "ACTION_REQUIRED" ? result.exitCode !== 1 || summary.verified === 0
      : status === "INCONCLUSIVE" ? result.exitCode !== 3 || summary.incompleteRoutes === 0
        : result.exitCode !== 0 || summary.verified !== 0) return null;
    if (status === "NO_VERIFIED_FAILURES_IN_COVERAGE" && summary.review > 0) return null;
    // A QA summary is NOT authoritative merely because its JSON agrees with
    // the returned host object. Bind the original *bytes*, route, scan policy
    // and every class count to this request before exposing completed status.
    // Historical reports without a source SHA remain inspectable offline, but
    // cannot produce a dashboard success or acceptance handle.
    const policy = result.scanPolicy;
    const savedPolicy = row["scanPolicy"];
    if (policy?.schemaVersion !== "tvdoctor.qa-scan-policy/v1"
      || savedPolicy === null || typeof savedPolicy !== "object" || Array.isArray(savedPolicy)
      || JSON.stringify(savedPolicy) !== JSON.stringify(policy)
      || !/^[a-f0-9]{64}$/u.test(policy.reportSha256)
      || policy.mode !== request.mode || policy.failOn !== "any"
      || policy.safeInteractions !== request.safeInteractions
      || policy.safeLinks !== request.safeLinks || summary.routes !== 1
      || summary.selected > summary.verified + summary.review
      || (status === "INCONCLUSIVE" ? summary.incompleteRoutes !== 1
        : summary.incompleteRoutes !== 0)) return null;
    const sourceDir = join(root, "original");
    const sourcePath = join(sourceDir, "report.json");
    const directory = await lstat(sourceDir);
    const sourceInfo = await lstat(sourcePath);
    if (!directory.isDirectory() || directory.isSymbolicLink()
      || !sourceInfo.isFile() || sourceInfo.isSymbolicLink()
      || sourceInfo.size < 1 || sourceInfo.size > REPORT_LIMIT
      || await realpath(sourceDir) !== sourceDir || await realpath(sourcePath) !== sourcePath) return null;
    const originalBytes = await readFile(sourcePath);
    const originalAfter = await lstat(sourcePath);
    const reportSha = createHash("sha256").update(originalBytes).digest("hex");
    if (originalBytes.length !== sourceInfo.size || originalAfter.size !== sourceInfo.size
      || originalAfter.ino !== sourceInfo.ino || originalAfter.mtimeMs !== sourceInfo.mtimeMs
      || reportSha !== policy.reportSha256) return null;
    const sourceReport = parseTVDoctorReportJson(originalBytes.toString("utf8"));
    const triage = await inspectReport(sourcePath, { maxFindings: 100 });
    if (sourceReport.schemaVersion !== REPORT_SCHEMA_VERSION_V1
      || sourceReport.run.status !== (status === "INCONCLUSIVE" ? "partial" : "completed")
      || sourceReport.run.mode !== request.mode
      || sourceReport.target.platform !== "web" || sourceReport.target.location !== request.target
      || sourceReport.target.environment["browser"] !== "chromium"
      || sourceReport.target.environment["inputMode"] !== "keyboard"
      || sourceReport.target.environment["keyboardInteractions"]
        !== (request.safeInteractions ? "enabled" : "disabled")
      || sourceReport.target.environment["safeLinkNavigation"]
        !== (request.safeLinks ? "enabled" : "disabled")
      || triage.coverage.incomplete !== (status === "INCONCLUSIVE")
      || triage.coverage.packsOmitted !== 0
      || triage.summary.omitted !== 0 || ["degraded", "bounded"].includes(triage.integrity.evidence)
      || triage.summary.VERIFIED !== summary.verified
      || triage.summary.REVIEW !== summary.review
      || triage.summary.UNTESTED !== summary.untested
      || createHash("sha256").update(await readFile(sourcePath)).digest("hex") !== reportSha) return null;
    const files: readonly [keyof PublicQaResult["links"], string | null, string][] = [
      ["report", result.originalPath, "original/report.json"],
      ["brief", result.agentBriefPath, "AGENT_REPAIR_BRIEF.md"],
      ["handoff", result.handoffPath, "handoff.json"],
    ];
    const links: Record<string, string> = { summary: `/reports/${jobId}/qa-summary.json` };
    for (const [key, given, relativeName] of files) {
      const path = join(root, relativeName);
      if (given !== path) return null;
      const file = await lstat(path);
      if (!file.isFile() || file.isSymbolicLink() || file.size < 1 || file.size > REPORT_LIMIT
        || !inside(root, await realpath(path))) return null;
      links[key] = `/reports/${jobId}/${relativeName}`;
    }
    const originalDirectory = join(root, "original");
    if ((await lstat(originalDirectory)).isSymbolicLink()) return null;
    try {
      const html = join(originalDirectory, "report.html");
      const file = await lstat(html);
      if (file.isFile() && !file.isSymbolicLink() && file.size <= REPORT_LIMIT
        && inside(root, await realpath(html))) links["report"] = `/reports/${jobId}/original/report.html`;
    } catch { /* The original report JSON remains available. */ }
    return { status, summary, links };
  } catch { return null; }
}

/** Only publish the actual on-disk result of independent replay + fresh QA. */
async function inspectQaAcceptance(root: string, jobId: string, result: QaAcceptResult,
  originalQa: PublicQaResult): Promise<PublicQaAcceptance | null> {
  try {
    const directory = await lstat(root);
    if (!directory.isDirectory() || directory.isSymbolicLink() || await realpath(root) !== root
      || result.acceptancePath !== "qa-accept.json") return null;
    const path = join(root, "qa-accept.json");
    const file = await lstat(path);
    if (!file.isFile() || file.isSymbolicLink() || file.size < 1 || file.size > 64 * 1024
      || await realpath(path) !== path) return null;
    const saved = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (saved === null || typeof saved !== "object" || Array.isArray(saved)
      || JSON.stringify(saved) !== JSON.stringify(result)
      || result.schemaVersion !== "tvdoctor.qa-accept/v1"
      || result.shouldFail !== (result.exitCode !== 0)) return null;
    const { verification, regression } = result;
    if (!verification || !regression || !result.original
      || originalQa.status !== "ACTION_REQUIRED" || originalQa.summary === null
      || originalQa.summary.incompleteRoutes !== 0
      || result.original.verified !== originalQa.summary.verified
      || typeof result.original.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(result.original.sha256)
      || !["COMPLETED", "INCOMPLETE", "NOT_RUN"].includes(regression.status)
      || !/^[A-Z_]{1,35}$/u.test(verification.status)
      || !["PASS", "REPRODUCED", "REGRESSION_FOUND", "INCONCLUSIVE", "ERROR"].includes(result.status)) return null;
    for (const value of [result.original.verified, verification.fixed, verification.reproduced,
      verification.inconclusive, regression.verified, regression.review, regression.untested]) {
      if (!qaCount(value)) return null;
    }
    if (result.status === "PASS" ? result.exitCode !== 0 || verification.reproduced !== 0
      || verification.inconclusive !== 0 || verification.fixed !== result.original.verified
      || regression.status !== "COMPLETED" || regression.verified !== 0
      : result.status === "REPRODUCED" ? result.exitCode !== 1 || verification.reproduced === 0
        : result.status === "REGRESSION_FOUND" ? result.exitCode !== 1
          || verification.reproduced !== 0 || regression.verified === 0
          : result.status === "INCONCLUSIVE" ? result.exitCode !== 2 && result.exitCode !== 3
            : result.exitCode !== 4) return null;
    const links: Record<string, string> = { summary: `/reports/${jobId}/qa-accept.json` };
    for (const [key, relativeName, expectedName] of [
      ["verification", verification.summaryPath, "verification/qa-verification.json"],
      ["regression", regression.summaryPath, "regression/qa-summary.json"],
    ] as const) {
      if (relativeName === null) continue;
      if (relativeName !== expectedName) return null;
      const asset = join(root, relativeName);
      const parent = await lstat(dirname(asset));
      const metadata = await lstat(asset);
      if (parent.isSymbolicLink() || !parent.isDirectory() || !metadata.isFile()
        || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > REPORT_LIMIT
        || !inside(root, await realpath(asset))) return null;
      links[key] = `/reports/${jobId}/${relativeName}`;
    }
    return { status: result.status,
      verification: { status: verification.status,
        fixed: verification.fixed, reproduced: verification.reproduced,
        inconclusive: verification.inconclusive },
      regression: { status: regression.status, verified: regression.verified,
        review: regression.review, untested: regression.untested },
      links, originalLinks: originalQa.links };
  } catch { return null; }
}

function decodeReportSegments(rawPath: string): string[] {
  const rawSegments = rawPath.split("/");
  if (rawSegments.length === 0 || rawSegments.length > 12) {
    throw new RequestError(404, "Report file not found.");
  }
  return rawSegments.map((segment) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new RequestError(404, "Report file not found.");
    }
    // Reject absolute paths, percent-encoded second passes, traversal and NTFS alternate streams.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(decoded)
      || decoded === "." || decoded === ".." || decoded.endsWith(".")) {
      throw new RequestError(404, "Report file not found.");
    }
    return decoded;
  });
}

export async function serveLocalUi(options: LocalUiOptions): Promise<LocalUiServer> {
  if (options.port !== undefined && (!Number.isInteger(options.port)
    || options.port < 0 || options.port > 65535)) {
    throw new TypeError("UI port must be between 0 and 65535.");
  }
  const outputRoot = resolve(options.outputRoot ?? join(process.cwd(), "Tests", "ui"));
  const csrfToken = randomBytes(32).toString("base64url");
  const jobs = new Map<string, Job>();
  let current: Job | null = null;
  let origin = "";
  let host = "";
  const scanActive = (): boolean => current?.state === "running" || current?.state === "cancelling";

  async function manifestUnchanged(job: Job): Promise<boolean> {
    if (job.manifestPath === undefined || job.manifestSha256 === undefined) return false;
    try {
      const metadata = await lstat(job.manifestPath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0
        || metadata.size > 64 * 1024 || await realpath(job.manifestPath) !== job.manifestPath) return false;
      const bytes = await readFile(job.manifestPath);
      return bytes.length === metadata.size && createHash("sha256").update(bytes).digest("hex") === job.manifestSha256;
    } catch { return false; }
  }

  const server = createServer({
    maxHeaderSize: 8192,
    headersTimeout: 10_000,
    requestTimeout: 10_000,
    keepAliveTimeout: 2_000,
  }, (req, res) => {
    void handle(req, res).catch((error: unknown) => {
      // Never forward exception strings: browser errors and target URLs can be sensitive.
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const code = error instanceof RequestError ? error.status : 500;
      json(res, code, {
        error: error instanceof RequestError ? error.message : "The local UI could not complete this request.",
      });
    });
  });

  async function runJob(
    job: Job, request: Omit<LocalUiScanRequest, "outputPath" | "signal">,
  ): Promise<void> {
    const outputPath = join(outputRoot, job.id);
    try {
      const outcome = await options.runScan({ ...request, outputPath, signal: job.controller.signal });
      if (outcome.result !== null) {
        job.issueCount = outcome.result.issueCount;
        job.highestSeverity = outcome.result.highestSeverity;
      }
      const metrics = publicMetrics(outcome.metrics);
      if (metrics !== undefined) job.metrics = metrics;
      const finishedState = outcome.result?.status === "completed"
        ? "completed"
        : outcome.result?.status === "partial"
          ? "partial" : job.controller.signal.aborted ? "cancelled" : "failed";
      // CLI exit 1 can mean verified findings. The scanner's result is authoritative.
      if (outcome.result?.reportPath !== null && outcome.result?.reportPath !== undefined) {
        try {
          const reportDirectory = resolve(dirname(outcome.result.reportPath));
          const expectedRoot = resolve(outputPath);
          if (inside(expectedRoot, reportDirectory)) {
            const [realRoot, realDirectory] = await Promise.all([
              realpath(expectedRoot),
              realpath(reportDirectory),
            ]);
            if (inside(realRoot, realDirectory)) {
              const html = join(realDirectory, "report.html");
              const htmlMetadata = await stat(html);
              if (htmlMetadata.isFile()) {
                job.reportDirectory = realDirectory;
                for (const [name, relativePath] of [
                  ["graphUrl", "navigation-graph.html"],
                  ["videoUrl", join("video", "audit-session.webm")],
                ] as const) {
                  try {
                    const asset = await realpath(join(realDirectory, relativePath));
                    if (inside(realDirectory, asset) && (await stat(asset)).isFile()) {
                      job[name] = `/reports/${job.id}/${relativePath.replaceAll("\\", "/")}`;
                    }
                  } catch {
                    // Optional asset not produced. No link is displayed.
                  }
                }
                const evidenceUrls: string[] = [];
                for (const candidate of (outcome.evidencePaths ?? []).slice(0, 8)) {
                  if (!/^(?:pages\/[0-9]{3}\/report\.html|responsive\/(?:mobile|tablet|desktop)\/page-[0-9]{2}\.png)$/u.test(candidate)) {
                    continue;
                  }
                  try {
                    const asset = await realpath(join(realDirectory, candidate));
                    const evidence = await stat(asset);
                    if (inside(realDirectory, asset) && evidence.isFile() && evidence.size <= REPORT_LIMIT) {
                      evidenceUrls.push(`/reports/${job.id}/${candidate}`);
                    }
                  } catch {
                    // Do not expose missing or out-of-root artifacts.
                  }
                }
                if (evidenceUrls.length > 0) job.evidenceUrls = evidenceUrls;
              }
            }
          }
        } catch {
          // Missing output never upgrades or downgrades the scanner's classification.
        }
      }
      if (job.reportDirectory !== undefined && job.type !== "qa" && job.type !== "qa-accept"
        && job.type !== "project" && job.type !== "project-accept"
        && job.type !== "route-health" && job.type !== "route-health-accept"
        && job.type !== "spa-route-health" && job.type !== "spa-route-health-accept"
        && job.type !== "boot-health" && job.type !== "boot-health-accept") {
        try {
          job.triage = await readLocalTriage(job.reportDirectory, job.id, job.type, finishedState,
            job.spaTargetIdentity);
        } catch {
          // Triage is optional; a failed or oversized index cannot change the scanner result.
        }
      }
      if (finishedState === "failed") job.message = "Scan failed. Check the target and browser setup.";
      else if (finishedState === "partial") job.message = "Partial scan. Review the report for untested paths and limits.";
      else if (finishedState === "cancelled") job.message = "Scan cancelled; no complete report was returned.";
      else job.message = "Scan finished. Review the findings and coverage in the report.";
      if (job.controller.signal.aborted && finishedState === "completed") {
        job.message = "Scan completed as cancellation was requested. Review its recorded coverage.";
      }
      if (job.reportDirectory === undefined && (finishedState === "partial" || finishedState === "completed")) {
        job.message = finishedState === "partial"
          ? "Partial scan. The HTML report is unavailable in the dashboard; check the Tests/ui output folder."
          : "Scan finished, but the HTML report is unavailable in the dashboard. Check the Tests/ui output folder.";
      }
      job.finishedAt = new Date().toISOString();
      // Publish terminal state after links and summary fields are fully populated.
      job.state = finishedState;
    } catch {
      job.message = job.controller.signal.aborted
        ? "Scan stopped after cancellation. Any partial files remain in the local output folder."
        : "Scan could not finish. Check the target and local browser setup.";
      job.finishedAt = new Date().toISOString();
      job.state = job.controller.signal.aborted ? "cancelled" : "failed";
    }
  }

  async function runQaJob(job: Job,
    request: Omit<LocalUiQaRequest, "outputPath" | "signal">): Promise<void> {
    const outputPath = join(outputRoot, job.id);
    try {
      const outcome = await options.runQa?.({ ...request, outputPath, signal: job.controller.signal });
      const validated = outcome === undefined ? null : await inspectQaResult(outputPath, job.id, outcome, request);
      if (validated === null) {
        job.message = "QA evidence was incomplete or could not be validated. Review the local run output.";
        job.state = job.controller.signal.aborted ? "cancelled" : "failed";
      } else {
        job.qa = validated;
        if (validated.status === "ACTION_REQUIRED") job.qaTarget = request.target;
        if (validated.summary !== null && outcome?.scanPolicy !== undefined) {
          job.qaOriginalSha256 = outcome.scanPolicy.reportSha256;
          job.qaSummarySha256 = createHash("sha256")
            .update(await readFile(join(outputPath, "qa-summary.json"))).digest("hex");
        }
        job.acceptReady = options.runQaAccept !== undefined
          && validated.status === "ACTION_REQUIRED"
          && validated.summary?.routes === 1
          && validated.summary.incompleteRoutes === 0
          && validated.summary.verified >= 1 && validated.summary.verified <= 16;
        // Only the exact validated local run can be served. Never expose the host-returned paths.
        job.reportDirectory = await realpath(outputPath);
        // The recommended QA view should expose actual issue cards, not just
        // totals and a download. Only publish bounded, redacted previews when
        // a separately validated original report agrees with the QA counts.
        // Never use app-authored titles, labels, URLs or error text in the API.
        if (validated.summary !== null && validated.status !== "INCONCLUSIVE") {
          try {
            const original = join(outputPath, "original", "report.json");
            const source = await inspectReport(original);
            if (source.run.status === "completed" && !source.coverage.incomplete
              && source.summary.VERIFIED === validated.summary.verified
              && source.summary.REVIEW === validated.summary.review
              && source.summary.UNTESTED === validated.summary.untested) {
              const preview = await readLocalTriage(outputPath, job.id, "qa", "completed");
              // The second parser may read a different report with identical
              // counts. Never attach issue cards from bytes other than the
              // original source SHA accepted by inspectQaResult.
              const pinned = outcome?.scanPolicy?.reportSha256;
              const unchanged = typeof pinned === "string"
                && createHash("sha256").update(await readFile(original)).digest("hex") === pinned;
              if (unchanged && preview.total === source.summary.total && preview.limits.length === 0) {
                job.triage = preview;
              }
            }
          } catch { /* Optional issue cards never change the QA verdict. */ }
        }
        if (validated.summary !== null) {
          // Treat any mutation during issue-card generation as a failed QA
          // handoff, not a completed result with potentially stale links.
          const original = join(outputPath, "original", "report.json");
          const pinned = outcome?.scanPolicy?.reportSha256;
          if (typeof pinned !== "string"
            || createHash("sha256").update(await readFile(original)).digest("hex") !== pinned) {
            delete job.qa;
            delete job.triage;
            job.acceptReady = false;
            delete job.qaTarget;
            delete job.qaOriginalSha256;
            delete job.qaSummarySha256;
            delete job.reportDirectory;
            job.state = "failed";
            job.message = "QA original evidence changed during dashboard validation. No completion or acceptance was certified.";
            job.finishedAt = new Date().toISOString();
            return;
          }
        }
        job.state = validated.status === "INCONCLUSIVE" ? "partial" : "completed";
        job.message = validated.status === "ACTION_REQUIRED"
          ? "Verified original findings need repair. Open the agent brief and evidence before changing code."
          : validated.status === "REVIEW_REQUIRED"
            ? "Review suspected findings and incomplete coverage; none was independently confirmed as fixed."
            : validated.status === "NO_VERIFIED_FAILURES_IN_COVERAGE"
              ? "No verified failures in observed coverage. Unvisited paths are still unknown."
              : "QA could not establish complete evidence. This result is inconclusive.";
        if (job.controller.signal.aborted) {
          job.message = "Cancellation was requested. Review only the evidence the QA engine actually saved.";
        }
      }
    } catch {
      job.state = job.controller.signal.aborted ? "cancelled" : "failed";
      job.message = "QA could not finish. Check the local browser setup and permissions.";
    }
    job.finishedAt = new Date().toISOString();
  }

  async function runQaAcceptJob(job: Job, source: Job): Promise<void> {
    const outputPath = join(outputRoot, job.id);
    try {
      const outcome = await options.runQaAccept?.({
        originalQaPath: join(outputRoot, source.id),
        target: source.qaTarget ?? "",
        outputPath, signal: job.controller.signal,
      });
      const validated = outcome === undefined || source.qa === undefined ? null
        : await inspectQaAcceptance(outputPath, job.id, outcome, source.qa);
      if (validated === null) {
        job.state = job.controller.signal.aborted ? "cancelled" : "failed";
        job.message = "Acceptance evidence could not be validated. No repair was certified.";
      } else {
        job.acceptance = validated;
        job.reportDirectory = await realpath(outputPath);
        job.state = validated.status === "INCONCLUSIVE" ? "partial"
          : validated.status === "ERROR" ? "failed" : "completed";
        job.message = validated.status === "PASS"
          ? "Supported original issues were independently FIXED. The bounded fresh QA found no VERIFIED failures; REVIEW and untested paths remain."
          : validated.status === "REPRODUCED"
            ? "An original failure was independently REPRODUCED after repair. Check the verification evidence."
            : validated.status === "REGRESSION_FOUND"
              ? "Fresh QA observed VERIFIED failures. They may predate the repair; inspect before attributing a regression."
              : validated.status === "INCONCLUSIVE"
                ? "Post-repair verification is INCONCLUSIVE. No supported issue was silently marked FIXED."
                : "Post-repair acceptance failed to execute completely. No repair was certified.";
      }
    } catch {
      job.state = job.controller.signal.aborted ? "cancelled" : "failed";
      job.message = "Post-repair acceptance could not finish. No repair was certified.";
    }
    job.finishedAt = new Date().toISOString();
  }

  async function runProjectJob(job: Job, manifestPath: string): Promise<void> {
    const outputPath = join(outputRoot, job.id);
    try {
      const result = await options.runProject?.({
        manifestPath, outputPath, signal: job.controller.signal,
      });
      const validated = result === undefined ? null
        : await inspectLocalProjectCapture(outputPath, job.id, result);
      if (validated === null || !await manifestUnchanged(job)) {
        job.state = job.controller.signal.aborted ? "cancelled" : "failed";
        job.message = "Project evidence was unavailable or inconsistent. No clean result was certified.";
      } else {
        job.project = validated;
        job.manifestPath = manifestPath;
        job.projectConfigUrl = `/api/project/${job.id}/manifest`;
        job.reportDirectory = await realpath(outputPath);
        job.acceptReady = options.runProjectAccept !== undefined && validated.acceptReady;
        try {
          // Produce an immediately useful local repair handoff using the
          // existing source-verified offline flow; never invent issue details.
          // Optional export failure cannot promote or downgrade the scan.
          const handoff = await createFirstRunHandoff({ projectSummaryPath: join(outputPath, "summary.json") });
          await writeFile(join(outputPath, "AGENT_PROJECT_HANDOFF.txt"),
            formatFirstRunHandoff(handoff), { flag: "wx", mode: 0o600 });
          job.projectHandoffUrl = `/reports/${job.id}/AGENT_PROJECT_HANDOFF.txt`;
        } catch {
          // A missing handoff is visible by the absence of its link.
        }
        job.state = validated.status === "INCONCLUSIVE" ? "partial" : "completed";
        job.message = validated.status === "FINDINGS"
          ? "Verified original issues were found. Inspect the affected routes, repair the app, then independently accept the original evidence."
          : validated.status === "INCONCLUSIVE"
            ? validated.routes.some((route) => route.reason === "authentication-journey-failed")
              ? "An approved login journey failed. Inspect the private login steps and protected assertions, download the unchanged configuration, then rerun. No route was certified."
              : "Some project routes are inconclusive. Review incomplete evidence and retry; no repair can be certified."
            : "Project scan finished. Review measured route coverage and any unverified leads before deciding on changes.";
      }
    } catch {
      job.state = job.controller.signal.aborted ? "cancelled" : "failed";
      job.message = "Project scan failed. Check your configured test routes and journey environment names.";
    }
    job.finishedAt = new Date().toISOString();
  }

  async function runProjectAcceptJob(job: Job, source: Job): Promise<void> {
    const outputPath = join(outputRoot, job.id);
    try {
      const outcome = source.manifestPath === undefined ? undefined : await options.runProjectAccept?.({
        manifestPath: source.manifestPath,
        originalSummaryPath: join(outputRoot, source.id, "summary.json"),
        outputPath, signal: job.controller.signal,
      });
      const validated = outcome === undefined || source.project === undefined ? null
        : await inspectLocalProjectAcceptance(outputPath, job.id, outcome, source.project);
      if (validated === null || !await manifestUnchanged(source)) {
        job.state = job.controller.signal.aborted ? "cancelled" : "failed";
        job.message = "Project acceptance evidence was incomplete or inconsistent. No PASS was certified.";
      } else {
        job.projectAcceptance = validated;
        if (source.projectHandoffUrl !== undefined) job.projectHandoffUrl = source.projectHandoffUrl;
        if (source.projectConfigUrl !== undefined) job.projectConfigUrl = source.projectConfigUrl;
        job.reportDirectory = await realpath(outputPath);
        job.state = validated.status === "INCONCLUSIVE" ? "partial"
          : validated.status === "ERROR" ? "failed" : "completed";
        job.message = validated.status === "PASS"
          ? "All supported originals were independently FIXED and the fresh bounded project scan found no VERIFIED failures."
          : validated.status === "REPRODUCED"
            ? "At least one original failure was independently REPRODUCED. Inspect the original replay outcomes."
            : validated.status === "NEW_VERIFIED"
              ? "Fresh project QA observed VERIFIED issues. They are not automatically caused by the repair."
              : "Independent verification or fresh project coverage was inconclusive; no repair PASS is claimed.";
      }
    } catch {
      job.state = job.controller.signal.aborted ? "cancelled" : "failed";
      job.message = "Project acceptance could not complete. No repair was certified.";
    }
    job.finishedAt = new Date().toISOString();
  }

  async function runRouteHealthCaptureJob(job: Job, request: LocalRouteHealthRequest): Promise<void> {
    const outputPath = join(outputRoot, job.id);
    try {
      if (job.controller.signal.aborted) throw new Error("cancelled");
      await mkdir(outputRoot, { recursive: true });
      const parent = await lstat(outputRoot);
      if (!parent.isDirectory() || parent.isSymbolicLink()
        || await realpath(outputRoot) !== outputRoot) {
        throw new Error("unsafe-local-output");
      }
      const config = await prepareLocalRouteHealthConfig(request, outputRoot, job.id);
      job.routeHealthConfigPath = config.configPath;
      job.routeHealthConfigSha256 = config.configSha256;
      if (job.controller.signal.aborted) throw new Error("cancelled");
      const result = await options.runRouteHealth?.({ action: "capture",
        configPath: config.configPath, outputPath, signal: job.controller.signal });
      const verified = result?.schemaVersion === "tvdoctor.public-route-health-command/v1"
        && result.status === "VERIFIED_ORIGINAL"
        ? await inspectLocalRouteHealthCapture(outputPath, job.id, {
          schemaVersion: "tvdoctor.public-route-health-capture/v1",
          classification: result.status, originalPath: join(outputPath, "original.json"),
          originalSha256: result.originalSha256, reason: result.reason,
        }, request,
          config.configSha256) : null;
      if (job.controller.signal.aborted) {
        job.state = "cancelled";
        job.message = "Original route check was cancelled; no repair evidence is certified.";
      } else if (verified === null) {
        job.state = "partial";
        job.message = "The original route did not produce a trustworthy direct HTTP 404/410 witness. No repair can be certified.";
      } else {
        job.routeHealth = { status: verified.status,
          originalSha256: verified.originalSha256, acceptReady: verified.acceptReady,
          links: verified.links,
          ...(verified.acceptReady ? { configDownloadUrl: `/api/route-health/${job.id}/config` } : {}) };
        if (verified.originalSha256 !== null) job.routeHealthOriginalSha256 = verified.originalSha256;
        job.acceptReady = verified.acceptReady;
        job.reportDirectory = await realpath(outputPath);
        job.state = "completed";
        job.message = "Original HTTP 404/410 independently observed and SHA-pinned. Repair the authored public document, then verify it with separate fresh QA.";
      }
    } catch {
      job.state = job.controller.signal.aborted ? "cancelled" : "failed";
      job.message = "Public route capture failed or its original evidence was unsafe. No repair is certified.";
    }
    job.finishedAt = new Date().toISOString();
  }

  async function runRouteHealthAcceptJob(job: Job, source: Job,
    request: LocalRouteHealthRequest): Promise<void> {
    const outputPath = join(outputRoot, job.id);
    try {
      if (source.routeHealthConfigPath === undefined
        || source.routeHealthOriginalSha256 === undefined
        || source.routeHealthConfigSha256 === undefined) throw new Error("original missing");
      const result = await options.runRouteHealth?.({ action: "accept",
        configPath: source.routeHealthConfigPath,
        originalPath: join(outputRoot, source.id, "original.json"),
        originalSha256: source.routeHealthOriginalSha256,
        outputPath, signal: job.controller.signal });
      const verified = result?.schemaVersion === "tvdoctor.public-route-health-accept/v1"
        ? await inspectLocalRouteHealthAcceptance(outputPath, job.id, result,
          join(outputRoot, source.id), source.routeHealthOriginalSha256, request,
          source.routeHealthConfigSha256) : null;
      if (job.controller.signal.aborted) {
        job.state = "cancelled";
        job.message = "Acceptance cancellation requested. No repaired-state verdict was certified.";
      } else if (verified === null) {
        job.state = "failed";
        job.message = "The original, repaired-state or fresh regression evidence was invalid. No repair is certified.";
      } else {
        job.routeHealthAcceptance = {
          status: verified.status, verification: verified.verification,
          postRegressionVerification: verified.postRegressionVerification,
          regression: verified.regression, reason: verified.reason, links: verified.links,
        };
        job.state = verified.status === "INCONCLUSIVE" ? "partial"
          : verified.status === "ERROR" ? "failed" : "completed";
        job.reportDirectory = await realpath(outputPath);
        job.message = verified.status === "ROUTE_RESTORED"
          ? "The authored public document was independently restored, fresh bounded QA completed, and a final browser recheck remained FIXED. REVIEW and UNTESTED coverage remain."
          : verified.status === "REPRODUCED"
            ? "The original route failure was independently REPRODUCED, including a possible post-QA regression."
            : verified.status === "NEW_VERIFIED"
              ? "Fresh QA found new VERIFIED failures; no route acceptance is claimed."
              : "Verification or fresh regression was incomplete. No restored route is claimed.";
      }
    } catch {
      job.state = job.controller.signal.aborted ? "cancelled" : "failed";
      job.message = "Independent public route acceptance failed. No repair is certified.";
    }
    job.finishedAt = new Date().toISOString();
  }

  async function runSpaRouteHealthCaptureJob(job: Job, request: LocalSpaRouteHealthRequest): Promise<void> {
    const outputPath = join(outputRoot, job.id);
    try {
      if (job.controller.signal.aborted) throw new Error("cancelled");
      await mkdir(outputRoot, { recursive: true });
      const parent = await lstat(outputRoot);
      if (!parent.isDirectory() || parent.isSymbolicLink()
        || await realpath(outputRoot) !== outputRoot) throw new Error("unsafe-local-output");
      const config = await prepareLocalSpaRouteHealthConfig(request, outputRoot, job.id);
      job.spaRouteHealthConfigPath = config.configPath;
      job.spaRouteHealthConfigSha256 = config.configSha256;
      if (job.controller.signal.aborted) throw new Error("cancelled");
      const result = await options.runSpaRouteHealth?.({ action: "capture",
        configPath: config.configPath, outputPath, signal: job.controller.signal });
      const observed = result?.schemaVersion === "tvdoctor.spa-route-health-command/v1"
        && result.status === "VERIFIED_ORIGINAL"
        ? await inspectLocalSpaRouteHealthCapture(outputPath, job.id, result,
          request, config.configSha256) : null;
      if (job.controller.signal.aborted) {
        job.state = "cancelled";
        job.message = "SPA source capture was cancelled. No repaired-state evidence is certified.";
      } else if (observed === null) {
        job.state = "partial";
        job.message = "An exact same-document blank-main original could not be established. Check hydration, intentional empty states, and link safety; no repair can be certified.";
      } else {
        job.spaRouteHealth = { status: observed.status,
          originalSha256: observed.originalSha256, acceptReady: observed.acceptReady,
          links: observed.links,
          ...(observed.acceptReady ? { configDownloadUrl: `/api/spa-route-health/${job.id}/config` } : {}) };
        if (observed.originalSha256 !== null) job.spaRouteHealthOriginalSha256 = observed.originalSha256;
        job.acceptReady = observed.acceptReady;
        job.reportDirectory = await realpath(outputPath);
        job.state = "completed";
        job.message = "Original HTTP 200 SPA source and blank client-side destination observed in Chromium and SHA-pinned. This is a negative witness, not proof of an application defect. Repair the authored destination and independently accept it with fresh QA.";
      }
    } catch {
      job.state = job.controller.signal.aborted ? "cancelled" : "failed";
      job.message = "SPA capture failed or its evidence was incomplete. No repair is certified.";
    }
    job.finishedAt = new Date().toISOString();
  }

  async function runSpaRouteHealthAcceptJob(job: Job, source: Job,
    request: LocalSpaRouteHealthRequest): Promise<void> {
    const outputPath = join(outputRoot, job.id);
    try {
      if (source.spaRouteHealthConfigPath === undefined
        || source.spaRouteHealthOriginalSha256 === undefined
        || source.spaRouteHealthConfigSha256 === undefined) throw new Error("original missing");
      const outcome = await options.runSpaRouteHealth?.({ action: "accept",
        configPath: source.spaRouteHealthConfigPath,
        originalPath: join(outputRoot, source.id, "original.json"),
        originalSha256: source.spaRouteHealthOriginalSha256, outputPath,
        signal: job.controller.signal });
      const validated = outcome?.schemaVersion === "tvdoctor.spa-route-health-accept/v1"
        ? await inspectLocalSpaRouteHealthAcceptance(outputPath, job.id, outcome,
          join(outputRoot, source.id), source.spaRouteHealthOriginalSha256,
          request, source.spaRouteHealthConfigSha256) : null;
      if (job.controller.signal.aborted) {
        job.state = "cancelled";
        job.message = "SPA acceptance was cancelled. No restored-state verdict is certified.";
      } else if (validated === null) {
        job.state = "failed";
        job.message = "SPA original, repaired content or fresh regression evidence was missing or inconsistent. No repair is certified.";
      } else {
        job.spaRouteHealthAcceptance = validated;
        job.reportDirectory = await realpath(outputPath);
        job.state = validated.status === "INCONCLUSIVE" ? "partial"
          : validated.status === "ERROR" ? "failed" : "completed";
        job.message = validated.status === "ROUTE_CONTENT_RESTORED"
          ? "Authored SPA main content independently restored in two fresh Chromium journeys, separated by source-bound QA. REVIEW and UNTESTED observations remain unresolved."
          : validated.status === "REPRODUCED"
            ? "The blank client-side route remained REPRODUCED, including a possible post-QA regression."
            : validated.status === "NEW_VERIFIED"
              ? "Fresh QA observed another VERIFIED failure; no restored SPA route is certified."
              : "SPA original or fresh verification was inconclusive. HTTP 200 does not certify a repair.";
      }
    } catch {
      job.state = job.controller.signal.aborted ? "cancelled" : "failed";
      job.message = "Independent SPA route acceptance failed. No repair is certified.";
    }
    job.finishedAt = new Date().toISOString();
  }

  /** A successful HTML 200 alone never establishes a healthy initial render. */
  async function runBootHealthCaptureJob(job: Job, request: LocalBootHealthRequest): Promise<void> {
    const outputPath = join(outputRoot, job.id);
    try {
      if (job.controller.signal.aborted) throw new Error("cancelled");
      await mkdir(outputRoot, { recursive: true });
      const parent = await lstat(outputRoot);
      if (!parent.isDirectory() || parent.isSymbolicLink()
        || await realpath(outputRoot) !== outputRoot) throw new Error("unsafe-output-root");
      const config = await prepareLocalBootHealthConfig(request, outputRoot, job.id);
      job.bootHealthConfigPath = config.configPath;
      job.bootHealthConfigSha256 = config.configSha256;
      if (job.controller.signal.aborted) throw new Error("cancelled");
      const result = await options.runBootHealth?.({ action: "capture",
        configPath: config.configPath, outputPath, signal: job.controller.signal });
      const observed = result?.schemaVersion === "tvdoctor.boot-health-command/v1"
        && result.status === "VERIFIED_ORIGINAL"
        ? await inspectLocalBootHealthCapture(outputPath, job.id, result,
          request, config.configSha256) : null;
      if (job.controller.signal.aborted) {
        job.state = "cancelled";
        job.message = "Initial page capture was cancelled; no repair can be certified.";
      } else if (observed === null) {
        job.state = "partial";
        job.message = "An exact stable blank first-render MAIN could not be established. Delayed hydration, intentional empty states and access shells remain possible; no defect or repair is certified.";
      } else {
        job.bootHealth = { status: observed.status,
          originalSha256: observed.originalSha256, acceptReady: observed.acceptReady,
          links: observed.links,
          ...(observed.acceptReady ? { configDownloadUrl: `/api/boot-health/${job.id}/config` } : {}) };
        if (observed.originalSha256 !== null) job.bootHealthOriginalSha256 = observed.originalSha256;
        job.acceptReady = observed.acceptReady;
        job.reportDirectory = await realpath(outputPath);
        job.state = "completed";
        job.message = "An exact HTTP 200 initial document with stable blank MAIN was observed in Chromium and SHA-pinned. It is a negative witness, NOT proof of a bug. Repair the independently authored page content, then accept it with fresh QA.";
      }
    } catch {
      job.state = job.controller.signal.aborted ? "cancelled" : "failed";
      job.message = "Initial page capture failed or its evidence was invalid; no repair is certified.";
    }
    job.finishedAt = new Date().toISOString();
  }

  async function runBootHealthAcceptJob(job: Job, source: Job,
    request: LocalBootHealthRequest): Promise<void> {
    const outputPath = join(outputRoot, job.id);
    try {
      if (source.bootHealthConfigPath === undefined
        || source.bootHealthOriginalSha256 === undefined
        || source.bootHealthConfigSha256 === undefined) throw new Error("original-missing");
      const result = await options.runBootHealth?.({ action: "accept",
        configPath: source.bootHealthConfigPath,
        originalPath: join(outputRoot, source.id, "original.json"),
        originalSha256: source.bootHealthOriginalSha256,
        outputPath, signal: job.controller.signal });
      const observed = result?.schemaVersion === "tvdoctor.boot-health-accept/v1"
        ? await inspectLocalBootHealthAcceptance(outputPath, job.id, result,
          join(outputRoot, source.id), source.bootHealthOriginalSha256,
          request, source.bootHealthConfigSha256) : null;
      if (job.controller.signal.aborted) {
        job.state = "cancelled";
        job.message = "Initial-render repair verification cancelled; no restored-state verdict is certified.";
      } else if (observed === null) {
        job.state = "failed";
        job.message = "Original, restored content or fresh QA evidence was missing or inconsistent. No repair is certified.";
      } else {
        job.bootHealthAcceptance = observed;
        job.reportDirectory = await realpath(outputPath);
        job.state = observed.status === "INCONCLUSIVE" ? "partial"
          : observed.status === "ERROR" ? "failed" : "completed";
        job.message = observed.status === "PAGE_CONTENT_RESTORED"
          ? "Authored initial page content independently observed in two fresh Chromium sessions separated by complete QA. This certifies one exact route, not the whole website."
          : observed.status === "REPRODUCED"
            ? "The same blank initial page was still observed. Inspect the repair and retry against the immutable original."
            : observed.status === "NEW_VERIFIED"
              ? "A separate fresh QA scan found another VERIFIED failure; no restored-state acceptance is claimed."
              : "Initial page verification or fresh regression coverage was inconclusive. HTTP 200 and disappeared errors cannot prove a repair.";
      }
    } catch {
      job.state = job.controller.signal.aborted ? "cancelled" : "failed";
      job.message = "Independent initial page repair acceptance failed; no repair is certified.";
    }
    job.finishedAt = new Date().toISOString();
  }

  async function report(req: IncomingMessage, res: ServerResponse, rawPath: string): Promise<void> {
    const [id, ...rawParts] = rawPath.split("/");
    if (id === undefined || !/^[0-9a-f-]{36}$/u.test(id) || rawParts.length === 0) {
      throw new RequestError(404, "Report file not found.");
    }
    const job = jobs.get(id);
    if (job?.reportDirectory === undefined) throw new RequestError(404, "Report file not found.");
    const parts = decodeReportSegments(rawParts.join("/"));
    const path = resolve(job.reportDirectory, ...parts);
    if (!inside(job.reportDirectory, path)) throw new RequestError(404, "Report file not found.");
    const extension = extname(path).toLowerCase();
    if (!REPORT_EXTENSIONS.has(extension)) throw new RequestError(404, "Report file not found.");
    let actual: string;
    try {
      actual = await realpath(path);
    } catch {
      throw new RequestError(404, "Report file not found.");
    }
    if (!inside(job.reportDirectory, actual)) throw new RequestError(404, "Report file not found.");
    const metadata = await stat(actual);
    if (!metadata.isFile() || metadata.size > REPORT_LIMIT) {
      throw new RequestError(404, "Report file not found.");
    }
    res.setHeader("Content-Security-Policy",
      (parts.join("/") === "navigation-graph.html" || parts.join("/") === "spa/graph.html")
      ? "sandbox allow-scripts allow-top-navigation-by-user-activation; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
      : "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const isVideo = extension === ".webm" || extension === ".mp4";
    const range = isVideo ? req.headers.range : undefined;
    if (isVideo) res.setHeader("Accept-Ranges", "bytes");
    let start = 0;
    let end = metadata.size - 1;
    if (range !== undefined) {
      const match = /^bytes=(\d*)-(\d*)$/u.exec(range);
      if (match === null || metadata.size === 0 || (match[1] === "" && match[2] === "")) {
        res.writeHead(416, { "Content-Range": `bytes */${metadata.size}` });
        res.end();
        return;
      }
      const first = match[1] ?? "";
      const last = match[2] ?? "";
      if (first.length === 0) {
        const suffix = Number(last);
        if (!Number.isSafeInteger(suffix) || suffix <= 0) {
          res.writeHead(416, { "Content-Range": `bytes */${metadata.size}` });
          res.end();
          return;
        }
        start = Math.max(0, metadata.size - suffix);
      } else {
        start = Number(first);
        end = last.length === 0 ? metadata.size - 1 : Number(last);
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0
        || end < start || start >= metadata.size) {
        res.writeHead(416, { "Content-Range": `bytes */${metadata.size}` });
        res.end();
        return;
      }
      end = Math.min(end, metadata.size - 1);
    }
    res.writeHead(range === undefined ? 200 : 206, {
      "Content-Type": MIME_TYPES[extension] ?? "application/octet-stream",
      "Content-Length": range === undefined ? metadata.size : end - start + 1,
      ...(range === undefined ? {} : { "Content-Range": `bytes ${start}-${end}/${metadata.size}` }),
    });
    const stream = createReadStream(actual, range === undefined ? {} : { start, end });
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    if (req.headers.host !== host
      || (req.headers.origin !== undefined && req.headers.origin !== origin)
      || (req.headers["sec-fetch-site"] !== undefined
        && !["none", "same-origin"].includes(String(req.headers["sec-fetch-site"])))) {
      throw new RequestError(403, "Local access only.");
    }
    const rawUrl = req.url;
    if (rawUrl === undefined || !rawUrl.startsWith("/") || rawUrl.startsWith("//")
      || rawUrl.includes("#") || rawUrl.includes("?")) {
      throw new RequestError(404, "Route not found.");
    }
    if (req.method === "GET" && rawUrl === "/") {
      res.setHeader("Content-Security-Policy",
        `default-src 'none'; script-src 'nonce-${csrfToken}'; style-src 'nonce-${csrfToken}'; img-src 'self'; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderLocalUiPage(csrfToken, options.runQa !== undefined,
        options.runProject !== undefined && options.runProjectAccept !== undefined,
        options.runRouteHealth !== undefined, options.runSpaRouteHealth !== undefined,
        options.runBootHealth !== undefined));
      return;
    }
    if (req.method === "GET" && rawUrl === "/api/status") {
      json(res, 200, presentJob(current));
      return;
    }
    if (req.method === "GET" && rawUrl === "/api/history") {
      // Bounded to this process's owned job ledger; no user-controlled path,
      // raw target or source/authenticated content is returned.
      json(res, 200, { schemaVersion: "tvdoctor.local-history/v1",
        jobs: [...jobs.values()].reverse().slice(0, 10).map(presentHistoryRow) });
      return;
    }
    if (req.method === "GET" && /^\/api\/jobs\/[0-9a-f-]{36}$/u.test(rawUrl)) {
      const id = rawUrl.slice("/api/jobs/".length);
      const saved = jobs.get(id);
      if (saved === undefined) throw new RequestError(404, "Local run not found in this session.");
      json(res, 200, presentJob(saved));
      return;
    }
    if (req.method === "GET" && /^\/api\/route-health\/[0-9a-f-]{36}\/config$/u.test(rawUrl)) {
      const id = rawUrl.slice("/api/route-health/".length, -"/config".length);
      const job = jobs.get(id);
      if (job?.type !== "route-health" || job.state !== "completed"
        || job.routeHealth?.status !== "VERIFIED_ORIGINAL" || !job.routeHealth.acceptReady
        || job.routeHealthConfigPath !== join(outputRoot, ".route-health-configs", `${id}.json`)
        || job.routeHealthConfigSha256 === undefined || job.routeHealthOriginalSha256 === undefined) {
        throw new RequestError(404, "Private route configuration unavailable.");
      }
      // Downloading private authored configuration is an EXPLICIT user action;
      // it is never exposed in status, history, report links or the UI DOM.
      let config: Buffer;
      try {
        const path = job.routeHealthConfigPath;
        const originalPath = join(outputRoot, id, "original.json");
        const [entry, witness] = await Promise.all([lstat(path), lstat(originalPath)]);
        if (!entry.isFile() || entry.isSymbolicLink() || entry.size <= 0 || entry.size > BODY_LIMIT
          || !witness.isFile() || witness.isSymbolicLink()
          || witness.size <= 0 || witness.size > BODY_LIMIT
          || await realpath(path) !== path || await realpath(originalPath) !== originalPath) {
          throw new Error("Changed source");
        }
        const [bytes, original] = await Promise.all([readFile(path), readFile(originalPath)]);
        if (bytes.length !== entry.size || original.length !== witness.size
          || createHash("sha256").update(bytes).digest("hex") !== job.routeHealthConfigSha256
          || createHash("sha256").update(original).digest("hex") !== job.routeHealthOriginalSha256) {
          throw new Error("Changed original");
        }
        const [after, witnessAfter] = await Promise.all([lstat(path), lstat(originalPath)]);
        if (after.ino !== entry.ino || after.mtimeMs !== entry.mtimeMs
          || witnessAfter.ino !== witness.ino || witnessAfter.mtimeMs !== witness.mtimeMs) {
          throw new Error("Changed during download");
        }
        config = bytes;
      } catch {
        throw new RequestError(409, "Private route configuration or original evidence changed. No export is available.");
      }
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": "attachment; filename=tvdoctor-public-route-private.json",
        "Content-Length": config.length,
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "X-TVDoctor-Source-Status": "VERIFIED_ORIGINAL",
      });
      res.end(config);
      return;
    }
    if (req.method === "GET" && /^\/api\/spa-route-health\/[0-9a-f-]{36}\/config$/u.test(rawUrl)) {
      const id = rawUrl.slice("/api/spa-route-health/".length, -"/config".length);
      const job = jobs.get(id);
      if (job?.type !== "spa-route-health" || job.state !== "completed"
        || job.spaRouteHealth?.status !== "VERIFIED_ORIGINAL" || !job.spaRouteHealth.acceptReady
        || job.spaRouteHealthConfigPath !== join(outputRoot, ".spa-route-health-configs", `${id}.json`)
        || job.spaRouteHealthConfigSha256 === undefined || job.spaRouteHealthOriginalSha256 === undefined) {
        throw new RequestError(404, "Private SPA route configuration unavailable.");
      }
      // This is a deliberate private download, never included in ordinary
      // JSON, recent history, markup, or shareable report content.
      let config: Buffer;
      try {
        const path = job.spaRouteHealthConfigPath;
        const originalPath = join(outputRoot, id, "original.json");
        const [entry, original] = await Promise.all([lstat(path), lstat(originalPath)]);
        if (!entry.isFile() || entry.isSymbolicLink() || entry.size <= 0 || entry.size > BODY_LIMIT
          || !original.isFile() || original.isSymbolicLink() || original.size <= 0 || original.size > BODY_LIMIT
          || await realpath(path) !== path || await realpath(originalPath) !== originalPath) {
          throw new Error("unsafe-spa-source");
        }
        const [bytes, witness] = await Promise.all([readFile(path), readFile(originalPath)]);
        if (bytes.length !== entry.size || witness.length !== original.size
          || createHash("sha256").update(bytes).digest("hex") !== job.spaRouteHealthConfigSha256
          || createHash("sha256").update(witness).digest("hex") !== job.spaRouteHealthOriginalSha256) {
          throw new Error("changed-spa-source");
        }
        const [after, last] = await Promise.all([lstat(path), lstat(originalPath)]);
        if (after.ino !== entry.ino || after.mtimeMs !== entry.mtimeMs
          || last.ino !== original.ino || last.mtimeMs !== original.mtimeMs) {
          throw new Error("changed-spa-source-during-export");
        }
        config = bytes;
      } catch {
        throw new RequestError(409, "Private SPA source configuration or original evidence changed. No export is available.");
      }
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": "attachment; filename=tvdoctor-spa-route-private.json",
        "Content-Length": config.length,
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "X-TVDoctor-Source-Status": "VERIFIED_ORIGINAL",
      });
      res.end(config);
      return;
    }
    if (req.method === "GET" && /^\/api\/boot-health\/[0-9a-f-]{36}\/config$/u.test(rawUrl)) {
      const id = rawUrl.slice("/api/boot-health/".length, -"/config".length);
      const job = jobs.get(id);
      if (job?.type !== "boot-health" || job.state !== "completed"
        || job.bootHealth?.status !== "VERIFIED_ORIGINAL" || !job.bootHealth.acceptReady
        || job.bootHealthConfigPath !== join(outputRoot, ".boot-health-configs", `${id}.json`)
        || job.bootHealthConfigSha256 === undefined || job.bootHealthOriginalSha256 === undefined) {
        throw new RequestError(404, "Private initial-render configuration is unavailable.");
      }
      let config: Buffer;
      try {
        const path = job.bootHealthConfigPath;
        const originalPath = join(outputRoot, id, "original.json");
        const [entry, original] = await Promise.all([lstat(path), lstat(originalPath)]);
        if (!entry.isFile() || entry.isSymbolicLink() || entry.size <= 0 || entry.size > BODY_LIMIT
          || !original.isFile() || original.isSymbolicLink() || original.size <= 0 || original.size > BODY_LIMIT
          || await realpath(path) !== path || await realpath(originalPath) !== originalPath) {
          throw new Error("unsafe-boot-source");
        }
        const [bytes, witness] = await Promise.all([readFile(path), readFile(originalPath)]);
        if (bytes.length !== entry.size || witness.length !== original.size
          || createHash("sha256").update(bytes).digest("hex") !== job.bootHealthConfigSha256
          || createHash("sha256").update(witness).digest("hex") !== job.bootHealthOriginalSha256) {
          throw new Error("changed-boot-source");
        }
        const [after, last] = await Promise.all([lstat(path), lstat(originalPath)]);
        if (after.ino !== entry.ino || after.mtimeMs !== entry.mtimeMs
          || last.ino !== original.ino || last.mtimeMs !== original.mtimeMs) {
          throw new Error("changed-boot-source-during-export");
        }
        config = bytes;
      } catch {
        throw new RequestError(409, "Private initial-render source or original evidence changed. No export is available.");
      }
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": "attachment; filename=tvdoctor-boot-health-private.json",
        "Content-Length": config.length,
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "X-TVDoctor-Source-Status": "VERIFIED_ORIGINAL",
      });
      res.end(config);
      return;
    }
    if (req.method === "GET" && /^\/api\/project\/[0-9a-f-]{36}\/manifest$/u.test(rawUrl)) {
      const jobId = rawUrl.slice("/api/project/".length, -"/manifest".length);
      const job = jobs.get(jobId);
      if (job?.type !== "project" || job.project === undefined
        || (job.state !== "completed" && job.state !== "partial")
        || !await manifestUnchanged(job) || job.manifestPath === undefined) {
        throw new RequestError(404, "Project configuration unavailable.");
      }
      // A deliberately requested local download remains available after a
      // PARTIAL run: otherwise developers lose the exact configuration they
      // need to correct the journey and rerun. This is CONFIGURATION ONLY,
      // never a claim that the failed project was successfully audited.
      const bytes = await readFile(job.manifestPath);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": "attachment; filename=tvdoctor-project.json",
        "X-TVDoctor-Project-Status": job.state === "partial" ? "INCONCLUSIVE" : job.project.status,
        "Content-Length": bytes.length,
        "Content-Security-Policy": "default-src 'none'; sandbox",
      });
      res.end(bytes);
      return;
    }
    if (req.method === "POST" && /^\/api\/scans\/[0-9a-f-]{36}\/cancel$/u.test(rawUrl)) {
      if (req.headers.origin !== origin || !tokenMatches(csrfToken, req.headers["x-tvdoctor-csrf"])) {
        throw new RequestError(403, "Local form token is missing or invalid.");
      }
      if (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0") {
        throw new RequestError(413, "Cancellation requests cannot include a body.");
      }
      const id = rawUrl.slice("/api/scans/".length, -"/cancel".length);
      if (current?.id !== id) throw new RequestError(404, "Scan not found.");
      if (current.state !== "running") throw new RequestError(409, "This scan cannot be cancelled.");
      current.state = "cancelling";
      current.message = "Cancellation requested. Waiting for the scanner to stop and save partial coverage.";
      current.controller.abort();
      json(res, 202, presentJob(current));
      return;
    }
    if (req.method === "POST" && rawUrl === "/api/scans") {
      if (req.headers.origin !== origin || !tokenMatches(csrfToken, req.headers["x-tvdoctor-csrf"])) {
        throw new RequestError(403, "Local form token is missing or invalid.");
      }
      if (scanActive()) {
        throw new RequestError(409, "A scan is already running.");
      }
      const request = parseScanRequest(await readJson(req));
      // A previous request may have started while this body was still streaming.
      if (scanActive()) {
        throw new RequestError(409, "A scan is already running.");
      }
      const scanUrl = request.type === "site" && request.exploreSpa ? new URL(request.target) : null;
      const spaTargetIdentity = scanUrl === null ? undefined
        : createHash("sha256").update(["route", scanUrl.pathname, scanUrl.hash].join("\u001f"))
          .digest("hex").slice(0, 20);
      const job: Job = {
        id: randomUUID(), type: request.type, mode: request.mode, input: request.input,
        recordVideo: request.recordVideo,
        ...(request.exploreSpa ? { exploreSpa: true } : {}),
        ...(spaTargetIdentity === undefined ? {} : { spaTargetIdentity }),
        ...(request.maxRoutes === undefined ? {} : { maxRoutes: request.maxRoutes }),
        ...(request.viewportProfile === undefined ? {} : { viewportProfile: request.viewportProfile }),
        controller: new AbortController(),
        state: "running", startedAt: new Date().toISOString(),
      };
      current = job;
      jobs.set(job.id, job);
      // Keep bounded memory; previous reports remain on disk but cease being shared here.
      while (jobs.size > 10) {
        const oldest = jobs.keys().next().value;
        if (oldest === undefined) break;
        jobs.delete(oldest);
      }
      void runJob(job, request);
      json(res, 202, presentJob(job));
      return;
    }
    if (req.method === "POST" && rawUrl === "/api/qa") {
      if (req.headers.origin !== origin || !tokenMatches(csrfToken, req.headers["x-tvdoctor-csrf"])) {
        throw new RequestError(403, "Local form token is missing or invalid.");
      }
      if (options.runQa === undefined) throw new RequestError(503, "QA is not configured in this local session.");
      if (scanActive()) throw new RequestError(409, "An audit is already running.");
      const request = parseQaRequest(await readJson(req));
      if (scanActive()) throw new RequestError(409, "An audit is already running.");
      const job: Job = {
        id: randomUUID(), type: "qa", input: "keyboard", mode: request.mode,
        recordVideo: false, controller: new AbortController(),
        state: "running", startedAt: new Date().toISOString(),
      };
      current = job;
      jobs.set(job.id, job);
      while (jobs.size > 10) {
        const oldest = jobs.keys().next().value;
        if (oldest === undefined) break;
        jobs.delete(oldest);
      }
      void runQaJob(job, request);
      json(res, 202, presentJob(job));
      return;
    }
    if (req.method === "POST" && rawUrl === "/api/route-health") {
      if (req.headers.origin !== origin || !tokenMatches(csrfToken, req.headers["x-tvdoctor-csrf"])) {
        throw new RequestError(403, "Local form token is missing or invalid.");
      }
      if (options.runRouteHealth === undefined) {
        throw new RequestError(503, "Public route health is unavailable in this session.");
      }
      if (scanActive()) throw new RequestError(409, "An audit is already running.");
      let request: LocalRouteHealthRequest;
      try { request = parseLocalRouteHealthRequest(await readJson(req)); }
      catch (error) {
        if (error instanceof LocalRouteHealthRequestError) {
          throw new RequestError(error.statusCode, "An exact authorized public route and independently authored expected content are required.");
        }
        throw error;
      }
      if (scanActive()) throw new RequestError(409, "An audit is already running.");
      const job: Job = {
        id: randomUUID(), type: "route-health", input: "keyboard", mode: "quick",
        recordVideo: false, controller: new AbortController(), routeHealthRequest: request,
        startedAt: new Date().toISOString(), state: "running",
      };
      current = job;
      jobs.set(job.id, job);
      while (jobs.size > 10) {
        const oldest = jobs.keys().next().value;
        if (oldest === undefined) break;
        jobs.delete(oldest);
      }
      void runRouteHealthCaptureJob(job, request);
      json(res, 202, presentJob(job));
      return;
    }
    if (req.method === "POST" && rawUrl === "/api/spa-route-health") {
      if (req.headers.origin !== origin || !tokenMatches(csrfToken, req.headers["x-tvdoctor-csrf"])) {
        throw new RequestError(403, "Local form token is missing or invalid.");
      }
      if (options.runSpaRouteHealth === undefined) {
        throw new RequestError(503, "SPA route repair verification is unavailable in this session.");
      }
      if (scanActive()) throw new RequestError(409, "An audit is already running.");
      let request: LocalSpaRouteHealthRequest;
      try { request = parseLocalSpaRouteHealthRequest(await readJson(req)); }
      catch (error) {
        if (error instanceof LocalSpaRouteHealthRequestError) {
          throw new RequestError(error.statusCode,
            "Exact authorised source and destination paths, a uniquely named link, and independently authored main-content SHA are required.");
        }
        throw error;
      }
      if (scanActive()) throw new RequestError(409, "An audit is already running.");
      const job: Job = { id: randomUUID(), type: "spa-route-health",
        input: "keyboard", mode: "quick", recordVideo: false,
        controller: new AbortController(), state: "running", startedAt: new Date().toISOString(),
        spaRouteHealthRequest: request,
      };
      current = job;
      jobs.set(job.id, job);
      while (jobs.size > 10) {
        const oldest = jobs.keys().next().value;
        if (oldest === undefined) break;
        jobs.delete(oldest);
      }
      void runSpaRouteHealthCaptureJob(job, request);
      json(res, 202, presentJob(job));
      return;
    }
    if (req.method === "POST" && rawUrl === "/api/boot-health") {
      if (req.headers.origin !== origin || !tokenMatches(csrfToken, req.headers["x-tvdoctor-csrf"])) {
        throw new RequestError(403, "Local form token is missing or invalid.");
      }
      if (options.runBootHealth === undefined) {
        throw new RequestError(503, "Initial-render repair verification is unavailable in this session.");
      }
      if (scanActive()) throw new RequestError(409, "An audit is already running.");
      let request: LocalBootHealthRequest;
      try { request = parseLocalBootHealthRequest(await readJson(req)); }
      catch (error) {
        if (error instanceof LocalBootHealthRequestError) {
          throw new RequestError(error.statusCode,
            "Exact authorised public route and independently authored healthy heading and MAIN content fingerprint are required.");
        }
        throw error;
      }
      if (scanActive()) throw new RequestError(409, "An audit is already running.");
      const job: Job = { id: randomUUID(), type: "boot-health",
        input: "keyboard", mode: "quick", recordVideo: false,
        controller: new AbortController(), state: "running", startedAt: new Date().toISOString(),
        bootHealthRequest: request,
      };
      current = job;
      jobs.set(job.id, job);
      while (jobs.size > 10) {
        const oldest = jobs.keys().next().value;
        if (oldest === undefined) break;
        jobs.delete(oldest);
      }
      void runBootHealthCaptureJob(job, request);
      json(res, 202, presentJob(job));
      return;
    }
    if (req.method === "POST" && rawUrl === "/api/project") {
      if (req.headers.origin !== origin || !tokenMatches(csrfToken, req.headers["x-tvdoctor-csrf"])) {
        throw new RequestError(403, "Local form token is missing or invalid.");
      }
      if (options.runProject === undefined || options.runProjectAccept === undefined) {
        throw new RequestError(503, "Project QA is not configured in this local session.");
      }
      if (scanActive()) throw new RequestError(409, "An audit is already running.");
      const raw = await readJson(req);
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new RequestError(400, "A project and its routes are required.");
      }
      const request = raw as Record<string, unknown>;
      if (Object.keys(request).some((key) => !["baseUrl", "mode", "failOn", "interactions", "routes", "authorized"].includes(key))) {
        throw new RequestError(400, "Unknown project form fields.");
      }
      if (request["authorized"] !== true) {
        throw new RequestError(403, "Explicit authorization for this test target and setup journey is required.");
      }
      const id = randomUUID();
      let prepared: Awaited<ReturnType<typeof prepareLocalProjectManifest>>;
      try {
        prepared = await prepareLocalProjectManifest({
          baseUrl: request["baseUrl"], mode: request["mode"],
          failOn: request["failOn"], interactions: request["interactions"],
          routes: request["routes"],
        }, outputRoot, id);
      } catch {
        // Never forward input or filesystem exceptions; the URI or journey
        // variable names can identify a private development application.
        throw new RequestError(400, "Invalid project configuration. Check same-origin route IDs, paths and journey environment names.");
      }
      // Browser-independent authentication readiness gate. The source CLI
      // already validates journey inputs, but checking BEFORE starting a UI
      // scan provides actionable, non-secret instructions to ordinary users.
      // This never confirms that a protected page is actually authenticated;
      // route/restoration verification remains mandatory in Chromium.
      const readiness = await preflightProjectJourneys({
        manifestPath: prepared.manifestPath, requireAuthReady: true,
      });
      if (readiness.status !== "READY") {
        // Remove ONLY the newly generated private manifest for this rejected
        // request. Neither an existing project nor original evidence is touched.
        await unlink(prepared.manifestPath).catch(() => undefined);
        const reason = readiness.routes.find((route) => route.status === "BLOCKED")?.reason;
        const detail = reason === "missing-auth-ready-assertion"
          ? "Protected routes require an exact accessible content marker (heading, region or button and name) in addition to their approved login journey."
          : reason === "missing-journey-environment"
          ? "The approved journey environment variable is not configured. Set TVDOCTOR_JOURNEY_* to an absolute JSON journey path before starting the local dashboard."
          : reason === "missing-journey-secret"
            ? "An approved journey secret variable is missing. Set disposable test-account secrets privately in the dashboard process environment."
            : reason === "invalid-journey-file"
              ? "The approved journey JSON file is missing, unsafe or invalid. Review the tvdoctor.journey/v1 schema and the configured file."
              : "The project journey setup could not be validated.";
        throw new RequestError(422, `${detail} No browser scan was started.`);
      }
      if (scanActive()) throw new RequestError(409, "An audit is already running.");
      let manifestSha256: string;
      try {
        const bytes = await readFile(prepared.manifestPath);
        if (bytes.length <= 0 || bytes.length > 64 * 1024) throw new TypeError("Invalid project manifest.");
        manifestSha256 = createHash("sha256").update(bytes).digest("hex");
      } catch {
        throw new RequestError(400, "Project configuration could not be saved safely.");
      }
      const job: Job = {
        id, type: "project", input: "keyboard", mode: prepared.manifest.mode,
        recordVideo: false, controller: new AbortController(),
        manifestPath: prepared.manifestPath, manifestSha256,
        state: "running", startedAt: new Date().toISOString(),
        message: "Scanning the explicitly configured project routes with bounded browser coverage.",
      };
      current = job;
      jobs.set(job.id, job);
      while (jobs.size > 10) {
        const oldest = jobs.keys().next().value;
        if (oldest === undefined) break;
        jobs.delete(oldest);
      }
      void runProjectJob(job, prepared.manifestPath);
      json(res, 202, presentJob(job));
      return;
    }
    if (req.method === "POST" && /^\/api\/project\/[0-9a-f-]{36}\/accept$/u.test(rawUrl)) {
      if (req.headers.origin !== origin || !tokenMatches(csrfToken, req.headers["x-tvdoctor-csrf"])) {
        throw new RequestError(403, "Local form token is missing or invalid.");
      }
      if (req.headers["transfer-encoding"] !== undefined
        || (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0")) {
        throw new RequestError(413, "Acceptance requests cannot include a body.");
      }
      if (options.runProjectAccept === undefined) throw new RequestError(503, "Project acceptance is not configured.");
      if (scanActive()) throw new RequestError(409, "An audit is already running.");
      const sourceId = rawUrl.slice("/api/project/".length, -"/accept".length);
      const source = jobs.get(sourceId);
      if (source?.type !== "project" || source.state !== "completed" || !source.acceptReady
        || source.manifestPath === undefined || source.project === undefined) {
        throw new RequestError(409, "A complete, verified server-owned original project is required.");
      }
      if (!await manifestUnchanged(source)) {
        throw new RequestError(409, "The original project configuration changed. Capture a new original before accepting repairs.");
      }
      const job: Job = {
        id: randomUUID(), type: "project-accept", input: "keyboard", mode: source.mode,
        recordVideo: false, controller: new AbortController(),
        state: "running", startedAt: new Date().toISOString(),
        message: "Independently replaying original issues, then checking all configured routes for new VERIFIED failures.",
      };
      current = job;
      jobs.set(job.id, job);
      while (jobs.size > 10) {
        const oldest = jobs.keys().next().value;
        if (oldest === undefined) break;
        jobs.delete(oldest);
      }
      void runProjectAcceptJob(job, source);
      json(res, 202, presentJob(job));
      return;
    }
    if (req.method === "POST" && /^\/api\/qa\/[0-9a-f-]{36}\/accept$/u.test(rawUrl)) {
      if (req.headers.origin !== origin || !tokenMatches(csrfToken, req.headers["x-tvdoctor-csrf"])) {
        throw new RequestError(403, "Local form token is missing or invalid.");
      }
      if (req.headers["transfer-encoding"] !== undefined
        || (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0")) {
        throw new RequestError(413, "Acceptance requests cannot include a body.");
      }
      if (options.runQaAccept === undefined) throw new RequestError(503, "QA acceptance is not configured.");
      if (scanActive()) throw new RequestError(409, "An audit is already running.");
      const sourceId = rawUrl.slice("/api/qa/".length, -"/accept".length);
      const source = jobs.get(sourceId);
      if (source?.type !== "qa" || source.state !== "completed" || !source.acceptReady
        || source.qaTarget === undefined || source.qa === undefined) {
        throw new RequestError(409, "A complete verified original QA run is required.");
      }
      // A dashboard job may outlive an accidental or malicious edit to its
      // original evidence. Reject before launching the acceptance scanner.
      let originalUnchanged = false;
      try {
        const path = join(outputRoot, source.id, "original", "report.json");
        const file = await lstat(path);
        const summaryPath = join(outputRoot, source.id, "qa-summary.json");
        const summary = await lstat(summaryPath);
        originalUnchanged = file.isFile() && !file.isSymbolicLink()
          && file.size > 0 && file.size <= REPORT_LIMIT
          && typeof source.qaOriginalSha256 === "string"
          && createHash("sha256").update(await readFile(path)).digest("hex") === source.qaOriginalSha256
          && summary.isFile() && !summary.isSymbolicLink()
          && summary.size > 0 && summary.size <= 128 * 1024
          && typeof source.qaSummarySha256 === "string"
          && createHash("sha256").update(await readFile(summaryPath)).digest("hex") === source.qaSummarySha256;
      } catch { /* Fail closed. */ }
      if (!originalUnchanged) {
        throw new RequestError(409, "The original QA evidence changed. Run a new source scan before acceptance.");
      }
      const job: Job = {
        id: randomUUID(), type: "qa-accept", input: "keyboard", mode: source.mode,
        recordVideo: false, controller: new AbortController(),
        state: "running", startedAt: new Date().toISOString(),
        message: "Independently verifying original issues and performing a fresh regression QA run.",
      };
      current = job;
      jobs.set(job.id, job);
      while (jobs.size > 10) {
        const oldest = jobs.keys().next().value;
        if (oldest === undefined) break;
        jobs.delete(oldest);
      }
      void runQaAcceptJob(job, source);
      json(res, 202, presentJob(job));
      return;
    }
    if (req.method === "POST" && /^\/api\/route-health\/[0-9a-f-]{36}\/accept$/u.test(rawUrl)) {
      if (req.headers.origin !== origin || !tokenMatches(csrfToken, req.headers["x-tvdoctor-csrf"])) {
        throw new RequestError(403, "Local form token is missing or invalid.");
      }
      if (req.headers["transfer-encoding"] !== undefined
        || (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0")) {
        throw new RequestError(413, "Acceptance requests cannot include a body.");
      }
      if (options.runRouteHealth === undefined) throw new RequestError(503, "Route acceptance is unavailable.");
      if (scanActive()) throw new RequestError(409, "An audit is already running.");
      const sourceId = rawUrl.slice("/api/route-health/".length, -"/accept".length);
      const source = jobs.get(sourceId);
      if (source?.type !== "route-health" || source.state !== "completed"
        || source.routeHealth?.status !== "VERIFIED_ORIGINAL"
        || source.routeHealthOriginalSha256 === undefined
        || source.routeHealthConfigSha256 === undefined
        || source.routeHealthConfigPath === undefined || source.routeHealthRequest === undefined
        || !source.acceptReady) throw new RequestError(409, "A source-pinned original HTTP404/410 is required.");
      // Do not launch Chromium if a saved original or private authored config
      // changed since capture. The CLI will independently enforce both again.
      let valid = false;
      try {
        const config = await lstat(source.routeHealthConfigPath);
        const path = join(outputRoot, source.id, "original.json");
        const original = await lstat(path);
        valid = config.isFile() && !config.isSymbolicLink() && config.size > 0
          && config.size <= 4096 && await realpath(source.routeHealthConfigPath) === source.routeHealthConfigPath
          && createHash("sha256").update(await readFile(source.routeHealthConfigPath)).digest("hex")
            === source.routeHealthConfigSha256
          && original.isFile() && !original.isSymbolicLink() && original.size > 0
          && original.size <= 4096 && await realpath(path) === path
          && createHash("sha256").update(await readFile(path)).digest("hex")
            === source.routeHealthOriginalSha256;
      } catch { /* Reject stale, replaced or removed originals. */ }
      if (!valid) throw new RequestError(409, "The original route evidence changed. Capture a new source witness.");
      if (scanActive()) throw new RequestError(409, "Another audit started while verifying original evidence.");
      const job: Job = {
        id: randomUUID(), type: "route-health-accept", input: "keyboard", mode: "quick",
        recordVideo: false, controller: new AbortController(),
        routeHealthOriginalId: source.id,
        startedAt: new Date().toISOString(), state: "running",
        message: "Independently checking the original route repair and fresh QA, with a final post-regression recheck.",
      };
      current = job;
      jobs.set(job.id, job);
      while (jobs.size > 10) {
        const oldest = jobs.keys().next().value;
        if (oldest === undefined) break;
        jobs.delete(oldest);
      }
      void runRouteHealthAcceptJob(job, source, source.routeHealthRequest);
      json(res, 202, presentJob(job));
      return;
    }
    if (req.method === "POST" && /^\/api\/spa-route-health\/[0-9a-f-]{36}\/accept$/u.test(rawUrl)) {
      if (req.headers.origin !== origin || !tokenMatches(csrfToken, req.headers["x-tvdoctor-csrf"])) {
        throw new RequestError(403, "Local form token is missing or invalid.");
      }
      if (req.headers["transfer-encoding"] !== undefined
        || (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0")) {
        throw new RequestError(413, "Acceptance requests cannot include a body.");
      }
      if (options.runSpaRouteHealth === undefined) throw new RequestError(503, "SPA acceptance is unavailable.");
      if (scanActive()) throw new RequestError(409, "An audit is already running.");
      const sourceId = rawUrl.slice("/api/spa-route-health/".length, -"/accept".length);
      const source = jobs.get(sourceId);
      if (source?.type !== "spa-route-health" || source.state !== "completed"
        || source.spaRouteHealth?.status !== "VERIFIED_ORIGINAL"
        || source.spaRouteHealthOriginalSha256 === undefined
        || source.spaRouteHealthConfigSha256 === undefined
        || source.spaRouteHealthConfigPath === undefined || source.spaRouteHealthRequest === undefined
        || !source.acceptReady) {
        throw new RequestError(409, "An exact SHA-pinned original blank SPA journey is required.");
      }
      let valid = false;
      try {
        const config = await lstat(source.spaRouteHealthConfigPath);
        const originalPath = join(outputRoot, source.id, "original.json");
        const original = await lstat(originalPath);
        valid = config.isFile() && !config.isSymbolicLink() && config.size > 0
          && config.size <= BODY_LIMIT && await realpath(source.spaRouteHealthConfigPath) === source.spaRouteHealthConfigPath
          && createHash("sha256").update(await readFile(source.spaRouteHealthConfigPath)).digest("hex")
            === source.spaRouteHealthConfigSha256
          && original.isFile() && !original.isSymbolicLink() && original.size > 0
          && original.size <= BODY_LIMIT && await realpath(originalPath) === originalPath
          && createHash("sha256").update(await readFile(originalPath)).digest("hex")
            === source.spaRouteHealthOriginalSha256;
      } catch { /* Reject altered sources, paths and symbolic links. */ }
      if (!valid) throw new RequestError(409,
        "Original SPA route or authored configuration changed. Capture a new original witness.");
      if (scanActive()) throw new RequestError(409, "An audit started during source revalidation.");
      const job: Job = { id: randomUUID(), type: "spa-route-health-accept",
        input: "keyboard", mode: "quick", recordVideo: false,
        controller: new AbortController(), state: "running", startedAt: new Date().toISOString(),
        spaRouteHealthOriginalId: source.id,
        message: "Comparing the authored SPA destination in fresh Chromium, performing source-bound QA, then checking content again after QA.",
      };
      current = job;
      jobs.set(job.id, job);
      while (jobs.size > 10) {
        const oldest = jobs.keys().next().value;
        if (oldest === undefined) break;
        jobs.delete(oldest);
      }
      void runSpaRouteHealthAcceptJob(job, source, source.spaRouteHealthRequest);
      json(res, 202, presentJob(job));
      return;
    }
    if (req.method === "POST" && /^\/api\/boot-health\/[0-9a-f-]{36}\/accept$/u.test(rawUrl)) {
      if (req.headers.origin !== origin || !tokenMatches(csrfToken, req.headers["x-tvdoctor-csrf"])) {
        throw new RequestError(403, "Local form token is missing or invalid.");
      }
      if (req.headers["transfer-encoding"] !== undefined
        || (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0")) {
        throw new RequestError(413, "Acceptance requests cannot include a body.");
      }
      if (options.runBootHealth === undefined) throw new RequestError(503, "Initial-render acceptance is unavailable.");
      if (scanActive()) throw new RequestError(409, "An audit is already running.");
      const sourceId = rawUrl.slice("/api/boot-health/".length, -"/accept".length);
      const source = jobs.get(sourceId);
      if (source?.type !== "boot-health" || source.state !== "completed"
        || source.bootHealth?.status !== "VERIFIED_ORIGINAL"
        || source.bootHealthOriginalSha256 === undefined
        || source.bootHealthConfigSha256 === undefined
        || source.bootHealthConfigPath === undefined || source.bootHealthRequest === undefined
        || !source.acceptReady) {
        throw new RequestError(409, "A SHA-pinned original blank initial-render witness is required.");
      }
      let unchanged = false;
      try {
        const config = await lstat(source.bootHealthConfigPath);
        const originalPath = join(outputRoot, source.id, "original.json");
        const original = await lstat(originalPath);
        unchanged = config.isFile() && !config.isSymbolicLink() && config.size > 0
          && config.size <= BODY_LIMIT && await realpath(source.bootHealthConfigPath) === source.bootHealthConfigPath
          && createHash("sha256").update(await readFile(source.bootHealthConfigPath)).digest("hex")
            === source.bootHealthConfigSha256
          && original.isFile() && !original.isSymbolicLink() && original.size > 0
          && original.size <= BODY_LIMIT && await realpath(originalPath) === originalPath
          && createHash("sha256").update(await readFile(originalPath)).digest("hex")
            === source.bootHealthOriginalSha256;
      } catch { /* No browser work after changed or unsafe originals. */ }
      if (!unchanged) throw new RequestError(409,
        "Initial page original or authored expectation changed; capture a fresh original witness.");
      if (scanActive()) throw new RequestError(409, "An audit started during source revalidation.");
      const job: Job = { id: randomUUID(), type: "boot-health-accept",
        input: "keyboard", mode: "quick", recordVideo: false,
        controller: new AbortController(), state: "running", startedAt: new Date().toISOString(),
        bootHealthOriginalId: source.id,
        message: "Revisiting the exact authored initial page in fresh Chromium, running independent QA, then checking it again.",
      };
      current = job;
      jobs.set(job.id, job);
      while (jobs.size > 10) {
        const oldest = jobs.keys().next().value;
        if (oldest === undefined) break;
        jobs.delete(oldest);
      }
      void runBootHealthAcceptJob(job, source, source.bootHealthRequest);
      json(res, 202, presentJob(job));
      return;
    }
    if (req.method === "GET" && rawUrl.startsWith("/reports/")) {
      await report(req, res, rawUrl.slice("/reports/".length));
      return;
    }
    throw new RequestError(req.method === "GET" || req.method === "POST" ? 404 : 405, "Route not found.");
  }

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error): void => rejectListen(error);
      server.once("error", onError);
      server.listen(options.port ?? 0, "127.0.0.1", () => {
        server.off("error", onError);
        resolveListen();
      });
    });
  } catch (error) {
    server.close();
    throw error;
  }
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    server.close();
    throw new Error("Could not determine the local UI port.");
  }
  host = `127.0.0.1:${address.port}`;
  origin = `http://${host}`;
  const handleShutdown = (): void => {
    if (current?.state === "running" || current?.state === "cancelling") current.controller.abort();
  };
  options.signal?.addEventListener("abort", handleShutdown, { once: true });
  if (options.signal?.aborted === true) handleShutdown();
  return {
    url: origin,
    close: async () => {
      options.signal?.removeEventListener("abort", handleShutdown);
      handleShutdown();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => error === undefined ? resolveClose() : rejectClose(error));
        server.closeAllConnections();
      });
    },
  };
}
