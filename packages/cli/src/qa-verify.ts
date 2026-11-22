import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PROTOCOL_VALIDATION_LIMITS, parseTVDoctorReportJson, type TVDoctorReportV1 } from "@tvdoctor/protocol";
import { renderAgentRepairBrief } from "./agent-repair-brief.js";
import { inspectReport, type ActionableTriageFinding, type ReportTriage } from "./node-triage.js";
import { createFirstRunHandoff, type FirstRunHandoff } from "./first-run-handoff.js";

const MAX_QA_BYTES = 128 * 1024;
const MAX_HANDOFF_BYTES = 256 * 1024;
const MAX_BRIEF_BYTES = 64 * 1024;
const MAX_CHILD_STDOUT = 1024 * 1024;
const MAX_VERIFIED = 16;
const SHA256 = /^[0-9a-f]{64}$/u;
const ISSUE_ID = /^[A-Za-z0-9_.:-]{1,256}$/u;
const ALLOWED_RULES = new Set([
  "keyboard.modal-focus-escape",
  "keyboard.modal-tab-focus-loss",
  "keyboard.modal-open-focus-not-transferred",
]);
const CAVEAT = "Only independently re-executed eligible original issues can be FIXED. This check does not scan for new regressions, establish whole-site coverage or certify WCAG conformance.";

export interface QaVerifyOptions {
  readonly originalQaPath: string;
  readonly target: string;
  readonly outputRoot: string;
  readonly authorized: boolean;
  readonly executeVerify: (args: readonly string[]) => Promise<{
    readonly exitCode: number;
    readonly stdout: string;
  }>;
}

export type QaVerifyVerdict = "FIXED" | "REPRODUCED" | "INCONCLUSIVE";

export interface QaVerifyIssue {
  readonly issueId: string;
  readonly rule: string;
  readonly classification: QaVerifyVerdict;
  readonly reason: string | null;
}

export interface QaVerifyResult {
  readonly schemaVersion: "tvdoctor.qa-verification/v1";
  readonly status: "FIXED" | "REPRODUCED" | "INCONCLUSIVE" | "ERROR";
  readonly exitCode: 0 | 1 | 2 | 3 | 4;
  readonly shouldFail: boolean;
  readonly reason: string | null;
  readonly originalSha256: string | null;
  readonly perIssue: readonly QaVerifyIssue[];
  readonly counts: {
    readonly originalVerified: number;
    readonly checked: number;
    readonly fixed: number;
    readonly reproduced: number;
    readonly inconclusive: number;
    readonly unsupported: number;
  };
  /** Relative to the new outputRoot; do not expose capture-host paths. */
  readonly verificationPath: "qa-verification.json" | null;
  readonly caveat: string;
}

interface QaFile {
  readonly bytes: Buffer;
  readonly sha256: string;
}

interface Original {
  readonly root: string;
  readonly reportPath: string;
  readonly report: TVDoctorReportV1;
  readonly reportSha256: string;
  readonly reportByteLength: number;
  readonly triage: ReportTriage;
  readonly issues: readonly ActionableTriageFinding[];
  readonly saved: readonly { readonly path: string; readonly sha256: string; readonly maximum: number }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inside(root: string, target: string): boolean {
  const rest = relative(root, target);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}

async function canonicalDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  const info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(absolute) !== absolute) {
    throw new Error("unsafe-directory");
  }
  return absolute;
}

async function checkedFile(path: string, max: number): Promise<QaFile> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > max
    || await realpath(path) !== path) throw new Error("unsafe-evidence-file");
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (!after.isFile() || after.isSymbolicLink() || bytes.length !== info.size
    || after.size !== info.size || after.mtimeMs !== info.mtimeMs
    || after.ino !== info.ino) throw new Error("changed-evidence-file");
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function decodeJson(bytes: Buffer): unknown {
  return JSON.parse(bytes.toString("utf8")) as unknown;
}

function validOptionPath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && path.length <= 4096
    && path.trim() === path && !path.includes("\0");
}

function validatedTarget(value: unknown): URL | null {
  if (typeof value !== "string" || value.length < 1 || value.length > 2048 || value.trim() !== value
    || Array.from(value).some((character) => (character.codePointAt(0) ?? 0) <= 32
      || (character.codePointAt(0) ?? 0) === 127)
    || value.includes("\\")) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username !== "" || url.password !== ""
      || url.search !== "" || url.hash !== "") return null;
    return url;
  } catch { return null; }
}

/**
 * The captured QA summary embeds absolute paths from the original machine.
 * They must agree on one original root but need not match the current checkout:
 * GitHub's download-artifact relocates the entire bundle.
 */
