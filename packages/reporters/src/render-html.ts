import { ISSUE_SEVERITIES, type ArtifactDescriptor, type TVDoctorIssue, type TVDoctorReportV1 } from "@tvdoctor/protocol";
import { escapeHtml } from "./security.js";
import {
  artifactHref,
  artifactsForIssue,
  availableArtifactPath,
  exhaustedBudgetReasons,
  formatDuration,
  formatRemoteSequence,
  hasDeterministicCliReplay,
  findingActionability,
  issuePatterns,
  issueCounts,
  replayCommand,
  replayTargetOverrideRequired,
  validReport,
} from "./render-helpers.js";

function renderArtifact(artifact: ArtifactDescriptor): string {
  if (artifact.status !== "available") {
    return `<li><code>${escapeHtml(artifact.id)}</code> <span class="status ${artifact.status}">${artifact.status}</span><pre>${escapeHtml(artifact.reason)}</pre></li>`;
  }
  return `<li><a href="${escapeHtml(artifactHref(artifact.path))}"><code>${escapeHtml(artifact.id)}</code></a> <span class="meta">${escapeHtml(artifact.mediaType)} · ${String(artifact.byteLength)} bytes · sha256 ${escapeHtml(artifact.sha256 ?? "unavailable")}</span></li>`;
}

function renderScreenshotPair(issue: TVDoctorIssue, artifacts: readonly ArtifactDescriptor[]): string {
  const before = availableArtifactPath(artifacts, "before-screenshot");
  const after = availableArtifactPath(artifacts, "after-screenshot");
  if (before === null && after === null) return "";
  const image = (label: string, path: string | null): string => path === null
    ? `<div class="shot unavailable">${label} screenshot unavailable</div>`
    : `<figure><img src="${escapeHtml(artifactHref(path))}" alt="${escapeHtml(`${label} evidence for ${issue.id}`)}"><figcaption>${label}</figcaption></figure>`;
  return `<section><h4>Visual evidence</h4><div class="screenshots">${image("Before", before)}${image("After", after)}</div></section>`;
}

function renderTransition(issue: TVDoctorIssue): string {
  if (issue.transition === null) return `<p class="meta">No single transition assertion was available.</p>`;
  return `<table class="transition"><tbody>
    <tr><th>From</th><td><pre>${escapeHtml(issue.transition.fromElement ?? "unobserved")}</pre></td></tr>
    <tr><th>Action</th><td><kbd>${issue.transition.action}</kbd></td></tr>
    <tr><th>Expected</th><td><pre>${escapeHtml(issue.transition.expectedElement ?? "unobserved")}</pre></td></tr>
    <tr><th>Observed</th><td><pre>${escapeHtml(issue.transition.observedElement ?? "unobserved")}</pre></td></tr>
  </tbody></table>`;
}

