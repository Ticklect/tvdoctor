import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ISSUE_SEVERITIES, parseTVDoctorReportJson } from "@tvdoctor/protocol";
import { sanitiseUntrustedText } from "@tvdoctor/reporters";
import { inspectReport, type ActionableTriageFinding } from "./node-triage.js";

const MAX_REPORT_BYTES = 16 * 1024 * 1024;
const MAX_PROJECT_BYTES = 256 * 1024;
const MAX_PROJECT_ROUTES = 8;
const MAX_HANDOFF_FINDINGS = 3;
const ROUTE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const ORIGINAL_URL = '"REPLACE_WITH_ORIGINAL_AUTHORIZED_URL"';
const ORIGINAL_JOURNEY = '"REPLACE_WITH_ORIGINAL_JOURNEY_JSON"';
const ORIGINAL_PROTECTED_LANDMARK = '"REPLACE_WITH_ORIGINAL_PROTECTED_LANDMARK_NAME"';
const ORIGINAL_PROTECTED_ROLE = "REPLACE_WITH_ORIGINAL_MARKER_ROLE";
const SAFE_RULES = new Set([
  "keyboard.modal-focus-escape",
  "keyboard.modal-tab-focus-loss",
  "keyboard.modal-open-focus-not-transferred",
]);

export interface FirstRunHandoffOptions {
  /** Canonical report.json or its report bundle directory, never a browser URL. */
  readonly reportPath?: string;
  /** Canonical project summary.json or its directory. */
  readonly projectSummaryPath?: string;
}

export interface FirstRunHandoffFinding {
  readonly routeId: string | null;
  readonly issueId: string;
  readonly rule: string;
  readonly severity: string;
  /** REVIEW_ORIGINAL is a manual lead only; neither class implies a repaired state. */
  readonly classification: "VERIFIED_ORIGINAL" | "REVIEW_ORIGINAL";
  readonly title: string;
  readonly expected: string;
  readonly observed: string;
  readonly evidence: readonly string[];
  readonly verifiedArtifacts: number;
  /** Relative, hash-checked report-bundle files, not arbitrary links. */
  readonly verifiedEvidenceFiles: readonly string[];
  readonly replayArtifactVerified: boolean;
  readonly reproduction: { readonly stored: boolean; readonly freshlyVerified: false };
  readonly commands: {
    readonly inspect: string;
    readonly reproduce: string | null;
    readonly verifyFix: string | null;
    readonly regressionCompare: string | null;
  };
  readonly caution: string;
}

export interface FirstRunHandoff {
  readonly schemaVersion: "tvdoctor.first-run-handoff/v1";
  readonly source: "report" | "project";
  readonly status: "ACTION_REQUIRED" | "REVIEW_REQUIRED" | "NO_VERIFIED_FAILURES_IN_COVERAGE" | "INCONCLUSIVE";
  readonly shouldFail: boolean;
  readonly summary: {
    readonly routes: number;
    readonly verified: number;
    readonly review: number;
    readonly untested: number;
    readonly incompleteRoutes: number;
    readonly selected: number;
  };
  readonly findings: readonly FirstRunHandoffFinding[];
  readonly caveats: readonly string[];
}

export interface FirstRunHandoffIo {
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
}

interface RouteEvidence {
  readonly id: string | null;
  readonly reportPath: string;
  readonly total: { readonly verified: number; readonly review: number; readonly untested: number };
  readonly incomplete: boolean;
  readonly findings: readonly FirstRunHandoffFinding[];
}

