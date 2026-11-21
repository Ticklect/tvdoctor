import { ISSUE_SEVERITIES, type ArtifactDescriptor, type TVDoctorIssue, type TVDoctorReportV1 } from "@tvdoctor/protocol";
import { markdownDataBlock } from "./security.js";
import {
  artifactHref,
  actionabilityCounts,
  artifactsForIssue,
  availableArtifactPath,
  availableRunArtifactPath,
  exhaustedBudgetReasons,
  formatDuration,
  formatRemoteSequence,
  hasDeterministicCliReplay,
  findingActionability,
  findingImpactStatement,
  currentRunReferenceLabel,
  directionalNavigationIssues,
  issuePatterns,
  issueCounts,
  navigationIssues,
  navigationCoverageStatement,
  replayCommand,
  replayTargetOverrideRequired,
  reproductionTimeline,
  validReport,
} from "./render-helpers.js";

function navigationSummaryMarkdown(report: TVDoctorReportV1): string {
  const navigation = navigationIssues(report);
  const directional = directionalNavigationIssues(report);
  const transitions = navigation.filter((issue) => issue.transition !== null).slice(0, 10).map((issue) => {
    if (issue.transition === null) return "";
    const from = issue.transition.fromElement ?? "unobserved";
    const reference = issue.transition.expectedElement ?? "unobserved";
    const observed = issue.transition.observedElement ?? "unobserved";
    const referenceLabel = currentRunReferenceLabel(issue, "target").toLowerCase();
    return `- **${issue.transition.action}** \`${issue.id}\`: ${markdownDataBlock(`${from} -> ${observed} (${referenceLabel}: ${reference})`).trimStart()}`;
  }).filter((line) => line.length > 0);
  return `## Remote navigation findings

- Screens discovered: **${String(report.coverage.screenStatesDiscovered)}**
- Focus targets discovered: **${String(report.coverage.focusStatesDiscovered)}**
- Transitions tested: **${String(report.coverage.transitionsTested)}**
- Navigation findings: **${String(navigation.length)}**
- Directional transition findings: **${String(directional.length)}**

${transitions.length === 0
    ? "No navigation transition findings were recorded."
    : `### Observed navigation findings\n\n${transitions.join("\n")}`}
`;
}

function artifactMarkdown(artifact: ArtifactDescriptor, artifactPrefix = ""): string {
  if (artifact.status !== "available") {
    return `- \`${artifact.id}\` — ${artifact.status}\n\n${markdownDataBlock(artifact.reason)}`;
  }
  return `- [\`${artifact.id}\`](${artifactPrefix}${artifactHref(artifact.path)}) — ${artifact.mediaType}, ${String(artifact.byteLength)} bytes, SHA-256 \`${artifact.sha256 ?? "unavailable"}\``;
}

function issueMarkdown(report: TVDoctorReportV1, issue: TVDoctorIssue, artifactPrefix = ""): string {
  const artifacts = artifactsForIssue(report, issue);
  const cliReplayable = hasDeterministicCliReplay(report, issue);
  const replayCommandMarkdown = cliReplayable
    ? `${replayTargetOverrideRequired(report)
      ? "\n\n**Original target required:** Query or fragment data was redacted from this report. Supply the original authorised URL explicitly; replay refuses to run without it."
      : ""}\n\nReplay command (deterministic):\n\n    ${replayCommand(report, issue.id)}`
    : "\n\n**Deterministic replay required.** The recorded sequence and evidence remain available, but the CLI rejects best-effort or otherwise non-deterministic reproductions; no replay command is shown.";
  const transition = issue.transition === null
    ? "No single transition assertion was available."
    : `From:\n\n${markdownDataBlock(issue.transition.fromElement ?? "unobserved")}\n\nAction: \`${issue.transition.action}\`\n\n${currentRunReferenceLabel(issue, "target")}:\n\n${markdownDataBlock(issue.transition.expectedElement ?? "unobserved")}\n\nObserved target:\n\n${markdownDataBlock(issue.transition.observedElement ?? "unobserved")}`;
  const reproduction = issue.reproduction.status === "available"
    ? `Recorded original sequence:\n\n${formatRemoteSequence(issue.reproduction.originalSequence)}${issue.reproduction.minimizedSequence === null ? "" : `\n\nRecorded minimized candidate (not executed by the M5 replay command):\n\n${formatRemoteSequence(issue.reproduction.minimizedSequence)}`}${replayCommandMarkdown}`
    : `Unavailable:\n\n${markdownDataBlock(issue.reproduction.reason)}`;
  const reproductionHeading = issue.reproduction.status !== "available"
    ? "Reproduction"
    : cliReplayable
      ? "Exact reproduction"
      : "Best-effort reproduction";
  const timeline = reproductionTimeline(issue)
    .map((entry) => `1. ${markdownDataBlock(entry).trimStart()}`)
    .join("\n");
  const replayArtifact = availableArtifactPath(artifacts, "replay");
  const graphArtifact = availableRunArtifactPath(report, "run:navigation-graph-markdown");
  const transitionArtifact = availableArtifactPath(artifacts, "transition");
  const supportingLinks = [
    replayArtifact === null ? "" : `[Replay artifact](${artifactPrefix}${artifactHref(replayArtifact)})`,
    graphArtifact === null ? "" : `[Navigation graph](${artifactPrefix}${artifactHref(graphArtifact)})`,
    transitionArtifact === null ? "" : `[Transition evidence](${artifactPrefix}${artifactHref(transitionArtifact)})`,
  ].filter((link) => link.length > 0);
  return `### ${issue.id}

Severity: **${issue.severity.toUpperCase()}**  
Confidence: **${issue.confidence.toUpperCase()}**  
Actionability: **${findingActionability(issue)}**<br>
Rule: \`${issue.rule}\`

Title (observed target data):

${markdownDataBlock(issue.title)}

Screen:

${markdownDataBlock(issue.screen ?? "unobserved")}

#### Problem

${markdownDataBlock(issue.description)}

#### Expected

_${currentRunReferenceLabel(issue, "behavior")}_

${markdownDataBlock(issue.expected)}

#### Observed

${markdownDataBlock(issue.observed)}

#### Why this matters

${markdownDataBlock(findingImpactStatement(issue))}

#### Navigation transition

${transition}

#### Reproduce

_${reproductionHeading}_

Reproduction timeline:

${timeline}

${reproduction}

${supportingLinks.length === 0 ? "" : `Supporting links: ${supportingLinks.join(" · ")}`}

#### Runtime evidence

${issue.evidence.map((evidence) => `- **${evidence.kind}**\n\n  Source (observed data):\n\n${markdownDataBlock(evidence.source ?? "source unavailable")}\n\n  Observation:\n\n${markdownDataBlock(evidence.summary)}`).join("\n\n") || "No runtime evidence entries were recorded."}

#### Artifacts

${artifacts.map((artifact) => artifactMarkdown(artifact, artifactPrefix)).join("\n") || "No artifacts were recorded for this issue."}
`;
}

