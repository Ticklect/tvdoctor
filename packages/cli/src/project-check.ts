import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { parseJourney } from "./journey.js";
import { parseTVDoctorReportJson, REPORT_SCHEMA_VERSION_V1 } from "@tvdoctor/protocol";

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_JOURNEY_BYTES = 64 * 1024;
const MAX_CHECK_STDOUT = 1024 * 1024;
const MAX_REPORT_BYTES = 16 * 1024 * 1024;
const MAX_FAILURE_DEBUG_BYTES = 4 * 1024;
const AUTH_JOURNEY_FAILURE_SUMMARY = "The approved login journey did not complete. Check the private journey, expected focus and protected route assertions. No authenticated scan was completed.";
const MAX_ROUTES = 8;
const ROUTE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const JOURNEY_ENV = /^TVDOCTOR_JOURNEY_[A-Z0-9_]{1,64}$/u;
const AUTH_READY_ROLES = ["heading", "region", "button"] as const;
const SAFE_ROUTE = /^\/(?:[A-Za-z0-9_~.-]+(?:\/[A-Za-z0-9_~.-]+)*)?\/?$/u;
const CI_THRESHOLDS = ["any", "critical", "high", "medium", "low", "info", "never"] as const;
const MODES = ["quick", "standard", "deep"] as const;
const CHECK_STATUSES = [
  "NO_VERIFIED_FAILURES_AT_THRESHOLD", "REVIEW_REQUIRED", "FINDINGS", "REGRESSED", "INCONCLUSIVE",
] as const;

type FailureThreshold = (typeof CI_THRESHOLDS)[number];
type CheckMode = (typeof MODES)[number];
type RouteStatus = "PASS" | "REVIEW_REQUIRED" | "FINDINGS" | "INCONCLUSIVE";

export interface ProjectRouteV1 {
  readonly id: string;
  /** Explicit safe absolute pathname on the manifest's origin; no query, fragment or traversal. */
  readonly path: string;
  /** Environment variable NAME, never a secret or a journey file path. */
  readonly journeyEnv?: string;
  /** Exact, uniquely visible protected-content landmark; never a secret or a selector. */
  readonly authReady?: {
    readonly role: (typeof AUTH_READY_ROLES)[number];
    readonly name: string;
  };
}

export interface ProjectManifestV1 {
  readonly schemaVersion: "tvdoctor.project/v1";
  readonly baseUrl: string;
  readonly mode: CheckMode;
  readonly failOn: FailureThreshold;
  readonly interactions: boolean;
  readonly routes: readonly ProjectRouteV1[];
}

export interface ProjectCheckExecution {
  readonly exitCode: number;
  /** Exactly one JSON object emitted by runCli(['check', ..., '--json'], context). */
  readonly stdout: string;
}

export interface ProjectCheckOptions {
  readonly manifestPath: string;
  /** Must be a fresh, explicitly selected directory; never derived from manifest data. */
  readonly outputRoot: string;
  /** Prime's CLI integration injects runCli and captures its JSON stdout. */
  readonly executeCheck: (args: readonly string[]) => Promise<ProjectCheckExecution>;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface ProjectRouteResult {
  readonly id: string;
  readonly status: RouteStatus;
  readonly exitCode: number;
  readonly verified: number;
  readonly review: number;
  readonly untested: number;
  readonly reportRelativePath: string | null;
  readonly reason: string | null;
}

export interface ProjectCheckResult {
  readonly schemaVersion: "tvdoctor.project-check/v1";
  readonly status: RouteStatus;
  readonly shouldFail: boolean;
  readonly exitCode: number;
  readonly reason: string | null;
  readonly summaryPath: string | null;
  readonly summary: {
    readonly routes: number;
    readonly verified: number;
    readonly review: number;
    readonly untested: number;
    readonly partial: number;
  };
  readonly routes: readonly ProjectRouteResult[];
  /** A clean check is bounded evidence, never proof that the whole application is bug free. */
  readonly caveat: string;
}

/** A deliberately small, non-secret preflight result for local UI and CI onboarding. */
export interface ProjectJourneyPreflight {
  readonly schemaVersion: "tvdoctor.project-preflight/v1";
  readonly status: "READY" | "BLOCKED";
  readonly routes: readonly {
    readonly id: string;
    readonly status: "READY" | "BLOCKED";
    readonly reason: "missing-journey-environment" | "invalid-journey-file"
      | "missing-journey-secret" | "missing-auth-ready-assertion" | null;
  }[];
}

const CAVEAT = "A clean bounded audit does not certify all routes, accessibility or a bug-free application.";

class ProjectConfigError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

function record(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectConfigError(`invalid-${label}`);
  }
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !keys.includes(key))) {
    throw new ProjectConfigError(`unknown-${label}-property`);
  }
  return object;
}