function safeText(text: string, maxLength = 300): string {
  // Application-controlled strings may include command-shaped Markdown,
  // credentials or local paths. Keep every observation a bounded, inert line.
  const redacted = sanitiseUntrustedText(text, 1_024)
    .replace(/<[^>]{1,512}>/gu, "[HTML REDACTED]")
    .replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"'()[\]]+/gu, "[URL REDACTED]")
    .replace(/(?:\\\\[^\s<>]+|\b[A-Za-z]:[\\/][^\s<>]+)/gu, "[PATH REDACTED]")
    .replace(/(^|[\s('">=:])\/(?:[^\s<>"'()[\]]+)/gu, "$1[PATH REDACTED]")
    .replace(/[\r\n\u2028\u2029]+/gu, " ")
    .replace(/\s+/gu, " ").trim();
  return Array.from(redacted).slice(0, maxLength).join("");
}

function quotePath(path: string): string {
  // JSON double-quoting also makes spaces and control characters safe for a
  // displayed command. Never interpolate target-derived HTML or shell text.
  return JSON.stringify(path);
}

function validPath(path: unknown): path is string {
  return typeof path === "string" && path.trim() === path
    && path.length > 0 && path.length <= 4_096 && !path.includes("\0");
}

function canonicalFile(path: string, filename: string): string {
  const full = resolve(path);
  return full.endsWith(filename) ? full : join(full, filename);
}

async function boundedFile(path: string, maxBytes: number): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > maxBytes) {
    throw new Error("invalid-evidence-file");
  }
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (!after.isFile() || after.isSymbolicLink() || bytes.length !== before.size
    || after.size !== before.size || after.mtimeMs !== before.mtimeMs
    || after.ino !== before.ino) {
    throw new Error("changed-evidence-file");
  }
  return bytes;
}

async function readReportContext(path: string, runId: string, issueCount: number): Promise<{
  readonly sha256: string;
  readonly needsOriginalTarget: boolean;
  readonly needsJourney: boolean;
  readonly needsAuthReady: boolean;
  readonly keyboardWeb: boolean;
}> {
  const bytes = await boundedFile(path, MAX_REPORT_BYTES);
  const report = parseTVDoctorReportJson(bytes.toString("utf8"));
  if (report.schemaVersion !== "tvdoctor.report/v1"
    || report.run.id !== runId || report.issues.length !== issueCount) {
    throw new Error("report-changed-between-validation-and-handoff");
  }
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    needsOriginalTarget: report.target.environment["replayTargetOverride"] === "required",
    needsJourney: typeof report.target.environment["journeyConfigSha256"] === "string",
    needsAuthReady: typeof report.target.environment["authReadySha256"] === "string",
    keyboardWeb: report.target.platform === "web" && report.target.environment["inputMode"] === "keyboard",
  };
}

