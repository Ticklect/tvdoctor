import type { SpaJourneyResult } from "./spa-journey.js";

function escapeHtml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&#39;");
}

function shortIdentity(value: string): string {
  return escapeHtml(value.slice(0, 16));
}

/** A standalone, script-free, privacy-minded viewer for bounded SPA observations. */
export function renderSpaJourneyGraph(result: SpaJourneyResult): string {
  const statePositions = new Map(result.states.map((state, i) => [state.id, i]));
  const states = result.states.map((state, index) => {
    const outgoing = result.edges.filter((edge) => edge.from === state.id);
    const visited = outgoing.filter((edge) => edge.status === "observed").length;
    const pending = outgoing.filter((edge) => edge.status !== "observed").length;
    return `<a id="state-${String(index + 1)}" class="state" href="#edges">
      <span class="eyebrow">STATE ${String(index + 1).padStart(2, "0")} · DEPTH ${String(state.depth)}</span>
      <strong>${shortIdentity(state.id)}</strong>
      <span>Route fingerprint ${shortIdentity(state.routeIdentity)}</span>
      <span>${String(visited)} observed · ${String(pending)} deferred/blocked · ${String(state.replay.length)} replay steps</span>
    </a>`;
  }).join("\n");
  const edges = result.edges.map((edge, index) => {
    const from = statePositions.get(edge.from);
    const to = edge.to === null ? undefined : statePositions.get(edge.to);
    const fromLabel = from === undefined ? "Unknown" : `State ${String(from + 1).padStart(2, "0")}`;
    const toLabel = to === undefined ? "Not observed" : `State ${String(to + 1).padStart(2, "0")}`;
    const fromLink = from === undefined ? fromLabel : `<a href="#state-${String(from + 1)}">${fromLabel}</a>`;
    const toLink = to === undefined ? toLabel : `<a href="#state-${String(to + 1)}">${toLabel}</a>`;
    return `<tr><td>${String(index + 1)}</td><td>${fromLink}</td><td>${toLink}</td>
      <td>${escapeHtml(edge.kind)}</td><td>${escapeHtml(edge.status)}</td><td>${String(edge.replay.length)}</td>
      <td>${edge.reason === null ? "—" : escapeHtml(edge.reason.slice(0, 100))}</td></tr>`;
  }).join("\n");
  const reviewLeads = result.issues.slice(0, 40).map((issue, index) => {
    const edge = result.edges[issue.edgeIndex];
    const state = statePositions.get(issue.stateId);
    const sequence = edge?.replay ?? [];
    const steps = sequence.slice(0, 16).map((step, number) =>
      `<li>Step ${String(number + 1)}: ${escapeHtml(step.kind)} on candidate ${String(step.index + 1)}
      (fingerprint ${shortIdentity(step.targetFingerprint)}), then verify checkpoint ${shortIdentity(step.checkpoint)}</li>`).join("");
    const interrupted = issue.rule === "spa.history-back-interrupted-stale-view";
    const history = issue.rule === "spa.history-back-stale-view" || interrupted ? issue.historyBack : undefined;
    const runtime = issue.runtimeEvent;
    const missingContent = issue.rule === "spa.route-content-missing";
    const title = runtime !== undefined ? runtime.kind === "http-response"
      ? "observed HTTP response error during SPA action"
      : runtime.kind === "request-failed" ? "observed network failure during SPA action"
        : "observed browser runtime error during SPA action"
      : missingContent ? "possible missing content after client-side route change"
      : history === undefined ? "possible expanded-panel mismatch"
        : interrupted ? "possible stale view after two interrupted browser Backs" : "possible stale view after browser Back";
    const expectedScreenshot = `evidence/${interrupted ? "back-interrupted-edge" : "back-edge"}-${String(issue.edgeIndex + 1).padStart(3, "0")}.png`;
    const screenshotPath = history?.screenshot?.path === expectedScreenshot
      ? history.screenshot.path : null;
    const screenshotLink = screenshotPath === null ? ""
      : `<p><a href="${escapeHtml(screenshotPath)}">Open private PNG captured after browser Back</a>
      (SHA-256 ${escapeHtml(history?.screenshot?.sha256 ?? "")}). This image is not an independently verified replay or video.</p>`;
    const verification = issue.verification;
    const verificationNote = verification === undefined ? ""
      : `<p><strong>Fresh Chromium-context replay: ${escapeHtml(verification.status)}</strong>
      (${escapeHtml(verification.reason)}). ${String(verification.replayStepsVerified)} exact checkpoints,
      ${String(verification.actions)} additional action(s), ${String(verification.durationMs)} ms.
      Public witness fingerprint ${shortIdentity(verification.fingerprint)}.
      The repeated observation still requires human review; it is not a proven defect,
      and repeating safe-looking actions can change page or server state.</p>`;
    const observation = runtime !== undefined
      ? `Chromium observed ${escapeHtml(runtime.kind)} while testing the selected forward action and settling the resulting view.
      ${runtime.httpStatus === undefined ? "" : `HTTP ${String(runtime.httpStatus)}.`}
      ${runtime.resourceType === undefined ? "" : `Resource type ${escapeHtml(runtime.resourceType)}.`}
      The event was associated with an observed state transition, but timing alone does not prove that the action caused the error.
      The error text, stack, request URL and response body were deliberately not retained.
      This is a bounded review lead, not a deterministic replay or site-wide error audit.`
      : missingContent
      ? "After a same-document client-side navigation, the settled destination had no substantive visible main content despite the source view containing content. This is only a possible missing-content lead: the destination might intentionally be empty. Confirm the expected view and hydration timing manually. A repaired HTTP 200 or a later nonempty main is not independent FIXED proof. No page text or destination URL was retained."
      : history === undefined
      ? "An observed button/panel visibility disagreement occurred after the recorded action. Recheck aria-expanded and controlled-panel visibility manually. It may be intentional or transitional."
      : `A separately observed ${interrupted ? "rapid pair of genuine browser Back actions" : "browser Back action"} returned to route ${shortIdentity(history.expectedRouteIdentity)}
      after ${String(history.settledSamples)} bounded settling samples, but the heading still matched the ${interrupted ? "intermediate" : "forward"} route. The returned view fingerprint was
      ${shortIdentity(history.observedStateId)}; expected source fingerprint ${shortIdentity(history.expectedStateId)}.
      This is observed heuristic evidence, not a deterministic regression test. Recheck the authorised live SPA.`;
    return `<article class="issue"><h3>Review lead ${String(index + 1)}: ${title}</h3>
      <p>Rule ${escapeHtml(issue.rule)} · <strong>Heuristic, human review required</strong> ·
      ${state === undefined ? "Unlinked state" : `<a href="#state-${String(state + 1)}">State ${String(state + 1)}</a>`} ·
      Edge ${String(issue.edgeIndex + 1)}</p>
      <p>${observation}</p>${screenshotLink}${verificationNote}<p>Recorded forward navigation checkpoints (not a replay of browser Back):</p>
      <ol>${steps || "<li>No reproducible action sequence was retained.</li>"}${history === undefined ? ""
    : interrupted
      ? "<li>Then two rapid Chromium browser Backs were independently observed during this scan, returning through the intermediate route; neither Back is a verified forward replay edge.</li>"
      : "<li>Then browser Back was independently observed during this scan; return state was not added as a verified forward graph edge.</li>"}</ol></article>`;
  }).join("\n");
  const reasons = result.terminationReasons.length === 0
    ? "No known bound exhausted in the explored frontier"
    : result.terminationReasons.map((reason) => escapeHtml(reason.slice(0, 80))).join(", ");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <title>TVDoctor SPA journey graph</title><style>
  :root{font:14px system-ui,-apple-system,Segoe UI,sans-serif;background:#f4f7fb;color:#142641}
  *{box-sizing:border-box}body{margin:0}header{background:#11243e;color:white;padding:34px max(22px,calc((100vw - 1050px)/2))}
  h1{font-size:clamp(28px,4vw,42px);margin:10px 0}header p{max-width:810px;line-height:1.65;color:#cdd8e8}
  main{max-width:1090px;margin:auto;padding:20px 22px 70px}h2{font-size:21px;margin:25px 0 14px}
  .metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:12px;margin:20px 0}
  .metrics div{background:white;border:1px solid #dfe5ef;border-radius:10px;padding:16px;display:flex;flex-direction:column;gap:8px}
  .metrics strong{font-size:25px}.metrics span,.eyebrow{font-size:11px;color:#62718b;letter-spacing:.03em}
  .states{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
  .state{display:flex;flex-direction:column;gap:9px;color:inherit;text-decoration:none;border:1px solid #dbe3ef;border-radius:10px;background:white;padding:17px;min-width:0}
  .state strong{font-size:17px;overflow-wrap:anywhere}.state span{overflow-wrap:anywhere}
  .state:focus-visible,.state:hover{outline:2px solid #2861aa}
  .issue{background:white;border:1px solid #dfdfed;border-left:4px solid #e0a942;padding:14px 20px;margin:14px 0;border-radius:8px}
  .issue strong{font-size:inherit}.issue ol{line-height:1.8;overflow-wrap:anywhere}
  .table{overflow:auto;border:1px solid #dfe5ef;border-radius:10px}table{border-collapse:collapse;width:100%;background:white;min-width:690px}
  td,th{padding:11px 12px;text-align:left;border-bottom:1px solid #edf0f5;font-size:12px}th{background:#ebf0f7}
  a{color:#1658ae}.note{border-left:3px solid #4c77b7;background:#e7eef9;padding:13px 18px;line-height:1.7}
  </style></head><body><header><small>TVDOCTOR / EXPERIMENTAL CLIENT-SIDE EXPLORATION</small>
  <h1>UI state journey graph</h1><p>Each state and interaction was observed through a bounded, safety-allowlisted Chromium traversal. IDs are opaque fingerprints. These edges do not certify all navigation or inaccessible controls.</p></header>
  <main><div class="metrics"><div><strong>${escapeHtml(result.status.toUpperCase())}</strong><span>Frontier status</span></div>
  <div><strong>${String(result.states.length)}</strong><span>Observed states</span></div>
  <div><strong>${String(result.edges.filter((edge) => edge.status === "observed").length)}</strong><span>Observed transitions</span></div>
  <div><strong>${String(result.deferred.length)}</strong><span>Deferred candidates</span></div>
  <div><strong>${String(result.actionsUsed)}</strong><span>Physical actions (incl. replay)</span></div>
  <div><strong>${String(result.issues.length)}</strong><span>Heuristic review leads</span></div></div>
  <p>${String(result.issues.filter((issue) => issue.verification?.status === "reobserved").length)}
  review lead(s) re-observed during separately opted-in, bounded fresh browser-context replay.
  Replay does not upgrade confidence to deterministic and cannot guarantee side-effect-free behaviour.</p>
  <section><h2>Visited states</h2><div class="states">${states || "No states observed."}</div></section>
  <section id="edges"><h2>Navigation transitions</h2><div class="table"><table><thead><tr>
  <th>#</th><th>From</th><th>To</th><th>Control type</th><th>Status</th><th>Replay steps</th><th>Unvisited reason</th>
  </tr></thead><tbody>${edges || '<tr><td colspan="7">No transitions observed.</td></tr>'}</tbody></table></div></section>
  <section id="issues"><h2>Review leads and reproduction checkpoints</h2>
  <p>Reproduction steps are relative to the original launch route; candidate numbers and fingerprints are observations, not stable CSS selectors. No automatic fix or accessible-state certification is claimed.</p>
  ${reviewLeads || "<p>No SPA inconsistency review leads observed in this bounded run.</p>"}</section>
  <section class="note"><h2>Replay and coverage limits</h2><p>${reasons}. A replay sequence records selected actions and verified intermediate checkpoints; reproduction can fail later if the site changes or behaves nondeterministically.</p>
  <p>${String(result.unsafeRequestsBlocked)} network request(s) were blocked by policy, ${String(result.unsafeCandidatesSkipped)} controls skipped, ${String(result.driftCount)} checkpoint drift(s). No arbitrary form submits or destructive actions were authorised. Any unexpected behaviour should be reviewed before claiming a bug.</p>
  <p><a href="spa-journey.json">Inspect machine-readable edge and replay evidence</a>. Review locally before sharing screenshots or other stored data.</p></section></main></body></html>\n`;
}