function urlOf(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048 || value.trim() !== value
    || value.includes("\\") || Array.from(value).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || (code >= 127 && code <= 159);
    })) {
    throw new ProjectConfigError("invalid-base-url");
  }
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new ProjectConfigError("invalid-base-url"); }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") {
    throw new ProjectConfigError("invalid-base-url");
  }
  return parsed.origin;
}

function routePath(value: unknown): string {
  if (typeof value !== "string" || value.length > 512 || !SAFE_ROUTE.test(value)
    || value.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new ProjectConfigError("invalid-route-path");
  }
  return value;
}

function selected<T extends string>(value: unknown, allowed: readonly T[], fallback: T, reason: string): T {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new ProjectConfigError(reason);
  return value as T;
}

function parseAuthReady(value: unknown): NonNullable<ProjectRouteV1["authReady"]> {
  const input = record(value, "auth-ready", ["role", "name"]);
  const role = input["role"];
  const name = input["name"];
  if (typeof role !== "string" || !AUTH_READY_ROLES.includes(role as (typeof AUTH_READY_ROLES)[number])
    || typeof name !== "string" || name.length < 1 || name.length > 128
    || name.trim() !== name || /[\p{Cc}\p{Cf}]/u.test(name)) {
    throw new ProjectConfigError("invalid-auth-ready-assertion");
  }
  return { role: role as (typeof AUTH_READY_ROLES)[number], name };
}

/** Strict schema validation, independent of filesystem and the CLI dispatcher. */
export function parseProjectManifest(value: unknown): ProjectManifestV1 {
  const input = record(value, "manifest", ["schemaVersion", "baseUrl", "mode", "failOn", "interactions", "routes"]);
  if (input["schemaVersion"] !== "tvdoctor.project/v1") throw new ProjectConfigError("unsupported-project-schema");
  const baseUrl = urlOf(input["baseUrl"]);
  const mode = selected(input["mode"], MODES, "quick", "invalid-project-mode");
  const failOn = selected(input["failOn"], CI_THRESHOLDS, "any", "invalid-project-fail-on");
  const interactions = input["interactions"] ?? false;
  if (typeof interactions !== "boolean") throw new ProjectConfigError("invalid-project-interactions");
  if (!Array.isArray(input["routes"]) || input["routes"].length < 1 || input["routes"].length > MAX_ROUTES) {
    throw new ProjectConfigError("invalid-project-routes");
  }
  const ids = new Set<string>();
  const targets = new Set<string>();
  const routes: ProjectRouteV1[] = input["routes"].map((item: unknown) => {
    const route = record(item, "route", ["id", "path", "journeyEnv", "authReady"]);
    const id = route["id"];
    if (typeof id !== "string" || !ROUTE_ID.test(id) || ids.has(id)) {
      throw new ProjectConfigError("invalid-or-duplicate-route-id");
    }
    ids.add(id);
    const path = routePath(route["path"]);
    const url = new URL(path, baseUrl);
    if (url.origin !== baseUrl || targets.has(url.href)) throw new ProjectConfigError("duplicate-or-cross-origin-route");
    targets.add(url.href);
    const journeyEnv = route["journeyEnv"];
    if (journeyEnv !== undefined && (typeof journeyEnv !== "string" || !JOURNEY_ENV.test(journeyEnv))) {
      throw new ProjectConfigError("invalid-journey-environment");
    }
    const authReady = route["authReady"] === undefined ? undefined : parseAuthReady(route["authReady"]);
    if (authReady !== undefined && journeyEnv === undefined) {
      throw new ProjectConfigError("auth-ready-requires-journey");
    }
    return { id, path, ...(journeyEnv === undefined ? {} : { journeyEnv }),
      ...(authReady === undefined ? {} : { authReady }) };
  });
  return { schemaVersion: "tvdoctor.project/v1", baseUrl, mode, failOn, interactions, routes };
}