function makeFinding(
  finding: ActionableTriageFinding, routeId: string | null, reportPath: string,
  context: Awaited<ReturnType<typeof readReportContext>>,
  complete: boolean,
): FirstRunHandoffFinding {
  const inspect = `tvdoctor findings --report ${quotePath(reportPath)}`;
  const verified = finding.artifacts.filter((artifact) => artifact.status === "verified");
  const replayVerified = verified.some((artifact) => artifact.kind === "replay");
  const validIssueId = /^[A-Za-z0-9_.:-]{1,256}$/u.test(finding.id);
  const canReplay = complete && finding.reproduction.status === "deterministic"
    && finding.reproduction.replayId !== null
    && replayVerified && validIssueId;
  // The true authorised URL can be unavailable in the redacted report.
  // Explicit placeholder avoids implicit replay against an unintended target.
  const parameters = ` --report ${quotePath(reportPath)}`
    + (context.needsOriginalTarget || context.needsAuthReady ? ` --target ${ORIGINAL_URL}` : "")
    + (context.needsJourney ? ` --journey ${ORIGINAL_JOURNEY}` : "")
    + (context.needsAuthReady
      ? ` --auth-ready-role ${ORIGINAL_PROTECTED_ROLE} --auth-ready-name ${ORIGINAL_PROTECTED_LANDMARK}` : "");
  // Historical journey-only originals lack protected-content provenance and
  // cannot be independently verified. Never generate a misleading runnable
  // command that would now fail before any browser observation.
  const supportedProtectedProof = !context.needsJourney || context.needsAuthReady;
  const canRunnableReplay = canReplay && supportedProtectedProof;
  const independentOracle = canRunnableReplay && context.keyboardWeb
    && finding.pack === "navigation" && SAFE_RULES.has(finding.rule);
  return {
    routeId, issueId: finding.id, rule: safeText(finding.rule, 160),
    severity: finding.severity, classification: "VERIFIED_ORIGINAL",
    title: safeText(finding.title, 180),
    expected: safeText(finding.expected),
    observed: safeText(finding.observed),
    evidence: finding.evidence.slice(0, 2).map((entry) => safeText(entry.summary, 200)),
    verifiedArtifacts: verified.length,
    verifiedEvidenceFiles: verified.filter((entry) => entry.path !== null)
      .slice(0, 4).map((entry) => safeText(entry.path ?? "", 240)),
    replayArtifactVerified: replayVerified,
    reproduction: { stored: true, freshlyVerified: false },
    commands: {
      inspect,
      reproduce: canRunnableReplay ? `tvdoctor replay ${finding.id}${parameters}` : null,
      verifyFix: independentOracle
        ? `tvdoctor verify-fix ${finding.id}${parameters} --authorized --sha256 ${context.sha256}` : null,
      regressionCompare: independentOracle
        ? `tvdoctor verify-fix ${finding.id}${parameters} --authorized --sha256 ${context.sha256} --scan-output "REPLACE_WITH_NEW_DIRECTORY" --compare` : null,
    },
    caution: !supportedProtectedProof
      ? "Historical protected evidence lacks the original authenticated-content binding. Recapture the unrepaired original; no independent FIXED verdict is possible."
      : !canReplay
      ? "The report or replay evidence was incomplete or not independently verified; inspect before attempting manual reproduction."
      : !independentOracle
        ? "Deterministic original replay only. This rule has no independent FIXED oracle."
        : "FIXED requires a separate real browser replay. A fresh missing finding or non-comparable inventory never proves FIXED.",
  };
}

function makeReviewFinding(
  finding: ActionableTriageFinding, routeId: string | null,
): FirstRunHandoffFinding {
  // REVIEW is neither reproducible nor an oracle for FIXED, even if an old
  // report happens to contain a replay artifact with the same issue ID.
  const verified = finding.artifacts.filter((artifact) =>
    artifact.status === "verified" && artifact.kind !== "replay");
  return {
    routeId, issueId: finding.id, rule: safeText(finding.rule, 160),
    severity: finding.severity, classification: "REVIEW_ORIGINAL",
    title: safeText(finding.title, 180),
    expected: safeText(finding.expected), observed: safeText(finding.observed),
    evidence: finding.evidence.slice(0, 2).map((entry) => safeText(entry.summary, 200)),
    verifiedArtifacts: verified.length,
    verifiedEvidenceFiles: verified.filter((entry) => entry.path !== null)
      .slice(0, 4).map((entry) => safeText(entry.path ?? "", 240)),
    replayArtifactVerified: false,
    reproduction: { stored: false, freshlyVerified: false },
    // Path is replaced in the portable review command; the local offline
    // handoff is able to identify its source route via routeId.
    commands: {
      inspect: `tvdoctor findings --report ${quotePath("REPLACE_WITH_ORIGINAL_REPORT_JSON")}`,
      reproduce: null, verifyFix: null, regressionCompare: null,
    },
    caution: "REVIEW ONLY. Inspect the saved report and independently confirm the observed behaviour on an authorised test target. This is not a verified defect, replay, regression, or FIXED result.",
  };
}

