import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ISSUE_SEVERITIES,
  PROTOCOL_VALIDATION_LIMITS,
  REPORT_SCHEMA_VERSION_V1,
  parseTVDoctorReportJson,
  type ArtifactDescriptor,
  type IssueConfidence,
  type IssueSeverity,
  type TVDoctorIssue,
  type TVDoctorReportV1,
} from "@tvdoctor/protocol";
import { assertPortableRelativePath, issueOwnsArtifactId, validateTVDoctorReportV1 } from "@tvdoctor/reporters";

const DEFAULT_MAX_FINDINGS = 80;
const HARD_MAX_FINDINGS = 100;
const MAX_ARTIFACTS_CHECKED = 64;
const MAX_BYTES_CHECKED = 128 * 1024 * 1024;
const MAX_SINGLE_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACTS_PER_FINDING = 12;
const SHA256 = /^[a-f0-9]{64}$/u;

export type TriageActionability = "VERIFIED" | "REVIEW" | "UNTESTED";
export type TriageArtifactStatus = "verified" | "unavailable" | "failed" | "invalid" | "not-checked";

export interface TriageArtifact {
  readonly id: string;
  readonly kind: ArtifactDescriptor["kind"];
  readonly status: TriageArtifactStatus;
  /** Path is supplied ONLY after safe filesystem and content verification. */
  readonly path: string | null;
}

export interface ActionableTriageFinding {
  readonly id: string;
  readonly rule: string;
  readonly title: string;
  readonly severity: IssueSeverity;
  readonly confidence: IssueConfidence;
  /** VERIFIED denotes the original report's deterministic evidence, never fresh verification. */
  readonly classification: TriageActionability;
  readonly pack: string;
  readonly screen: string | null;
  readonly expected: string;
  readonly observed: string;
  readonly evidence: readonly {
    readonly kind: TVDoctorIssue["evidence"][number]["kind"];
    readonly summary: string;
    readonly artifact: string | null;
  }[];
  readonly artifacts: readonly TriageArtifact[];
  readonly artifactsOmitted: number;
  readonly reproduction: {
    readonly status: "deterministic" | "best-effort" | "unavailable";
    readonly replayId: string | null;
    /** A stored replay has not been freshly executed by this offline operation. */
    readonly freshlyVerified: false;
    readonly stepCount: number | null;
  };
}

export interface ReportTriage {
  readonly schemaVersion: "tvdoctor.triage/v1";
  readonly run: {
    readonly id: string;
    readonly status: TVDoctorReportV1["run"]["status"];
    readonly mode: TVDoctorReportV1["run"]["mode"];
    readonly platform: string;
  };
  /** Severity among original evidence-backed replayable failures, including omitted findings. */
  readonly highestVerifiedSeverity: IssueSeverity | null;
  readonly summary: {
    readonly total: number;
    readonly returned: number;
    readonly omitted: number;
    readonly VERIFIED: number;
    readonly REVIEW: number;
    readonly UNTESTED: number;
  };
  readonly findings: readonly ActionableTriageFinding[];
  readonly coverage: {
    readonly status: TVDoctorReportV1["run"]["status"];
    /** Complete means only that the report's bounded packs ended successfully. */
    readonly incomplete: boolean;
    readonly observedOnly: true;
    readonly noFindingsMeansFixed: false;
    readonly reasons: readonly string[];
    readonly exhaustedBudgets: TVDoctorReportV1["coverage"]["budget"]["exhausted"];
    readonly screensObserved: number;
    readonly focusStatesObserved: number;
    readonly transitionsTested: number;
    readonly packs: TVDoctorReportV1["coverage"]["packs"];
    readonly packsOmitted: number;
  };
  readonly integrity: {
    readonly report: "validated";
    readonly evidence: "verified" | "degraded" | "bounded" | "none";
    readonly artifactsChecked: number;
    readonly artifactsRejected: number;
    readonly artifactsNotChecked: number;
    /** The filesystem is not inspected beyond the emitted, bounded finding subset. */
    readonly scope: "returned-findings";
  };
}

export interface InspectReportOptions {
  /** Default 80; capped at 100 so a huge report cannot flood agents or terminals. */
  readonly maxFindings?: number;
}

function display(value: string, limit: number): string {
  // Runtime observations are untrusted data. Keep JSON / terminal output bounded.
  return Array.from(value, (character) => {
    const point = character.codePointAt(0) ?? 0;
    return point < 32 || (point >= 127 && point <= 159) ? " " : character;
  }).join("").replace(/\s+/gu, " ").trim().slice(0, limit);
}

function classification(issue: TVDoctorIssue): TriageActionability {
  // Mirror the established reporter CI/actionability contract.
  if (issue.severity === "info" || issue.rule === "remote.startup-blocker"
    || issue.confidence === "unobservable") return "UNTESTED";
  return issue.confidence === "deterministic"
    && issue.evidence.some((evidence) => evidence.kind === "deterministic-failure")
    && issue.reproduction.status === "available"
    && issue.reproduction.confidence === "deterministic"
      ? "VERIFIED"
      : "REVIEW";
}