async function boundedRegularFile(path: string, maximum: number, reason: string): Promise<Buffer> {
  // Disallow symlinked inputs and reread the metadata after reading to detect
  // replacement. Neither the manifest nor the journey can name another file.
  if (!isAbsolute(path) || path.length > 4096 || path.includes("\0")) throw new ProjectConfigError(reason);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const initial = await lstat(path);
    if (!initial.isFile() || initial.isSymbolicLink() || initial.size < 1 || initial.size > maximum) {
      throw new ProjectConfigError(reason);
    }
    handle = await open(path, "r");
    const current = await handle.stat();
    if (!current.isFile() || current.size !== initial.size
      || current.size > maximum || current.size < 1) throw new ProjectConfigError(reason);
    const bytes = Buffer.alloc(current.size);
    let read = 0;
    while (read < bytes.length) {
      const part = await handle.read(bytes, read, bytes.length - read, read);
      if (part.bytesRead <= 0) throw new ProjectConfigError(reason);
      read += part.bytesRead;
    }
    const last = await lstat(path);
    if (!last.isFile() || last.isSymbolicLink() || last.size !== initial.size
      || last.mtimeMs !== initial.mtimeMs || last.ino !== initial.ino) {
      throw new ProjectConfigError(reason);
    }
    return bytes;
  } catch {
    throw new ProjectConfigError(reason);
  } finally {
    await handle?.close();
  }
}

export async function loadProjectManifest(path: string): Promise<ProjectManifestV1> {
  let raw: Buffer;
  try { raw = await boundedRegularFile(resolve(path), MAX_MANIFEST_BYTES, "invalid-project-file"); }
  catch { throw new ProjectConfigError("invalid-project-file"); }
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString("utf8")) as unknown; }
  catch { throw new ProjectConfigError("invalid-project-json"); }
  return parseProjectManifest(parsed);
}

/**
 * Validate route journey setup without opening a browser, retaining secret
 * values, or disclosing environment variable names and filesystem paths.
 * Invalid manifests deliberately produce an empty, blocked result: callers
 * must validate manifest syntax separately for detailed form errors.
 */
export async function preflightProjectJourneys(options: {
  readonly manifestPath: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** New-capture mode. Omit for legacy read/verify compatibility. */
  readonly requireAuthReady?: boolean;
}): Promise<ProjectJourneyPreflight> {
  const blocked: ProjectJourneyPreflight = {
    schemaVersion: "tvdoctor.project-preflight/v1", status: "BLOCKED", routes: [],
  };
  let manifest: ProjectManifestV1;
  try { manifest = await loadProjectManifest(options.manifestPath); }
  catch { return blocked; }
  const env = options.env ?? process.env;
  const routes: ProjectJourneyPreflight["routes"][number][] = [];
  for (const route of manifest.routes) {
    let reason: ProjectJourneyPreflight["routes"][number]["reason"] = null;
    if (route.journeyEnv !== undefined) {
      const path = env[route.journeyEnv];
      if (typeof path !== "string" || !isAbsolute(path)) {
        reason = "missing-journey-environment";
      } else {
        try {
          const bytes = await boundedRegularFile(path, MAX_JOURNEY_BYTES, "invalid-journey-file");
          const parsed = parseJourney(JSON.parse(bytes.toString("utf8")) as unknown);
          if (parsed.steps.some((step) => step.action === "type-from-env"
            && (typeof env[step.env] !== "string" || env[step.env]?.length === 0
              || (env[step.env]?.length ?? 0) > 256))) reason = "missing-journey-secret";
        } catch { reason = "invalid-journey-file"; }
      }
      if (reason === null && options.requireAuthReady === true
        && route.authReady === undefined) reason = "missing-auth-ready-assertion";
    }
    routes.push({ id: route.id, status: reason === null ? "READY" : "BLOCKED", reason });
  }
  return { schemaVersion: "tvdoctor.project-preflight/v1",
    status: routes.some((route) => route.status === "BLOCKED") ? "BLOCKED" : "READY",
    routes };
}

