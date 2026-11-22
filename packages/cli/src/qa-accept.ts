import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PROTOCOL_VALIDATION_LIMITS, parseTVDoctorReportJson } from "@tvdoctor/protocol";
import { renderAgentRepairBrief } from "./agent-repair-brief.js";
import { inspectReport } from "./node-triage.js";
import { runQaVerify, type QaVerifyResult } from "./qa-verify.js";
import type { QaWorkflowResult } from "./qa-workflow.js";

const MAX_QA_BYTES = 128 * 1024;
const MAX_HANDOFF_BYTES = 256 * 1024;
const MAX_BRIEF_BYTES = 64 * 1024;
const MAX_CHILD_STDOUT = 1024 * 1024;
const MAX_ACCEPT_BYTES = 64 * 1024;
const ID = /^[A-Za-z0-9_.:-]{1,256}$/u;
const CAVEAT = "PASS means every original VERIFIED issue passed its independent repair oracle AND this bounded post-repair QA scan found no VERIFIED issues. Post-repair VERIFIED findings are observed failures, not proof the repair introduced them. REVIEW leads remain unresolved; no whole-site or WCAG certification is implied.";

export interface QaAcceptOptions {
  readonly originalQaPath: string;
  readonly target: string;
  readonly outputRoot: string;
  readonly authorized: boolean;
  readonly executeVerify: (args: readonly string[]) => Promise<{
    readonly exitCode: number; readonly stdout: string;
  }>;
  /** Public tvdoctor qa URL --output NEW_DIR --json, not a fabricated scan. */
  readonly executeQa: (args: readonly string[]) => Promise<{
    readonly exitCode: number; readonly stdout: string;
  }>;
}

export interface QaAcceptResult {
  readonly schemaVersion: "tvdoctor.qa-accept/v1";
  readonly status: "PASS" | "REPRODUCED" | "REGRESSION_FOUND" | "INCONCLUSIVE" | "ERROR";
  readonly exitCode: 0 | 1 | 2 | 3 | 4;
  readonly shouldFail: boolean;
  /** Stable redacted reason code; never a child exception or application text. */
  readonly reason: string | null;
  readonly original: { readonly sha256: string | null; readonly verified: number };
  readonly verification: {
    readonly status: QaVerifyResult["status"] | "NOT_RUN";
    readonly fixed: number;
    readonly reproduced: number;
    readonly inconclusive: number;
    readonly summaryPath: "verification/qa-verification.json" | null;
  };
  readonly regression: {
    readonly status: "COMPLETED" | "INCOMPLETE" | "NOT_RUN";
    readonly verified: number;
    readonly review: number;
    readonly untested: number;
    readonly verifiedIssueIds: readonly string[];
    readonly summaryPath: "regression/qa-summary.json" | null;
  };
  readonly acceptancePath: "qa-accept.json" | null;
  readonly caveat: string;
}

interface ChildResult { readonly exitCode: number; readonly stdout: string }
interface OriginalFile { readonly path: string; readonly size: number; readonly sha256: string }
interface Original {
  readonly root: string;
  readonly reportPath: string;
  readonly reportSha256: string;
  readonly verified: number;
  readonly scanPolicy: NonNullable<QaWorkflowResult["scanPolicy"]>;
  readonly files: readonly OriginalFile[];
}
type ScanPolicy = Original["scanPolicy"];
const QA_MODES = new Set(["quick", "standard", "deep"]);
const QA_FAIL_ON = new Set(["any", "critical", "high", "medium", "low", "info", "never"]);

