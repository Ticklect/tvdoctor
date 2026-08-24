import { ISSUE_SEVERITIES, type ArtifactDescriptor, type TVDoctorIssue, type TVDoctorReportV1 } from "@tvdoctor/protocol";
import { markdownDataBlock } from "./security.js";
import {
  artifactHref,
  artifactsForIssue,
  formatDuration,
  formatRemoteSequence,
  issueCounts,
  replayCommand,
  replayTargetOverrideRequired,
  validReport,
} from "./render-helpers.js";

function artifactMarkdown(artifact: ArtifactDescriptor): string {
  if (artifact.status !== "available") {
    return `- \`${artifact.id}\` — ${artifact.status}\n\n${markdownDataBlock(artifact.reason)}`;
  }
  return `- [\`${artifact.id}\`](${artifactHref(artifact.path)}) — ${artifact.mediaType}, ${String(artifact.byteLength)} bytes, SHA-256 \`${artifact.sha256 ?? "unavailable"}\``;
}

function issueMarkdown(report: TVDoctorReportV1, issue: TVDoctorIssue): string {
  const artifacts = artifactsForIssue(report, issue);
  const replayOverrideWarning = replayTargetOverrideRequired(report)
    ? "\n\n**Original target required:** Query or fragment data was redacted from this report. Supply the original authorised URL explicitly; replay refuses to run without it."
    : "";
  const transition = issue.transition === null
    ? "No single transition assertion was available."
    : `From:\n\n${markdownDataBlock(issue.transition.fromElement ?? "unobserved")}\n\nAction: \`${issue.transition.action}\`\n\nExpected target:\n\n${markdownDataBlock(issue.transition.expectedElement ?? "unobserved")}\n\nObserved target:\n\n${markdownDataBlock(issue.transition.observedElement ?? "unobserved")}`;
  const reproduction = issue.reproduction.status === "available"
    ? `Original sequence executed by replay:\n\n${formatRemoteSequence(issue.reproduction.originalSequence)}${issue.reproduction.minimizedSequence === null ? "" : `\n\nRecorded minimized candidate (not executed by the M5 replay command):\n\n${formatRemoteSequence(issue.reproduction.minimizedSequence)}`}${replayOverrideWarning}\n\nReplay command (${issue.reproduction.confidence}):\n\n    ${replayCommand(report, issue.id)}`
    : `Unavailable:\n\n${markdownDataBlock(issue.reproduction.reason)}`;
  const reproductionHeading = issue.reproduction.status !== "available"
    ? "Reproduction"
    : issue.reproduction.confidence === "deterministic"
      ? "Exact reproduction"
      : "Best-effort reproduction";
  return `### ${issue.id}

Severity: **${issue.severity.toUpperCase()}**  
Confidence: **${issue.confidence.toUpperCase()}**  
Rule: \`${issue.rule}\`

Title (observed target data):

${markdownDataBlock(issue.title)}

Screen:

${markdownDataBlock(issue.screen ?? "unobserved")}

#### Problem

${markdownDataBlock(issue.description)}

#### Expected

${markdownDataBlock(issue.expected)}

#### Observed

${markdownDataBlock(issue.observed)}

#### Navigation transition

${transition}

#### ${reproductionHeading}

${reproduction}

#### Runtime evidence

${issue.evidence.map((evidence) => `- **${evidence.kind}**\n\n  Source (observed data):\n\n${markdownDataBlock(evidence.source ?? "source unavailable")}\n\n  Observation:\n\n${markdownDataBlock(evidence.summary)}`).join("\n\n") || "No runtime evidence entries were recorded."}

#### Artifacts

${artifacts.map((artifact) => artifactMarkdown(artifact)).join("\n") || "No artifacts were recorded for this issue."}
`;
}

export function renderReportMarkdown(report: TVDoctorReportV1): string {
  const valid = validReport(report);
  const counts = issueCounts(valid);
  const incompleteCoverage = [
    ...valid.coverage.packs
      .filter((pack) => pack.status !== "completed")
      .map((pack) => `${pack.pack}: ${pack.status}`),
    ...valid.coverage.budget.exhausted.map((budget) => `${budget} budget exhausted`),
  ];
  const partialWarning = valid.run.status === "partial"
    ? `> **INCONCLUSIVE — PARTIAL RUN**\n>\n> This report describes only completed coverage. Do not interpret absent findings as a pass.\n>\n> Recorded reasons: ${incompleteCoverage.join("; ") || "The run ended before all requested coverage completed; no more-specific reason was recorded."}\n\n`
    : "";
  const severitySummary = ISSUE_SEVERITIES.map((severity) => `| ${severity.toUpperCase()} | ${String(counts[severity] ?? 0)} |`).join("\n");
  const groups = ISSUE_SEVERITIES.map((severity) => {
    const issues = valid.issues.filter((issue) => issue.severity === severity);
    return issues.length === 0 ? "" : `## ${severity.toUpperCase()} findings\n\n${issues.map((issue) => issueMarkdown(valid, issue)).join("\n")}`;
  }).filter((group) => group.length > 0).join("\n");
  return `# TVDoctor Report

Target name (untrusted observed data):

${markdownDataBlock(valid.target.name)}

Target location (sanitised observed data):

${markdownDataBlock(valid.target.location)}

- Platform: \`${valid.target.platform}\`
- Run: \`${valid.run.id}\`
- Status: **${valid.run.status.toUpperCase()}**
- Mode: \`${valid.run.mode}\`
- Duration: ${formatDuration(valid.run.durationMs)}

${partialWarning}## Summary

| Severity | Count |
| --- | ---: |
${severitySummary}

## Coverage

- Screens discovered: ${String(valid.coverage.screenStatesDiscovered)}
- Focus targets discovered: ${String(valid.coverage.focusStatesDiscovered)}
- Transitions tested: ${String(valid.coverage.transitionsTested)}
- Actions sent: ${String(valid.coverage.actionsSent)}
- Exhausted budgets: ${valid.coverage.budget.exhausted.join(", ") || "none"}

${groups || "## Findings\n\nNo issues were reported for the observed coverage. This is not a claim of exhaustive testing."}

## Artifact inventory

${valid.artifacts.map((artifact) => artifactMarkdown(artifact)).join("\n") || "No artifacts were recorded."}
`;
}