interface CheckJson {
  readonly status: (typeof CHECK_STATUSES)[number];
  readonly triage: { readonly summary: { readonly VERIFIED: number; readonly REVIEW: number; readonly UNTESTED: number } };
};

function boundedCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000
    ? value : -1;
}

type ProtectedProjectFailure = "protected-route-redirected" | "protected-content-unproven";

/**
 * The child cannot assert its own authentication failure reason. Only the
 * canonical source report for the exact target/mode can classify the route.
 * Never surface observed redirect locations or application-authored details.
 */
export async function inspectProtectedProjectFailure(
  reportPath: string, expectedTarget: string, mode: ProjectManifestV1["mode"],
): Promise<ProtectedProjectFailure | null> {
  try {
    const expected = resolve(reportPath);
    if (expected !== join(dirname(expected), "report.json")) return null;
    const meta = await lstat(expected);
    if (!meta.isFile() || meta.isSymbolicLink() || meta.size <= 0
      || meta.size > 16 * 1024 * 1024 || await realpath(expected) !== expected) return null;
    const raw = await readFile(expected);
    if (raw.byteLength !== meta.size) return null;
    const report = parseTVDoctorReportJson(raw.toString("utf8"));
    if (report.schemaVersion !== REPORT_SCHEMA_VERSION_V1) return null;
    const valid = report.target.platform === "web"
      && report.target.location === expectedTarget
      && report.target.environment["browser"] === "chromium"
      && report.target.environment["inputMode"] === "keyboard"
      && report.run.mode === mode && report.run.status === "partial"
      && report.issues.length === 0 && report.replays.length === 0
      && report.artifacts.length === 0
      && report.coverage.screenStatesDiscovered === 0
      && report.coverage.focusStatesDiscovered === 0
      && report.coverage.transitionsTested === 0
      && report.coverage.actionsSent === 0
      && report.coverage.packs.length > 0
      && report.coverage.budget.exhausted.length === 0
      && report.coverage.packs.every((pack) => pack.status === "partial");
    if (!valid) return null;
    if (report.target.environment["outcome"] === "project-route-inconclusive") {
      return "protected-route-redirected";
    }
    if (report.target.environment["outcome"] === "project-content-inconclusive") {
      return "protected-content-unproven";
    }
    return null;
  } catch { return null; }
}

/** Historical boolean predicate retained for existing callers. */
export async function inspectProtectedRouteRedirect(
  reportPath: string, expectedTarget: string, mode: ProjectManifestV1["mode"],
): Promise<boolean> {
  return await inspectProtectedProjectFailure(reportPath, expectedTarget, mode)
    === "protected-route-redirected";
}

export async function inspectProtectedContentUnproven(
  reportPath: string, expectedTarget: string, mode: ProjectManifestV1["mode"],
): Promise<boolean> {
  return await inspectProtectedProjectFailure(reportPath, expectedTarget, mode)
    === "protected-content-unproven";
}

