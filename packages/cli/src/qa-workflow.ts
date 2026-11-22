import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseTVDoctorReportJson } from "@tvdoctor/protocol";
import {
  createFirstRunHandoff,
  type FirstRunHandoff,
} from "./first-run-handoff.js";

const MAX_CHILD_STDOUT = 1024 * 1024;
const CAVEAT = "A bounded browser check is not proof of a bug-free, WCAG-conformant or fully tested application. Only an original issue's supported independent verify-fix oracle can confirm FIXED.";

export interface QaWorkflowOptions {
  readonly source: "url" | "project";
  readonly target: string;
  readonly outputRoot: string;
  readonly mode?: "quick" | "standard" | "deep";
  readonly failOn?: string;
  readonly safeInteractions?: boolean;
  readonly safeLinks?: boolean;
  readonly sourceRoot?: string;
  readonly baselinePath?: string;
  /** A validated project manifest requires explicit authorization in the CLI. */
  readonly authorized?: boolean;
  readonly execute: (args: readonly string[]) => Promise<{ readonly exitCode: number; readonly stdout: string }>;
  readonly renderBrief: (handoff: FirstRunHandoff) => string;
}

export interface QaWorkflowResult {
  readonly schemaVersion: "tvdoctor.qa/v1";
  readonly source: "url" | "project";
  readonly status: "ACTION_REQUIRED" | "REVIEW_REQUIRED" | "NO_VERIFIED_FAILURES_IN_COVERAGE" | "INCONCLUSIVE";
  readonly shouldFail: boolean;
  readonly exitCode: number;
  readonly reason: string | null;
  readonly originalPath: string | null;
  readonly handoffPath: string | null;
  readonly agentBriefPath: string | null;
  readonly summaryPath: string | null;
  readonly summary: FirstRunHandoff["summary"] | null;
  /** Bound to the original report SHA, not inferred from later scan output. */
  readonly scanPolicy?: {
    readonly schemaVersion: "tvdoctor.qa-scan-policy/v1";
    readonly safeInteractions: boolean;
    readonly safeLinks: boolean;
    readonly mode: "quick" | "standard" | "deep";
    readonly failOn: string;
    readonly reportSha256: string;
  };
  readonly caveat: string;
}

type JsonObject = Record<string, unknown>;
function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isExpectedChildOutput(source: "url" | "project", exitCode: number,
  stdout: string, expectedArtifact: string): boolean {
  if (stdout.length === 0 || stdout.length > MAX_CHILD_STDOUT || ![0, 1, 3, 4].includes(exitCode)) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(stdout) as unknown; } catch { return false; }
  if (!isObject(parsed) || parsed["shouldFail"] !== (exitCode !== 0)) return false;
  if (source === "url") {
    if (parsed["schemaVersion"] !== "tvdoctor.developer-check/v1"
      || !isObject(parsed["scan"])) return false;
    const statuses = exitCode === 0 ? ["REVIEW_REQUIRED", "NO_VERIFIED_FAILURES_AT_THRESHOLD"]
      : exitCode === 1 ? ["FINDINGS", "REGRESSED"] : ["INCONCLUSIVE"];
    return statuses.includes(String(parsed["status"]))
      && parsed["scan"]["reportPath"] === expectedArtifact;
  }
  if (parsed["schemaVersion"] !== "tvdoctor.project-check/v1") return false;
  const statuses = exitCode === 0 ? ["PASS", "REVIEW_REQUIRED"]
    : exitCode === 1 ? ["FINDINGS"] : ["INCONCLUSIVE"];
  return statuses.includes(String(parsed["status"]))
    && parsed["summaryPath"] === expectedArtifact;
}

async function existingEvidence(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink() && info.size > 0;
  } catch { return false; }
}

/**
 * Product orchestration ONLY: delegate all scanning, replay/evidence checks,
 * and per-route verification to the already shipped production engine.
 * Do not synthesize findings or infer a FIXED result from a clean scan.
 */