function scanPolicy(value: unknown, reportSha256: string): ScanPolicy | null {
  if (!record(value) || value["schemaVersion"] !== "tvdoctor.qa-scan-policy/v1"
    || typeof value["safeInteractions"] !== "boolean"
    || typeof value["safeLinks"] !== "boolean"
    || (value["safeLinks"] === true && value["safeInteractions"] !== true)
    || !QA_MODES.has(String(value["mode"]))
    || !QA_FAIL_ON.has(String(value["failOn"]))
    || value["reportSha256"] !== reportSha256) return null;
  return value as unknown as ScanPolicy;
}
function sameScanPolicy(a: ScanPolicy, b: ScanPolicy): boolean {
  return a.safeLinks === b.safeLinks && a.safeInteractions === b.safeInteractions
    && a.mode === b.mode && a.failOn === b.failOn;
}
type Regression = QaAcceptResult["regression"];
type Verification = QaAcceptResult["verification"];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function inside(parent: string, child: string): boolean {
  const diff = relative(parent, child);
  return diff === "" || (diff !== ".." && !diff.startsWith(`..${sep}`) && !isAbsolute(diff));
}
function validPath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && path.length <= 4096
    && path.trim() === path && !path.includes("\0");
}
function safeUrl(raw: unknown): URL | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048
    || raw.trim() !== raw || raw.includes("\\")
    || [...raw].some((symbol) => (symbol.codePointAt(0) ?? 0) <= 32
      || (symbol.codePointAt(0) ?? 0) === 127)) return null;
  try {
    const parsed = new URL(raw);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.username === "" && parsed.password === "" && parsed.search === ""
      && parsed.hash === "" ? parsed : null;
  } catch { return null; }
}
async function canonicalDir(path: string): Promise<string> {
  const absolute = resolve(path);
  const stat = await lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(absolute) !== absolute) {
    throw new Error("unsafe-directory");
  }
  return absolute;
}
async function pinnedFile(path: string, limit: number): Promise<OriginalFile> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > limit
    || await realpath(path) !== path) throw new Error("unsafe-file");
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (!after.isFile() || after.isSymbolicLink()
    || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs
    || before.size !== bytes.length || after.size !== bytes.length) throw new Error("changed-file");
  return { path, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}