function capturedPathsAgree(summary: Record<string, unknown>): boolean {
  const suffixes = {
    summaryPath: "/qa-summary.json",
    originalPath: "/original/report.json",
    handoffPath: "/handoff.json",
    agentBriefPath: "/AGENT_REPAIR_BRIEF.md",
  } as const;
  let oldRoot: string | undefined;
  for (const [field, suffix] of Object.entries(suffixes)) {
    const value = summary[field];
    if (typeof value !== "string" || value.length > 4096 || value.includes("\0")
      || /[\r\n]/u.test(value)) return false;
    const normalized = value.replace(/\\/gu, "/");
    if (!normalized.endsWith(suffix) || !/^(?:[A-Za-z]:)?\//u.test(normalized)
      || normalized.includes("//") || normalized.split("/").includes("..")) return false;
    const prefix = normalized.slice(0, -suffix.length);
    if (prefix.length < 1 || (oldRoot !== undefined && oldRoot !== prefix)) return false;
    oldRoot = prefix;
  }
  return true;
}

function asFirstRunHandoff(value: unknown): FirstRunHandoff | null {
  if (!isRecord(value) || value["schemaVersion"] !== "tvdoctor.first-run-handoff/v1"
    || value["source"] !== "report" || !isRecord(value["summary"])
    || !Array.isArray(value["findings"]) || value["findings"].length > 3) return null;
  return value as unknown as FirstRunHandoff;
}

function reportedShaPins(handoff: FirstRunHandoff): readonly string[] {
  const pins: string[] = [];
  for (const entry of handoff.findings) {
    if (!isRecord(entry) || !isRecord(entry.commands)) throw new Error("invalid-handoff-finding");
    const command = entry.commands.verifyFix;
    if (command === null) continue;
    if (typeof command !== "string") throw new Error("invalid-handoff-command");
    const hit = command.match(/(?:^|\s)--sha256\s+([0-9a-f]{64})(?=\s|$)/gu);
    if (hit?.length !== 1) throw new Error("missing-original-sha-pin");
    const hash = hit[0]?.trim().slice("--sha256 ".length);
    if (hash === undefined || !SHA256.test(hash)) throw new Error("invalid-original-sha-pin");
    pins.push(hash);
  }
  return pins;
}