function renderIssue(report: TVDoctorReportV1, issue: TVDoctorIssue, expanded: boolean): string {
  const artifacts = artifactsForIssue(report, issue);
  const cliReplayable = hasDeterministicCliReplay(report, issue);
  const replayCommandMarkup = cliReplayable
    ? `${replayTargetOverrideRequired(report)
      ? "<p class=\"status unavailable\"><strong>Original target required:</strong> Query or fragment data was redacted from this report. Supply the original authorised URL explicitly; replay refuses to run without it.</p>"
      : ""}<p><strong>Replay command:</strong> <code>${escapeHtml(replayCommand(report, issue.id))}</code></p>`
    : "<p><strong>Deterministic replay required.</strong> The recorded sequence and evidence remain available, but the CLI rejects best-effort or otherwise non-deterministic reproductions; no replay command is shown.</p>";
  const reproduction = issue.reproduction.status === "available"
    ? `<p><strong>Reset:</strong> ${escapeHtml(issue.reproduction.resetStrategy)} · <strong>Confidence:</strong> ${escapeHtml(issue.reproduction.confidence)}</p><p><strong>Recorded original sequence:</strong></p><pre>${formatRemoteSequence(issue.reproduction.originalSequence)}</pre>${issue.reproduction.minimizedSequence === null ? "" : `<p><strong>Recorded minimized candidate (not executed by the M5 replay command):</strong></p><pre>${formatRemoteSequence(issue.reproduction.minimizedSequence)}</pre>`}${replayCommandMarkup}`
    : `<p class="status unavailable">Unavailable</p><pre>${escapeHtml(issue.reproduction.reason)}</pre>`;
  const reproductionHeading = issue.reproduction.status !== "available"
    ? "Reproduction"
    : cliReplayable
      ? "Exact reproduction"
      : "Best-effort reproduction";
  return `<details class="issue severity-${issue.severity}" id="${escapeHtml(issue.id)}"${expanded ? " open" : ""}>
    <summary><span class="badge severity">${issue.severity.toUpperCase()}</span><span>${escapeHtml(issue.title)}</span><span class="badge confidence">${issue.confidence.toUpperCase()}</span></summary>
    <div class="issue-body">
      <section><h4>Problem</h4><pre>${escapeHtml(issue.description)}</pre></section>
      <div class="expected-observed"><section><h4>Expected</h4><pre>${escapeHtml(issue.expected)}</pre></section><section><h4>Observed</h4><pre>${escapeHtml(issue.observed)}</pre></section></div>
      <section><h4>${reproductionHeading}</h4>${reproduction}</section>
      ${renderScreenshotPair(issue, artifacts)}
      <details class="technical-details"><summary>Technical details and evidence</summary><div class="technical-body">
        <dl><dt>Issue ID</dt><dd><code>${escapeHtml(issue.id)}</code></dd><dt>Rule</dt><dd><code>${escapeHtml(issue.rule)}</code></dd><dt>Pack</dt><dd>${escapeHtml(issue.pack)}</dd><dt>Screen</dt><dd><pre>${escapeHtml(issue.screen ?? "unobserved")}</pre></dd></dl>
        <section><h4>Navigation transition</h4>${renderTransition(issue)}</section>
        <section><h4>Runtime evidence</h4><ul>${issue.evidence.map((evidence) => `<li><strong>${escapeHtml(evidence.kind)}</strong><pre>${escapeHtml(evidence.summary)}</pre><span class="meta">Source: ${escapeHtml(evidence.source ?? "unavailable")}</span></li>`).join("")}</ul></section>
        <section><h4>Artifacts</h4>${artifacts.length === 0 ? "<p class=\"meta\">No artifacts were recorded.</p>" : `<ul>${artifacts.map((artifact) => renderArtifact(artifact)).join("")}</ul>`}</section>
      </div></details>
    </div>
  </details>`;
}

function verdictText(report: TVDoctorReportV1): string {
  if (report.run.status === "failed") return "Scan could not complete";
  const fixNow = report.issues.filter((issue) => findingActionability(issue) === "FIX NOW").length;
  if (report.run.status === "partial") {
    return `${String(report.issues.length)} ${report.issues.length === 1 ? "finding" : "findings"}, but the scan was incomplete`;
  }
  if (fixNow > 0) return `${String(fixNow)} ${fixNow === 1 ? "issue needs" : "issues need"} fixing`;
  if (report.issues.length > 0) return `${String(report.issues.length)} ${report.issues.length === 1 ? "finding needs" : "findings need"} review`;
  return "No issues found in the completed coverage";
}

function renderRunWarning(report: TVDoctorReportV1): string {
  if (report.run.status === "failed") {
    const failure = report.target.environment["failure"]
      ?? "The browser session could not complete the requested scan.";
    return `<aside class="run-warning" role="alert"><h2>Scan could not complete</h2><p>${escapeHtml(failure)}</p><p>This is a run failure, not evidence that the target passed.</p></aside>`;
  }
  if (report.run.status !== "partial") return "";
  const packReasons = report.coverage.packs
    .filter((pack) => pack.status !== "completed")
    .map((pack) => `${pack.pack}: ${pack.status}`);
  const budgetReasons = exhaustedBudgetReasons(report);
  const reasons = [...packReasons, ...budgetReasons];
  return `<aside class="run-warning" role="alert"><h2>Inconclusive — partial run</h2><p>This report describes only the coverage that completed. Do not interpret absent findings as a pass.</p><p><strong>Recorded reasons:</strong> ${reasons.length === 0 ? "The run ended before all requested coverage completed; no more-specific reason was recorded." : reasons.map((reason) => escapeHtml(reason)).join(" · ")}</p></aside>`;
}