async function loadRoute(reportPath: string, routeId: string | null): Promise<RouteEvidence> {
  const canonical = canonicalFile(reportPath, "report.json");
  // inspectReport verifies cross-links and available evidence artifacts, not
  // merely the presence of a plausible-looking JSON object.
  const triage = await inspectReport(canonical, { maxFindings: 100 });
  const context = await readReportContext(canonical, triage.run.id, triage.summary.total);
  const complete = !triage.coverage.incomplete && triage.integrity.evidence !== "degraded"
    && triage.summary.omitted === 0;
  const candidates = triage.findings
    .filter((entry) => entry.classification === "VERIFIED" && entry.reproduction.status === "deterministic")
    .sort((left, right) => ISSUE_SEVERITIES.indexOf(left.severity) - ISSUE_SEVERITIES.indexOf(right.severity)
      || left.id.localeCompare(right.id));
  // Prioritise deterministic originals. REVIEW candidates occupy only spare
  // slots and require a nonmodal, evidence-bearing original observation.
  const reviews = triage.findings
    .filter((entry) => entry.classification === "REVIEW"
      && !/(?:^|[.-])modal(?:[.-]|$)/iu.test(entry.rule)
      && entry.evidence.length > 0
      && /^[A-Za-z0-9_.:-]{1,256}$/u.test(entry.id))
    .sort((left, right) => ISSUE_SEVERITIES.indexOf(left.severity) - ISSUE_SEVERITIES.indexOf(right.severity)
      || left.id.localeCompare(right.id));
  const selectedVerified = candidates.slice(0, MAX_HANDOFF_FINDINGS)
    .map((finding) => makeFinding(finding, routeId, canonical, context, complete));
  return {
    id: routeId, reportPath: canonical,
    total: { verified: triage.summary.VERIFIED, review: triage.summary.REVIEW, untested: triage.summary.UNTESTED },
    incomplete: !complete,
    findings: [...selectedVerified,
      ...reviews.slice(0, MAX_HANDOFF_FINDINGS - selectedVerified.length)
        .map((finding) => makeReviewFinding(finding, routeId))],
  };
}

async function loadProject(path: string): Promise<{ readonly routes: readonly RouteEvidence[];
  readonly routeCount: number; readonly incomplete: number; readonly summaryInconclusive: boolean }> {
  const summaryPath = canonicalFile(path, "summary.json");
  const bytes = await boundedFile(summaryPath, MAX_PROJECT_BYTES);
  const parsed: unknown = JSON.parse(bytes.toString("utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("invalid-project-summary");
  }
  const summary = parsed as Record<string, unknown>;
  if (summary["schemaVersion"] !== "tvdoctor.project-check/v1"
    || !Array.isArray(summary["routes"])
    || summary["routes"].length < 1 || summary["routes"].length > MAX_PROJECT_ROUTES) {
    throw new Error("invalid-project-summary");
  }
  const root = await realpath(dirname(summaryPath));
  const seen = new Set<string>();
  let incomplete = 0;
  const routes: RouteEvidence[] = [];
  for (const item of summary["routes"]) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("invalid-project-route");
    }
    const row = item as Record<string, unknown>;
    const id = row["id"];
    const status = row["status"];
    if (typeof id !== "string" || !ROUTE_ID.test(id) || seen.has(id)
      || !["PASS", "REVIEW_REQUIRED", "FINDINGS", "INCONCLUSIVE"].includes(String(status))) {
      throw new Error("invalid-project-route");
    }
    seen.add(id);
    const pathPart = row["reportRelativePath"];
    if (status === "INCONCLUSIVE" || pathPart === null) {
      if (status !== "INCONCLUSIVE" && pathPart === null) throw new Error("missing-project-report");
      incomplete += 1;
      continue;
    }
    if (pathPart !== `${id}/report.json`) throw new Error("unsafe-project-report-path");
    const folder = join(root, id);
    const metadata = await lstat(folder);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()
      || await realpath(folder) !== folder) throw new Error("unsafe-project-report-folder");
    const evidence = await loadRoute(join(folder, "report.json"), id);
    if (evidence.total.verified !== row["verified"] || evidence.total.review !== row["review"]
      || evidence.total.untested !== row["untested"]
      || (status === "FINDINGS" && evidence.total.verified === 0)
      || (status === "REVIEW_REQUIRED" && evidence.total.review === 0)) {
      incomplete += 1;
    }
    routes.push(evidence);
  }
  return { routes, routeCount: summary["routes"].length, incomplete,
    summaryInconclusive: summary["status"] === "INCONCLUSIVE" };
}