/**
 * The child JSON and an unvalidated debug sidecar cannot assert a journey
 * failure. Only the exact source-produced failed report AND its bounded,
 * allowlisted sidecar from the same canonical route directory can do so.
 * No page text, browser URL or application-authored exception is returned.
 */
export async function inspectAuthenticatedJourneyFailure(
  reportPath: string, expectedTarget: string, mode: ProjectManifestV1["mode"],
): Promise<boolean> {
  try {
    const expected = resolve(reportPath);
    const directory = dirname(expected);
    if (expected !== join(directory, "report.json") || await realpath(directory) !== directory) return false;
    const debugPath = join(directory, "failure-debug.json");
    const [reportBytes, debugBytes] = await Promise.all([
      boundedRegularFile(expected, MAX_REPORT_BYTES, "invalid-source-report"),
      boundedRegularFile(debugPath, MAX_FAILURE_DEBUG_BYTES, "invalid-source-failure"),
    ]);
    if (await realpath(expected) !== expected || await realpath(debugPath) !== debugPath) return false;
    const report = parseTVDoctorReportJson(reportBytes.toString("utf8"));
    const debug: unknown = JSON.parse(debugBytes.toString("utf8")) as unknown;
    if (debug === null || typeof debug !== "object" || Array.isArray(debug)) return false;
    const diagnostic = debug as Record<string, unknown>;
    if (Object.keys(diagnostic).sort().join("|") !== "code|schemaVersion|summary"
      || diagnostic["schemaVersion"] !== 1
      || diagnostic["code"] !== "authentication-journey-failed"
      || diagnostic["summary"] !== AUTH_JOURNEY_FAILURE_SUMMARY) return false;
    const environment = report.target.environment;
    return report.schemaVersion === REPORT_SCHEMA_VERSION_V1
      && report.target.platform === "web" && report.target.location === expectedTarget
      && report.run.mode === mode && report.run.status === "failed"
      && /^failed-[a-z0-9]+$/u.test(report.run.id)
      && Object.keys(environment).sort().join("|") === "browser|failure|inputMode"
      && environment["browser"] === "chromium" && environment["inputMode"] === "keyboard"
      && environment["failure"] === AUTH_JOURNEY_FAILURE_SUMMARY
      && report.issues.length === 0 && report.replays.length === 0
      && report.artifacts.length === 0
      && report.coverage.screenStatesDiscovered === 0
      && report.coverage.focusStatesDiscovered === 0
      && report.coverage.transitionsTested === 0
      && report.coverage.actionsSent === 0
      && report.coverage.packs.length > 0
      && report.coverage.packs.every((pack) => pack.status === "skipped")
      && report.coverage.budget.exhausted.length === 0
      && report.coverage.budget.maxActions === null
      && report.coverage.budget.maxStates === null
      && report.coverage.budget.maxDepth === null
      && report.coverage.budget.maxDurationMs === null;
  } catch { return false; }
}