async function originalEvidence(path: string, target: URL): Promise<Original> {
  const source = resolve(path);
  const qaSummaryPath = source.endsWith("qa-summary.json") ? source : join(source, "qa-summary.json");
  const root = await canonicalDirectory(dirname(qaSummaryPath));
  if (qaSummaryPath !== join(root, "qa-summary.json")) throw new Error("noncanonical-qa-summary");
  const qaFile = await checkedFile(qaSummaryPath, MAX_QA_BYTES);
  const qa = decodeJson(qaFile.bytes);
  if (!isRecord(qa) || qa["schemaVersion"] !== "tvdoctor.qa/v1" || qa["source"] !== "url"
    || qa["status"] !== "ACTION_REQUIRED" || qa["reason"] !== null
    || !isRecord(qa["summary"]) || !capturedPathsAgree(qa)) throw new Error("invalid-qa-provenance");

  const originalRoot = await canonicalDirectory(join(root, "original"));
  const reportPath = join(originalRoot, "report.json");
  const handoffPath = join(root, "handoff.json");
  const briefPath = join(root, "AGENT_REPAIR_BRIEF.md");
  const [reportFile, handoffFile, briefFile] = await Promise.all([
    checkedFile(reportPath, PROTOCOL_VALIDATION_LIMITS.maxJsonBytes),
    checkedFile(handoffPath, MAX_HANDOFF_BYTES),
    checkedFile(briefPath, MAX_BRIEF_BYTES),
  ]);
  const report = parseTVDoctorReportJson(reportFile.bytes.toString("utf8"));
  if (report.schemaVersion !== "tvdoctor.report/v1" || report.run.status !== "completed"
    || report.target.platform !== "web" || report.target.environment["inputMode"] !== "keyboard"
    || report.target.environment["journeyConfigSha256"] !== undefined) throw new Error("unsupported-original-report");
  const originalTarget = validatedTarget(report.target.location);
  if (originalTarget === null || originalTarget.origin !== target.origin) {
    throw new Error("target-origin-mismatch");
  }
  const triage = await inspectReport(reportPath, { maxFindings: 100 });
  if (triage.coverage.incomplete || triage.integrity.evidence === "degraded"
    || triage.integrity.evidence === "bounded" || triage.summary.omitted > 0
    || triage.summary.VERIFIED < 1 || triage.summary.VERIFIED > MAX_VERIFIED) {
    throw new Error("incomplete-original-or-unsupported-count");
  }
  const qaCounts = qa["summary"];
  if (qaCounts["routes"] !== 1 || qaCounts["verified"] !== triage.summary.VERIFIED
    || qaCounts["review"] !== triage.summary.REVIEW || qaCounts["untested"] !== triage.summary.UNTESTED
    || qaCounts["incompleteRoutes"] !== 0) throw new Error("qa-summary-counts-mismatch");
  const handoff = asFirstRunHandoff(decodeJson(handoffFile.bytes));
  if (handoff === null || handoff.status !== "ACTION_REQUIRED"
    || handoff.summary.verified !== triage.summary.VERIFIED
    || handoff.summary.review !== triage.summary.REVIEW
    || handoff.summary.untested !== triage.summary.UNTESTED
    || handoff.summary.incompleteRoutes !== 0
    || handoff.summary.routes !== 1 || handoff.summary.selected !== handoff.findings.length
    || handoff.summary.selected !== qaCounts["selected"]) {
    throw new Error("handoff-inconsistent-with-original");
  }
  const verified = triage.findings.filter((entry) => entry.classification === "VERIFIED");
  // Reconstruct source-derived priorities and review content independently.
  // REVIEW entries are never eligible for the browser FIXED oracle. Comparing
  // non-command fields also keeps CI artifact relocation supported: captured
  // verified commands can name the old host's original report path.
  const sourceHandoff = await createFirstRunHandoff({ reportPath });
  const expected = sourceHandoff.findings;
  const seen = new Set<string>();
  const sameFinding = (entry: FirstRunHandoff["findings"][number],
    sourceFinding: FirstRunHandoff["findings"][number]): boolean => {
    return JSON.stringify({ ...entry, commands: undefined })
      === JSON.stringify({ ...sourceFinding, commands: undefined });
  };
  if (verified.length !== triage.summary.VERIFIED || handoff.findings.length !== expected.length
    || handoff.findings.some((entry, i) => {
      const sourceFinding = expected[i];
      if (!isRecord(entry) || !isRecord(entry.commands)
        || !ISSUE_ID.test(entry.issueId) || seen.has(entry.issueId)
        || sourceFinding === undefined || !sameFinding(entry, sourceFinding)) return true;
      seen.add(entry.issueId);
      const commands = entry.commands;
      if (entry.classification === "REVIEW_ORIGINAL") {
        return commands.inspect !== sourceFinding.commands.inspect
          || commands.reproduce !== null || commands.verifyFix !== null
          || commands.regressionCompare !== null || entry.reproduction.stored !== false
          || entry.replayArtifactVerified !== false;
      }
      return entry.classification !== "VERIFIED_ORIGINAL"
        || typeof commands.inspect !== "string"
        || (commands.reproduce === null) !== (sourceFinding.commands.reproduce === null)
        || (commands.verifyFix === null) !== (sourceFinding.commands.verifyFix === null)
        || (commands.regressionCompare === null) !== (sourceFinding.commands.regressionCompare === null);
    })) {
    throw new Error("handoff-does-not-match-original-issues");
  }
  // A coherent fake report + QA summary is insufficient: the saved handoff's
  // originally captured SHA pin must still match the exact report bytes.
  const pins = reportedShaPins(handoff);
  if (pins.length === 0 || pins.some((sha) => sha !== reportFile.sha256)) {
    throw new Error("original-report-sha-pin-mismatch");
  }
  if (briefFile.bytes.toString("utf8") !== renderAgentRepairBrief(handoff)) {
    throw new Error("agent-brief-modified");
  }
  return {
    root, reportPath, report, reportSha256: reportFile.sha256,
    reportByteLength: reportFile.bytes.length, triage,
    issues: verified, saved: [
      { path: qaSummaryPath, sha256: qaFile.sha256, maximum: MAX_QA_BYTES },
      { path: reportPath, sha256: reportFile.sha256, maximum: PROTOCOL_VALIDATION_LIMITS.maxJsonBytes },
      { path: handoffPath, sha256: handoffFile.sha256, maximum: MAX_HANDOFF_BYTES },
      { path: briefPath, sha256: briefFile.sha256, maximum: MAX_BRIEF_BYTES },
    ],
  };
}

async function unchanged(original: Original): Promise<boolean> {
  try {
    for (const item of original.saved) {
      if ((await checkedFile(item.path, item.maximum)).sha256 !== item.sha256) return false;
    }
    const triage = await inspectReport(original.reportPath, { maxFindings: 100 });
    if (triage.coverage.incomplete || triage.integrity.evidence === "degraded"
      || triage.integrity.evidence === "bounded" || triage.summary.VERIFIED !== original.issues.length
      || triage.summary.omitted > 0) return false;
    return true;
  } catch { return false; }
}