async function originalPreflight(root: string, target: URL): Promise<Original> {
  const original = await canonicalDir(root);
  await canonicalDir(join(original, "original"));
  const paths = [
    [join(original, "qa-summary.json"), MAX_QA_BYTES],
    [join(original, "original", "report.json"), PROTOCOL_VALIDATION_LIMITS.maxJsonBytes],
    [join(original, "handoff.json"), MAX_HANDOFF_BYTES],
    [join(original, "AGENT_REPAIR_BRIEF.md"), MAX_BRIEF_BYTES],
  ] as const;
  const files: OriginalFile[] = [];
  for (const [path, maximum] of paths) files.push(await pinnedFile(path, maximum));
  const summary = JSON.parse(await readFile(paths[0][0], "utf8")) as unknown;
  const report = parseTVDoctorReportJson(await readFile(paths[1][0], "utf8"));
  if (!record(summary) || summary["schemaVersion"] !== "tvdoctor.qa/v1"
    || summary["source"] !== "url" || summary["status"] !== "ACTION_REQUIRED"
    || summary["reason"] !== null || !record(summary["summary"])
    || report.run.status !== "completed" || report.target.platform !== "web"
    || report.target.environment["inputMode"] !== "keyboard"
    || report.target.environment["journeyConfigSha256"] !== undefined) {
    throw new Error("untrusted-original-provenance");
  }
  const originalUrl = safeUrl(report.target.location);
  if (originalUrl === null || originalUrl.origin !== target.origin) {
    throw new Error("origin-mismatch");
  }
  const policy = scanPolicy(summary["scanPolicy"], files[1]?.sha256 ?? "");
  if (policy === null || report.schemaVersion !== "tvdoctor.report/v1"
    || report.run.mode !== policy.mode
    || report.target.environment["safeLinkNavigation"] !== (policy.safeLinks ? "enabled" : "disabled")
    || report.target.environment["keyboardInteractions"] !== (policy.safeInteractions ? "enabled" : "disabled")) {
    // A legacy original without a pinned scan policy cannot establish that a
    // purportedly clean post-repair run revisited its opted-in safe links.
    throw new Error("original-scan-policy-unverifiable");
  }
  const triage = await inspectReport(paths[1][0], { maxFindings: 100 });
  if (triage.coverage.incomplete || triage.summary.omitted !== 0
    || triage.integrity.evidence === "degraded" || triage.integrity.evidence === "bounded"
    || triage.summary.VERIFIED < 1 || triage.summary.VERIFIED > 16
    || summary["summary"]["routes"] !== 1
    || summary["summary"]["verified"] !== triage.summary.VERIFIED
    || summary["summary"]["review"] !== triage.summary.REVIEW
    || summary["summary"]["untested"] !== triage.summary.UNTESTED
    || summary["summary"]["incompleteRoutes"] !== 0) {
    throw new Error("invalid-original-coverage");
  }
  // Full handoff/repair brief verification is delegated to runQaVerify before
  // any verify-fix callback. This preflight is an additional early gate.
  return {
    root: original,
    reportPath: paths[1][0],
    reportSha256: files[1]?.sha256 ?? "",
    verified: triage.summary.VERIFIED,
    scanPolicy: policy,
    files,
  };
}
async function originalUnchanged(original: Original): Promise<boolean> {
  try {
    if (await canonicalDir(original.root) !== original.root
      || await canonicalDir(join(original.root, "original")) !== join(original.root, "original")) return false;
    for (const file of original.files) {
      const current = await pinnedFile(file.path, file.size);
      if (current.sha256 !== file.sha256) return false;
    }
    const triage = await inspectReport(original.reportPath, { maxFindings: 100 });
    return !triage.coverage.incomplete && triage.summary.omitted === 0
      && triage.summary.VERIFIED === original.verified
      && triage.integrity.evidence !== "degraded" && triage.integrity.evidence !== "bounded";
  } catch { return false; }
}
function notRunVerification(): Verification {
  return { status: "NOT_RUN", fixed: 0, reproduced: 0, inconclusive: 0, summaryPath: null };
}
function notRunRegression(): Regression {
  return { status: "NOT_RUN", verified: 0, review: 0, untested: 0,
    verifiedIssueIds: [], summaryPath: null };
}
function response(code: QaAcceptResult["exitCode"], reason: string | null,
  original: Original | null, verification: Verification, regression: Regression,
  path: QaAcceptResult["acceptancePath"] = null): QaAcceptResult {
  return {
    schemaVersion: "tvdoctor.qa-accept/v1",
    status: code === 0 ? "PASS" : code === 1
      ? (verification.reproduced > 0 ? "REPRODUCED" : "REGRESSION_FOUND")
      : code === 4 ? "ERROR" : "INCONCLUSIVE",
    exitCode: code, shouldFail: code !== 0, reason,
    original: { sha256: original?.reportSha256 ?? null, verified: original?.verified ?? 0 },
    verification, regression, acceptancePath: path, caveat: CAVEAT,
  };
}
function checkedChild(child: unknown): ChildResult | null {
  if (!record(child) || typeof child["exitCode"] !== "number"
    || !Number.isInteger(child["exitCode"])
    || ![0, 1, 3, 4].includes(child["exitCode"])
    || typeof child["stdout"] !== "string"
    || child["stdout"].length < 2 || child["stdout"].length > MAX_CHILD_STDOUT) return null;
  return { exitCode: child["exitCode"] as number, stdout: child["stdout"] as string };
}
function cleanVerification(run: QaVerifyResult, original: Original): Verification | null {
  if (run.schemaVersion !== "tvdoctor.qa-verification/v1"
    || ![0, 1, 3, 4].includes(run.exitCode)
    || run.shouldFail !== (run.exitCode !== 0)
    || run.originalSha256 !== original.reportSha256
    || run.counts.originalVerified !== original.verified
    || run.perIssue.length !== original.verified
    || run.counts.fixed + run.counts.reproduced + run.counts.inconclusive !== original.verified
    || !run.perIssue.every((entry) => ID.test(entry.issueId) && ID.test(entry.rule))
    || new Set(run.perIssue.map((entry) => entry.issueId)).size !== original.verified
    || run.counts.fixed !== run.perIssue.filter((entry) => entry.classification === "FIXED").length
    || run.counts.reproduced !== run.perIssue.filter((entry) => entry.classification === "REPRODUCED").length
    || run.counts.inconclusive !== run.perIssue.filter((entry) => entry.classification === "INCONCLUSIVE").length
    || run.verificationPath !== "qa-verification.json"
    || (run.exitCode === 0) !== (run.status === "FIXED" && run.counts.fixed === original.verified)
    || (run.exitCode === 1) !== (run.status === "REPRODUCED" && run.counts.reproduced > 0)) return null;
  return {
    status: run.status, fixed: run.counts.fixed,
    reproduced: run.counts.reproduced, inconclusive: run.counts.inconclusive,
    summaryPath: "verification/qa-verification.json",
  };
}
async function checkedVerificationFile(path: string, expected: QaVerifyResult): Promise<boolean> {
  try {
    await pinnedFile(path, MAX_ACCEPT_BYTES);
    return JSON.stringify(JSON.parse(await readFile(path, "utf8")) as unknown) === JSON.stringify(expected);
  } catch { return false; }
}
function validFreshQa(raw: unknown, child: ChildResult, expectedReport: string,
  expectedSummary: string): raw is Record<string, unknown> {
  if (!record(raw) || raw["schemaVersion"] !== "tvdoctor.qa/v1"
    || raw["source"] !== "url" || raw["exitCode"] !== child.exitCode
    || raw["shouldFail"] !== (child.exitCode !== 0)
    || raw["originalPath"] !== expectedReport || raw["summaryPath"] !== expectedSummary
    || !record(raw["summary"])) return false;
  const summary = raw["summary"];
  if (summary["routes"] !== 1 || ![0, 1, 3].includes(child.exitCode)
    || !["ACTION_REQUIRED", "REVIEW_REQUIRED", "NO_VERIFIED_FAILURES_IN_COVERAGE", "INCONCLUSIVE"].includes(String(raw["status"]))
    || (child.exitCode === 0 && !["REVIEW_REQUIRED", "NO_VERIFIED_FAILURES_IN_COVERAGE"].includes(String(raw["status"])))
    || (child.exitCode === 1 && raw["status"] !== "ACTION_REQUIRED")
    || (child.exitCode === 3 && raw["status"] !== "INCONCLUSIVE")) return false;
  for (const key of ["verified", "review", "untested", "incompleteRoutes"] as const) {
    if (!Number.isSafeInteger(summary[key]) || (summary[key] as number) < 0
      || (summary[key] as number) > 100_000) return false;
  }
  return true;
}
async function inspectFreshRegression(
  root: string, target: URL, child: ChildResult, expectedPolicy: ScanPolicy,
): Promise<{ readonly regression: Regression; readonly inconclusive: boolean } | null> {
  const qaRoot = await canonicalDir(root);
  const reportRoot = await canonicalDir(join(qaRoot, "original"));
  const expectedReport = join(reportRoot, "report.json");
  const expectedSummary = join(qaRoot, "qa-summary.json");
  const expectedHandoff = join(qaRoot, "handoff.json");
  const expectedBrief = join(qaRoot, "AGENT_REPAIR_BRIEF.md");
  const [summaryEvidence, reportEvidence, handoffEvidence, briefEvidence] = await Promise.all([
    pinnedFile(expectedSummary, MAX_QA_BYTES),
    pinnedFile(expectedReport, PROTOCOL_VALIDATION_LIMITS.maxJsonBytes),
    pinnedFile(expectedHandoff, MAX_HANDOFF_BYTES),
    pinnedFile(expectedBrief, MAX_BRIEF_BYTES),
  ]);
  const saved = JSON.parse(await readFile(expectedSummary, "utf8")) as unknown;
  const printed = JSON.parse(child.stdout) as unknown;
  if (!validFreshQa(saved, child, expectedReport, expectedSummary)
    || !validFreshQa(printed, child, expectedReport, expectedSummary)
    || saved["handoffPath"] !== expectedHandoff
    || saved["agentBriefPath"] !== expectedBrief
    || saved["reason"] !== null
    || JSON.stringify(saved) !== JSON.stringify(printed)) return null;
  const counts = saved["summary"];
  if (!record(counts)) return null;
  const handoff = JSON.parse(await readFile(expectedHandoff, "utf8")) as unknown;
  if (!record(handoff) || handoff["schemaVersion"] !== "tvdoctor.first-run-handoff/v1"
    || handoff["source"] !== "report" || handoff["status"] !== saved["status"]
    || !record(handoff["summary"])
    || handoff["summary"]["routes"] !== counts["routes"]
    || handoff["summary"]["verified"] !== counts["verified"]
    || handoff["summary"]["review"] !== counts["review"]
    || handoff["summary"]["untested"] !== counts["untested"]
    || handoff["summary"]["incompleteRoutes"] !== counts["incompleteRoutes"]
    || !Array.isArray(handoff["findings"]) || handoff["findings"].length > 3) return null;
  const rendered = renderAgentRepairBrief(
    handoff as unknown as Parameters<typeof renderAgentRepairBrief>[0],
  );
  if (rendered !== await readFile(expectedBrief, "utf8")) return null;
  const report = parseTVDoctorReportJson(await readFile(expectedReport, "utf8"));
  const location = safeUrl(report.target.location);
  const policy = scanPolicy(saved["scanPolicy"], reportEvidence.sha256);
  if (report.target.platform !== "web" || report.target.environment["inputMode"] !== "keyboard"
    || location === null || location.href !== target.href
    || policy === null || !sameScanPolicy(expectedPolicy, policy)
    || report.run.mode !== policy.mode
    || report.target.environment["safeLinkNavigation"] !== (policy.safeLinks ? "enabled" : "disabled")
    || report.target.environment["keyboardInteractions"] !== (policy.safeInteractions ? "enabled" : "disabled")
    || report.target.environment["journeyConfigSha256"] !== undefined) return null;
  const triage = await inspectReport(expectedReport, { maxFindings: 100 });
  if (triage.summary.omitted > 0 || triage.integrity.evidence === "degraded"
    || triage.integrity.evidence === "bounded"
    || counts["verified"] !== triage.summary.VERIFIED
    || counts["review"] !== triage.summary.REVIEW
    || counts["untested"] !== triage.summary.UNTESTED) return null;
  const ids = triage.findings.filter((entry) => entry.classification === "VERIFIED")
    .map((entry) => entry.id);
  if (ids.length !== triage.summary.VERIFIED || ids.some((id) => !ID.test(id))
    || new Set(ids).size !== ids.length) return null;
  const incomplete = triage.coverage.incomplete || counts["incompleteRoutes"] !== 0
    || report.run.status !== "completed" || child.exitCode === 3;
  if (!incomplete && ((triage.summary.VERIFIED > 0 && saved["status"] !== "ACTION_REQUIRED")
    || (triage.summary.VERIFIED === 0 && triage.summary.REVIEW > 0
      && saved["status"] !== "REVIEW_REQUIRED")
    || (triage.summary.VERIFIED === 0 && triage.summary.REVIEW === 0
      && saved["status"] !== "NO_VERIFIED_FAILURES_IN_COVERAGE"))) return null;
  if (!incomplete && ((triage.summary.VERIFIED > 0) !== (child.exitCode === 1))) return null;
  if (await pinnedFile(expectedSummary, MAX_QA_BYTES).then((now) => now.sha256) !== summaryEvidence.sha256
    || await pinnedFile(expectedReport, PROTOCOL_VALIDATION_LIMITS.maxJsonBytes)
      .then((now) => now.sha256) !== reportEvidence.sha256
    || await pinnedFile(expectedHandoff, MAX_HANDOFF_BYTES)
      .then((now) => now.sha256) !== handoffEvidence.sha256
    || await pinnedFile(expectedBrief, MAX_BRIEF_BYTES)
      .then((now) => now.sha256) !== briefEvidence.sha256) return null;
  return {
    regression: {
      status: incomplete ? "INCOMPLETE" : "COMPLETED",
      verified: triage.summary.VERIFIED,
      review: triage.summary.REVIEW,
      untested: triage.summary.UNTESTED,
      verifiedIssueIds: ids,
      summaryPath: "regression/qa-summary.json",
    },
    inconclusive: incomplete,
  };
}

