import { createHash } from "node:crypto";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PROTOCOL_VALIDATION_LIMITS, parseTVDoctorReportJson } from "@tvdoctor/protocol";
import { assertPortableRelativePath } from "@tvdoctor/reporters";
import { renderAgentRepairBrief } from "./agent-repair-brief.js";
import { createFirstRunHandoff } from "./first-run-handoff.js";
import { inspectReport } from "./node-triage.js";

const MAX_QA_SUMMARY = 128 * 1024;
const MAX_HANDOFF = 256 * 1024;
const MAX_BRIEF = 64 * 1024;
const MAX_STDOUT = 1024 * 1024;
const MAX_ARTIFACT = 64 * 1024 * 1024;
const MAX_TOTAL_ARTIFACTS = 128 * 1024 * 1024;
const SHA = /^[a-f0-9]{64}$/u;
const CAVEAT = "COMPLETED means one bounded, non-interactive public QA scan produced independently validated evidence. Zero VERIFIED findings does not prove the route healthy, the original defect FIXED, or the application safe. Compose this with the separate source-backed original-to-repair route-health oracle.";

export interface PublicRouteHealthRegressionOptions {
  readonly target: string;
  /** This directory MUST NOT exist. Public qa creates it once. */
  readonly outputRoot: string;
  readonly executeQa: (args: readonly string[]) => Promise<{
    readonly exitCode: number;
    readonly stdout: string;
  }>;
}

export interface PublicRouteHealthRegressionResult {
  readonly schemaVersion: "tvdoctor.public-route-health-regression/v1";
  readonly status: "COMPLETED" | "INCOMPLETE" | "FAILED";
  readonly verified: number;
  readonly review: number;
  readonly untested: number;
  readonly reason: string | null;
  /** This is relative to outputRoot, never an application URL or private path. */
  readonly summaryPath: "qa-summary.json" | null;
  readonly reportSha256: string | null;
  readonly caveat: string;
}

interface Pinned { readonly path: string; readonly hash: string; readonly size: number }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 100_000;
}
function safeTarget(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > 2048
    || value.trim() !== value || /[\\\p{Cc}\p{Cf}]/u.test(value)) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:")
      || url.username !== "" || url.password !== ""
      || url.search !== "" || url.hash !== "" || url.href !== value) return null;
    return url.href;
  } catch { return null; }
}
function result(status: PublicRouteHealthRegressionResult["status"], reason: string | null,
  counts: { verified: number; review: number; untested: number } = { verified: 0, review: 0, untested: 0 },
  reportSha256: string | null = null): PublicRouteHealthRegressionResult {
  return { schemaVersion: "tvdoctor.public-route-health-regression/v1",
    status, reason, ...counts, reportSha256, summaryPath: status === "FAILED" ? null : "qa-summary.json",
    caveat: CAVEAT };
}
function inside(parent: string, child: string): boolean {
  const diff = relative(parent, child);
  return diff === "" || (diff !== ".." && !diff.startsWith(`..${sep}`) && !isAbsolute(diff));
}
async function canonicalDirectory(path: string): Promise<void> {
  const meta = await lstat(path);
  if (!meta.isDirectory() || meta.isSymbolicLink() || await realpath(path) !== path) {
    throw new TypeError("unsafe-directory");
  }
}
/** Bounded read with no symlink/junction components and metadata recheck. */
async function pinned(root: string, segments: readonly string[], maximum: number): Promise<{
  readonly evidence: Pinned; readonly bytes: Buffer;
}> {
  let current = root;
  for (let index = 0; index < segments.length - 1; index++) {
    current = join(current, segments[index] ?? "");
    await canonicalDirectory(current);
  }
  const file = join(current, segments[segments.length - 1] ?? "");
  if (!inside(root, file)) throw new TypeError("unsafe-evidence-path");
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1
    || before.size > maximum || await realpath(file) !== file) {
    throw new TypeError("unsafe-evidence-file");
  }
  const handle = await open(file, "r");
  let bytes: Buffer;
  try {
    const active = await handle.stat();
    if (!active.isFile() || active.ino !== before.ino || active.size !== before.size) {
      throw new TypeError("evidence-changed");
    }
    bytes = Buffer.alloc(before.size);
    for (let cursor = 0; cursor < bytes.length;) {
      const chunk = await handle.read(bytes, cursor, bytes.length - cursor, cursor);
      if (chunk.bytesRead < 1) throw new TypeError("truncated-evidence");
      cursor += chunk.bytesRead;
    }
  } finally { await handle.close(); }
  const after = await lstat(file);
  if (!after.isFile() || after.isSymbolicLink() || after.ino !== before.ino
    || after.size !== before.size || after.mtimeMs !== before.mtimeMs
    || await realpath(file) !== file) throw new TypeError("evidence-changed");
  return { evidence: { path: file, size: bytes.length,
    hash: createHash("sha256").update(bytes).digest("hex") }, bytes };
}
async function unchanged(root: string, pins: readonly Pinned[]): Promise<boolean> {
  try {
    await canonicalDirectory(root);
    for (const prior of pins) {
      const diff = relative(root, prior.path);
      if (!inside(root, prior.path) || diff === "") return false;
      const current = await pinned(root, diff.split(sep), prior.size);
      if (current.evidence.hash !== prior.hash || current.evidence.size !== prior.size) return false;
    }
    return true;
  } catch { return false; }
}