export function renderReportMarkdown(report: TVDoctorReportV1, artifactPrefix = ""): string {
  const valid = validReport(report);
  const counts = issueCounts(valid);
  const incompleteCoverage = [
    ...valid.coverage.packs
      .filter((pack) => pack.status !== "completed")
      .map((pack) => `${pack.pack}: ${pack.status}`),
    ...exhaustedBudgetReasons(valid),
  ];
  const partialWarning = valid.run.status === "partial"
    ? `> **INCONCLUSIVE — PARTIAL RUN**\n>\n> This report describes only completed coverage. Do not interpret absent findings as a pass.\n>\n> Recorded reasons: ${incompleteCoverage.join("; ") || "The run ended before all requested coverage completed; no more-specific reason was recorded."}\n\n`
    : valid.run.status === "failed"
      ? "> **RUN FAILED — NOT A TARGET PASS**\n>\n> TVDoctor could not complete this audit. Zero findings do not mean the target passed.\n\n"
      : "";
  const severitySummary = ISSUE_SEVERITIES.map((severity) => `| ${severity.toUpperCase()} | ${String(counts[severity] ?? 0)} |`).join("\n");
  const actionability = actionabilityCounts(valid);
  const groups = (["VERIFIED", "REVIEW", "UNTESTED"] as const).map((label) => {
    const issues = valid.issues.filter((issue) => findingActionability(issue) === label);
    return issues.length === 0 ? "" : `## ${label}\n\n${issues.map((issue) => issueMarkdown(valid, issue, artifactPrefix)).join("\n")}`;
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

## Verdict

- ${navigationCoverageStatement(valid)}
- Verified findings: **${String(actionability.VERIFIED)}**
- Review findings: **${String(actionability.REVIEW)}**
- Untested checks: **${String(actionability.UNTESTED)}**

${partialWarning}## Summary

| Severity | Count |
| --- | ---: |
${severitySummary}

${navigationSummaryMarkdown(valid)}

${(() => {
  const patterns = issuePatterns(valid);
  return patterns.length === 0 ? "" : `## Repeated patterns\n\n${patterns.map((pattern) => `- **${pattern.label}** - ${String(pattern.count)} related findings across ${String(pattern.stateCount)} screen(s): ${pattern.issueIds.map((id) => `\`${id}\``).join(", ")}`).join("\n")}\n`;
})()}

## Coverage

- Screens discovered: ${String(valid.coverage.screenStatesDiscovered)}
- Focus targets discovered: ${String(valid.coverage.focusStatesDiscovered)}
- Transitions tested: ${String(valid.coverage.transitionsTested)}
- Actions sent: ${String(valid.coverage.actionsSent)}
- Exhausted budgets: ${exhaustedBudgetReasons(valid).join(" ") || "none"}

${groups || "## Findings\n\nNo issues were reported for the observed coverage. This is not a claim of exhaustive testing."}

## Artifact inventory

${valid.artifacts.map((artifact) => artifactMarkdown(artifact, artifactPrefix)).join("\n") || "No artifacts were recorded."}
`;
}