/** Fast offline fix handoff for a single completed check or an aggregate project QA run. */
export async function createFirstRunHandoff(options: FirstRunHandoffOptions): Promise<FirstRunHandoff> {
  if ((options.reportPath === undefined) === (options.projectSummaryPath === undefined)
    || (options.reportPath !== undefined && !validPath(options.reportPath))
    || (options.projectSummaryPath !== undefined && !validPath(options.projectSummaryPath))) {
    throw new TypeError("Exactly one bounded --report or --project path is required.");
  }
  const project = options.projectSummaryPath !== undefined;
  const loaded = project
    ? await loadProject(options.projectSummaryPath as string)
    : { routes: [await loadRoute(options.reportPath as string, null)], routeCount: 1,
      incomplete: 0, summaryInconclusive: false };
  const routes = loaded.routes;
  const knownIncomplete = loaded.incomplete + routes.filter((route) => route.incomplete).length;
  // A parent summary may say INCONCLUSIVE even when each individual route
  // seems complete; preserve that unexplained blocker, never synthesize PASS.
  const incomplete = loaded.summaryInconclusive ? Math.max(1, knownIncomplete) : knownIncomplete;
  const totals = routes.reduce((counts, route) => ({
    verified: counts.verified + route.total.verified,
    review: counts.review + route.total.review,
    untested: counts.untested + route.total.untested,
  }), { verified: 0, review: 0, untested: 0 });
  const findings = routes.flatMap((route) => route.findings)
    .sort((left, right) => (left.classification === "VERIFIED_ORIGINAL" ? 0 : 1)
      - (right.classification === "VERIFIED_ORIGINAL" ? 0 : 1)
      || ISSUE_SEVERITIES.indexOf(left.severity as typeof ISSUE_SEVERITIES[number])
      - ISSUE_SEVERITIES.indexOf(right.severity as typeof ISSUE_SEVERITIES[number])
      || left.issueId.localeCompare(right.issueId)
      || (left.routeId ?? "").localeCompare(right.routeId ?? ""))
    .slice(0, MAX_HANDOFF_FINDINGS);
  const status: FirstRunHandoff["status"] = incomplete > 0 ? "INCONCLUSIVE"
    : totals.verified > 0 ? "ACTION_REQUIRED"
      : totals.review > 0 ? "REVIEW_REQUIRED" : "NO_VERIFIED_FAILURES_IN_COVERAGE";
  return {
    schemaVersion: "tvdoctor.first-run-handoff/v1", source: project ? "project" : "report",
    status, shouldFail: status === "ACTION_REQUIRED" || status === "INCONCLUSIVE",
    summary: { routes: loaded.routeCount,
      ...totals, incompleteRoutes: incomplete, selected: findings.length },
    findings,
    caveats: [
      "VERIFIED_ORIGINAL is a classification of recorded evidence, not confirmation that a repair was tested.",
      "REVIEW_ORIGINAL is an unconfirmed manual investigation lead; it has no trusted replay or independent FIXED oracle.",
      "The scan is bounded. No findings does not certify a bug-free app or WCAG conformance.",
      "Replay and verify-fix require authorised target access; restore the original journey and secrets through environment variables where applicable.",
      ...(incomplete > 0 ? ["INCONCLUSIVE: incomplete or mismatched coverage prevents any clean-run claim."] : []),
    ],
  };
}