const CLASS_ORDER: Readonly<Record<TriageActionability, number>> = { VERIFIED: 0, REVIEW: 1, UNTESTED: 2 };
function compareIssues(a: TVDoctorIssue, b: TVDoctorIssue): number {
  return CLASS_ORDER[classification(a)] - CLASS_ORDER[classification(b)]
    || ISSUE_SEVERITIES.indexOf(a.severity) - ISSUE_SEVERITIES.indexOf(b.severity)
    || a.id.localeCompare(b.id, "en");
}

function within(root: string, candidate: string): boolean {
  const rest = relative(root, candidate);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}

async function assertBundleFile(root: string, relativePath: string): Promise<string> {
  assertPortableRelativePath(relativePath);
  const absolute = resolve(root, ...relativePath.split("/"));
  if (!within(root, absolute)) throw new TypeError("Artifact escaped its report bundle.");
  let current = root;
  for (const component of relativePath.split("/")) {
    current = join(current, component);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) throw new TypeError("Artifact path contains a symbolic link or junction.");
  }
  const metadata = await lstat(absolute);
  if (!metadata.isFile()) throw new TypeError("Artifact must be a regular file.");
  const actual = await realpath(absolute);
  if (!within(root, actual)) throw new TypeError("Artifact resolves outside the report bundle.");
  return absolute;
}

async function openReport(reportPath: string): Promise<{ report: TVDoctorReportV1; root: string }> {
  const requested = resolve(reportPath);
  const metadata = await lstat(requested);
  if (metadata.isSymbolicLink()) throw new TypeError("Report path must not be a symlink or junction.");
  const rootPath = metadata.isDirectory() ? requested : resolve(requested, "..");
  const rootMetadata = await lstat(rootPath);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new TypeError("Report bundle must be an ordinary directory.");
  }
  const root = await realpath(rootPath);
  const reportFile = metadata.isDirectory() ? resolve(root, "report.json") : requested;
  if (!metadata.isDirectory() && !metadata.isFile()) throw new TypeError("Report must be a regular file.");
  if (resolve(root, "report.json") !== reportFile) {
    throw new TypeError("Expected the canonical report.json file or its bundle directory.");
  }
  await assertBundleFile(root, "report.json");
  const reportMetadata = await lstat(reportFile);
  if (reportMetadata.size === 0 || reportMetadata.size > PROTOCOL_VALIDATION_LIMITS.maxJsonBytes) {
    throw new TypeError("Report is empty or exceeds the protocol JSON byte limit.");
  }
  const bytes = await readFile(reportFile);
  if (bytes.byteLength !== reportMetadata.size || bytes.byteLength > PROTOCOL_VALIDATION_LIMITS.maxJsonBytes) {
    throw new TypeError("Report changed during bounded reading.");
  }
  const parsed = parseTVDoctorReportJson(bytes.toString("utf8"));
  if (parsed.schemaVersion !== REPORT_SCHEMA_VERSION_V1) {
    throw new TypeError("Offline triage requires a tvdoctor.report/v1 report.");
  }
  // Stronger than the protocol parser: checks reporter-owned artifact/replay links.
  return { report: validateTVDoctorReportV1(parsed), root };
}

interface EvidenceBudget {
  checked: number;
  bytes: number;
  rejected: number;
  notChecked: number;
}

async function checkArtifact(
  root: string,
  descriptor: ArtifactDescriptor,
  budget: EvidenceBudget,
): Promise<TriageArtifact> {
  const base = { id: descriptor.id, kind: descriptor.kind };
  if (descriptor.status !== "available") {
    return { ...base, status: descriptor.status, path: null };
  }
  if (budget.checked >= MAX_ARTIFACTS_CHECKED
    || descriptor.byteLength > MAX_SINGLE_ARTIFACT_BYTES
    || budget.bytes + descriptor.byteLength > MAX_BYTES_CHECKED) {
    budget.notChecked += 1;
    return { ...base, status: "not-checked", path: null };
  }
  budget.checked += 1;
  budget.bytes += descriptor.byteLength;
  try {
    if (descriptor.sha256 === null || !SHA256.test(descriptor.sha256)) {
      throw new TypeError("An evidence digest is required.");
    }
    const file = await assertBundleFile(root, descriptor.path);
    const metadata = await lstat(file);
    if (metadata.size !== descriptor.byteLength) throw new TypeError("Evidence byte length differs.");
    const sha = createHash("sha256");
    for await (const chunk of createReadStream(file)) sha.update(chunk);
    if (sha.digest("hex") !== descriptor.sha256) throw new TypeError("Evidence digest differs.");
    return { ...base, status: "verified", path: descriptor.path };
  } catch {
    budget.rejected += 1;
    return { ...base, status: "invalid", path: null };
  }
}

