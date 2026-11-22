import { ISSUE_SEVERITIES, type TVDoctorIssue, type TVDoctorReportV1 } from "@tvdoctor/protocol";
import { escapeHtml } from "./security.js";
import {
  findingActionability,
  hasDeterministicCliReplay,
  replayTargetOverrideRequired,
} from "./render-helpers.js";

/**
 * Safe, static first-run instructions in every keyboard check's report.html.
 * The report is observation data, not an instruction source. Never imply that
 * a stored replay has already been re-executed or that scan coverage is global.
 */
const INDEPENDENTLY_VERIFIABLE_KEYBOARD_RULES = new Set([
  "keyboard.modal-focus-escape",
  "keyboard.modal-tab-focus-loss",
  "keyboard.modal-open-focus-not-transferred",
]);

function code(command: string): string {
  return `<pre class="handoff-command"><code>${escapeHtml(command)}</code></pre>`;
}

function originalUrlOption(report: TVDoctorReportV1): string {
  return replayTargetOverrideRequired(report) ? ' --target "REPLACE_WITH_ORIGINAL_AUTHORIZED_URL"' : "";
}

function journeyOption(report: TVDoctorReportV1): string {
  return report.target.environment["journeyConfigSha256"] === undefined
    ? ""
    : ' --journey "REPLACE_WITH_ORIGINAL_JOURNEY_JSON"';
}

function firstReproducibleFinding(report: TVDoctorReportV1): TVDoctorIssue | undefined {
  return [...report.issues]
    .filter((issue) => findingActionability(issue) === "VERIFIED" && hasDeterministicCliReplay(report, issue))
    .sort((left, right) => ISSUE_SEVERITIES.indexOf(left.severity) - ISSUE_SEVERITIES.indexOf(right.severity)
      || left.id.localeCompare(right.id))[0];
}

export function renderDeveloperHandoff(report: TVDoctorReportV1): string {
  // The historical TV/remote report flow remains unchanged. This is shown
  // only for the keyboard scanner behind the public 'tvdoctor check' workflow.
  if (report.target.platform !== "web" || report.target.environment["inputMode"] !== "keyboard") return "";
  const offline = code("tvdoctor findings --report report.json");
  const introduction = '<p class="meta">Commands run locally from the folder containing report.html and report.json. Review the target and authorise browser navigation before replay or verification.</p>';
  const coverage = '<p class="meta">A completed bounded scan is not a guarantee that the entire website, every journey, or every viewport is bug-free.</p>';
  if (report.run.status !== "completed"
    || report.coverage.packs.some((pack) => pack.status !== "completed")
    || report.coverage.budget.exhausted.length > 0) {
    return `<section class="developer-handoff" aria-label="Developer next steps">
      <h2>Next steps: finish the audit</h2>
      <p><strong>INCONCLUSIVE.</strong> The scan did not complete all recorded checks. Findings may be useful leads, but missing findings are not proof of a fix or a pass.</p>
      <ol><li>Inspect the recorded evidence and incomplete coverage.${offline}</li>
      <li>Resolve blockers or increase bounded scanning budgets, then run <code>tvdoctor check</code> again against the authorised target.</li></ol>
      ${introduction}
    </section>`;
  }

  const first = firstReproducibleFinding(report);
  if (first === undefined) {
    const manual = report.issues.some((issue) => findingActionability(issue) === "REVIEW");
    return `<section class="developer-handoff" aria-label="Developer next steps">
      <h2>${manual ? "Next steps: review the findings" : "Next steps: extend your coverage"}</h2>
      <p>${manual
        ? "These observations need human confirmation. No independently verified failure is available for an automated fix command."
        : "No independently verified keyboard failure was recorded within the completed, bounded coverage."}</p>
      <ol><li>Inspect the saved evidence and exact issue IDs.${offline}</li>
      <li>Test unobserved workflows, authenticated routes, and relevant viewports before relying on the result.</li></ol>
      ${coverage}
    </section>`;
  }

  const target = originalUrlOption(report);
  const journey = journeyOption(report);
  const commandTail = ` --report report.json${target}${journey}`;
  const replay = code(`tvdoctor replay ${first.id}${commandTail}`);
  const canVerify = first.pack === "navigation"
    && INDEPENDENTLY_VERIFIABLE_KEYBOARD_RULES.has(first.rule);
  const verify = canVerify
    ? code(`tvdoctor verify-fix ${first.id} --report report.json --authorized${target}${journey}`)
    : "";
  const compare = canVerify
    ? code(`tvdoctor verify-fix ${first.id} --report report.json --authorized${target}${journey} --scan-output "REPLACE_WITH_NEW_DIRECTORY" --compare`)
    : "";
  const optionsWarning = `${target.length === 0 ? "" : '<p class="meta">The original URL was redacted. Replace the URL placeholder with the exact original authorised target; do not paste credentials into the report.</p>'}
    ${journey.length === 0 ? "" : '<p class="meta">This audit used a custom journey. Supply the exact original journey JSON and its environment variables. No secret values are stored in this handoff.</p>'}`;
  return `<section class="developer-handoff" aria-label="Developer next steps">
    <h2>Start here: reproduce and fix a keyboard failure</h2>
    <p><strong>VERIFIED original observation:</strong> <a href="#${escapeHtml(first.id)}">${escapeHtml(first.title)}</a>
      <span class="meta">(${escapeHtml(first.severity.toUpperCase())} · ${escapeHtml(first.id)})</span></p>
    <div class="handoff-difference">
      <div><h3>Expected</h3><p>${escapeHtml(first.expected)}</p></div>
      <div><h3>Observed</h3><p>${escapeHtml(first.observed)}</p></div>
    </div>
    <ol>
      <li><strong>Inspect the evidence</strong> in <a href="#${escapeHtml(first.id)}">this finding</a> or the offline triage summary.${offline}</li>
      <li><strong>Reproduce the original failure</strong> against an authorised target.${replay}
        <p class="meta">This is a recorded deterministic replay, not a fresh confirmation. If the browser state differs, the CLI can return INCONCLUSIVE.</p></li>
      <li><strong>Make a code change, then independently verify the same issue.</strong>
        ${canVerify ? `${verify}<p class="meta">The CLI checks a rule-specific positive fix predicate. FIXED, REPRODUCED, and INCONCLUSIVE are distinct outcomes; a missing finding alone is not FIXED.</p>`
          : '<p>The independent verify-fix command is not supported for this rule. Confirm the expected behavior manually and run a fresh audit.</p>'}</li>
      <li><strong>Check for regressions.</strong>
        ${canVerify ? `${compare}<p class="meta">Use a new output directory and the same scan conditions and budgets. A partial or non-comparable inventory must remain INCONCLUSIVE, even if the original replay is FIXED.</p>`
          : '<p>Run a new bounded audit with the same conditions. Only comparable, completed evidence can support a broader regression check.</p>'}</li>
    </ol>
    ${optionsWarning}${introduction}${coverage}
  </section>`;
}
