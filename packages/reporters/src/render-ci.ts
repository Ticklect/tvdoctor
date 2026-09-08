import {
  ISSUE_SEVERITIES,
  type IssueSeverity,
  type TVDoctorIssue,
  type TVDoctorReportV1,
} from "@tvdoctor/protocol";
import { sanitiseReportForOutput } from "./report-builder.js";

export const CI_FAILURE_THRESHOLDS = ["any", ...ISSUE_SEVERITIES, "never"] as const;
export type CiFailureThreshold = (typeof CI_FAILURE_THRESHOLDS)[number];

export function issueViolatesPolicy(
  severity: IssueSeverity,
  failOn: CiFailureThreshold,
): boolean {
  if (failOn === "never") return false;
  if (failOn === "any") return true;
  return ISSUE_SEVERITIES.indexOf(severity) <= ISSUE_SEVERITIES.indexOf(failOn);
}

function compact(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function markdownInline(value: string): string {
  return compact(value).replace(/[\\`*_[\]<>]/gu, "\\$&");
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function policyFailures(issues: readonly TVDoctorIssue[], failOn: CiFailureThreshold): readonly TVDoctorIssue[] {
  return issues.filter((issue) => issueViolatesPolicy(issue.severity, failOn));
}

export function renderCiSummary(
  report: TVDoctorReportV1,
  failOn: CiFailureThreshold,
): string {
  const safe = sanitiseReportForOutput(report);
  const failures = policyFailures(safe.issues, failOn);
  const verdict = safe.run.status !== "completed"
    ? "INCONCLUSIVE"
    : failures.length > 0 ? "FAILED" : "PASSED";
  const counts = ISSUE_SEVERITIES
    .map((severity) => `${severity} ${String(safe.issues.filter((issue) => issue.severity === severity).length)}`)
    .join(" · ");
  const findings = safe.issues.slice(0, 10).map((issue) =>
    `- **${issue.severity.toUpperCase()}** \`${issue.id}\` — ${markdownInline(issue.title)}`
  );
  return [
    `# TVDoctor CI: ${verdict}`,
    "",
    `Run: **${safe.run.status}** · Policy: fail on **${failOn}** · Findings: **${String(safe.issues.length)}**`,
    "",
    counts,
    "",
    ...(findings.length === 0 ? ["No findings."] : findings),
    ...(safe.issues.length > findings.length
      ? [`- ${String(safe.issues.length - findings.length)} more findings are in the report.`]
      : []),
    "",
    "[Open the full TVDoctor report](../report.html)",
    "",
  ].join("\n");
}

export function renderJunitReport(
  report: TVDoctorReportV1,
  failOn: CiFailureThreshold,
): string {
  const safe = sanitiseReportForOutput(report);
  const failures = policyFailures(safe.issues, failOn);
  const runError = safe.run.status === "completed" ? 0 : 1;
  const testCount = Math.max(1, safe.issues.length) + runError;
  const cases = safe.issues.length === 0
    ? ['    <testcase classname="tvdoctor" name="audit completed"/>']
    : safe.issues.map((issue) => {
        const opening = `    <testcase classname="tvdoctor.${xml(issue.pack)}" name="${xml(issue.id)}: ${xml(compact(issue.title))}">`;
        const detail = `${issue.severity.toUpperCase()}: ${compact(issue.observed)}`;
        return issueViolatesPolicy(issue.severity, failOn)
          ? `${opening}\n      <failure type="tvdoctor.${xml(issue.severity)}" message="${xml(detail)}">${xml(compact(issue.description))}</failure>\n    </testcase>`
          : `${opening}\n      <system-out>${xml(detail)}</system-out>\n    </testcase>`;
      });
  if (runError > 0) {
    cases.unshift(
      `    <testcase classname="tvdoctor" name="audit completeness">\n      <error type="tvdoctor.${xml(safe.run.status)}" message="TVDoctor audit was ${xml(safe.run.status)}.">Review report.html before trusting this result.</error>\n    </testcase>`,
    );
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites tests="${String(testCount)}" failures="${String(failures.length)}" errors="${String(runError)}">`,
    `  <testsuite name="TVDoctor" tests="${String(testCount)}" failures="${String(failures.length)}" errors="${String(runError)}" time="${(safe.run.durationMs / 1_000).toFixed(3)}">`,
    ...cases,
    "  </testsuite>",
    "</testsuites>",
    "",
  ].join("\n");
}