/**
 * New independent regression scan only. Never verifies the original health
 * witness and never asserts FIXED; the caller MUST apply that separate gate.
 */
export async function runPublicRouteHealthRegression(
  options: PublicRouteHealthRegressionOptions,
): Promise<PublicRouteHealthRegressionResult> {
  const target = safeTarget(options?.target);
  if (target === null || typeof options?.executeQa !== "function"
    || typeof options.outputRoot !== "string" || options.outputRoot.length === 0
    || options.outputRoot.length > 4096 || options.outputRoot.trim() !== options.outputRoot
    || options.outputRoot.includes("\0")) return result("FAILED", "invalid-regression-input");
  const root = resolve(options.outputRoot);
  try {
    await mkdir(dirname(root), { recursive: true });
    await canonicalDirectory(dirname(root));
    if (await lstat(root).then(() => true, () => false)) {
      return result("FAILED", "regression-output-not-fresh");
    }
  } catch { return result("FAILED", "regression-output-parent-unsafe"); }

  let child: { readonly exitCode: number; readonly stdout: string };
  try {
    child = await options.executeQa([
      "qa", target, "--output", root, "--mode", "quick", "--no-interactions",
      "--fail-on", "any", "--json",
    ]);
  } catch { return result("FAILED", "regression-child-execution-failed"); }
  if (!object(child) || ![0, 1, 3].includes(child.exitCode)
    || typeof child.stdout !== "string" || child.stdout.length < 2
    || Buffer.byteLength(child.stdout, "utf8") > MAX_STDOUT) {
    return result("FAILED", "regression-child-invalid");
  }

  const pins: Pinned[] = [];
  try {
    await canonicalDirectory(root);
    await canonicalDirectory(join(root, "original"));
    const summaryFile = await pinned(root, ["qa-summary.json"], MAX_QA_SUMMARY);
    const reportFile = await pinned(root, ["original", "report.json"],
      PROTOCOL_VALIDATION_LIMITS.maxJsonBytes);
    const handoffFile = await pinned(root, ["handoff.json"], MAX_HANDOFF);
    const briefFile = await pinned(root, ["AGENT_REPAIR_BRIEF.md"], MAX_BRIEF);
    pins.push(summaryFile.evidence, reportFile.evidence, handoffFile.evidence, briefFile.evidence);
    const saved: unknown = JSON.parse(summaryFile.bytes.toString("utf8")) as unknown;
    const emitted: unknown = JSON.parse(child.stdout.trim()) as unknown;
    const report = parseTVDoctorReportJson(reportFile.bytes.toString("utf8"));
    if (!object(saved) || !object(emitted) || JSON.stringify(saved) !== JSON.stringify(emitted)
      || saved["schemaVersion"] !== "tvdoctor.qa/v1" || saved["source"] !== "url"
      || saved["summaryPath"] !== join(root, "qa-summary.json")
      || saved["originalPath"] !== join(root, "original", "report.json")
      || saved["handoffPath"] !== join(root, "handoff.json")
      || saved["agentBriefPath"] !== join(root, "AGENT_REPAIR_BRIEF.md")
      || saved["reason"] !== null || saved["exitCode"] !== child.exitCode
      || saved["shouldFail"] !== (child.exitCode !== 0)
      || !object(saved["summary"]) || !object(saved["scanPolicy"])) {
      return result("FAILED", "regression-summary-invalid");
    }
    const summary = saved["summary"];
    const policy = saved["scanPolicy"];
    if (policy["schemaVersion"] !== "tvdoctor.qa-scan-policy/v1"
      || Object.keys(policy).sort().join("|")
        !== "failOn|mode|reportSha256|safeInteractions|safeLinks|schemaVersion"
      || policy["reportSha256"] !== reportFile.evidence.hash
      || policy["safeInteractions"] !== false || policy["safeLinks"] !== false
      || policy["mode"] !== "quick" || policy["failOn"] !== "any"
      || report.schemaVersion !== "tvdoctor.report/v1"
      || report.target.platform !== "web" || report.target.location !== target
      || report.target.environment["browser"] !== "chromium"
      || report.target.environment["inputMode"] !== "keyboard"
      || report.target.environment["keyboardInteractions"] !== "disabled"
      || report.target.environment["safeLinkNavigation"] !== "disabled"
      || report.target.environment["journeyConfigSha256"] !== undefined
      || report.target.environment["authReadySha256"] !== undefined
      || report.run.mode !== "quick"
      || summary["routes"] !== 1
      || !nonnegative(summary["verified"]) || !nonnegative(summary["review"])
      || !nonnegative(summary["untested"]) || !nonnegative(summary["incompleteRoutes"])) {
      return result("FAILED", "regression-policy-or-provenance-invalid");
    }

    const handoff: unknown = JSON.parse(handoffFile.bytes.toString("utf8")) as unknown;
    const sourceHandoff = await createFirstRunHandoff({ reportPath: reportFile.evidence.path });
    if (!object(handoff) || JSON.stringify(handoff) !== JSON.stringify(sourceHandoff)
      || Object.keys(summary).sort().join("|")
        !== "incompleteRoutes|review|routes|selected|untested|verified"
      || JSON.stringify(summary) !== JSON.stringify(sourceHandoff.summary)
      || briefFile.bytes.toString("utf8") !== renderAgentRepairBrief(sourceHandoff)
      || handoff["status"] !== saved["status"]) {
      return result("FAILED", "regression-handoff-invalid");
    }

    const triage = await inspectReport(reportFile.evidence.path, { maxFindings: 100 });
    if (summary["verified"] !== triage.summary.VERIFIED
      || summary["review"] !== triage.summary.REVIEW
      || summary["untested"] !== triage.summary.UNTESTED
      || triage.summary.omitted !== 0 || triage.coverage.packsOmitted !== 0
      || triage.integrity.evidence === "degraded" || triage.integrity.evidence === "bounded"
      || triage.integrity.artifactsRejected !== 0 || triage.integrity.artifactsNotChecked !== 0) {
      return result("FAILED", "regression-report-evidence-invalid");
    }
    let bytes = 0;
    const paths = new Set<string>();
    for (const artifact of report.artifacts) {
      if (artifact.status !== "available") continue;
      assertPortableRelativePath(artifact.path);
      if (paths.has(artifact.path) || artifact.byteLength > MAX_ARTIFACT
        || !SHA.test(artifact.sha256 ?? "")) {
        return result("FAILED", "regression-artifact-invalid");
      }
      paths.add(artifact.path);
      bytes += artifact.byteLength;
      if (bytes > MAX_TOTAL_ARTIFACTS) return result("FAILED", "regression-artifact-budget");
      const file = await pinned(join(root, "original"),
        artifact.path.split("/"), MAX_ARTIFACT);
      if (file.evidence.size !== artifact.byteLength || file.evidence.hash !== artifact.sha256) {
        return result("FAILED", "regression-artifact-invalid");
      }
      pins.push(file.evidence);
    }
    const counts = { verified: triage.summary.VERIFIED,
      review: triage.summary.REVIEW, untested: triage.summary.UNTESTED };
    const incomplete = report.run.status !== "completed" || triage.coverage.incomplete
      || triage.coverage.exhaustedBudgets.length !== 0
      || summary["incompleteRoutes"] !== 0 || child.exitCode === 3;
    const expected = incomplete ? "INCONCLUSIVE" : counts.verified > 0 ? "ACTION_REQUIRED"
      : counts.review > 0 ? "REVIEW_REQUIRED" : "NO_VERIFIED_FAILURES_IN_COVERAGE";
    const expectedCode = incomplete ? 3 : counts.verified > 0 ? 1 : 0;
    if (saved["status"] !== expected || child.exitCode !== expectedCode
      || summary["incompleteRoutes"] !== (incomplete ? 1 : 0)) {
      return result("FAILED", "regression-status-contradiction");
    }
    if (!await unchanged(root, pins)) return result("FAILED", "regression-evidence-changed");
    return result(incomplete ? "INCOMPLETE" : "COMPLETED",
      incomplete ? "regression-coverage-incomplete" : null, counts, reportFile.evidence.hash);
  } catch {
    return result("FAILED", "regression-evidence-unavailable");
  }
}