function verifyResponse(
  execution: { readonly exitCode: number; readonly stdout: string },
  item: ActionableTriageFinding, original: Original,
): QaVerifyIssue {
  const base = { issueId: item.id, rule: item.rule };
  if (!Number.isInteger(execution.exitCode) || ![0, 1, 3, 4].includes(execution.exitCode)
    || typeof execution.stdout !== "string" || execution.stdout.length > MAX_CHILD_STDOUT) {
    return { ...base, classification: "INCONCLUSIVE", reason: "invalid-verification-result" };
  }
  let output: unknown;
  try { output = JSON.parse(execution.stdout.trim()) as unknown; }
  catch { return { ...base, classification: "INCONCLUSIVE", reason: "invalid-verification-json" }; }
  if (!isRecord(output) || output["schemaVersion"] !== "tvdoctor.verify-workflow/v1"
    || !isRecord(output["original"]) || !isRecord(output["replay"])
    || output["freshScan"] !== null || output["comparison"] !== null) {
    return { ...base, classification: "INCONCLUSIVE", reason: "untrusted-verification-response" };
  }
  const report = output["original"];
  const replay = output["replay"];
  if (report["issueId"] !== item.id || report["rule"] !== item.rule
    || report["runId"] !== original.report.run.id || report["reportSha256"] !== original.reportSha256
    || report["reportByteLength"] !== original.reportByteLength
    || report["inputMode"] !== "keyboard" || report["targetOverridden"] !== true
    || output["shouldFail"] !== (execution.exitCode !== 0)) {
    return { ...base, classification: "INCONCLUSIVE", reason: "verification-provenance-mismatch" };
  }
  const status = output["classification"];
  if (status === "FIXED" && execution.exitCode === 0 && output["fixed"] === true
    && output["reason"] === null && replay["status"] === "fixed"
    && replay["stableFixConfirmationRequested"] === true && replay["originalSequenceReused"] === true) {
    return { ...base, classification: "FIXED", reason: null };
  }
  if (status === "REPRODUCED" && execution.exitCode === 1 && output["fixed"] === false
    && replay["status"] === "reproduced"
    && replay["stableFixConfirmationRequested"] === true && replay["originalSequenceReused"] === true) {
    return { ...base, classification: "REPRODUCED", reason: null };
  }
  return { ...base, classification: "INCONCLUSIVE",
    reason: execution.exitCode === 4 ? "verify-execution-failed" : "independent-verification-inconclusive" };
}

function result(
  status: QaVerifyResult["status"], exitCode: QaVerifyResult["exitCode"], reason: string | null,
  sha: string | null, perIssue: readonly QaVerifyIssue[], total: number, checked: number,
  unsupported: number, verificationPath: QaVerifyResult["verificationPath"],
): QaVerifyResult {
  return {
    schemaVersion: "tvdoctor.qa-verification/v1", status, exitCode, shouldFail: exitCode !== 0,
    reason, originalSha256: sha, perIssue,
    counts: {
      originalVerified: total, checked,
      fixed: perIssue.filter((item) => item.classification === "FIXED").length,
      reproduced: perIssue.filter((item) => item.classification === "REPRODUCED").length,
      inconclusive: perIssue.filter((item) => item.classification === "INCONCLUSIVE").length,
      unsupported,
    },
    verificationPath, caveat: CAVEAT,
  };
}

/**
 * Gate ALL originally VERIFIED issues, not only the three in an agent handoff.
 * Browser operations are delegated solely to the production verify-fix command.
 */