/** Two INDEPENDENT gates: original replay fix verification and a new QA scan. */
export async function runQaAccept(options: QaAcceptOptions): Promise<QaAcceptResult> {
  let verification = notRunVerification();
  let regression = notRunRegression();
  if (options.authorized !== true || !validPath(options.originalQaPath)
    || !validPath(options.outputRoot)
    || typeof options.executeVerify !== "function" || typeof options.executeQa !== "function") {
    return response(2, "invalid-options", null, verification, regression);
  }
  const target = safeUrl(options.target);
  if (target === null) return response(2, "invalid-target", null, verification, regression);
  const source = resolve(options.originalQaPath);
  const originalRoot = source.endsWith("qa-summary.json") ? dirname(source) : source;
  const output = resolve(options.outputRoot);
  if (inside(originalRoot, output) || inside(output, originalRoot)) {
    return response(2, "output-overlaps-original", null, verification, regression);
  }
  let original: Original;
  try { original = await originalPreflight(originalRoot, target); }
  catch { return response(3, "original-evidence-invalid", null, verification, regression); }
  try {
    await mkdir(dirname(output), { recursive: true });
    const parent = await canonicalDir(dirname(output));
    if (!inside(parent, output) || inside(original.root, parent)) {
      throw new Error("output-root-overlap");
    }
    await mkdir(output, { mode: 0o700 }); // create only; existing path fails
    await canonicalDir(output);
  } catch {
    return response(4, "output-root-not-fresh-or-unsafe", original, verification, regression);
  }

  let code: QaAcceptResult["exitCode"] = 3;
  let reason: string | null;
  try {
    if (!await originalUnchanged(original)) {
      reason = "original-evidence-changed";
    } else {
      const checked = await runQaVerify({
        originalQaPath: original.root, target: target.href, authorized: true,
        outputRoot: join(output, "verification"), executeVerify: options.executeVerify,
      });
      if (!await originalUnchanged(original)) {
        reason = "original-evidence-changed";
      } else {
        const stage = cleanVerification(checked, original);
        if (stage === null || !await checkedVerificationFile(
          join(output, "verification", "qa-verification.json"), checked,
        )) {
          code = checked.exitCode === 4 ? 4 : 3;
          reason = "verification-output-invalid";
        } else {
          verification = stage;
          if (checked.exitCode === 4) {
            code = 4; reason = "verification-execution-failed";
          } else {
            const child = checkedChild(await options.executeQa([
              "qa", target.href, "--output", join(output, "regression"),
              "--mode", original.scanPolicy.mode, "--fail-on", original.scanPolicy.failOn,
              ...(original.scanPolicy.safeInteractions ? [] : ["--no-interactions"]),
              ...(original.scanPolicy.safeLinks ? ["--safe-links"] : []),
              "--json",
            ]));
            if (!await originalUnchanged(original)) {
              code = 3; reason = "original-evidence-changed";
            } else if (child === null) {
              code = 4; reason = "regression-child-invalid";
            } else if (child.exitCode === 4) {
              code = 4; reason = "regression-execution-failed";
            } else {
              const fresh = await inspectFreshRegression(join(output, "regression"), target, child,
                original.scanPolicy)
                .catch(() => null);
              if (fresh === null) {
                code = 3; reason = "regression-evidence-invalid";
              } else {
                regression = fresh.regression;
                const anyReproduced = verification.reproduced > 0 || regression.verified > 0;
                if (fresh.inconclusive || verification.inconclusive > 0
                  || checked.exitCode === 3) {
                  code = anyReproduced ? 1 : 3;
                  reason = anyReproduced ? "verified-defects-remain" : "coverage-or-verification-incomplete";
                } else if (anyReproduced) {
                  code = 1; reason = "verified-defects-remain";
                } else if (verification.fixed === original.verified
                  && checked.exitCode === 0 && regression.status === "COMPLETED") {
                  code = 0; reason = null;
                } else {
                  code = 3; reason = "acceptance-inconclusive";
                }
              }
            }
          }
        }
      }
    }
  } catch {
    code = 4; reason = "child-operation-or-evidence-failed";
  }
  // Child operations must never be able to mutate original evidence and still
  // obtain a successful or reproduced certification.
  if (!await originalUnchanged(original)) {
    code = 3; reason = "original-evidence-changed";
  }
  const outcome = response(code, reason, original, verification, regression, "qa-accept.json");
  try {
    const serialized = JSON.stringify(outcome, null, 2) + "\n";
    if (Buffer.byteLength(serialized) > MAX_ACCEPT_BYTES) throw new Error("oversized-summary");
    await writeFile(join(output, "qa-accept.json"), serialized, { flag: "wx", mode: 0o600 });
    return outcome;
  } catch {
    return response(4, "acceptance-summary-write-failed", original, verification, regression);
  }
}