async function inspectCheckOutput(
  run: ProjectCheckExecution,
  outputPath: string,
  expectedTarget: string,
  mode: ProjectManifestV1["mode"],
  protectedJourney: boolean,
): Promise<{ status: RouteStatus; counts: [number, number, number]; report: boolean; reason: string | null }> {
  if (typeof run.stdout !== "string" || run.stdout.length > MAX_CHECK_STDOUT
    || !Number.isInteger(run.exitCode) || run.exitCode < 0 || run.exitCode > 4) {
    return { status: "INCONCLUSIVE", counts: [0, 0, 0], report: false, reason: "invalid-check-response" };
  }
  let data: unknown;
  try { data = JSON.parse(run.stdout.trim()) as unknown; }
  catch { return { status: "INCONCLUSIVE", counts: [0, 0, 0], report: false, reason: "invalid-check-json" }; }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { status: "INCONCLUSIVE", counts: [0, 0, 0], report: false, reason: "invalid-check-json" };
  }
  const source = data as Record<string, unknown>;
  const scan = source["scan"];
  const triage = source["triage"];
  const summary = triage !== null && typeof triage === "object" && !Array.isArray(triage)
    ? (triage as Record<string, unknown>)["summary"] : null;
  if (source["schemaVersion"] !== "tvdoctor.developer-check/v1"
    || !CHECK_STATUSES.includes(source["status"] as (typeof CHECK_STATUSES)[number])
    || source["shouldFail"] !== (run.exitCode !== 0)) {
    return { status: "INCONCLUSIVE", counts: [0, 0, 0], report: false, reason: "contradictory-check-result" };
  }
  const checkStatus = source["status"] as CheckJson["status"];
  const failed = run.exitCode === 2 || run.exitCode === 3 || run.exitCode === 4 || checkStatus === "INCONCLUSIVE";
  if (failed) {
    const rawScan = source["scan"];
    const scan = rawScan !== null && typeof rawScan === "object" && !Array.isArray(rawScan)
      ? rawScan as Record<string, unknown> : null;
    const savedCause = run.exitCode === 3 && checkStatus === "INCONCLUSIVE"
      && scan?.["status"] === "partial"
      && scan["reportPath"] === join(outputPath, "report.json")
      ? await inspectProtectedProjectFailure(join(outputPath, "report.json"), expectedTarget, mode)
      : null;
    const failedJourney = protectedJourney && run.exitCode === 3 && checkStatus === "INCONCLUSIVE"
      && scan?.["status"] === "failed"
      && scan["reportPath"] === join(outputPath, "report.json")
      && await inspectAuthenticatedJourneyFailure(join(outputPath, "report.json"), expectedTarget, mode);
    return { status: "INCONCLUSIVE", counts: [0, 0, 0], report: false,
      reason: run.exitCode === 4 ? "check-execution-failed"
        : savedCause ?? (failedJourney ? "authentication-journey-failed" : "check-inconclusive") };
  }
  if (scan === null || typeof scan !== "object" || Array.isArray(scan)
    || triage === null || typeof triage !== "object" || Array.isArray(triage)
    || summary === null || typeof summary !== "object" || Array.isArray(summary)) {
    return { status: "INCONCLUSIVE", counts: [0, 0, 0], report: false, reason: "missing-check-evidence" };
  }
  const values = summary as Record<string, unknown>;
  const counts: [number, number, number] = [
    boundedCount(values["VERIFIED"]), boundedCount(values["REVIEW"]), boundedCount(values["UNTESTED"]),
  ];
  const scanResult = scan as Record<string, unknown>;
  const triageRecord = triage as Record<string, unknown>;
  const coverage = triageRecord["coverage"];
  const integrity = triageRecord["integrity"];
  const reportPath = scanResult["reportPath"];
  if (counts.some((count) => count < 0) || scanResult["status"] !== "completed"
    || typeof reportPath !== "string" || resolve(reportPath) !== join(outputPath, "report.json")
    || coverage === null || typeof coverage !== "object" || Array.isArray(coverage)
    || (coverage as Record<string, unknown>)["incomplete"] !== false
    || integrity === null || typeof integrity !== "object" || Array.isArray(integrity)
    || (integrity as Record<string, unknown>)["report"] !== "validated"
    || (integrity as Record<string, unknown>)["evidence"] === "degraded") {
    return { status: "INCONCLUSIVE", counts: [0, 0, 0], report: false, reason: "incomplete-check-evidence" };
  }
  try {
    const meta = await lstat(reportPath);
    if (!meta.isFile() || meta.isSymbolicLink() || meta.size < 1 || meta.size > 16 * 1024 * 1024) {
      throw new Error("Invalid report artifact.");
    }
  } catch {
    return { status: "INCONCLUSIVE", counts: [0, 0, 0], report: false, reason: "missing-check-report" };
  }
  const status: RouteStatus = run.exitCode === 1
    && (checkStatus === "FINDINGS" || checkStatus === "REGRESSED") ? "FINDINGS"
    : run.exitCode === 0 && checkStatus === "REVIEW_REQUIRED" ? "REVIEW_REQUIRED"
      : run.exitCode === 0 && checkStatus === "NO_VERIFIED_FAILURES_AT_THRESHOLD" ? "PASS"
        : "INCONCLUSIVE";
  return { status, counts, report: status !== "INCONCLUSIVE",
    reason: status === "INCONCLUSIVE" ? "contradictory-check-status" : null };
}