function renderNextAction(report: TVDoctorReportV1): string {
  if (report.run.status === "failed") {
    return "Resolve the recorded run failure, then run the scan again.";
  }
  if (report.run.status === "partial") {
    return "Resolve the recorded blocker or exhausted budget, then run the scan again.";
  }
  const fixNow = report.issues.find((issue) => findingActionability(issue) === "FIX NOW");
  if (fixNow !== undefined) {
    return `Fix the first deterministic finding: <a href="#${escapeHtml(fixNow.id)}">${escapeHtml(fixNow.title)}</a>.`;
  }
  const firstFinding = report.issues[0];
  if (firstFinding !== undefined) {
    return `Review the first finding: <a href="#${escapeHtml(firstFinding.id)}">${escapeHtml(firstFinding.title)}</a>.`;
  }
  return "Complete the real-TV hardware checks before release.";
}

function renderConfidencePanel(report: TVDoctorReportV1): string {
  const completedPacks = report.coverage.packs
    .filter((pack) => pack.status === "completed")
    .map((pack) => pack.pack);
  const automatedProof = completedPacks.length === 0
    ? "No automated pack completed."
    : `Completed automated checks: ${completedPacks.map((pack) => escapeHtml(pack)).join(", ")}.`;
  return `<section class="confidence-panel" aria-label="Scan confidence and next action">
    <div><h2>What this scan proved</h2><p>${automatedProof}</p><p class="meta">This statement covers only the recorded automated observations and does not certify a TV model or operating system.</p></div>
    <div><h2>Still verify on real TV hardware</h2><ul><li>D-pad reachability and visible focus on every supported device</li><li>screen reader announcements, including TalkBack or VoiceView</li><li>text scaling and readability at normal viewing distance</li><li>captions and audio-description preferences</li><li>autoplay and playback interruptions, including pause, resume, and audio focus</li><li>launch, navigation, and playback performance on representative hardware</li></ul></div>
    <div class="next-action"><h2>Next action</h2><p>${renderNextAction(report)}</p></div>
  </section>`;
}