export async function runQaWorkflow(options: QaWorkflowOptions): Promise<QaWorkflowResult> {
  const root = resolve(options.outputRoot);
  await mkdir(dirname(root), { recursive: true });
  // Reserve a completely new output root. Never rewrite an older run's proof.
  await mkdir(root);
  const originalDirectory = join(root, "original");
  const originalPath = join(originalDirectory, options.source === "url" ? "report.json" : "summary.json");
  const summaryPath = join(root, "qa-summary.json");
  const childArgs = options.source === "url"
    ? ["check", options.target, "--json", "--output", originalDirectory,
      "--mode", options.mode ?? "standard", "--fail-on", options.failOn ?? "any",
      ...(options.safeInteractions === false ? [] : ["--interactions"]),
      ...(options.safeLinks === true ? ["--safe-links"] : []),
      ...(options.sourceRoot === undefined ? [] : ["--source-root", options.sourceRoot]),
      ...(options.baselinePath === undefined ? [] : ["--baseline", options.baselinePath])]
    : ["project", "--config", options.target, "--authorized", "--json",
      "--output", originalDirectory];

  const fail = (reason: string, code = 3): QaWorkflowResult => ({
    schemaVersion: "tvdoctor.qa/v1", source: options.source, status: "INCONCLUSIVE",
    shouldFail: true, exitCode: code, reason,
    originalPath: null, handoffPath: null, agentBriefPath: null,
    summaryPath, summary: null, caveat: CAVEAT,
  });

  let result: QaWorkflowResult;
  try {
    if (options.source === "project" && options.authorized !== true) {
      result = fail("project-authorization-required", 2);
    } else {
      const child = await options.execute(childArgs);
      if (!isExpectedChildOutput(options.source, child.exitCode, child.stdout, originalPath)) {
        result = fail("source-audit-incomplete-or-contradictory", child.exitCode === 4 ? 4 : 3);
      } else if (!await existingEvidence(originalPath)) {
        result = fail("source-evidence-missing-or-incomplete");
      } else {
        let scanPolicy: QaWorkflowResult["scanPolicy"];
        if (options.source === "url") {
          const bytes = await readFile(originalPath);
          const report = parseTVDoctorReportJson(bytes.toString("utf8"));
          const safeLinks = options.safeLinks === true;
          const safeInteractions = options.safeInteractions !== false;
          const reportedLinks = report.target.environment["safeLinkNavigation"];
          const reportedInteractions = report.target.environment["keyboardInteractions"];
          if (reportedLinks !== undefined || reportedInteractions !== undefined) {
            if (report.schemaVersion !== "tvdoctor.report/v1"
              || reportedLinks !== (safeLinks ? "enabled" : "disabled")
              || reportedInteractions !== (safeInteractions ? "enabled" : "disabled")
              || report.run.mode !== (options.mode ?? "standard")) {
              throw new Error("Original browser evidence does not match the requested scan policy.");
            }
            scanPolicy = {
              schemaVersion: "tvdoctor.qa-scan-policy/v1", safeInteractions, safeLinks,
              mode: options.mode ?? "standard", failOn: options.failOn ?? "any",
              reportSha256: createHash("sha256").update(bytes).digest("hex"),
            };
          }
          // Legacy reports without explicit scanner policy remain inspectable,
          // but qa-accept cannot later certify comparable fresh coverage.
        }
        const handoff = await createFirstRunHandoff(options.source === "url"
          ? { reportPath: originalPath } : { projectSummaryPath: originalPath });
        const brief = options.renderBrief(handoff);
        if (typeof brief !== "string" || brief.length < 20 || brief.length > 64 * 1024) {
          throw new Error("invalid-agent-brief");
        }
        const handoffPath = join(root, "handoff.json");
        const agentBriefPath = join(root, "AGENT_REPAIR_BRIEF.md");
        await writeFile(handoffPath, JSON.stringify(handoff, null, 2) + "\n",
          { flag: "wx", mode: 0o600 });
        await writeFile(agentBriefPath, brief,
          { flag: "wx", mode: 0o600 });
        const code = handoff.status === "INCONCLUSIVE" ? 3 : child.exitCode;
        const inconsistent = (child.exitCode === 1 && handoff.summary.verified === 0)
          || (child.exitCode === 0 && handoff.status === "ACTION_REQUIRED" && (options.failOn ?? "any") === "any");
        result = inconsistent ? fail("audit-and-handoff-evidence-disagree") : {
          schemaVersion: "tvdoctor.qa/v1", source: options.source,
          status: handoff.status, shouldFail: code !== 0, exitCode: code,
          reason: null, originalPath, handoffPath, agentBriefPath, summaryPath,
          summary: handoff.summary, ...(scanPolicy === undefined ? {} : { scanPolicy }),
          caveat: CAVEAT,
        };
      }
    }
  } catch {
    // Never print untrusted browser, report, journey or filesystem details.
    result = fail("source-evidence-or-handoff-unavailable");
  }
  try {
    await writeFile(summaryPath, JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return result;
  } catch {
    return { ...fail("qa-summary-write-failed", 4), summaryPath: null };
  }
}