function coverage(report: TVDoctorReportV1): ReportTriage["coverage"] {
  const packs = report.coverage.packs;
  const exhausted = report.coverage.budget.exhausted;
  const reasons: string[] = [];
  if (report.run.status !== "completed") reasons.push(`run-${report.run.status}`);
  for (const pack of packs) {
    if (pack.status !== "completed") reasons.push(`pack-${pack.status}`);
  }
  if (packs.length === 0) reasons.push("no-packs");
  for (const budget of exhausted) reasons.push(`budget-${budget}`);
  if (report.coverage.screenStatesDiscovered === 0) reasons.push("no-screens-observed");
  const incomplete = reasons.length > 0;
  return {
    status: report.run.status,
    incomplete, observedOnly: true, noFindingsMeansFixed: false,
    reasons: [...new Set(reasons)].slice(0, 16),
    exhaustedBudgets: exhausted,
    screensObserved: report.coverage.screenStatesDiscovered,
    focusStatesObserved: report.coverage.focusStatesDiscovered,
    transitionsTested: report.coverage.transitionsTested,
    packs: packs.slice(0, 32),
    packsOmitted: Math.max(0, packs.length - 32),
  };
}

/** Purely offline report inspection. Never opens a browser, runs replays or declares fixes. */
export async function inspectReport(
  reportPath: string,
  options: InspectReportOptions = {},
): Promise<ReportTriage> {
  const maxFindings = options.maxFindings ?? DEFAULT_MAX_FINDINGS;
  if (!Number.isSafeInteger(maxFindings) || maxFindings < 1 || maxFindings > HARD_MAX_FINDINGS) {
    throw new TypeError("maxFindings must be an integer from 1 to 100.");
  }
  const { report, root } = await openReport(reportPath);
  const ordered = [...report.issues].sort(compareIssues);
  const counts = { VERIFIED: 0, REVIEW: 0, UNTESTED: 0 };
  for (const issue of ordered) counts[classification(issue)] += 1;
  const highestVerifiedSeverity = ISSUE_SEVERITIES.find((severity) => ordered.some(
    (issue) => issue.severity === severity && classification(issue) === "VERIFIED",
  )) ?? null;
  const budget: EvidenceBudget = { checked: 0, bytes: 0, rejected: 0, notChecked: 0 };
  const findings: ActionableTriageFinding[] = [];
  for (const issue of ordered.slice(0, maxFindings)) {
    const owned = report.artifacts.filter((artifact) => issueOwnsArtifactId(issue.id, artifact.id));
    const artifacts: TriageArtifact[] = [];
    for (const artifact of owned.slice(0, MAX_ARTIFACTS_PER_FINDING)) {
      artifacts.push(await checkArtifact(root, artifact, budget));
    }
    budget.notChecked += owned.slice(MAX_ARTIFACTS_PER_FINDING)
      .filter((artifact) => artifact.status === "available").length;
    const verifiedPaths = new Set(artifacts.filter((artifact) => artifact.path !== null)
      .map((artifact) => artifact.path));
    const replay = report.replays.find((candidate) => candidate.issueId === issue.id);
    const reproductionStatus = issue.reproduction.status === "unavailable" ? "unavailable"
      : issue.confidence === "deterministic" && issue.reproduction.confidence === "deterministic" && replay !== undefined
        ? "deterministic" : "best-effort";
    findings.push({
      id: issue.id,
      rule: issue.rule,
      title: display(issue.title, 180),
      severity: issue.severity,
      confidence: issue.confidence,
      classification: classification(issue),
      pack: issue.pack,
      screen: issue.screen === null ? null : display(issue.screen, 180),
      expected: display(issue.expected, 300),
      observed: display(issue.observed, 300),
      evidence: issue.evidence.slice(0, 8).map((evidence) => ({
        kind: evidence.kind,
        summary: display(evidence.summary, 240),
        artifact: evidence.artifact !== null && verifiedPaths.has(evidence.artifact)
          ? evidence.artifact : null,
      })),
      artifacts,
      artifactsOmitted: owned.length - artifacts.length,
      reproduction: {
        status: reproductionStatus,
        replayId: replay?.id ?? null,
        freshlyVerified: false,
        stepCount: replay?.steps.length ?? null,
      },
    });
  }
  return {
    schemaVersion: "tvdoctor.triage/v1",
    run: {
      id: report.run.id,
      status: report.run.status,
      mode: report.run.mode,
      platform: display(report.target.platform, 60),
    },
    highestVerifiedSeverity,
    summary: { total: ordered.length, returned: findings.length,
      omitted: ordered.length - findings.length, ...counts },
    findings,
    coverage: coverage(report),
    integrity: {
      report: "validated",
      evidence: budget.rejected > 0 ? "degraded"
        : budget.notChecked > 0 || ordered.length > findings.length ? "bounded"
          : budget.checked === 0 ? "none" : "verified",
      artifactsChecked: budget.checked,
      artifactsRejected: budget.rejected,
      artifactsNotChecked: budget.notChecked,
      scope: "returned-findings",
    },
  };
}