export function renderReportHtml(report: TVDoctorReportV1): string {
  const valid = validReport(report);
  const counts = issueCounts(valid);
  const environmentRows = Object.entries(valid.target.environment)
    .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td><pre>${escapeHtml(value)}</pre></td></tr>`)
    .join("");
  const actionGroups = [
    ["FIX NOW", "Deterministic findings that should be addressed first"],
    ["REVIEW", "Heuristic or lower-confidence findings for human triage"],
    ["SETUP / INFO", "Setup context and informational observations"],
  ] as const;
  const severitySections = actionGroups.map(([label, description]) => {
    const issues = valid.issues.filter((issue) => findingActionability(issue) === label);
    if (issues.length === 0) return "";
    return `<section class="issue-group"><h2>${label}</h2><p class="meta">${description}</p>${issues.map((issue, index) => renderIssue(valid, issue, label === "FIX NOW" && index === 0)).join("")}</section>`;
  }).join("");
  const packRows = valid.coverage.packs.length === 0
    ? "<tr><td colspan=\"2\">No packs were assessed.</td></tr>"
    : valid.coverage.packs.map((pack) => `<tr><th>${escapeHtml(pack.pack)}</th><td>${escapeHtml(pack.status)}</td></tr>`).join("");
  const nonZeroSeverities = ISSUE_SEVERITIES.filter((severity) => (counts[severity] ?? 0) > 0);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <title>TVDoctor Report</title>
  <style>
    :root{color-scheme:dark;--bg:#0a0f1b;--panel:#121a2b;--panel2:#19233a;--text:#f3f6ff;--muted:#9dabca;--line:#2a3857;--accent:#64e0c1;--critical:#ff667a;--high:#ff9d62;--medium:#ffd166;--low:#6fb5ff;--info:#a9b8d6}*{box-sizing:border-box;min-width:0}body{margin:0;background:linear-gradient(135deg,#080d17,#111a2c);color:var(--text);font:16px/1.5 system-ui,sans-serif}main{width:min(1000px,calc(100% - 32px));margin:0 auto;padding:42px 0 80px}header{padding:28px;border:1px solid var(--line);border-radius:18px;background:rgba(18,26,43,.94)}h1{margin:0;font-size:1rem;color:var(--muted);letter-spacing:.06em;text-transform:uppercase}h2{margin-top:36px}h3,h4{margin-bottom:8px}.tagline,.meta{color:var(--muted)}.verdict{margin:.35rem 0 0;font-size:clamp(1.8rem,5vw,3rem);line-height:1.1}.severity-summary{display:flex;gap:8px;flex-wrap:wrap;margin-top:18px}.metric{padding:6px 10px;border:1px solid var(--line);border-radius:999px;background:var(--panel2)}.metric strong{margin-right:5px}.run-warning{margin-top:18px;padding:18px 22px;border:2px solid var(--medium);border-radius:14px;background:#352d18}.run-warning h2{margin:0;color:#ffe59a}.run-warning p:last-child{margin-bottom:0}.confidence-panel{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;margin-top:18px;padding:18px;border:1px solid var(--line);border-radius:14px;background:var(--panel)}.confidence-panel h2{margin:0;font-size:1.05rem}.confidence-panel p,.confidence-panel ul{margin-bottom:0}.confidence-panel .next-action{border-left:4px solid var(--accent);padding-left:14px}.panels{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;margin:12px 0 18px}.panel{padding:18px;border:1px solid var(--line);border-radius:14px;background:var(--panel)}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{text-align:left;vertical-align:top;padding:8px;border-bottom:1px solid var(--line);overflow-wrap:anywhere}th{color:var(--muted);width:34%}pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;font:inherit}code,kbd{font-family:ui-monospace,monospace}code,a,.meta,dd,li,summary span{overflow-wrap:anywhere;word-break:break-word}kbd{padding:3px 8px;border:1px solid var(--line);border-radius:6px;background:#050913}ul{padding-left:1.35rem}.issue summary:focus-visible,.technical-details summary:focus-visible,.scan-details>summary:focus-visible,.artifact-inventory>summary:focus-visible{outline:3px solid var(--accent);outline-offset:2px}.issue{margin:12px 0;border:1px solid var(--line);border-left:5px solid var(--info);border-radius:12px;background:var(--panel)}.severity-critical{border-left-color:var(--critical)}.severity-high{border-left-color:var(--high)}.severity-medium{border-left-color:var(--medium)}.severity-low{border-left-color:var(--low)}summary{display:flex;align-items:center;gap:10px;cursor:pointer;padding:16px}.issue-body{padding:4px 20px 22px;overflow-wrap:anywhere}.badge{padding:3px 7px;border-radius:999px;font-size:.72rem;font-weight:750;letter-spacing:.04em}.badge.severity{background:#342438}.badge.confidence{margin-left:auto;background:#183848;color:var(--accent)}dl{display:grid;grid-template-columns:110px minmax(0,1fr);gap:6px 12px}dt{color:var(--muted)}dd{margin:0}.expected-observed,.screenshots{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px}.expected-observed section,figure,.shot{padding:14px;border:1px solid var(--line);border-radius:10px;background:#0c1322}figure{margin:0}img{display:block;width:100%;height:auto;border-radius:8px}figcaption{padding-top:8px;color:var(--muted)}a{color:var(--accent)}.status.failed{color:var(--critical)}.status.unavailable{color:var(--medium)}.technical-details,.scan-details,.artifact-inventory{margin-top:18px;border:1px solid var(--line);border-radius:12px;background:#0c1322}.technical-details>summary,.scan-details>summary,.artifact-inventory>summary{font-weight:700}.technical-body,.scan-body,.artifact-body{padding:0 18px 18px}.supporting{margin-top:14px;color:var(--muted);font-size:.92rem}@media(max-width:680px){main{width:calc(100% - 20px);padding-top:18px}header{padding:18px}.panels,.expected-observed,.screenshots{grid-template-columns:minmax(0,1fr)}summary{align-items:flex-start;flex-wrap:wrap}.badge.confidence{margin-left:0}.issue-body{padding-left:14px;padding-right:14px}dl{grid-template-columns:88px minmax(0,1fr)}.confidence-panel .next-action{border-left:0;border-top:4px solid var(--accent);padding:14px 0 0}}
  </style>
</head>
<body><main>
  <header><h1>TVDoctor</h1><p class="verdict">${escapeHtml(verdictText(valid))}</p><p class="tagline">Start with the findings below. Each one includes what happened, what should happen, and how to reproduce it.</p>
    <div class="severity-summary">
      ${nonZeroSeverities.map((severity) => `<span class="metric"><strong>${String(counts[severity] ?? 0)}</strong>${severity.toUpperCase()}</span>`).join("") || '<span class="metric"><strong>0</strong> findings</span>'}
    </div>
  </header>
  ${renderRunWarning(valid)}
  ${renderConfidencePanel(valid)}
  ${(() => {
    const patterns = issuePatterns(valid);
    return patterns.length === 0 ? "" : `<section><h2>Repeated patterns</h2><ul>${patterns.map((pattern) => `<li><strong>${escapeHtml(pattern.label)}</strong> — ${String(pattern.count)} related findings across ${String(pattern.stateCount)} screen(s); ${pattern.issueIds.map((id) => `<a href="#${escapeHtml(id)}"><code>${escapeHtml(id)}</code></a>`).join(", ")}</li>`).join("")}</ul></section>`;
  })()}
  ${severitySections || "<section><h2>No findings</h2><p>No issues were reported for the observed coverage. This is not a claim of exhaustive testing.</p></section>"}
  <details class="scan-details"><summary>Scan details</summary><div class="scan-body"><div class="panels">
    <section class="panel"><h2>Run</h2><table><tbody><tr><th>ID</th><td><code>${escapeHtml(valid.run.id)}</code></td></tr><tr><th>Status</th><td>${escapeHtml(valid.run.status)}</td></tr><tr><th>Mode</th><td>${escapeHtml(valid.run.mode)}</td></tr><tr><th>Duration</th><td>${formatDuration(valid.run.durationMs)}</td></tr><tr><th>Started</th><td>${escapeHtml(valid.run.startedAt)}</td></tr></tbody></table></section>
    <section class="panel"><h2>Target</h2><table><tbody><tr><th>Name</th><td><pre>${escapeHtml(valid.target.name)}</pre></td></tr><tr><th>Platform</th><td>${escapeHtml(valid.target.platform)}</td></tr><tr><th>Location</th><td><pre>${escapeHtml(valid.target.location)}</pre></td></tr>${environmentRows}</tbody></table></section>
    <section class="panel"><h2>Coverage</h2><table><tbody><tr><th>Screens</th><td>${String(valid.coverage.screenStatesDiscovered)}</td></tr><tr><th>Focus targets</th><td>${String(valid.coverage.focusStatesDiscovered)}</td></tr><tr><th>Transitions</th><td>${String(valid.coverage.transitionsTested)}</td></tr><tr><th>Actions</th><td>${String(valid.coverage.actionsSent)}</td></tr><tr><th>Exhausted budgets</th><td>${escapeHtml(exhaustedBudgetReasons(valid).join(" ") || "none")}</td></tr></tbody></table></section>
    <section class="panel"><h2>Pack coverage</h2><table><tbody>${packRows}</tbody></table></section>
  </div></div></details>
  <details class="artifact-inventory"><summary>Artifact inventory</summary><div class="artifact-body">${valid.artifacts.length === 0 ? "<p>No artifacts were recorded.</p>" : `<ul>${valid.artifacts.map((artifact) => renderArtifact(artifact)).join("")}</ul>`}</div></details>
  <p class="supporting">Supporting exports and machine data remain in this bundle for CI, replay, sharing, and coding tools.</p>
</main></body></html>
`;
}