export function formatFirstRunHandoff(result: FirstRunHandoff): string {
  const lines = [
    `TVDoctor handoff: ${result.status} — ${String(result.summary.verified)} original verified, ${String(result.summary.review)} review, ${String(result.summary.incompleteRoutes)} incomplete route(s).`,
  ];
  for (const [index, finding] of result.findings.entries()) {
    lines.push(`\n${String(index + 1)}. [${finding.classification === "VERIFIED_ORIGINAL" ? "VERIFIED ORIGINAL" : "REVIEW ORIGINAL — UNCONFIRMED"}] ${finding.severity.toUpperCase()} ${finding.issueId}`,
      `   ${finding.routeId === null ? "" : `Route: ${finding.routeId} — `}${finding.title}`,
      `   Expected: ${finding.expected}`,
      `   Observed: ${finding.observed}`,
      ...finding.evidence.map((entry) => `   Evidence: ${entry}`),
      ...finding.verifiedEvidenceFiles.map((path) => `   Hash-verified file (relative to report.json): ${path}`),
      `   Inspect: ${finding.commands.inspect}`,
      ...(finding.commands.reproduce === null ? [] : [`   Reproduce: ${finding.commands.reproduce}`]),
      ...(finding.commands.verifyFix === null ? [] : [`   After repair: ${finding.commands.verifyFix}`]),
      ...(finding.commands.regressionCompare === null ? [] : [`   Regression check: ${finding.commands.regressionCompare}`]),
      `   Note: ${finding.caution}`);
  }
  if (result.findings.length === 0) {
    lines.push(result.status === "INCONCLUSIVE"
      ? "Repair the incomplete scan or missing project route evidence, then rerun before asserting a pass."
      : result.status === "REVIEW_REQUIRED"
        ? "Review heuristic observations in report.html or with tvdoctor findings --report PATH."
        : "No verified original defect in observed bounded coverage; expand real workflow coverage.");
  }
  lines.push("", ...result.caveats.map((caveat) => `Note: ${caveat}`));
  return lines.join("\n") + "\n";
}

/** Can be called directly from CLI dispatch or with: node dist/first-run-handoff.js --report PATH. */
export async function runFirstRunHandoffCli(args: readonly string[], io: FirstRunHandoffIo): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    io.writeStdout("Usage: tvdoctor handoff (--report REPORT_JSON_OR_DIR | --project SUMMARY_JSON_OR_DIR) [--json]\nOffline, bounded, no browser or credentials. A handoff is never an independently verified FIXED result.\n");
    return 0;
  }
  let path: string | null = null;
  let kind: "--report" | "--project" | null = null;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--json" && !json) { json = true; continue; }
    if ((flag === "--report" || flag === "--project") && path === null) {
      const value = args[index + 1];
      if (!validPath(value) || value.length > 1_024 || value.startsWith("--")) break;
      kind = flag;
      path = value;
      index += 1;
      continue;
    }
    io.writeStderr("Invalid handoff options. Use --report PATH or --project PATH, optionally --json.\n");
    return 2;
  }
  if (path === null || kind === null) {
    io.writeStderr("Exactly one --report or --project path is required.\n");
    return 2;
  }
  try {
    const result = await createFirstRunHandoff(kind === "--report"
      ? { reportPath: path } : { projectSummaryPath: path });
    io.writeStdout(json ? `${JSON.stringify(result)}\n` : formatFirstRunHandoff(result));
    return result.status === "INCONCLUSIVE" ? 3 : 0;
  } catch {
    // Never echo an untrusted file name, document contents, URL or credentials.
    io.writeStderr("Handoff INCONCLUSIVE: report or project evidence invalid or unavailable.\n");
    return 3;
  }
}

// An immediately usable source-checkout command without edits to the shared
// CLI dispatcher. Importing the module never starts the command.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runFirstRunHandoffCli(process.argv.slice(2), {
    writeStdout: (value) => { process.stdout.write(value); },
    writeStderr: (value) => { process.stderr.write(value); },
  }).then((exit) => { process.exitCode = exit; }).catch(() => { process.exitCode = 3; });
}