export async function runQaVerify(options: QaVerifyOptions): Promise<QaVerifyResult> {
  if (options.authorized !== true || !validOptionPath(options.originalQaPath)
    || !validOptionPath(options.outputRoot) || typeof options.executeVerify !== "function") {
    return result("INCONCLUSIVE", 2, "invalid-qa-verify-options", null, [], 0, 0, 0, null);
  }
  const target = validatedTarget(options.target);
  if (target === null) return result("INCONCLUSIVE", 2, "invalid-target", null, [], 0, 0, 0, null);
  const output = resolve(options.outputRoot);
  const source = resolve(options.originalQaPath);
  const sourceRoot = source.endsWith("qa-summary.json") ? dirname(source) : source;
  if (inside(sourceRoot, output) || inside(output, sourceRoot)) {
    return result("INCONCLUSIVE", 2, "output-overlaps-original", null, [], 0, 0, 0, null);
  }
  let original: Original | null = null;
  let preflightReason: string | null = null;
  try { original = await originalEvidence(source, target); }
  catch { preflightReason = "original-qa-evidence-unavailable-or-changed"; }
  // No browser may run until the output root has been reserved create-only.
  try {
    await mkdir(dirname(output), { recursive: true });
    const parent = await canonicalDirectory(dirname(output));
    if (!inside(parent, output)) throw new Error("invalid-output-root");
    await mkdir(output, { mode: 0o700 });
  } catch {
    return result("ERROR", 4, "output-root-unavailable-or-not-fresh",
      original?.reportSha256 ?? null, [], original?.triage.summary.VERIFIED ?? 0, 0, 0, null);
  }
  const perIssue: QaVerifyIssue[] = [];
  let checked = 0;
  let unsupported = 0;
  let executionFailure = false;
  let evidenceChanged = preflightReason !== null;
  if (original !== null) {
    for (const item of original.issues) {
      const supported = item.pack === "navigation" && ALLOWED_RULES.has(item.rule)
        && item.reproduction.status === "deterministic"
        && item.reproduction.replayId !== null
        && item.artifacts.some((artifact) => artifact.kind === "replay" && artifact.status === "verified");
      if (!supported) {
        unsupported += 1;
        perIssue.push({ issueId: item.id, rule: item.rule,
          classification: "INCONCLUSIVE", reason: "unsupported-original-rule-or-replay" });
        continue;
      }
      if (evidenceChanged || !await unchanged(original)) {
        evidenceChanged = true;
        perIssue.push({ issueId: item.id, rule: item.rule,
          classification: "INCONCLUSIVE", reason: "original-evidence-changed" });
        continue;
      }
      let verified: QaVerifyIssue;
      try {
        const execution = await options.executeVerify([
          "verify-fix", item.id, "--report", original.reportPath,
          "--target", target.href, "--sha256", original.reportSha256, "--authorized",
        ]);
        checked += 1;
        verified = verifyResponse(execution, item, original);
        if (execution.exitCode === 4) executionFailure = true;
      } catch {
        checked += 1;
        executionFailure = true;
        verified = { issueId: item.id, rule: item.rule,
          classification: "INCONCLUSIVE", reason: "verify-execution-failed" };
      }
      if (!await unchanged(original)) {
        evidenceChanged = true;
        verified = { issueId: item.id, rule: item.rule,
          classification: "INCONCLUSIVE", reason: "original-evidence-changed" };
      }
      perIssue.push(verified);
    }
  }
  if (evidenceChanged && perIssue.length > 0) {
    // A saved report, a linked artifact or its provenance changing at any
    // point invalidates the entire multi-issue certification, including
    // previously completed replay outcomes.
    for (let index = 0; index < perIssue.length; index += 1) {
      const issue = perIssue[index];
      if (issue !== undefined) {
        perIssue[index] = { ...issue, classification: "INCONCLUSIVE",
          reason: "original-evidence-changed" };
      }
    }
  }
  const total = original?.triage.summary.VERIFIED ?? 0;
  const anyReproduced = perIssue.some((item) => item.classification === "REPRODUCED");
  const everyFixed = total > 0 && perIssue.length === total
    && perIssue.every((item) => item.classification === "FIXED");
  const exitCode: QaVerifyResult["exitCode"] = everyFixed ? 0
    : anyReproduced ? 1 : executionFailure ? 4 : 3;
  const status: QaVerifyResult["status"] = everyFixed ? "FIXED"
    : anyReproduced ? "REPRODUCED" : executionFailure ? "ERROR" : "INCONCLUSIVE";
  const reason = everyFixed || anyReproduced ? null
    : evidenceChanged ? "original-evidence-changed-or-incomplete"
      : executionFailure ? "verify-execution-failed"
        : total === 0 ? "no-original-verified-issues" : "unsupported-or-inconclusive-issues";
  const final = result(status, exitCode, reason, original?.reportSha256 ?? null,
    perIssue, total, checked, unsupported, "qa-verification.json");
  try {
    await writeFile(join(output, "qa-verification.json"), JSON.stringify(final, null, 2) + "\n",
      { mode: 0o600, flag: "wx" });
    return final;
  } catch {
    return result("ERROR", 4, "verification-artifact-write-failed",
      original?.reportSha256 ?? null, perIssue, total, checked, unsupported, null);
  }
}

/** Alternative name for integration with the public qa-verify CLI dispatcher. */
export const runQaVerification: typeof runQaVerify = runQaVerify;