function failure(reason: string, exitCode: number, routes: readonly ProjectRouteResult[] = []): ProjectCheckResult {
  return { schemaVersion: "tvdoctor.project-check/v1", status: "INCONCLUSIVE", shouldFail: true,
    exitCode, reason, summaryPath: null,
    summary: { routes: routes.length, verified: routes.reduce((sum, route) => sum + route.verified, 0),
      review: routes.reduce((sum, route) => sum + route.review, 0),
      untested: routes.reduce((sum, route) => sum + route.untested, 0),
      partial: routes.filter((route) => route.status === "INCONCLUSIVE").length },
    routes, caveat: CAVEAT };
}

/**
 * Run the existing JSON developer-check once per explicit route. No parallel
 * browsers, no new scanner, and no file/secret names from the manifest.
 * Errors never yield exit 0; the CLI can forward the returned result as JSON.
 */
export async function runProjectCheck(options: ProjectCheckOptions): Promise<ProjectCheckResult> {
  if (typeof options.executeCheck !== "function"
    || typeof options.outputRoot !== "string" || options.outputRoot.trim().length === 0
    || options.outputRoot.length > 4096 || options.outputRoot.includes("\0")) {
    return failure("invalid-project-options", 2);
  }
  let manifest: ProjectManifestV1;
  try { manifest = await loadProjectManifest(options.manifestPath); }
  catch (error) {
    return failure(error instanceof ProjectConfigError ? error.reason : "invalid-project-file", 2);
  }
  const env = options.env ?? process.env;
  const journeys = new Map<string, Buffer>();
  try {
    for (const route of manifest.routes) {
      if (route.journeyEnv === undefined) continue;
      const secretPath = env[route.journeyEnv];
      if (typeof secretPath !== "string" || !isAbsolute(secretPath)) {
        throw new ProjectConfigError("missing-journey-environment");
      }
      const bytes = await boundedRegularFile(secretPath, MAX_JOURNEY_BYTES, "invalid-journey-file");
      try { parseJourney(JSON.parse(bytes.toString("utf8")) as unknown); }
      catch { throw new ProjectConfigError("invalid-journey-file"); }
      // Keep the approved bytes, not the source path: a developer process
      // could otherwise change the journey between consecutive route scans.
      journeys.set(route.id, bytes);
    }
  } catch (error) {
    return failure(error instanceof ProjectConfigError ? error.reason : "invalid-journey-file", 2);
  }
  const root = resolve(options.outputRoot);
  try {
    // Match the existing check command's `Tests/...` default when this is the
    // first TVDoctor run on a fresh checkout. Only the parent is recursive;
    // the actual output directory remains strictly create-only.
    await mkdir(dirname(root), { recursive: true });
    await mkdir(root, { mode: 0o700 });
  }
  catch { return failure("output-root-not-fresh-or-unavailable", 2); }
  let stagingDirectory: string | null = null;
  let outcome: ProjectCheckResult;
  try {
    const stagedJourneys = new Map<string, string>();
    if (journeys.size > 0) {
      // Keep credential-bearing journey copies OUTSIDE the report bundle, so
      // uploading CI artifacts cannot accidentally publish them. The private
      // files are deleted after every route, including failed and partial runs.
      stagingDirectory = await mkdtemp(join(tmpdir(), "tvdoctor-project-journey-"));
      for (const [id, bytes] of journeys) {
        const stagedPath = join(stagingDirectory, `${id}.json`);
        await writeFile(stagedPath, bytes, { mode: 0o600, flag: "wx" });
        stagedJourneys.set(id, stagedPath);
      }
    }
  const routes: ProjectRouteResult[] = [];
  for (const route of manifest.routes) {
    if (route.journeyEnv !== undefined && route.authReady === undefined) {
      // Old v1 manifests remain readable by offline inspection and original
      // verification, but a NEW authenticated scan cannot claim PASS from URL
      // equality or journey execution alone. Do not launch a browser.
      routes.push({ id: route.id, status: "INCONCLUSIVE", exitCode: 3,
        verified: 0, review: 0, untested: 0, reportRelativePath: null,
        reason: "missing-auth-ready-assertion" });
      continue;
    }
    const routeOutput = join(root, route.id);
    const target = new URL(route.path, manifest.baseUrl).href;
    const args = ["check", target, "--json", "--mode", manifest.mode,
      "--fail-on", manifest.failOn, "--output", routeOutput, "--require-target-route",
      ...(manifest.interactions ? ["--interactions"] : []),
      ...(route.authReady === undefined ? []
        : ["--auth-ready-role", route.authReady.role, "--auth-ready-name", route.authReady.name]),
      ...(stagedJourneys.has(route.id) ? ["--journey", stagedJourneys.get(route.id) ?? ""] : [])];
    let execution: ProjectCheckExecution;
    try { execution = await options.executeCheck(args); }
    catch {
      routes.push({ id: route.id, status: "INCONCLUSIVE", exitCode: 4,
        verified: 0, review: 0, untested: 0, reportRelativePath: null, reason: "check-execution-failed" });
      continue;
    }
    const result = await inspectCheckOutput(execution, routeOutput, target, manifest.mode,
      route.journeyEnv !== undefined && route.authReady !== undefined);
    routes.push({ id: route.id, status: result.status,
      exitCode: result.status === "INCONCLUSIVE" && execution.exitCode === 0 ? 3 : execution.exitCode,
      verified: result.counts[0], review: result.counts[1], untested: result.counts[2],
      reportRelativePath: result.report ? `${route.id}/report.json` : null,
      reason: result.reason });
  }
  const partial = routes.filter((route) => route.status === "INCONCLUSIVE").length;
  const failed = routes.some((route) => route.status === "FINDINGS");
  const review = routes.some((route) => route.status === "REVIEW_REQUIRED");
  const exitCode = partial > 0
    ? routes.some((route) => route.exitCode === 4) ? 4 : 3
    : failed ? 1 : 0;
  const status: RouteStatus = partial > 0 ? "INCONCLUSIVE"
    : failed ? "FINDINGS" : review ? "REVIEW_REQUIRED" : "PASS";
  const result: ProjectCheckResult = {
    schemaVersion: "tvdoctor.project-check/v1", status,
    shouldFail: exitCode !== 0, exitCode, reason: partial > 0 ? "one-or-more-routes-inconclusive" : null,
    summaryPath: join(root, "summary.json"),
    summary: { routes: routes.length,
      verified: routes.reduce((sum, route) => sum + route.verified, 0),
      review: routes.reduce((sum, route) => sum + route.review, 0),
      untested: routes.reduce((sum, route) => sum + route.untested, 0),
      partial }, routes, caveat: CAVEAT,
  };
  outcome = result;
  } catch {
    outcome = failure("project-journey-staging-or-execution-failed", 4);
  }
  if (stagingDirectory !== null) {
    try { await rm(stagingDirectory, { recursive: true, force: true }); }
    catch { outcome = failure("project-journey-cleanup-failed", 4); }
  }
  // Publish the summary only after temporary credential-bearing files have
  // been removed. Never leave an on-disk PASS summary if cleanup fails.
  if (outcome.summaryPath !== null) {
    try {
      await writeFile(outcome.summaryPath, JSON.stringify(outcome, null, 2) + "\n",
        { mode: 0o600, flag: "wx" });
    } catch { outcome = failure("project-summary-write-failed", 4); }
  }
  return outcome;
}
