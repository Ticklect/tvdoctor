/** The UI is delivered as a single self-contained document; no remote assets or CDN requests. */
export function renderLocalUiPage(csrfToken: string, qaAvailable = false, projectAvailable = false,
  routeHealthAvailable = false, spaRouteHealthAvailable = false, bootHealthAvailable = false): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0c1620">
  <meta name="tvdoctor-csrf" content="${csrfToken}">
  <title>TVDoctor · Agent QA</title>
  <style nonce="${csrfToken}">
    :root { color-scheme: dark; font: 16px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0c1620; color: #e8f1f3; font-synthesis: none; }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 300px; }
    .shell { max-width: 1100px; margin: 0 auto; padding: 32px 28px 70px; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 0 0 34px;
      border-bottom: 1px solid #283944; }
    .brand { display: flex; align-items: center; gap: 12px; font-weight: 750; letter-spacing: -.5px; font-size: 23px; }
    .mark { background: #58e5b4; color: #10251e; width: 38px; height: 38px; display: grid; place-items: center;
      border-radius: 11px; font-size: 20px; font-weight: 900; }
    .local { color: #98b1bc; display: flex; align-items: center; gap: 8px; font-size: 13px; }
    .dot { width: 8px; height: 8px; background: #58e5b4; border-radius: 50%; box-shadow: 0 0 0 4px #58e5b41e; }
    main { padding-top: 58px; }
    .eyebrow { color: #65ebbf; text-transform: uppercase; letter-spacing: 2px; font-size: 12px; font-weight: 800; }
    h1 { font-size: clamp(36px, 5.6vw, 64px); letter-spacing: -2.3px; line-height: 1.1; margin: 15px 0 18px;
      max-width: 750px; }
    .intro { color: #aac0c9; max-width: 680px; margin: 0 0 29px; font-size: 17px; }
    .agent-workflow { margin: 0 0 28px; padding: 24px; border: 1px solid #4c7778; border-radius: 20px;
      background: linear-gradient(135deg, #19323b, #14232e 68%); }
    .agent-heading { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px 18px; }
    .agent-heading .section-title { margin: 0; }
    .agent-heading a { color: #a5f2da; font-size: 14px; text-underline-offset: 4px; }
    .agent-steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; list-style: none;
      padding: 0; margin: 18px 0; }
    .agent-steps li { border-top: 2px solid #59bfaa; background: #10232d; border-radius: 0 0 10px 10px;
      color: #b8cdd6; font-size: 14px; padding: 12px 14px; overflow-wrap: anywhere; }
    .agent-steps strong { display: block; color: #e8f5f3; font-size: 16px; margin-bottom: 4px; }
    .agent-setup { border-top: 1px solid #365460; color: #b8cdd6; padding: 13px 0 0; font-size: 14px; }
    .agent-setup + .agent-setup { margin-top: 13px; }
    .agent-setup summary { color: #e8f5f3; cursor: pointer; font-weight: 680; }
    .agent-setup summary:focus-visible { outline: 3px solid #58e5b4; outline-offset: 3px; }
    .agent-setup code { color: #b1eedb; }
    .agent-setup pre, .agent-prompt { padding: 12px 14px; background: #0d1b25; border: 1px solid #34515d;
      border-radius: 10px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .agent-prompt { margin: 12px 0; }
    .agent-copy { display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap; }
    .agent-copy button.secondary { margin: 0; min-height: 42px; width: auto; padding: 8px 13px; }
    .layout { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(285px, 1fr); gap: 22px; align-items: start; }
    .panel { background: #14232e; border: 1px solid #2b414c; border-radius: 20px; padding: 29px; min-width: 0; }
    .section-title { margin: 0 0 8px; font-size: 21px; letter-spacing: -.45px; font-weight: 700; }
    .section-desc { color: #9db4c0; font-size: 14px; margin: 0 0 25px; }
    label { display: block; color: #c5d7dd; font-weight: 640; font-size: 13px; margin-bottom: 9px; }
    input[type=url], input[type=number], input[type=text], select, textarea { width: 100%; background: #0d1b25; border: 1px solid #405763; color: #f3f9fb;
      border-radius: 10px; font: inherit; padding: 13px 14px; outline: none; min-height: 50px; }
    input[type=url]:focus-visible, input[type=number]:focus-visible, input[type=text]:focus-visible, select:focus-visible, textarea:focus-visible, button:focus-visible, a:focus-visible,
    input[type=checkbox]:focus-visible { outline: 3px solid #58e5b4; outline-offset: 3px; }
    input::placeholder { color: #788f9a; }
    .fields { display: grid; gap: 22px; }
    .two { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .help { margin: 8px 0 0; color: #8099a6; font-size: 12px; }
    .record { display: flex; align-items: flex-start; gap: 13px; margin-top: 3px; }
    .record input { margin: 4px 0 0; width: 18px; height: 18px; accent-color: #58e5b4; }
    .record label { margin: 0; cursor: pointer; }
    .record span { display: block; color: #9bb2bd; font-weight: 400; font-size: 12px; line-height: 1.5; padding-top: 3px; }
    .problem-first { padding: 17px; border: 1px solid #4c7778; border-radius: 14px; background: #172e37; }
    .problem-first label { font-size: 15px; margin-bottom: 9px; }
    .problem-first .help { font-size: 13px; line-height: 1.5; }
    .expert-workflows { border: 1px solid #354d58; border-radius: 12px; padding: 10px 12px; }
    .expert-workflows > summary { cursor: pointer; font-weight: 650; padding: 5px 0; }
    .expert-workflows .workflow-switch { margin-top: 13px; }
    button { border: 0; border-radius: 11px; background: #63e9bb; padding: 15px 21px; font: inherit;
      color: #09241b; font-weight: 750; cursor: pointer; min-height: 52px; width: 100%; }
    button:hover { background: #8ff1cf; }
    button:disabled { background: #456b61; color: #cee7de; cursor: wait; }
    button.secondary { margin-top: 12px; border: 1px solid #718d94; color: #ddebed; background: transparent; }
    button.secondary:hover { background: #293e46; }
    button.secondary:disabled { color: #839ca4; background: #1a2c35; cursor: wait; }
    [hidden] { display: none !important; }
    .counts { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 14px;
      border-top: 1px solid #304751; padding-top: 16px; margin-top: 14px; }
    .counts strong { display: block; font-size: 20px; font-weight: 760; }
    .counts span { display: block; color: #9bb2bd; font-size: 12px; }
    .status { display: inline-flex; align-items: center; gap: 8px; color: #8fbbc3; font-size: 12px;
      letter-spacing: 1px; text-transform: uppercase; font-weight: 800; }
    .status:before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: #82a5af; }
    .status[data-state=running]:before { background: #f5c970; box-shadow: 0 0 0 4px #f5c9701d; }
    .status[data-state=completed]:before { background: #58e5b4; }
    .status[data-state=partial]:before { background: #f5c970; }
    .status[data-state=cancelling]:before { background: #f5c970; }
    .status[data-state=cancelled]:before { background: #9bb2bd; }
    .status[data-state=failed]:before { background: #ff938f; }
    .status[data-qa-status=ACTION_REQUIRED]:before { background: #ff938f; }
    .status[data-qa-status=REVIEW_REQUIRED]:before { background: #f5c970; }
    .status[data-qa-status=INCONCLUSIVE]:before { background: #f5c970; }
    .status[data-qa-status=REPRODUCED]:before, .status[data-qa-status=REGRESSION_FOUND]:before,
    .status[data-qa-status=ERROR]:before { background: #ff938f; }
    .status[data-qa-status=PASS]:before { background: #58e5b4; }
    .run { margin-top: 25px; border-top: 1px solid #2a404a; padding-top: 25px; }
    .large-number { font-size: 58px; font-weight: 780; letter-spacing: -2px; margin: 4px 0 0; line-height: 1.13; }
    .metric-name { color: #96afba; font-size: 13px; }
    .message { color: #b9cbd2; font-size: 14px; min-height: 42px; margin: 14px 0 0; }
    .links { display: grid; gap: 10px; margin-top: 15px; }
    .links a { border: 1px solid #476857; color: #8ff3d0; border-radius: 10px; padding: 12px 15px;
      text-decoration: none; font-weight: 650; font-size: 14px; }
    .links a:hover { background: #1d3a34; }
    .note { margin-top: 22px; display: flex; gap: 12px; align-items: flex-start; color: #95acb8; font-size: 13px; }
    .triage { margin-top: 25px; border-top: 1px solid #2a404a; padding-top: 24px; }
    .triage h3 { font-size: 17px; letter-spacing: -.3px; margin: 0 0 6px; }
    .triage .muted { color: #95adba; font-size: 12px; margin: 0 0 12px; }
    .triage-intro { border: 1px solid #3d5c67; border-radius: 10px; padding: 12px 14px;
      background: #0e202a; margin: 12px 0 14px; }
    .triage-intro p { margin: 5px 0; font-size: 12px; color: #b5cbd2; line-height: 1.55; }
    .triage-intro strong { color: #e7f6f5; }
    .triage-priority { display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
      margin: 0 0 12px; }
    .triage-priority button { width: auto; min-height: 40px; padding: 9px 13px; font-size: 12px; }
    .triage-priority p { margin: 0; color: #b1c7cf; font-size: 12px; }
    .filter-groups { display: flex; flex-wrap: wrap; gap: 7px; padding: 8px 0 15px; }
    .filter-groups button { width: auto; min-height: 32px; padding: 5px 10px; font-size: 12px;
      background: #1c3340; color: #c8e2e4; border: 1px solid #41606d; }
    .filter-groups button[aria-pressed=true] { background: #71e8bd; color: #09251c; border-color: #71e8bd; }
    .triage-list { display: grid; gap: 9px; max-height: 560px; overflow: auto; }
    .triage-list details { border: 1px solid #324e5a; border-radius: 10px; background: #10212d; overflow: hidden; }
    .triage-list summary { display: grid; gap: 4px; padding: 12px; cursor: pointer; overflow-wrap: anywhere; }
    .triage-list summary:focus-visible { outline: 3px solid #71e8bd; outline-offset: -3px; }
    .triage-list summary strong { font-size: 13px; font-weight: 700; }
    .triage-list summary span, .triage-list p { font-size: 12px; color: #a7bfca; }
    .triage-list details[data-review=review] { border-color: #997c4d; }
    .triage-list details[data-priority=critical], .triage-list details[data-priority=high] { border-left: 3px solid #dd8580; }
    .triage-body { padding: 1px 12px 12px; }
    .triage-body p { margin: 8px 0; overflow-wrap: anywhere; }
    .triage-guidance { display: grid; gap: 9px; margin: 10px 0; }
    .triage-guidance section { border-left: 2px solid #4a6b78; padding: 0 9px; }
    .triage-guidance h4 { font-size: 12px; color: #dbebed; margin: 0; }
    .triage-guidance p { line-height: 1.5; }
    .triage-body a { display: inline-flex; border: 1px solid #496a5e; border-radius: 7px; padding: 7px 10px;
      font-size: 12px; color: #86eec8; text-decoration: none; }
    .triage-body img { display: block; max-width: 100%; max-height: 185px; object-fit: contain;
      background: #091720; border: 1px solid #35515f; border-radius: 8px; margin-top: 10px; }
    .coverage-note { padding: 12px; background: #10212d; border: 1px solid #35505e;
      border-radius: 10px; margin: 0 0 18px; }
    .coverage-note p { margin: 0 0 8px; font-size: 12px; color: #b8d0d9; }
    .coverage-note ul { margin: 5px 0 0; padding-left: 20px; font-size: 12px; color: #b8d0d9; }
    .video-preview { margin-top: 18px; }
    .video-preview video { width: 100%; max-height: 280px; border-radius: 10px; background: #050b0f; }
    .video-preview p { font-size: 12px; color: #a8c2ce; margin: 7px 0 0; }
    .note span { color: #6de6bd; font-weight: 800; }
    .error { color: #ffadab; font-size: 13px; min-height: 18px; margin: 8px 0 0; }
    .workflow-switch { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 10px; margin-bottom: 3px; }
    .workflow-switch.three { grid-template-columns: repeat(3,minmax(0,1fr)); }
    .workflow-switch.four { grid-template-columns: repeat(2,minmax(0,1fr)); }
    .workflow-switch label { display: block; border: 1px solid #405763; border-radius: 13px;
      padding: 14px; margin: 0; cursor: pointer; background: #0d1b25; font-size: 14px; }
    .workflow-switch input { accent-color: #58e5b4; width: 17px; height: 17px; vertical-align: middle; }
    .workflow-switch label:has(input:checked) { border-color: #58e5b4; background: #193a36; }
    .workflow-switch label:has(input:disabled) { opacity: .65; cursor: not-allowed; }
    .workflow-switch small { display: block; font-weight: 400; color: #adc2c9; padding-top: 7px; line-height: 1.5; }
    .workflow-options { display: grid; gap: 20px; }
    .workflow-options .record { margin: 7px 0 0; }
    .qa-summary { margin-top: 20px; padding: 17px; border: 1px solid #3c5964; border-radius: 12px; background: #10212d; }
    .qa-summary h3 { font-size: 16px; margin: 0 0 7px; }
    .qa-summary p { font-size: 12px; color: #aac0ca; margin: 7px 0 12px; }
    .qa-metrics { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 12px; margin: 15px 0; }
    .qa-metrics > div { border: 1px solid #335361; border-radius: 9px; padding: 10px 12px; }
    .qa-metrics dt { color: #b3cbd3; font-size: 12px; }
    .qa-metrics dd { margin: 3px 0 0; font-size: 25px; font-weight: 750; }
    .qa-metrics .verified { border-color: #bb716c; }
    .qa-metrics .review { border-color: #ba9857; }
    .qa-metrics .untested { border-color: #7b8ca6; }
    .qa-summary .next-step { border-top: 1px solid #355261; padding-top: 12px; margin-bottom: 0; }
    .qa-summary .secondary { margin: 12px 0 0; width: 100%; text-align: left; }
    .project-route-editor { display: grid; gap: 12px; }
    .project-route { padding: 16px; background: #0d1b25; border: 1px solid #3b5563; border-radius: 12px; }
    .project-route header { border: 0; padding: 0 0 12px; display: flex; align-items: center; justify-content: space-between; }
    .project-route header strong { font-size: 14px; }
    .project-route .route-fields { display: grid; grid-template-columns: minmax(0, .7fr) minmax(0, 1.3fr); gap: 12px; }
    .project-route .env-field { margin-top: 12px; }
    .project-route .auth-fields { display: grid; grid-template-columns: minmax(0,.65fr) minmax(0,1.35fr); gap: 12px; margin-top: 12px; }
    .project-route .auth-fields[hidden],.project-route .auth-note[hidden] { display: none; }
    .project-route .auth-note { margin: 9px 0 0; font-size: 12px; color: #b7c9d3; }
    .project-route .secondary { width: auto; min-height: 35px; margin: 0; padding: 5px 11px; font-size: 12px; }
    .project-route label { overflow-wrap: anywhere; }
    .project-route input { font-size: 14px; min-height: 42px; padding: 9px 10px; }
    .route-results { display: grid; gap: 10px; margin-top: 13px; }
    .route-result { padding: 13px; border: 1px solid #385662; border-radius: 10px; background: #10222d; overflow-wrap: anywhere; }
    .route-result h4 { margin: 0 0 5px; font-size: 14px; }
    .route-result p { color: #b7c9d3; font-size: 12px; margin: 5px 0; }
    .route-result a { color: #8ff3d0; font-size: 12px; }
    .route-result[data-status=INCONCLUSIVE],.route-result[data-status=INCOMPLETE] { border-color: #b49a67; }
    .route-result[data-status=REPRODUCED],.route-result[data-status=FINDINGS] { border-color: #b77a77; }
    .stage-title { font-weight: 720; font-size: 12px; letter-spacing: .6px; text-transform: uppercase; color: #b1ccd5; margin: 14px 0 5px; }
    .route-health-pin { display: block; margin: 8px 0 15px; padding: 10px; background: #0a1a25;
      border: 1px solid #345564; border-radius: 8px; font: 12px/1.6 ui-monospace, Consolas, monospace;
      overflow-wrap: anywhere; user-select: all; }
    .route-health-caveat { padding: 12px; border: 1px solid #b49a67; border-radius: 9px;
      color: #f3d6a4 !important; font-weight: 680; }
    .history { margin-top: 26px; padding-top: 21px; border-top: 1px solid #2c4652; }
    .history h3 { margin: 0 0 6px; font-size: 17px; }
    .history .help { margin-bottom: 13px; }
    .history-list { display: grid; gap: 8px; max-height: 390px; overflow: auto; }
    .history-list button { display: grid; gap: 3px; text-align: left; width: 100%; min-height: 0;
      background: #10212d; color: #e0eef1; border: 1px solid #3b5663;
      border-radius: 10px; padding: 10px 12px; overflow-wrap: anywhere; }
    .history-list button:hover { background: #1d3643; }
    .history-list button[aria-current=true] { border-color: #6eeabf; background: #193a36; }
    .history-list button strong { font-size: 13px; font-weight: 710; }
    .history-list button span { font-size: 12px; color: #adc3cc; font-weight: 400; }
    .history .secondary { min-height: 40px; padding: 8px 12px; text-align: center; }
    .history-view-note { margin: 0 0 9px; color: #bed3da; font-size: 13px; }
    footer { color: #718994; font-size: 12px; padding-top: 34px; }
    @media (max-width: 760px) {
      .shell { padding: 24px 16px 40px; }
      header { padding-bottom: 24px; }
      main { padding-top: 37px; }
      h1 { letter-spacing: -1.4px; }
      .layout { grid-template-columns: 1fr; }
      .panel { padding: 22px; }
      .two { grid-template-columns: 1fr; }
      .workflow-switch { grid-template-columns: 1fr; }
      .workflow-switch.three { grid-template-columns: 1fr; }
      .workflow-switch.four { grid-template-columns: 1fr; }
      .project-route .route-fields { grid-template-columns: 1fr; }
      .project-route .auth-fields { grid-template-columns: 1fr; }
      .history-list { max-height: 320px; }
      .triage-priority { align-items: stretch; flex-direction: column; }
      .triage-priority button { width: 100%; }
      .triage-list { max-height: none; }
      .intro { margin-bottom: 22px; }
      .agent-workflow { padding: 18px; }
      .agent-steps { grid-template-columns: 1fr; gap: 8px; }
      .agent-steps li { border-top: 0; border-left: 2px solid #59bfaa; border-radius: 0 10px 10px 0; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <div class="brand"><div class="mark" aria-hidden="true">T</div>TVDoctor</div>
      <div class="local"><span class="dot" aria-hidden="true"></span>Private local session</div>
    </header>
    <main>
      <div class="eyebrow">MCP for coding agents</div>
      <h1>Find the bug. Verify the fix.</h1>
      <p class="intro">TVDoctor scans your running web app. Your coding agent uses the evidence to fix the code, then TVDoctor independently retests supported findings.</p>
      <section class="agent-workflow" aria-labelledby="agent-heading">
        <div class="agent-heading">
          <h2 id="agent-heading" class="section-title">Agent repair workflow</h2>
          <a href="#scan-heading">Open local scan controls</a>
        </div>
        <ol class="agent-steps">
          <li><strong>Scan</strong>Start <code>tvdoctor_scan</code> on an authorized URL.</li>
          <li><strong>Fix</strong>Use findings and reproduction evidence to guide code changes.</li>
          <li><strong>Verify</strong>Use <code>tvdoctor_verify_fix</code> on the original supported finding.</li>
        </ol>
        <details class="agent-setup">
          <summary>Connect an MCP client</summary>
          <p>Build TVDoctor from its source checkout and install the matching browser runtime.</p>
          <pre><code>npm ci
npm run build:packages
npm run tvdoctor -- setup</code></pre>
          <p>Register a stdio server named <code>tvdoctor</code> with the command <code>node</code> and the absolute path to <code>packages/cli/dist/mcp-bin.js</code> as its argument.</p>
          <pre><code>codex mcp add tvdoctor -- node "&lt;absolute path&gt;/packages/cli/dist/mcp-bin.js"
claude mcp add --transport stdio tvdoctor -- node "&lt;absolute path&gt;/packages/cli/dist/mcp-bin.js"</code></pre>
          <p>Open a new agent session so it can discover the tools. Start your app and give the agent a URL you authorize it to test.</p>
        </details>
        <details class="agent-setup">
          <summary>Prompt your agent</summary>
          <p id="agent-prompt" class="agent-prompt">Use TVDoctor MCP to scan [authorized local URL]. Poll for the result and inspect the findings and coverage. Fix confirmed bugs in the app code. For each supported finding, call tvdoctor_verify_fix with the original scan_id and issue_id. Run a matched follow-up scan, compare compatible completed runs, and report verified fixes, review leads, and untested coverage.</p>
          <div class="agent-copy">
            <button id="copy-agent-prompt" class="secondary" type="button">Copy agent prompt</button>
            <span id="agent-copy-status" role="status"></span>
          </div>
        </details>
      </section>
      <div class="layout">
        <section class="panel" aria-labelledby="scan-heading">
          <h2 id="scan-heading" class="section-title">Run a local scan</h2>
          <p class="section-desc">Use a website you own or have permission to test. Start with your local development URL.</p>
          <form id="scan-form" class="fields" method="post" action="/api/scans">
            <div class="problem-first">
              <label for="problem-chooser">What is going wrong with your website?</label>
              <select id="problem-chooser" aria-describedby="problem-choice-help problem-choice-status">
                <option value="" selected>Select a problem or use expert workflows below</option>
                <option value="boot-health" ${bootHealthAvailable ? "" : "disabled"}>Page loads blank</option>
                <option value="route-health" ${routeHealthAvailable ? "" : "disabled"}>Broken public page (404/410)</option>
                <option value="spa-route-health" ${spaRouteHealthAvailable ? "" : "disabled"}>Blank after SPA link</option>
                <option value="qa" ${qaAvailable ? "" : "disabled"}>General bugs / JavaScript errors</option>
                <option value="project" ${projectAvailable ? "" : "disabled"}>Multiple routes</option>
              </select>
              <p id="problem-choice-help" class="help">Start with the symptom. This selects an existing safe workflow; it does not start testing, enable extra interactions, or certify a fix.</p>
              <p id="problem-choice-status" class="help" role="status" aria-live="polite">For a general check, Website QA is recommended. More specialised verification requires independently authored expected content.</p>
            </div>
            <div>
              <details id="expert-workflows" class="expert-workflows">
                <summary>Expert workflows and advanced scan choices</summary>
              <span class="section-desc" id="workflow-label">Choose a testing workflow</span>
              <div class="workflow-switch ${routeHealthAvailable || spaRouteHealthAvailable ? "four" : projectAvailable ? "three" : ""}" role="radiogroup" aria-labelledby="workflow-label">
                <label><input id="workflow-qa" type="radio" name="workflow" value="qa" ${qaAvailable ? "checked" : "disabled"}>
                  Website QA · recommended
                  <small>${qaAvailable ? "Find reproducible web defects, review unconfirmed leads and generate a repair brief." : "Not available in this session. Use tvdoctor qa from a terminal or start the QA-enabled UI."}</small>
                </label>
                ${projectAvailable ? `<label><input id="workflow-project" type="radio" name="workflow" value="project" ${qaAvailable ? "" : "checked"}>
                  Project QA · multiple routes
                  <small>Check 1–8 explicit routes, including authorised scripted setup, then verify each repair independently.</small>
                </label>` : `<input id="workflow-project" type="radio" name="workflow" value="project" hidden disabled aria-hidden="true">`}
                <label><input id="workflow-legacy" type="radio" name="workflow" value="legacy" ${qaAvailable || projectAvailable ? "" : "checked"}>
                  Navigation &amp; layout
                  <small>Explore TV remote and keyboard paths, linked pages, or responsive screenshots.</small>
                </label>
                ${routeHealthAvailable ? `<label><input id="workflow-route-health" type="radio" name="workflow" value="route-health">
                  Public route repair
                  <small>Capture a public (no sign-in) document 404/410, then verify authored content and fresh QA after repair. Local development sites are supported.</small>
                </label>` : `<input id="workflow-route-health" type="radio" name="workflow" value="route-health" hidden disabled aria-hidden="true">`}
                ${spaRouteHealthAvailable ? `<label><input id="workflow-spa-route-health" type="radio" name="workflow" value="spa-route-health">
                  SPA route-content repair
                  <small>Review blank MAIN content after a real client-side link. Pin a witnessed original, repair, then independently verify the exact route and fresh QA.</small>
                </label>` : `<input id="workflow-spa-route-health" type="radio" name="workflow" value="spa-route-health" hidden disabled aria-hidden="true">`}
                ${bootHealthAvailable ? `<label><input id="workflow-boot-health" type="radio" name="workflow" value="boot-health">
                  Initial page content repair
                  <small>Capture an authorised blank public MAIN on direct GET, then independently verify the authored healthy page after repair.</small>
                </label>` : `<input id="workflow-boot-health" type="radio" name="workflow" value="boot-health" hidden disabled aria-hidden="true">`}
              </div>
              </details>
            </div>
            <div>
              <label for="target" id="target-label">Website URL</label>
              <input id="target" name="target" type="url" placeholder="http://localhost:3000" required maxlength="2048" autocomplete="url" spellcheck="false" aria-describedby="target-help">
              <p id="target-help" class="help">HTTP(S) only, without credentials, query or fragment in QA mode. The target URL is not returned by dashboard status APIs.</p>
            </div>
            <div id="project-options" class="workflow-options" hidden>
              <div>
                <h3 class="section-title">Project routes</h3>
                <p class="help">Enter 1–8 paths on the base URL's origin. For protected routes, choose the private journey environment variable and an exact visible authenticated-content marker. No passwords, URLs or filesystem paths in marker names.</p>
                <div id="project-route-editor" class="project-route-editor" role="group" aria-label="Project routes"></div>
                <button id="project-add-route" type="button" class="secondary">Add another route (max 8)</button>
                <p id="project-route-error" class="error" role="alert"></p>
              </div>
              <div>
                <label for="project-fail-on">Fail build for verified findings at</label>
                <select id="project-fail-on">
                  <option value="any" selected>Any verified severity</option>
                  <option value="critical">Critical</option><option value="high">High</option>
                  <option value="medium">Medium</option><option value="low">Low</option>
                  <option value="info">Info</option><option value="never">Never (report only)</option>
                </select>
                <p class="help">Severity threshold applies to original QA; REVIEW and untested coverage are displayed separately.</p>
              </div>
              <div class="record"><input id="project-interactions" type="checkbox">
                <label for="project-interactions">Enable restricted project interactions
                  <span>Optional. Bounded keyboard actions remain policy-checked; configured setup journeys may change application state.</span>
                </label>
              </div>
              <div class="record"><input id="project-authorized" type="checkbox">
                <label for="project-authorized">I am authorised to test every route and execute its configured setup journey
                  <span>Required. Setup can have side effects. Configure any secrets outside the browser in TVDOCTOR_JOURNEY_* environment variables. No passwords are requested here.</span>
                </label>
              </div>
            </div>
            <div id="route-health-options" class="workflow-options" hidden>
              <div>
                <h3 class="section-title">Public route evidence</h3>
                <p class="help">For an unauthenticated public document on an application you own or are authorised to test. Localhost is recommended. This performs a real GET, so do not assume the target has no side effects. No login or private credentials; direct document response only, without redirects, query strings or fragments.</p>
              </div>
              <div>
                <label for="route-health-path">Exact public path</label>
                <input id="route-health-path" type="text" maxlength="512" placeholder="/help/articles" autocomplete="off" spellcheck="false">
                <p class="help">Starts with / and contains only URL-safe path segments. No query, hash or encoded characters.</p>
              </div>
              <div>
                <label for="route-health-heading">Exact expected visible heading</label>
                <input id="route-health-heading" type="text" maxlength="128" placeholder="Help articles" autocomplete="off" spellcheck="false">
                <p class="help">The repaired document must contain exactly one visible heading with this accessible name inside &lt;main&gt;.</p>
              </div>
              <div>
                <label for="route-health-sha">Previously known expected MAIN text SHA-256</label>
                <input id="route-health-sha" type="text" maxlength="64" minlength="64" pattern="[0-9a-f]{64}" placeholder="64 lowercase hexadecimal characters" autocomplete="off" spellcheck="false">
                <p class="help">Required trust anchor from the expected healthy page, authored before capture. Never use the missing page, an HTTP 200 response or the repair itself to invent expected content. Hash NFKC-normalised text with collapsed whitespace.</p>
                <details class="route-health-hash-helper">
                  <summary>Compute SHA-256 from known healthy MAIN text (optional, local only)</summary>
                  <label for="route-health-main-text">Expected healthy MAIN text you already know</label>
                  <textarea id="route-health-main-text" rows="4" maxlength="65536" placeholder="Paste previously authored expected healthy MAIN text" autocomplete="off" spellcheck="false"></textarea>
                  <p class="help">Uses this browser's Web Crypto to compute the exact NFKC and collapsed-whitespace SHA-256. Plaintext never goes to TVDoctor or any server and is cleared after hashing. Never copy text from a broken or unverified response.</p>
                  <button id="route-health-compute-sha" type="button" class="secondary">Compute SHA-256 locally</button>
                  <p id="route-health-compute-status" class="help" role="status" aria-live="polite"></p>
                </details>
              </div>
              <div class="record"><input id="route-health-authorized" type="checkbox">
                <label for="route-health-authorized">I am authorised to test this exact public route
                  <span>Required. A real document GET can have side effects. Capture observes an original 404/410; acceptance compares pinned evidence, expected content and a separate fresh non-interactive QA scan.</span>
                </label>
              </div>
            </div>
            <div id="spa-route-health-options" class="workflow-options" hidden>
              <div>
                <h3 class="section-title">Client-side route-content evidence</h3>
                <p class="help">A possible blank destination is a REVIEW lead, not a verified defect. Intentional empty pages, loading and delayed hydration can be valid. The scanner visits the source with a real GET and activates a permitted link; even GET or link activation may have side effects. Use an authorised, disposable local app when possible.</p>
              </div>
              <div class="two">
                <div><label for="spa-source-path">Source document path</label>
                  <input id="spa-source-path" type="text" maxlength="512" placeholder="/help" autocomplete="off" spellcheck="false" aria-describedby="spa-source-help">
                  <p id="spa-source-help" class="help">The authored page with exactly one safe link. The document GET must load successfully.</p>
                </div>
                <div><label for="spa-destination-path">Expected client-side destination path</label>
                  <input id="spa-destination-path" type="text" maxlength="512" placeholder="/help/articles" autocomplete="off" spellcheck="false" aria-describedby="spa-destination-help">
                  <p id="spa-destination-help" class="help">Must differ from source. One same-document History navigation; no query, fragment or unsafe action paths.</p>
                </div>
              </div>
              <div><label for="spa-link-name">Unique accessible link name on the source</label>
                <input id="spa-link-name" type="text" maxlength="128" placeholder="Browse help articles" autocomplete="off" spellcheck="false" aria-describedby="spa-link-help">
                <p id="spa-link-help" class="help">Use an independently authored name for a single safe anchor. The browser will activate that link once.</p>
              </div>
              <div><label for="spa-expected-heading">Expected visible heading in the repaired MAIN</label>
                <input id="spa-expected-heading" type="text" maxlength="128" placeholder="Help articles" autocomplete="off" spellcheck="false" aria-describedby="spa-heading-help">
                <p id="spa-heading-help" class="help">Must be an independently authored, uniquely visible heading. Do not infer it from the broken destination.</p>
              </div>
              <div><label for="spa-expected-sha">Authored healthy MAIN text SHA-256</label>
                <input id="spa-expected-sha" type="text" maxlength="64" minlength="64" pattern="[0-9a-f]{64}" placeholder="64 lowercase hexadecimal characters" autocomplete="off" spellcheck="false" aria-describedby="spa-sha-help">
                <p id="spa-sha-help" class="help">SHA-256 of the complete expected healthy visible MAIN text after NFKC normalization and collapsing whitespace. Author it independently before repair; HTTP 200, an empty source or a vanished REVIEW finding is not proof.</p>
              </div>
              <div class="record"><input id="spa-route-health-authorized" type="checkbox">
                <label for="spa-route-health-authorized">I authorise this exact source GET and single client-side link activation
                  <span>Required. No credentials, forms, mutating paths or unsafe redirects. Only the server may establish a pinned original and independently verify a repair.</span>
                </label>
              </div>
            </div>
            <div id="boot-health-options" class="workflow-options" hidden>
              <div>
                <h3 class="section-title">Page loads blank · original evidence</h3>
                <p class="help">For a public page that responds to a direct document GET but appears to have no substantive MAIN content. A blank page can be an intentional empty state, login boundary, or hydration/loading delay; this is a REVIEW lead until independently observed. A GET can cause side effects on a misconfigured application. Use authorised disposable test data.</p>
              </div>
              <div>
                <label for="boot-health-path">Exact public document path</label>
                <input id="boot-health-path" type="text" maxlength="512" placeholder="/dashboard" autocomplete="off" spellcheck="false" aria-describedby="boot-health-path-help">
                <p class="help" id="boot-health-path-help">One canonical public path on the base origin above. No query, fragment, encoded characters, sign-in, or mutating routes.</p>
              </div>
              <div>
                <label for="boot-health-heading">Expected visible heading after repair</label>
                <input id="boot-health-heading" type="text" maxlength="128" placeholder="Dashboard" autocomplete="off" spellcheck="false" aria-describedby="boot-health-heading-help">
                <p class="help" id="boot-health-heading-help">Independently author the unique visible heading inside the expected healthy MAIN element; do not guess from a broken page.</p>
              </div>
              <div>
                <label for="boot-health-sha">Authored healthy MAIN text SHA-256</label>
                <input id="boot-health-sha" type="text" maxlength="64" minlength="64" pattern="[0-9a-f]{64}" placeholder="64 lowercase hex characters" autocomplete="off" spellcheck="false" aria-describedby="boot-health-sha-help">
                <p class="help" id="boot-health-sha-help">SHA-256 of the COMPLETE intended visible MAIN text (NFKC, whitespace collapsed). Must come from an independently authored healthy-content oracle, not the blank page or a repaired response. HTTP 200 does not certify FIXED.</p>
                <details class="route-health-hash-helper">
                  <summary>Compute SHA-256 locally from independently authored healthy MAIN text</summary>
                  <label for="boot-health-main-text">Expected healthy MAIN text (never sent)</label>
                  <textarea id="boot-health-main-text" rows="4" maxlength="65536" autocomplete="off" spellcheck="false"></textarea>
                  <p class="help">The text stays in this browser, is normalised exactly like the verifier, and is cleared after local hashing.</p>
                  <button id="boot-health-compute-sha" class="secondary" type="button">Compute expected SHA-256 locally</button>
                  <p id="boot-health-compute-status" class="help" role="status" aria-live="polite"></p>
                </details>
              </div>
              <div class="record">
                <input id="boot-health-authorized" type="checkbox">
                <label for="boot-health-authorized">I authorise an exact public GET of this page
                  <span>Required. A GET may have side effects. No credentials, mutations, redirects or automated fixes; accept only against a server-pinned original after a separate repair.</span>
                </label>
              </div>
            </div>
            <div id="qa-options" class="workflow-options" ${qaAvailable ? "" : "hidden"}>
              <div class="record"><input id="qa-interactions" type="checkbox" checked>
                <label for="qa-interactions">Include restricted, policy-checked UI interactions
                  <span>Recommended. Checks supported keyboard flows and dialogs. Unsafe actions are excluded by the scanner's policy.</span>
                </label>
              </div>
              <div class="record"><input id="qa-links" type="checkbox">
                <label for="qa-links">Also follow safe same-origin links
                  <span>Optional. Can visit additional pages and take longer; requires restricted interactions.</span>
                </label>
              </div>
            </div>
            <div id="legacy-options" class="workflow-options" ${qaAvailable || projectAvailable ? "hidden" : ""}>
            <div>
              <label for="scan-type">Scan type</label>
              <select id="scan-type" name="type">
                <option value="navigation">Navigation · focus paths</option>
                <option value="site">Website · route exploration</option>
                <option value="responsive">Responsive · viewport checks</option>
              </select>
              <p id="scan-description" class="help">Explore observed focus paths with a remote or keyboard.</p>
            </div>
            <div>
              <div id="input-field">
                <label for="input-mode">Input device</label>
                <select id="input-mode" name="input"><option value="remote">Remote · D-pad</option><option value="keyboard">Keyboard · Tab / Shift+Tab</option></select>
              </div>
            </div>
            <div id="site-options" hidden>
              <label for="max-routes">Maximum website routes</label>
              <input id="max-routes" name="maxRoutes" type="number" min="1" max="20" step="1" value="5" inputmode="numeric">
              <p class="help">Safety ceiling of 1–20 pages. Discovered routes depend on reachable static links and scan budgets.</p>
              <div class="record">
                <input id="explore-spa" name="exploreSpa" type="checkbox">
                <label for="explore-spa">Experimental stateful UI discovery
                  <span>Off by default. Where supported, explore additional UI states using bounded policy-checked actions. Results may be partial.</span>
                </label>
              </div>
            </div>
            <div id="responsive-options" hidden>
              <label for="viewport-profile">Viewport profiles</label>
              <select id="viewport-profile" name="viewportProfile">
                <option value="all">Mobile, tablet and desktop</option>
              </select>
              <p class="help">Three fixed viewport sizes. Findings are heuristic and require review; screenshots are saved for observed problems.</p>
            </div>
            <div class="record" id="record-options">
              <input id="record-video" name="record-video" type="checkbox">
              <label for="record-video">Record session video (optional)
                <span>Off by default. Recordings can include sensitive page content and are saved in the local report.</span>
              </label>
            </div>
            </div>
            <div id="scan-mode-field">
                <label for="scan-mode">Scan depth</label>
                <select id="scan-mode" name="mode"><option value="quick">Quick · 30s sample</option><option value="standard" selected>Standard · 2 min</option><option value="deep">Deep · up to 30 min</option></select>
            </div>
            <div>
              <button id="start" type="submit">${qaAvailable ? "Run website QA" : "Start navigation scan"}</button>
              <p id="form-error" class="error" role="alert" tabindex="-1"></p>
            </div>
          </form>
        </section>
        <aside class="panel" aria-labelledby="results-heading">
          <h2 id="results-heading" class="section-title">Latest result</h2>
          <p class="section-desc" id="results-description">Updates automatically as the scanner runs.</p>
          <p id="history-view-note" class="history-view-note" hidden>Viewing a previous run. The current scan continues separately.</p>
          <button id="history-back-live" class="secondary" type="button" hidden>Back to live/current</button>
          <div id="scan-status" class="status" data-state="idle" role="status" aria-live="polite">Ready</div>
          <div class="run">
            <div class="large-number" id="findings">—</div>
            <div class="metric-name" id="metric-name">Findings reported</div>
            <p id="run-message" class="message">Start a scan to see findings and coverage.</p>
            <div class="counts" id="coverage-counts" hidden>
              <div id="routes-count" hidden><strong id="routes-value">—</strong><span>Observed routes / configured cap</span></div>
              <div id="viewports-count" hidden><strong id="viewports-value">—</strong><span>Tested / selected viewports</span></div>
            </div>
            <div id="report-links" class="links"></div>
            <section class="qa-summary" id="qa-summary" aria-labelledby="qa-heading" hidden>
              <h3 id="qa-heading">QA evidence and next steps</h3>
              <p id="qa-status-detail"></p>
              <dl class="qa-metrics">
                <div class="verified"><dt>VERIFIED originals</dt><dd id="qa-verified">—</dd></div>
                <div class="review"><dt>REVIEW leads</dt><dd id="qa-review">—</dd></div>
                <div class="untested"><dt>UNTESTED coverage</dt><dd id="qa-untested">—</dd></div>
                <div><dt>Incomplete routes</dt><dd id="qa-incomplete">—</dd></div>
              </dl>
              <p class="next-step">Open the repair brief and original evidence. After changes, use <code>tvdoctor qa-accept</code> to independently verify the original supported failures and scan for new regressions. A new clean scan alone does not prove FIXED.</p>
              <button id="qa-accept" class="secondary" type="button" hidden>After repair: verify originals + check regressions</button>
              <p id="qa-accept-guidance"></p>
              <p id="qa-action-error" class="error" role="alert"></p>
            </section>
            <section class="qa-summary" id="accept-summary" aria-labelledby="accept-heading" hidden>
              <h3 id="accept-heading">Post-repair acceptance</h3>
              <p id="accept-detail"></p>
              <dl class="qa-metrics">
                <div><dt>Original FIXED</dt><dd id="accept-fixed">—</dd></div>
                <div class="verified"><dt>Original REPRODUCED</dt><dd id="accept-reproduced">—</dd></div>
                <div><dt>Original INCONCLUSIVE</dt><dd id="accept-inconclusive">—</dd></div>
                <div class="verified"><dt>Fresh QA VERIFIED</dt><dd id="accept-regression">—</dd></div>
                <div class="review"><dt>Fresh QA REVIEW</dt><dd id="accept-review">—</dd></div>
                <div class="untested"><dt>Fresh QA UNTESTED</dt><dd id="accept-untested">—</dd></div>
              </dl>
              <p class="next-step">PASS requires independently FIXED supported original failures and a separate completed QA scan with zero VERIFIED findings. New VERIFIED findings need inspection; they are not automatically caused by your repair.</p>
            </section>
            <section class="qa-summary" id="project-summary" aria-labelledby="project-heading" hidden>
              <h3 id="project-heading">Original project QA</h3>
              <p id="project-detail"></p>
              <p>Project handoffs and configuration may contain app content, origin URLs or journey environment VARIABLE NAMES. Review locally before sharing; no secret values are entered here.</p>
              <dl class="qa-metrics">
                <div class="verified"><dt>Original VERIFIED</dt><dd id="project-verified">—</dd></div>
                <div class="review"><dt>Original REVIEW</dt><dd id="project-review">—</dd></div>
                <div class="untested"><dt>Original UNTESTED</dt><dd id="project-untested">—</dd></div>
                <div><dt>Incomplete routes</dt><dd id="project-incomplete">—</dd></div>
              </dl>
              <p class="stage-title">Original per-route evidence</p>
              <div id="project-route-results" class="route-results"></div>
              <button id="project-accept" class="secondary" type="button" hidden>After repair: independently verify project + fresh QA</button>
              <p id="project-accept-guidance"></p>
              <p id="project-action-error" class="error" role="alert"></p>
            </section>
            <section class="qa-summary" id="project-accept-summary" aria-labelledby="project-accept-heading" hidden>
              <h3 id="project-accept-heading">Project post-repair acceptance</h3>
              <p id="project-accept-detail"></p>
              <p>Project configuration includes selected origin, routes and journey environment VARIABLE NAMES. Review locally before adding it to CI or sharing.</p>
              <dl class="qa-metrics">
                <div><dt>Original FIXED</dt><dd id="project-fixed">—</dd></div>
                <div class="verified"><dt>Original REPRODUCED</dt><dd id="project-reproduced">—</dd></div>
                <div><dt>Original INCONCLUSIVE</dt><dd id="project-inconclusive">—</dd></div>
                <div class="verified"><dt>Fresh QA VERIFIED</dt><dd id="project-fresh-verified">—</dd></div>
                <div class="review"><dt>Fresh QA REVIEW</dt><dd id="project-fresh-review">—</dd></div>
                <div class="untested"><dt>Fresh QA UNTESTED</dt><dd id="project-fresh-untested">—</dd></div>
              </dl>
              <p class="stage-title">ORIGINAL — independent repair verification by route</p>
              <div id="project-verification-routes" class="route-results"></div>
              <p class="stage-title">FRESH — separate post-repair QA by route</p>
              <div id="project-regression-routes" class="route-results"></div>
              <p class="next-step">PASS requires independently fixed supported originals and a completed fresh QA scan with zero VERIFIED findings. Fresh findings are observations; their cause is not established. Incomplete checks never certify FIXED.</p>
            </section>
            <section class="qa-summary" id="route-health-summary" aria-labelledby="route-health-result-heading" hidden>
              <h3 id="route-health-result-heading">Public route original evidence</h3>
              <p id="route-health-detail"></p>
              <p class="stage-title">Pinned original evidence SHA-256</p>
              <code id="route-health-original-pin" class="route-health-pin">Unconfirmed</code>
              <p class="help">The optional private configuration download includes the original route URL. Review locally and do not share it without checking its contents.</p>
              <p class="route-health-caveat">NOT FULL APP SAFE. Capturing an original public 404/410 is only the first step; it does not verify a repair.</p>
              <button id="route-health-accept" class="secondary" type="button" hidden>Verify repair and scan fresh</button>
              <p id="route-health-accept-guidance"></p>
              <p id="route-health-action-error" class="error" role="alert"></p>
            </section>
            <section class="qa-summary" id="route-health-accept-summary" aria-labelledby="route-health-accept-heading" hidden>
              <h3 id="route-health-accept-heading">Public route repair verification</h3>
              <p id="route-health-accept-detail"></p>
              <button id="route-health-retry" class="secondary" type="button" hidden>Retry verification after repair</button>
              <p id="route-health-retry-guidance"></p>
              <p id="route-health-retry-error" class="error" role="alert"></p>
              <p class="stage-title">Independent original route check</p>
              <p id="route-health-verification-status"></p>
              <p class="stage-title">Fresh QA of the repaired public route</p>
              <p id="route-health-regression-status"></p>
              <dl class="qa-metrics">
                <div class="verified"><dt>Fresh QA VERIFIED</dt><dd id="route-health-verified">—</dd></div>
                <div class="review"><dt>Fresh QA REVIEW</dt><dd id="route-health-review">—</dd></div>
                <div class="untested"><dt>Fresh QA UNTESTED</dt><dd id="route-health-untested">—</dd></div>
              </dl>
              <p class="stage-title">Final route check after fresh QA</p>
              <p id="route-health-final-status"></p>
              <p class="route-health-caveat">NOT FULL APP SAFE. Even ROUTE RESTORED covers only the exact public route and bounded checks. REVIEW, UNTESTED, authentication and other application flows remain unverified.</p>
            </section>
            <section class="qa-summary" id="spa-route-health-summary" aria-labelledby="spa-route-health-result-heading" hidden>
              <h3 id="spa-route-health-result-heading">SPA route original observation</h3>
              <p id="spa-route-health-detail"></p>
              <p class="stage-title">Server-pinned original evidence SHA-256</p>
              <code id="spa-route-health-original-pin" class="route-health-pin">Not yet captured</code>
              <p class="route-health-caveat">REVIEW is not FIXED. A blank client-side destination can be intentional or still hydrating. Only a source-backed original witness permits acceptance; no document HTTP 200 certifies a repair.</p>
              <p class="help">The private configuration contains the original route URL, link name and authored content expectations. Review locally before sharing.</p>
              <button id="spa-route-health-accept" class="secondary" type="button" hidden>After repair: independently verify SPA route and fresh QA</button>
              <p id="spa-route-health-accept-guidance" class="help"></p>
              <p id="spa-route-health-action-error" class="error" role="alert"></p>
            </section>
            <section class="qa-summary" id="spa-route-health-accept-summary" aria-labelledby="spa-route-health-accept-heading" hidden>
              <h3 id="spa-route-health-accept-heading">SPA route repair acceptance</h3>
              <p id="spa-route-health-accept-detail"></p>
              <button id="spa-route-health-retry" class="secondary" type="button" hidden>Retry SPA verification after repair</button>
              <p id="spa-route-health-retry-guidance" class="help"></p>
              <p id="spa-route-health-retry-error" class="error" role="alert"></p>
              <p class="stage-title">Independent authored-content verification</p>
              <p id="spa-route-health-verification-status"></p>
              <p class="stage-title">Fresh bounded non-interactive QA</p>
              <p id="spa-route-health-regression-status"></p>
              <dl class="qa-metrics">
                <div class="verified"><dt>Fresh QA VERIFIED</dt><dd id="spa-route-health-verified">—</dd></div>
                <div class="review"><dt>Fresh QA REVIEW</dt><dd id="spa-route-health-review">—</dd></div>
                <div class="untested"><dt>Fresh QA UNTESTED</dt><dd id="spa-route-health-untested">—</dd></div>
              </dl>
              <p class="stage-title">Final independent route-content recheck</p>
              <p id="spa-route-health-final-status"></p>
              <p class="route-health-caveat">NOT FULL APP SAFE. Only independently confirmed exact route content with separate complete QA and a final source-bound recheck can be called ROUTE CONTENT RESTORED. Other routes, REVIEW, UNTESTED and protected flows remain outside this claim.</p>
            </section>
            <section class="qa-summary" id="boot-health-summary" aria-labelledby="boot-health-result-heading" hidden>
              <h3 id="boot-health-result-heading">Initial blank-page original witness</h3>
              <p id="boot-health-detail" role="status" aria-live="polite"></p>
              <p class="stage-title">Source-bound original SHA-256</p>
              <code class="route-health-pin" id="boot-health-original-pin">Not yet witnessed</code>
              <p class="route-health-caveat">An initial blank MAIN can be intentional or not yet hydrated. Even a VERIFIED ORIGINAL means a witnessed blank condition, NOT a verified defect or FIXED repair. An HTTP 200 is never a positive content oracle.</p>
              <p class="help">The config download contains private route and authored content expectations; only save or share it after local review.</p>
              <button id="boot-health-accept" class="secondary" type="button" hidden>After repair: independently verify page and scan fresh</button>
              <p id="boot-health-accept-guidance" class="help"></p>
              <p id="boot-health-action-error" class="error" role="alert" tabindex="-1"></p>
            </section>
            <section class="qa-summary" id="boot-health-accept-summary" aria-labelledby="boot-health-accept-heading" hidden>
              <h3 id="boot-health-accept-heading">Initial page content repair acceptance</h3>
              <p id="boot-health-accept-detail" role="status" aria-live="polite"></p>
              <button id="boot-health-retry" class="secondary" type="button" hidden>Retry verification using original blank-page witness</button>
              <p id="boot-health-retry-guidance" class="help"></p>
              <p id="boot-health-retry-error" class="error" role="alert" tabindex="-1"></p>
              <p class="stage-title">Independent authored-content verification</p>
              <p id="boot-health-verification-status"></p>
              <p class="stage-title">Fresh bounded QA regression check</p>
              <p id="boot-health-regression-status"></p>
              <dl class="qa-metrics">
                <div class="verified"><dt>Fresh QA VERIFIED</dt><dd id="boot-health-verified">—</dd></div>
                <div class="review"><dt>Fresh QA REVIEW</dt><dd id="boot-health-review">—</dd></div>
                <div class="untested"><dt>Fresh QA UNTESTED</dt><dd id="boot-health-untested">—</dd></div>
              </dl>
              <p class="stage-title">Final independent post-QA page check</p>
              <p id="boot-health-final-status"></p>
              <p class="route-health-caveat">PAGE CONTENT RESTORED is limited to this exact publicly authorised page with two positive source-bound checks and a complete fresh QA scan. REVIEW, untested paths, authentication, and unrelated routes remain outside the claim. NOT FULL APP SAFE.</p>
            </section>
            <div id="video-panel" class="video-preview" hidden>
              <button id="load-video" type="button" class="secondary">Load local recording for playback</button>
              <video id="session-video" controls preload="none" playsinline hidden aria-label="Recorded local scan session"></video>
              <p>Recording contains the page as captured. Review it before sharing.</p>
            </div>
            <section class="triage" id="triage-section" aria-labelledby="triage-heading" hidden>
              <h3 id="triage-heading">Prioritised findings and next steps</h3>
              <p class="muted" id="triage-count"></p>
              <div class="triage-intro" aria-label="Evidence and repair interpretation">
                <p><strong>VERIFIED</strong> means a supported original failure was established. It does not mean a repair is fixed.</p>
                <p><strong>REVIEW</strong> means a lead to investigate, not a confirmed defect. In particular, an empty SPA route after navigation may be intentional.</p>
                <p>After a repair, use the original source-bound verification where supported, then run separate fresh regression QA. A missing finding or HTTP 200 never proves FIXED.</p>
              </div>
              <div class="triage-priority">
                <button id="triage-open-priority" class="secondary" type="button">Review highest-priority finding</button>
                <p id="triage-priority-detail" role="status"></p>
              </div>
              <div id="coverage-details" class="coverage-note" role="status" aria-label="Recorded scan coverage"></div>
              <div id="triage-groups" class="filter-groups" role="group" aria-label="Filter findings by severity and confidence"></div>
              <div id="triage-list" class="triage-list"></div>
            </section>
            <button class="secondary" id="cancel" type="button" hidden>Stop scan and preserve partial findings</button>
          </div>
          <div class="note"><span>↳</span><div>Quick scans are samples. Even deep scans can finish with untested paths when a budget or safety limit is reached.</div></div>
          <section id="history-section" class="history" aria-labelledby="history-heading">
            <h3 id="history-heading">Recent runs (this local session)</h3>
            <p class="help">Up to ten runs from this private session. Open a previous result without interrupting the current scan.</p>
            <div id="history-list" class="history-list" aria-label="Previous local runs"></div>
            <p id="history-status" class="help" role="status" aria-live="polite">Loading recent runs…</p>
            <button id="history-refresh" class="secondary" type="button">Refresh recent runs</button>
          </section>
        </aside>
      </div>
    </main>
    <footer>TVDoctor runs on 127.0.0.1. Results and recordings are stored locally.</footer>
  </div>
  <script nonce="${csrfToken}">
    (() => {
      "use strict";
      document.getElementById("copy-agent-prompt")?.addEventListener("click", async () => {
        const copyStatus = document.getElementById("agent-copy-status");
        try {
          await navigator.clipboard.writeText(document.getElementById("agent-prompt").textContent);
          copyStatus.textContent = "Prompt copied.";
        } catch {
          copyStatus.textContent = "Select the prompt text to copy it.";
        }
      });
      const form = document.getElementById("scan-form");
      const button = document.getElementById("start");
      const status = document.getElementById("scan-status");
      const findings = document.getElementById("findings");
      const metricName = document.getElementById("metric-name");
      const message = document.getElementById("run-message");
      const resultsHeading = document.getElementById("results-heading");
      const resultsDescription = document.getElementById("results-description");
      const historyViewNote = document.getElementById("history-view-note");
      const historyBackLive = document.getElementById("history-back-live");
      const historyList = document.getElementById("history-list");
      const historyStatus = document.getElementById("history-status");
      const historyRefresh = document.getElementById("history-refresh");
      const links = document.getElementById("report-links");
      const error = document.getElementById("form-error");
      const triageSection = document.getElementById("triage-section");
      const triageCount = document.getElementById("triage-count");
      const triageGroups = document.getElementById("triage-groups");
      const triageList = document.getElementById("triage-list");
      const triageOpenPriority = document.getElementById("triage-open-priority");
      const triagePriorityDetail = document.getElementById("triage-priority-detail");
      const coverageDetails = document.getElementById("coverage-details");
      const videoPanel = document.getElementById("video-panel");
      const loadVideo = document.getElementById("load-video");
      const sessionVideo = document.getElementById("session-video");
      const scanType = document.getElementById("scan-type");
      const qaSwitch = document.getElementById("workflow-qa");
      const projectSwitch = document.getElementById("workflow-project");
      const legacySwitch = document.getElementById("workflow-legacy");
      const routeHealthSwitch = document.getElementById("workflow-route-health");
      const routeHealthOptions = document.getElementById("route-health-options");
      const routeHealthPath = document.getElementById("route-health-path");
      const routeHealthHeading = document.getElementById("route-health-heading");
      const routeHealthSha = document.getElementById("route-health-sha");
      const routeHealthMainText = document.getElementById("route-health-main-text");
      const routeHealthComputeSha = document.getElementById("route-health-compute-sha");
      const routeHealthComputeStatus = document.getElementById("route-health-compute-status");
      const routeHealthAuthorized = document.getElementById("route-health-authorized");
      const routeHealthSummary = document.getElementById("route-health-summary");
      const routeHealthAcceptSummary = document.getElementById("route-health-accept-summary");
      const routeHealthAcceptButton = document.getElementById("route-health-accept");
      const routeHealthRetryButton = document.getElementById("route-health-retry");
      const spaRouteHealthSwitch = document.getElementById("workflow-spa-route-health");
      const spaRouteHealthOptions = document.getElementById("spa-route-health-options");
      const spaSourcePath = document.getElementById("spa-source-path");
      const spaDestinationPath = document.getElementById("spa-destination-path");
      const spaLinkName = document.getElementById("spa-link-name");
      const spaExpectedHeading = document.getElementById("spa-expected-heading");
      const spaExpectedSha = document.getElementById("spa-expected-sha");
      const spaAuthorized = document.getElementById("spa-route-health-authorized");
      const spaSummary = document.getElementById("spa-route-health-summary");
      const spaAcceptSummary = document.getElementById("spa-route-health-accept-summary");
      const spaAcceptButton = document.getElementById("spa-route-health-accept");
      const spaRetryButton = document.getElementById("spa-route-health-retry");
      const bootHealthSwitch = document.getElementById("workflow-boot-health");
      const bootHealthOptions = document.getElementById("boot-health-options");
      const bootHealthPath = document.getElementById("boot-health-path");
      const bootHealthHeading = document.getElementById("boot-health-heading");
      const bootHealthSha = document.getElementById("boot-health-sha");
      const bootHealthMainText = document.getElementById("boot-health-main-text");
      const bootHealthComputeSha = document.getElementById("boot-health-compute-sha");
      const bootHealthComputeStatus = document.getElementById("boot-health-compute-status");
      const bootHealthAuthorized = document.getElementById("boot-health-authorized");
      const bootHealthSummary = document.getElementById("boot-health-summary");
      const bootHealthAcceptSummary = document.getElementById("boot-health-accept-summary");
      const bootHealthAcceptButton = document.getElementById("boot-health-accept");
      const bootHealthRetryButton = document.getElementById("boot-health-retry");
      const problemChooser = document.getElementById("problem-chooser");
      const problemChoiceStatus = document.getElementById("problem-choice-status");
      const qaOptions = document.getElementById("qa-options");
      const legacyOptions = document.getElementById("legacy-options");
      const projectOptions = document.getElementById("project-options");
      const projectRouteEditor = document.getElementById("project-route-editor");
      const projectAddRoute = document.getElementById("project-add-route");
      const projectAuthorized = document.getElementById("project-authorized");
      const projectAcceptButton = document.getElementById("project-accept");
      const projectSummary = document.getElementById("project-summary");
      const projectAcceptSummary = document.getElementById("project-accept-summary");
      const qaInteractions = document.getElementById("qa-interactions");
      const qaLinks = document.getElementById("qa-links");
      const qaSummary = document.getElementById("qa-summary");
      const acceptButton = document.getElementById("qa-accept");
      const acceptSummary = document.getElementById("accept-summary");
      const acceptGuidance = document.getElementById("qa-accept-guidance");
      const acceptError = document.getElementById("qa-action-error");
      const scanDescription = document.getElementById("scan-description");
      const inputMode = document.getElementById("input-mode");
      const siteOptions = document.getElementById("site-options");
      const responsiveOptions = document.getElementById("responsive-options");
      const cancel = document.getElementById("cancel");
      const counts = document.getElementById("coverage-counts");
      const routesCount = document.getElementById("routes-count");
      const viewportsCount = document.getElementById("viewports-count");
      const routeValue = document.getElementById("routes-value");
      const viewportValue = document.getElementById("viewports-value");
      let activeJobId = null;
      let currentLiveJob = { state: "idle" };
      let selectedHistoryId = null;
      let loadingHistoryId = null;
      let historyBusy = false;
      let lastHistoryStamp = null;
      let routeHealthAcceptPending = false;
      let routeHealthRetryOriginalId = null;
      let spaAcceptPending = false;
      let spaAcceptOriginalId = null;
      let bootAcceptPending = false;
      let bootAcceptOriginalId = null;
      let displayedTriage = null;
      let groupFilter = "all";
      let displayedVideo = null;
      const csrfToken = document.querySelector('meta[name="tvdoctor-csrf"]').content;
      const isQa = () => qaSwitch.checked && !qaSwitch.disabled;
      const isProject = () => projectSwitch.checked && !projectSwitch.disabled;
      const isRouteHealth = () => routeHealthSwitch.checked && !routeHealthSwitch.disabled;
      const isSpaRouteHealth = () => spaRouteHealthSwitch.checked && !spaRouteHealthSwitch.disabled;
      const isBootHealth = () => bootHealthSwitch.checked && !bootHealthSwitch.disabled;
      const routeIdPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
      const routePathPattern = /^\\/(?:[A-Za-z0-9_~.-]+(?:\\/[A-Za-z0-9_~.-]+)*)?\\/?$/;
      const journeyNamePattern = /^TVDOCTOR_JOURNEY_[A-Z0-9_]{1,64}$/;
      const authReadyRoles = new Set(["heading", "region", "button"]);
      async function sha256ExpectedMain(normalised) {
        const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalised));
        return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      }
      const authNameUnsafe = /[\\/<>\\\\]|:\\/\\/|(?:^|\\s)(?:https?:|file:|token=|password=)/i;
      routeHealthComputeSha.addEventListener("click", async () => {
        routeHealthComputeStatus.textContent = "";
        const supplied = routeHealthMainText.value;
        if (!supplied.trim()) {
          routeHealthComputeStatus.textContent = "Enter previously known healthy MAIN text before computing its fingerprint.";
          return;
        }
        if (!globalThis.crypto?.subtle || typeof TextEncoder !== "function") {
          routeHealthComputeStatus.textContent = "Web Crypto is unavailable in this browser. Enter a previously calculated lowercase SHA-256 manually.";
          return;
        }
        routeHealthComputeSha.disabled = true;
        try {
          const normalised = supplied.normalize("NFKC").replace(/\\s+/gu, " ").trim();
          routeHealthSha.value = await sha256ExpectedMain(normalised);
          routeHealthMainText.value = "";
          routeHealthComputeStatus.textContent = "Fingerprint computed locally and entered above. The plaintext input has been cleared.";
        } catch {
          routeHealthComputeStatus.textContent = "Local fingerprint calculation failed. Enter a previously calculated SHA-256 manually.";
        } finally {
          routeHealthComputeSha.disabled = false;
        }
      });
      let projectRouteCounter = 0;
      bootHealthComputeSha.addEventListener("click", async () => {
        bootHealthComputeStatus.textContent = "";
        if (!bootHealthMainText.value.trim()) {
          bootHealthComputeStatus.textContent = "Enter independently authored expected MAIN text first.";
          return;
        }
        if (!globalThis.crypto?.subtle || typeof TextEncoder !== "function") {
          bootHealthComputeStatus.textContent = "Local Web Crypto unavailable; enter an independently calculated SHA-256.";
          return;
        }
        bootHealthComputeSha.disabled = true;
        try {
          const normalised = bootHealthMainText.value.normalize("NFKC").replace(/\\s+/gu, " ").trim();
          bootHealthSha.value = await sha256ExpectedMain(normalised);
          bootHealthMainText.value = "";
          bootHealthComputeStatus.textContent = "Computed only in your browser; entered the SHA-256 and cleared plaintext.";
        } catch {
          bootHealthComputeStatus.textContent = "Local SHA-256 failed. Enter a previously authored fingerprint manually.";
        } finally {
          bootHealthComputeSha.disabled = false;
        }
      });
      function projectInput(labelText, kind, value, maxLength, placeholder) {
        const holder = document.createElement("div");
        const label = document.createElement("label");
        const input = document.createElement("input");
        projectRouteCounter += 1;
        input.id = "project-route-field-" + projectRouteCounter;
        label.htmlFor = input.id;
        label.textContent = labelText;
        input.type = "text";
        input.dataset.field = kind;
        input.value = value;
        input.maxLength = maxLength;
        input.placeholder = placeholder;
        input.autocomplete = "off";
        input.spellcheck = false;
        holder.appendChild(label);
        holder.appendChild(input);
        return holder;
      }
      function updateRouteButtons() {
        const rows = projectRouteEditor.querySelectorAll(".project-route");
        projectAddRoute.disabled = rows.length >= 8;
        rows.forEach((row, index) => {
          row.querySelector("strong").textContent = "Route " + (index + 1);
          const remove = row.querySelector("button");
          remove.disabled = rows.length <= 1;
          remove.setAttribute("aria-label", "Remove route " + (index + 1));
        });
      }
      function addProjectRoute(id = "", path = "", journeyEnv = "") {
        if (projectRouteEditor.querySelectorAll(".project-route").length >= 8) return;
        const row = document.createElement("div");
        row.className = "project-route";
        const heading = document.createElement("header");
        const title = document.createElement("strong");
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "secondary";
        remove.textContent = "Remove";
        remove.addEventListener("click", () => { row.remove(); updateRouteButtons(); });
        heading.appendChild(title);
        heading.appendChild(remove);
        const fields = document.createElement("div");
        fields.className = "route-fields";
        fields.appendChild(projectInput("Route ID", "id", id, 64, "home"));
        fields.appendChild(projectInput("Path", "path", path, 512, "/dashboard"));
        const env = projectInput("Journey environment variable (optional)", "journeyEnv", journeyEnv, 81,
          "TVDOCTOR_JOURNEY_LOGIN");
        env.className = "env-field";
        const authFields = document.createElement("div");
        authFields.className = "auth-fields";
        const authRoleHolder = document.createElement("div");
        const authRoleLabel = document.createElement("label");
        const role = document.createElement("select");
        projectRouteCounter += 1;
        role.id = "project-route-field-" + projectRouteCounter;
        role.dataset.field = "authReadyRole";
        authRoleLabel.htmlFor = role.id;
        authRoleLabel.textContent = "Protected content type";
        for (const [value, label] of [["", "Choose a visible landmark"], ["heading", "Heading"],
          ["region", "Region"], ["button", "Button"]]) {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = label;
          role.appendChild(option);
        }
        authRoleHolder.appendChild(authRoleLabel);
        authRoleHolder.appendChild(role);
        const authName = projectInput("Exact accessible name on the signed-in page",
          "authReadyName", "", 128, "Workspace");
        authFields.appendChild(authRoleHolder);
        authFields.appendChild(authName);
        const note = document.createElement("p");
        note.className = "auth-note";
        note.textContent = "Required with a journey: this heading, region or button must be visible only when authenticated. It is not a password, selector or URL.";
        function syncAuthFields() {
          const protectedRoute = env.querySelector('[data-field="journeyEnv"]').value !== "";
          authFields.hidden = !protectedRoute;
          note.hidden = !protectedRoute;
          role.required = protectedRoute;
          authName.querySelector('[data-field="authReadyName"]').required = protectedRoute;
        }
        env.querySelector('[data-field="journeyEnv"]').addEventListener("input", syncAuthFields);
        row.appendChild(heading);
        row.appendChild(fields);
        row.appendChild(env);
        row.appendChild(authFields);
        row.appendChild(note);
        projectRouteEditor.appendChild(row);
        syncAuthFields();
        updateRouteButtons();
      }
      projectAddRoute.addEventListener("click", () => {
        const count = projectRouteEditor.children.length + 1;
        addProjectRoute("route" + count, "/route" + count);
      });
      addProjectRoute("home", "/");
      function projectRoutes() {
        const rows = Array.from(projectRouteEditor.querySelectorAll(".project-route"));
        if (rows.length < 1 || rows.length > 8) throw new Error("Choose between 1 and 8 routes.");
        const ids = new Set();
        const paths = new Set();
        return rows.map((row, index) => {
          const id = row.querySelector('[data-field="id"]').value;
          const path = row.querySelector('[data-field="path"]').value;
          const journeyEnv = row.querySelector('[data-field="journeyEnv"]').value;
          const authRole = row.querySelector('[data-field="authReadyRole"]').value;
          const authName = row.querySelector('[data-field="authReadyName"]').value;
          if (!routeIdPattern.test(id) || ids.has(id)) {
            throw new Error("Route " + (index + 1) + ": use a unique ID starting with a letter (up to 64 characters)." );
          }
          if (!routePathPattern.test(path) || path.split("/").some((segment) => segment === "." || segment === "..") || paths.has(path)) {
            throw new Error("Route " + (index + 1) + ": enter a unique absolute path without query, fragment or traversal.");
          }
          if (journeyEnv !== "" && !journeyNamePattern.test(journeyEnv)) {
            throw new Error("Route " + (index + 1) + ": enter only a TVDOCTOR_JOURNEY_* environment variable NAME.");
          }
          if (journeyEnv !== "" && (!authReadyRoles.has(authRole) || !authName
            || authName.length > 128 || authName.trim() !== authName
            || /[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f]/.test(authName)
            || authNameUnsafe.test(authName))) {
            throw new Error("Route " + (index + 1)
              + ": choose a visible signed-in heading, region or button and its exact safe accessible name (not a URL or secret).");
          }
          if (journeyEnv === "" && (authRole !== "" || authName !== "")) {
            throw new Error("Route " + (index + 1) + ": a protected content marker requires a journey environment variable.");
          }
          ids.add(id);
          paths.add(path);
          return { id, path, ...(journeyEnv === "" ? {} : {
            journeyEnv, authReady: { role: authRole, name: authName },
          }) };
        });
      }
      function projectRequest() {
        if (!projectAuthorized.checked) {
          throw new Error("Confirm permission to test every route and run configured setup journeys.");
        }
        const raw = document.getElementById("target").value;
        let url;
        try { url = new URL(raw); }
        catch { throw new Error("Enter a valid project base URL."); }
        if (!/^(?:http:|https:)$/.test(url.protocol) || url.username || url.password || url.search
          || url.hash || raw.length > 2048 || raw !== raw.trim()) {
          throw new Error("Project base URL must be HTTP(S) without credentials, query or fragment.");
        }
        // The server normalizes to origin; do not imply a path on the base URL is part of project routing.
        if (url.pathname !== "/") {
          throw new Error("Use the site origin as the base URL and enter pages as explicit route paths.");
        }
        return { baseUrl: url.origin, mode: document.getElementById("scan-mode").value,
          failOn: document.getElementById("project-fail-on").value,
          interactions: document.getElementById("project-interactions").checked,
          authorized: true, routes: projectRoutes() };
      }
      function routeHealthRequest() {
        if (!routeHealthAuthorized.checked) {
          throw new Error("Confirm that you are authorised to test this exact public route.");
        }
        const raw = document.getElementById("target").value;
        let url;
        try { url = new URL(raw); }
        catch { throw new Error("Enter a valid public HTTP(S) origin."); }
        if (!/^(?:http:|https:)$/.test(url.protocol) || url.username || url.password
          || url.search || url.hash || url.pathname !== "/" || raw.length > 2048
          || raw !== raw.trim() || (raw !== url.origin && raw !== url.origin + "/")) {
          throw new Error("Enter an exact public HTTP(S) origin, without path, credentials, query or fragment.");
        }
        const path = routeHealthPath.value;
        if (!routePathPattern.test(path) || path.split("/").some((part) => part === "." || part === "..")) {
          throw new Error("Enter an exact public path beginning with / and without query, hash, encoding or traversal.");
        }
        const heading = routeHealthHeading.value;
        if (heading.length < 1 || heading.length > 128 || heading !== heading.trim()
          || /[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f<>]/.test(heading)) {
          throw new Error("Enter the exact, safe visible heading expected inside the repaired page's MAIN element.");
        }
        const expectedMainTextSha256 = routeHealthSha.value;
        if (!/^[0-9a-f]{64}$/.test(expectedMainTextSha256)) {
          throw new Error("Enter the previously known expected MAIN text SHA-256 as 64 lowercase hexadecimal characters.");
        }
        return { baseUrl: url.origin, path, heading, expectedMainTextSha256, authorized: true };
      }
      function spaRouteHealthRequest() {
        if (!spaAuthorized.checked) {
          throw new Error("Confirm permission for the source document GET and the exact client-side link action.");
        }
        const raw = document.getElementById("target").value;
        let url;
        try { url = new URL(raw); }
        catch { throw new Error("Enter a canonical HTTP(S) base origin for the SPA."); }
        if (!/^(?:http:|https:)$/.test(url.protocol) || url.username || url.password || url.search
          || url.hash || url.pathname !== "/" || raw.length > 2048 || raw !== raw.trim()
          || (raw !== url.origin && raw !== url.origin + "/")) {
          throw new Error("Enter only the SPA HTTP(S) origin, without path, credentials, query or fragment.");
        }
        const sourcePath = spaSourcePath.value;
        const destinationPath = spaDestinationPath.value;
        const unsafePath = /(?:^|\\/)(?:api|auth|login|logout|signin|signout|checkout|cart|buy|purchase|pay|payment|subscribe|delete|remove|create|edit|save|update|upload|submit|send|approve|revoke|reset|transfer|order)(?:\\/|$)/i;
        if (![sourcePath, destinationPath].every((value) => routePathPattern.test(value)
          && value.length <= 512 && !value.includes("..") && !unsafePath.test(value))
          || sourcePath === destinationPath) {
          throw new Error("Use distinct canonical safe source and destination paths, without mutation routes, encoding, query, fragment or traversal.");
        }
        const unsafeName = /[<>\\\\@\\p{Cc}\\p{Cf}]|(?:https?:\\/\\/|www\\.|javascript:|data:|\\b(?:password|secret|token|credential|apikey|api.key|private.key)\\b)/iu;
        const unsafeLinkAction = /\\b(?:delete|remove|erase|create|edit|save|update|upload|submit|send|approve|revoke|reset|transfer|order|pay|purchase|checkout|login|logout|download|subscribe|unsubscribe|confirm)\\b|\\bsign\\s*(?:in|out)\\b/iu;
        const validName = (value) => typeof value === "string" && value.length > 0 && value.length <= 128
          && value === value.trim() && !/[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f<>]/.test(value);
        if (!validName(spaLinkName.value) || unsafeName.test(spaLinkName.value)
          || unsafeLinkAction.test(spaLinkName.value)
          || !validName(spaExpectedHeading.value) || unsafeName.test(spaExpectedHeading.value)) {
          throw new Error("Enter exact independently authored accessible link and heading names (1–128 safe characters each).");
        }
        if (!/^[0-9a-f]{64}$/.test(spaExpectedSha.value)) {
          throw new Error("Enter the independently authored expected healthy MAIN SHA-256 (64 lowercase hex characters).");
        }
        return { baseUrl: url.origin, sourcePath, destinationPath, linkName: spaLinkName.value,
          heading: spaExpectedHeading.value, expectedMainTextSha256: spaExpectedSha.value, authorized: true };
      }
      function bootHealthRequest() {
        if (!bootHealthAuthorized.checked) {
          throw new Error("Confirm permission for this exact public document GET before capture.");
        }
        const raw = document.getElementById("target").value;
        let parsed;
        try { parsed = new URL(raw); } catch { throw new Error("Enter a canonical HTTP(S) base origin."); }
        if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password
          || parsed.pathname !== "/" || parsed.search || parsed.hash || raw.length > 2048
          || raw !== raw.trim() || (raw !== parsed.origin && raw !== parsed.origin + "/")) {
          throw new Error("Enter only the canonical public HTTP(S) base origin, without credentials, route, query or fragment.");
        }
        const path = bootHealthPath.value;
        const mutationPath = /(?:^|\\/)(?:api|auth|login|logout|signin|signout|checkout|cart|buy|purchase|pay|payment|subscribe|delete|remove|create|edit|save|update|upload|submit|send|approve|revoke|reset|transfer|order)(?:\\/|$)/iu;
        if (typeof path !== "string" || path.length < 1 || path.length > 512
          || !routePathPattern.test(path) || path.split("/").some((segment) => segment === "." || segment === "..")
          || mutationPath.test(path) || new URL(path, parsed.origin).pathname !== path) {
          throw new Error("Enter one canonical public document path, without mutations, traversal, encoding, query or fragment.");
        }
        const heading = bootHealthHeading.value;
        const forbiddenHeading = /[<>\\\\@\\p{Cc}\\p{Cf}]|(?:https?:\\/\\/|www\\.|javascript:|data:|\\b(?:password|secret|token|credential|apikey|api.key|private.key)\\b)/iu;
        if (typeof heading !== "string" || heading.length < 1 || heading.length > 128
          || heading !== heading.trim() || forbiddenHeading.test(heading)) {
          throw new Error("Enter a safe, independently authored, unique expected MAIN heading (1–128 characters).");
        }
        const expectedMainTextSha256 = bootHealthSha.value;
        if (typeof expectedMainTextSha256 !== "string" || !/^[0-9a-f]{64}$/.test(expectedMainTextSha256)) {
          throw new Error("Enter the full independently authored healthy MAIN SHA-256 (64 lowercase hexadecimal characters).");
        }
        return { authorized: true, baseUrl: parsed.origin, path, heading, expectedMainTextSha256 };
      }
      const problemSwitches = new Map([
        ["boot-health", bootHealthSwitch],
        ["route-health", routeHealthSwitch],
        ["spa-route-health", spaRouteHealthSwitch],
        ["qa", qaSwitch],
        ["project", projectSwitch],
      ]);
      const problemGuidance = new Map([
        ["boot-health", "A direct public page loads blank. An intentional empty state or delayed hydration may be valid. Capture only the authorized exact GET; independent expected MAIN content and SHA are required before any restored verdict."],
        ["route-health", "A public document returns 404/410. Capture a witnessed original before repair; HTTP 200 alone cannot establish restoration."],
        ["spa-route-health", "MAIN turns blank after a client-side link. This REVIEW lead needs a witnessed source-to-destination transition and independently authored expected content."],
        ["qa", "Run a bounded general website check. JavaScript errors are REVIEW leads; absence on a later scan cannot independently prove FIXED."],
        ["project", "Check multiple explicit paths and optional authorised setup. Only supported originals can be independently verified, and coverage can be incomplete."],
      ]);
      problemChooser.addEventListener("change", () => {
        const chosen = problemSwitches.get(problemChooser.value);
        if (!chosen || chosen.disabled) {
          problemChoiceStatus.textContent = "This workflow is unavailable in this local session. Use expert workflows or start the corresponding enabled server.";
          return;
        }
        // Programmatic radio selection should be atomic even in non-browser
        // DOM harnesses; the browser also enforces the shared name group.
        for (const control of [qaSwitch, projectSwitch, legacySwitch, routeHealthSwitch,
          spaRouteHealthSwitch, bootHealthSwitch]) control.checked = false;
        chosen.checked = true;
        updateWorkflow();
        document.getElementById("target").focus();
      });
      function updateWorkflow() {
        const qa = isQa();
        const project = isProject();
        const routeHealth = isRouteHealth();
        const spaHealth = isSpaRouteHealth();
        const bootHealth = isBootHealth();
        qaOptions.hidden = !qa;
        projectOptions.hidden = !project;
        routeHealthOptions.hidden = !routeHealth;
        spaRouteHealthOptions.hidden = !spaHealth;
        bootHealthOptions.hidden = !bootHealth;
        legacyOptions.hidden = qa || project || routeHealth || spaHealth || bootHealth;
        document.getElementById("scan-mode-field").hidden = routeHealth || spaHealth || bootHealth;
        routeHealthPath.required = routeHealth;
        routeHealthHeading.required = routeHealth;
        routeHealthSha.required = routeHealth;
        routeHealthAuthorized.required = routeHealth;
        for (const field of [spaSourcePath, spaDestinationPath, spaLinkName, spaExpectedHeading,
          spaExpectedSha, spaAuthorized]) field.required = spaHealth;
        for (const field of [bootHealthPath, bootHealthHeading, bootHealthSha, bootHealthAuthorized]) {
          field.required = bootHealth;
        }
        const selectedProblem = [...problemSwitches].find(([, control]) => control.checked && !control.disabled)?.[0] || "";
        problemChooser.value = selectedProblem;
        problemChoiceStatus.textContent = problemGuidance.get(selectedProblem)
          || "Expert navigation and responsive checks observe bounded evidence; a scan is not full site certification.";
        document.getElementById("target-label").textContent = bootHealth ? "Public page base URL"
          : spaHealth ? "SPA base URL"
          : routeHealth ? "Public base URL"
          : project ? "Project base URL" : "Website URL";
        document.getElementById("target").placeholder = "http://localhost:3000";
        document.getElementById("target-help").textContent = bootHealth
          ? "Use the public origin only (e.g. http://localhost:3000). Put the direct page path below. No credentials or sensitive query strings."
          : spaHealth
          ? "Use the exact HTTP(S) origin of the authorised SPA, such as http://localhost:3000. Enter the source document path and distinct client-side destination below. Do not enter private credentials."
          : routeHealth
          ? "Use the exact HTTP(S) origin of your authorised unauthenticated app (for example http://localhost:3000). Enter the missing public document path below. No credentials, query, fragment or sign-in setup."
          : project
          ? "Use the origin only (for example http://localhost:3000). Add routes below; credentials and setup files stay outside this browser."
          : "HTTP(S) only, without credentials, query or fragment in QA mode. The target URL is not returned by dashboard status APIs.";
        projectAuthorized.required = project;
        qaLinks.disabled = !qaInteractions.checked;
        if (qaLinks.disabled) qaLinks.checked = false;
        if (activeJobId === null) {
          metricName.textContent = bootHealth ? "Original blank-page content witness"
            : spaHealth ? "Original SPA route-content witness"
            : routeHealth ? "Original public route capture" : project || qa ? "Verified original findings" : "Findings reported";
          message.textContent = bootHealth ? "Capture a directly loaded blank MAIN first. REVIEW is not a FIXED result."
            : spaHealth ? "Capture a source-bound blank destination before repair. REVIEW is not FIXED."
            : routeHealth ? "Capture a public HTTP 404/410 first. Repair checks require server-backed original evidence."
            : project ? "Run each configured route and review original findings before repairing."
            : qa ? "Run QA to see verified originals, review leads, coverage limits and a repair brief."
              : "Start a scan to see findings and coverage.";
        }
        updateScanType();
      }
      function updateScanType() {
        const type = scanType.value;
        siteOptions.hidden = type !== "site";
        responsiveOptions.hidden = type !== "responsive";
        document.getElementById("input-field").hidden = type !== "navigation";
        document.getElementById("record-options").hidden = type !== "navigation";
        if (type !== "navigation") {
          inputMode.value = "keyboard";
          document.getElementById("record-video").checked = false;
        }
        const modeOptions = document.getElementById("scan-mode").options;
        const labels = isQa() || isProject() ? ["Quick · bounded sample", "Standard · broader audit", "Deep · extended budget"]
          : type === "site"
          ? ["Quick · 30s per route", "Standard · 60s per route", "Deep · 120s per route"]
          : type === "responsive"
            ? ["Quick · 20s cap", "Standard · 45s cap", "Deep · 120s cap"]
            : ["Quick · 30s sample", "Standard · 2 min", "Deep · up to 30 min"];
        for (let index = 0; index < labels.length; index += 1) {
          modeOptions[index].textContent = labels[index];
        }
        scanDescription.textContent = type === "site"
          ? "Follow supported in-site links and UI journeys, within the selected route limit."
          : type === "responsive"
            ? "Sample layouts at the selected viewport profiles. This is bounded visual evidence, not exhaustive breakpoint coverage."
            : "Explore observed focus paths with a remote or keyboard.";
        if (status.dataset.state !== "running" && status.dataset.state !== "cancelling") {
          button.textContent = isBootHealth() ? "Capture original blank public page"
            : isSpaRouteHealth() ? "Capture original SPA route observation"
            : isRouteHealth() ? "Capture original 404/410"
            : isProject() ? "Run project QA" : isQa() ? "Run website QA" : "Start " + type + " scan";
        }
      }
      qaSwitch.addEventListener("change", updateWorkflow);
      projectSwitch.addEventListener("change", updateWorkflow);
      legacySwitch.addEventListener("change", updateWorkflow);
      routeHealthSwitch.addEventListener("change", updateWorkflow);
      spaRouteHealthSwitch.addEventListener("change", updateWorkflow);
      bootHealthSwitch.addEventListener("change", updateWorkflow);
      qaInteractions.addEventListener("change", updateWorkflow);
      scanType.addEventListener("change", updateScanType);
      updateWorkflow();
      function addLink(href, label) {
        if (typeof href !== "string" || !/^\\/reports\\/[a-z0-9-]{36}\\/[a-z0-9_./-]+$/i.test(href)) return;
        const link = document.createElement("a");
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = label + " ↗";
        links.appendChild(link);
      }
      function addRouteHealthConfigLink(href, jobId) {
        if (typeof jobId !== "string" || typeof href !== "string"
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)
          || href !== "/api/route-health/" + jobId + "/config") return;
        const link = document.createElement("a");
        link.href = href;
        link.rel = "noopener noreferrer";
        link.setAttribute("download", "tvdoctor.route-health.json");
        link.textContent = "Download private route configuration (contains route URL)";
        links.appendChild(link);
      }
      function addSpaConfigLink(href, jobId) {
        if (typeof jobId !== "string" || !historyUuid.test(jobId) || typeof href !== "string"
          || href !== "/api/spa-route-health/" + jobId + "/config") return;
        const anchor = document.createElement("a");
        anchor.href = href;
        anchor.rel = "noopener noreferrer";
        anchor.setAttribute("download", "tvdoctor.spa-route-health.json");
        anchor.textContent = "Download PRIVATE source-bound SPA route configuration (contains routes)";
        links.appendChild(anchor);
      }
      function addBootConfigLink(href, jobId) {
        if (typeof jobId !== "string" || !historyUuid.test(jobId)
          || href !== "/api/boot-health/" + jobId + "/config") return;
        const anchor = document.createElement("a");
        anchor.href = href;
        anchor.rel = "noopener noreferrer";
        anchor.setAttribute("download", "tvdoctor.boot-health.json");
        anchor.textContent = "Download PRIVATE original boot-health configuration (contains page URL)";
        links.appendChild(anchor);
      }
      function addBootEvidenceLink(href, jobId, suffix, title) {
        if (typeof jobId !== "string" || !historyUuid.test(jobId)
          || href !== "/reports/" + jobId + "/" + suffix) return;
        const anchor = document.createElement("a");
        anchor.href = href;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        anchor.textContent = title + " (local evidence; review before sharing)";
        links.appendChild(anchor);
      }
      function addSpaEvidenceLink(href, jobId, suffix, label) {
        if (typeof jobId !== "string" || !historyUuid.test(jobId)
          || href !== "/reports/" + jobId + "/" + suffix) return;
        const anchor = document.createElement("a");
        anchor.href = href;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        anchor.textContent = label + " (local evidence; review before sharing)";
        links.appendChild(anchor);
      }
      function routeLink(href, label) {
        if (typeof href !== "string" || !/^\\/reports\\/[0-9a-f-]{36}\\/(?:[A-Za-z0-9_-]{1,64}\\/|(?:original|regression)\\/[A-Za-z0-9_-]{1,64}\\/)report\\.html$/i.test(href)) return null;
        const element = document.createElement("a");
        element.href = href;
        element.target = "_blank";
        element.rel = "noopener noreferrer";
        element.textContent = label;
        return element;
      }
      function addProjectConfigLink(href, incomplete) {
        if (typeof href !== "string" || !/^\\/api\\/project\\/[0-9a-f-]{36}\\/manifest$/i.test(href)) return;
        const anchor = document.createElement("a");
        anchor.href = href;
        anchor.textContent = incomplete
          ? "Download project configuration to correct and rerun (NOT verified)"
          : "Download audited project configuration for CI";
        anchor.rel = "noopener noreferrer";
        anchor.setAttribute("download", "tvdoctor.project.json");
        links.appendChild(anchor);
      }
      function outputCount(id, value) {
        document.getElementById(id).textContent = Number.isSafeInteger(value) && value >= 0 ? String(value) : "—";
      }
      function renderProjectRoutes(container, rows, stage) {
        container.replaceChildren();
        if (!Array.isArray(rows) || rows.length === 0) {
          container.appendChild(textNode("p", "No validated route results were returned for this stage."));
          return;
        }
        rows.slice(0, 8).forEach((entry) => {
          if (!entry || !routeIdPattern.test(entry.id || "")) return;
          const card = document.createElement("article");
          card.className = "route-result";
          card.dataset.status = String(entry.status || "INCONCLUSIVE");
          card.appendChild(textNode("h4", entry.id));
          if (stage === "original") {
            card.appendChild(textNode("p", "ORIGINAL · " + String(entry.status || "INCONCLUSIVE")));
            card.appendChild(textNode("p", "VERIFIED " + formatCount(entry.verified)
              + " · REVIEW " + formatCount(entry.review) + " · UNTESTED " + formatCount(entry.untested)));
            if (entry.status === "INCONCLUSIVE") {
              // Only known, server-validated reason codes can influence advice.
              // Never display application-authored redirect URLs, error text
              // or an unverified claim that this protected route was tested.
              const guidance = entry.reason === "protected-route-redirected"
                && entry.remediation === "configure-auth-journey"
                ? "Protected route redirected or could not be restored. Set an approved login journey using a TVDOCTOR_JOURNEY_* environment variable and assert the expected route/content before rerunning. No defect or FIXED result is claimed for this route."
                : entry.reason === "protected-content-unproven"
                  && entry.remediation === "inspect-auth-ready-marker"
                  ? "Protected route stayed on its URL, but the required signed-in content marker was not proven. Check the approved login journey, then choose a uniquely visible heading, region or button with its exact accessible name. This route is INCONCLUSIVE, not FIXED or clean."
                : entry.reason === "authentication-journey-failed"
                  && entry.remediation === "repair-auth-journey"
                  ? "The approved login journey did not finish. Review the private journey steps, focused sign-in control, login test account, expected route and protected-content assertion. Download the project configuration, correct the journey locally and rerun. No authenticated route was tested or certified."
                : "This route has incomplete or unverified coverage. Check the saved project summary and rerun after resolving the blocker; zero displayed counts are not proof of zero defects.";
              card.appendChild(textNode("p", guidance));
            }
          } else if (stage === "verification") {
            const partial = Number(entry.inconclusive) > 0;
            card.appendChild(textNode("p", "ORIGINAL independent replay · "
              + (partial ? "INCONCLUSIVE present" : Number(entry.reproduced) > 0 ? "REPRODUCED" : "Recorded verification")));
            card.appendChild(textNode("p", "FIXED " + formatCount(entry.fixed)
              + " · REPRODUCED " + formatCount(entry.reproduced)
              + " · INCONCLUSIVE " + formatCount(entry.inconclusive)));
            if (partial) card.appendChild(textNode("p", "Not all supported originals have a final result; do not claim this route is fixed."));
          } else {
            card.appendChild(textNode("p", "FRESH independent scan · " + String(entry.status || "INCONCLUSIVE")));
            card.appendChild(textNode("p", "VERIFIED " + formatCount(entry.verified)
              + " · REVIEW " + formatCount(entry.review) + " · UNTESTED " + formatCount(entry.untested)));
            if (Number(entry.omittedVerifiedIssueIds) > 0) {
              card.appendChild(textNode("p", formatCount(entry.omittedVerifiedIssueIds)
                + " fresh VERIFIED issue IDs omitted from the bounded summary; inspect the report."));
            }
          }
          const destination = routeLink(entry.reportUrl, "Open this route's "
            + (stage === "regression" ? "fresh" : "original") + " evidence");
          if (destination) card.appendChild(destination);
          container.appendChild(card);
        });
      }
      function formatCount(value) {
        return Number.isSafeInteger(value) && value >= 0 ? String(value) : "unknown";
      }
      function renderProject(job) {
        const project = job.project;
        const isCapture = job.type === "project";
        const isAccept = job.type === "project-accept";
        projectSummary.hidden = !isCapture || !project;
        projectAcceptSummary.hidden = !isAccept || !job.projectAcceptance;
        projectAcceptButton.hidden = !(isCapture && project && job.acceptReady && job.state === "completed");
        if (isCapture && project) {
          addLink(project.summaryUrl, "Original project QA summary");
          addLink(job.projectHandoffUrl, "Open project coding-agent handoff (may contain private paths)");
          addProjectConfigLink(job.projectConfigUrl, job.state === "partial");
          outputCount("project-verified", project.summary?.verified);
          outputCount("project-review", project.summary?.review);
          outputCount("project-untested", project.summary?.untested);
          outputCount("project-incomplete", project.summary?.partial);
          document.getElementById("project-detail").textContent = project.status === "INCONCLUSIVE"
            ? "INCONCLUSIVE: original route coverage or evidence is incomplete. Recorded findings remain evidence, but the project cannot pass."
            : project.status === "FINDINGS"
              ? "VERIFIED originals require repair. REVIEW leads and UNTESTED coverage are separate; no repair has been independently verified."
              : project.status === "REVIEW_REQUIRED"
                ? "Review-only findings require inspection before calling them confirmed defects."
                : "No verified original failures at the selected threshold within completed coverage; unvisited states are still unknown.";
          document.getElementById("project-accept-guidance").textContent = job.acceptReady
            ? "After deploying repairs to the same authorised routes, explicitly run independent replay and fresh per-route QA. Original evidence stays preserved."
            : "Independent acceptance requires a complete, evidence-backed original project capture with supported verified defects. Re-run incomplete routes before verifying a repair.";
          renderProjectRoutes(document.getElementById("project-route-results"), project.routes, "original");
        }
        if (isAccept && job.projectAcceptance) {
          const result = job.projectAcceptance;
          const verification = result.verification;
          const regression = result.regression;
          addLink(result.links?.summary, "Project acceptance summary");
          addLink(result.links?.verification, "ORIGINAL independent replay results");
          addLink(result.links?.regression, "FRESH post-repair QA results");
          addLink(result.originalLinks?.summary, "Preserved original project report");
          addLink(result.originalLinks?.handoff, "Open original project coding-agent handoff (private)");
          addLink(job.projectHandoffUrl, "Open original project coding-agent handoff (private)");
          addProjectConfigLink(job.projectConfigUrl);
          document.getElementById("project-accept-detail").textContent = result.status === "PASS"
            ? "PASS: all supported original failures were independently FIXED and completed fresh QA found zero VERIFIED findings. REVIEW and UNTESTED work remain visible."
            : result.status === "REPRODUCED"
              ? "REPRODUCED: original defects persist after repair. Review the original per-route replay before drawing any success conclusion."
              : result.status === "NEW_VERIFIED"
                ? "FRESH QA VERIFIED findings need investigation. They are not automatically regressions introduced by the repair."
                : result.status === "INCONCLUSIVE"
                  ? "INCONCLUSIVE: one or more original replays or fresh route checks lack decisive evidence. No project-wide FIXED verdict."
                  : "ERROR: acceptance did not complete. No repair certification was issued.";
          const originalKnown = verification?.status !== "NOT_RUN";
          const freshKnown = regression?.status !== "NOT_RUN";
          outputCount("project-fixed", originalKnown ? verification?.fixed : null);
          outputCount("project-reproduced", originalKnown ? verification?.reproduced : null);
          outputCount("project-inconclusive", originalKnown ? verification?.inconclusive : null);
          outputCount("project-fresh-verified", freshKnown ? regression?.verified : null);
          outputCount("project-fresh-review", freshKnown ? regression?.review : null);
          outputCount("project-fresh-untested", freshKnown ? regression?.untested : null);
          renderProjectRoutes(document.getElementById("project-verification-routes"),
            originalKnown ? verification?.routes : null, "verification");
          renderProjectRoutes(document.getElementById("project-regression-routes"),
            freshKnown ? regression?.routes : null, "regression");
        }
      }
      function routeHealthStatus(status) {
        return typeof status === "string" && ["VERIFIED_ORIGINAL", "ROUTE_RESTORED", "FIXED",
          "REPRODUCED", "NEW_VERIFIED", "INCONCLUSIVE", "ERROR", "COMPLETED", "INCOMPLETE",
          "FAILED", "NOT_RUN"].includes(status) ? status.replaceAll("_", " ") : "Unknown";
      }
      function renderRouteHealth(job) {
        const capture = job.type === "route-health";
        const accept = job.type === "route-health-accept";
        const original = capture && job.routeHealth && typeof job.routeHealth === "object"
          ? job.routeHealth : null;
        const result = accept && job.routeHealthAcceptance && typeof job.routeHealthAcceptance === "object"
          ? job.routeHealthAcceptance : null;
        routeHealthSummary.hidden = !capture;
        routeHealthAcceptSummary.hidden = !accept;
        const pinned = original && typeof original.originalSha256 === "string"
          && /^[0-9a-f]{64}$/.test(original.originalSha256) ? original.originalSha256 : null;
        document.getElementById("route-health-original-pin").textContent = pinned || "Unavailable — no verified original pin";
        routeHealthAcceptButton.hidden = !(capture && job.state === "completed"
          && original?.acceptReady === true && pinned !== null);
        routeHealthAcceptButton.disabled = routeHealthAcceptButton.hidden || routeHealthAcceptPending;
        const terminal = ["completed", "partial", "failed"].includes(job.state);
        const retryable = result?.status === "INCONCLUSIVE" || result?.status === "REPRODUCED"
          || result?.status === "NEW_VERIFIED" || result?.status === "ERROR" || job.state === "failed";
        routeHealthRetryOriginalId = accept && terminal && retryable
          && typeof job.routeHealthOriginalId === "string"
          && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(job.routeHealthOriginalId)
          ? job.routeHealthOriginalId : null;
        routeHealthRetryButton.hidden = routeHealthRetryOriginalId === null;
        routeHealthRetryButton.disabled = routeHealthRetryButton.hidden || routeHealthAcceptPending;
        document.getElementById("route-health-retry-guidance").textContent = accept && terminal && retryable
          ? routeHealthRetryOriginalId === null
            ? "Retry unavailable: the original capture reference is missing or invalid. This verification did not establish a repaired route."
            : "After correcting the public document, run verification again against the same pinned original. The server will recheck its SHA-256 and authored configuration."
          : "";
        if (capture) {
          document.getElementById("route-health-detail").textContent = job.state === "running"
            || job.state === "cancelling"
            ? "Observing the exact public page and checking for a direct original HTTP 404/410. No repair result is available yet."
            : original?.status === "VERIFIED_ORIGINAL"
            ? "VERIFIED ORIGINAL: the server preserved source-backed evidence of an exact HTTP 404/410 public document response. This does not verify any repair."
            : "INCONCLUSIVE: the required exact public 404/410 original was not proven. A later HTTP 200 alone cannot establish a repair.";
          document.getElementById("route-health-accept-guidance").textContent = routeHealthAcceptButton.hidden
            ? "Independent acceptance is unavailable until a completed, source-backed original capture is pinned by the server."
            : "After deploying your repair, verify the pinned original against your previously known heading and MAIN text hash, then run fresh QA and recheck the route.";
          if (original?.status === "VERIFIED_ORIGINAL" && pinned !== null) {
            addLink(original.links?.original, "Open pinned public original evidence");
            addRouteHealthConfigLink(original.configDownloadUrl, job.id);
          }
        }
        if (accept) {
          const verification = result?.verification;
          const final = result?.postRegressionVerification;
          const regression = result?.regression;
          const pending = (job.state === "running" || job.state === "cancelling") && !result;
          document.getElementById("route-health-accept-detail").textContent = pending
            ? "Independent repair verification is running. Original replay, separate fresh QA and the final route check must finish before a route verdict is available."
            : result?.status === "ROUTE_RESTORED"
            ? "ROUTE RESTORED: original public HTTP 404/410 evidence was independently checked against your authored content. Fresh bounded QA completed with zero VERIFIED findings, followed by a second successful route verification."
            : result?.status === "REPRODUCED"
              ? "REPRODUCED: the original missing-route failure persisted or returned. The route is not restored."
              : result?.status === "NEW_VERIFIED"
                ? "FRESH VERIFIED findings require investigation. The QA result alone does not prove whether the repair introduced them."
                : result?.status === "INCONCLUSIVE"
                  ? "INCONCLUSIVE: original replay, fresh QA or final verification did not establish reliable evidence. No restored-route verdict is supported."
                  : "ERROR or incomplete acceptance: no restored-route verdict was established.";
          document.getElementById("route-health-verification-status").textContent = "Original document and authored MAIN content: "
            + (pending ? "Pending" : routeHealthStatus(verification?.status));
          document.getElementById("route-health-regression-status").textContent = "Separate fresh QA: "
            + (pending ? "Pending" : routeHealthStatus(regression?.status));
          document.getElementById("route-health-final-status").textContent = "Post-regression route check: "
            + (pending ? "Pending" : routeHealthStatus(final?.status));
          const regressionComplete = regression?.status === "COMPLETED" || regression?.status === "INCOMPLETE";
          outputCount("route-health-verified", regressionComplete ? regression.verified : null);
          outputCount("route-health-review", regressionComplete ? regression.review : null);
          outputCount("route-health-untested", regressionComplete ? regression.untested : null);
          addLink(result?.links?.summary, "Open public route acceptance summary");
          addLink(result?.links?.verification, "Open independent original route verification");
          addLink(result?.links?.regression, "Open fresh QA evidence");
          addLink(result?.links?.postRegressionVerification, "Open final route verification");
        }
      }
      function bootAcceptIsRestored(job) {
        const result = job.type === "boot-health-accept" ? job.bootHealthAcceptance : null;
        return job.state === "completed" && result?.status === "PAGE_CONTENT_RESTORED"
          && typeof job.bootHealthOriginalId === "string" && historyUuid.test(job.bootHealthOriginalId)
          && result.verification?.status === "PAGE_CONTENT_RESTORED"
          && result.postRegressionVerification?.status === "PAGE_CONTENT_RESTORED"
          && result.regression?.status === "COMPLETED"
          && Number.isSafeInteger(result.regression.verified) && result.regression.verified === 0;
      }
      function renderBootHealth(job) {
        const capture = job.type === "boot-health";
        const accept = job.type === "boot-health-accept";
        const original = capture && job.bootHealth && typeof job.bootHealth === "object"
          ? job.bootHealth : null;
        const outcome = accept && job.bootHealthAcceptance && typeof job.bootHealthAcceptance === "object"
          ? job.bootHealthAcceptance : null;
        const terminal = ["completed", "partial", "failed"].includes(job.state);
        const pinned = original && typeof original.originalSha256 === "string"
          && /^[0-9a-f]{64}$/.test(original.originalSha256) ? original.originalSha256 : null;
        const ready = capture && job.state === "completed" && original?.status === "VERIFIED_ORIGINAL"
          && original.acceptReady === true && pinned !== null && historyUuid.test(job.id || "");
        bootHealthSummary.hidden = !capture;
        bootHealthAcceptSummary.hidden = !accept;
        document.getElementById("boot-health-original-pin").textContent = pinned || "No trustworthy original SHA-256 available";
        bootHealthAcceptButton.hidden = !ready;
        bootHealthAcceptButton.disabled = !ready || bootAcceptPending;
        const retryable = job.state === "failed" ||
          ["INCONCLUSIVE", "REPRODUCED", "NEW_VERIFIED", "ERROR"].includes(outcome?.status);
        bootAcceptOriginalId = accept && terminal && retryable
          && typeof job.bootHealthOriginalId === "string" && historyUuid.test(job.bootHealthOriginalId)
          ? job.bootHealthOriginalId : null;
        bootHealthRetryButton.hidden = bootAcceptOriginalId === null;
        bootHealthRetryButton.disabled = bootHealthRetryButton.hidden || bootAcceptPending;
        document.getElementById("boot-health-retry-guidance").textContent = !accept || !terminal
          ? "" : retryable && bootAcceptOriginalId !== null
            ? "After repairing the page, retry verification against the same server-pinned original. No new original capture replaces its evidence."
            : retryable ? "Retry unavailable without the exact pinned original. No restored verdict was established." : "";
        if (capture) {
          document.getElementById("boot-health-detail").textContent = !terminal
            ? "Observing the authorised public document GET and its settled MAIN content. No defect or fixed-state verdict yet."
            : ready
              ? "VERIFIED ORIGINAL: the server pinned direct-load blank MAIN evidence. This is a witnessed original condition, not proof it was unintended and not a repaired-state verdict."
              : "INCONCLUSIVE: no exact original blank MAIN was established. An intentional empty state, delayed hydration, protection boundary or incomplete browser evidence may explain it.";
          document.getElementById("boot-health-accept-guidance").textContent = ready
            ? "After a real repair, explicitly verify independently authored heading and full MAIN SHA, run separate fresh QA, and recheck the exact page. Do not trust HTTP 200 alone."
            : "Acceptance needs a completed source-bound original and its private configuration; a REVIEW lead alone cannot be declared FIXED.";
          if (ready) {
            addBootEvidenceLink(original.links?.original, job.id, "original.json",
              "Open original blank-page evidence");
            addBootConfigLink(original.configDownloadUrl, job.id);
          }
        }
        if (accept) {
          const first = outcome?.verification;
          const regression = outcome?.regression;
          const last = outcome?.postRegressionVerification;
          const restored = bootAcceptIsRestored(job);
          document.getElementById("boot-health-accept-detail").textContent = !terminal
            ? "Acceptance in progress. Two independent authored-content checks and a complete separate QA regression are required before a verdict."
            : restored
              ? "PAGE CONTENT RESTORED: two independent checks matched the authored healthy heading and full MAIN text, with a completed fresh QA scan containing zero VERIFIED findings between checks. Other application paths remain unverified."
              : outcome?.status === "REPRODUCED"
                ? "REPRODUCED: the original missing MAIN content persisted or returned. A repair was not established."
                : outcome?.status === "NEW_VERIFIED"
                  ? "NEW VERIFIED findings in fresh QA require investigation. This does not certify restored content."
                  : "INCONCLUSIVE / ERROR: independent positive content proof or complete QA is missing. A clean HTTP response or vanished REVIEW lead never certifies FIXED.";
          const safeStage = (value) => ["PAGE_CONTENT_RESTORED", "REPRODUCED", "INCONCLUSIVE",
            "COMPLETED", "INCOMPLETE", "FAILED", "NOT_RUN"].includes(value)
            ? value.replaceAll("_", " ") : "Unknown / not independently established";
          document.getElementById("boot-health-verification-status").textContent =
            "First fresh independent check: " + (!terminal ? "Pending" : safeStage(first?.status));
          document.getElementById("boot-health-regression-status").textContent =
            "Fresh bounded QA: " + (!terminal ? "Pending" : safeStage(regression?.status));
          document.getElementById("boot-health-final-status").textContent =
            "Final fresh independent check: " + (!terminal ? "Pending" : safeStage(last?.status));
          const count = (value) => terminal && ["COMPLETED", "INCOMPLETE"].includes(regression?.status)
            && Number.isSafeInteger(value) && value >= 0 && value <= 1000000 ? String(value) : "—";
          document.getElementById("boot-health-verified").textContent = count(regression?.verified);
          document.getElementById("boot-health-review").textContent = count(regression?.review);
          document.getElementById("boot-health-untested").textContent = count(regression?.untested);
          if (outcome?.links && typeof outcome.links === "object") {
            addBootEvidenceLink(outcome.links.summary, job.id, "boot-health-accept.json", "Open acceptance summary");
            addBootEvidenceLink(outcome.links.verification, job.id,
              "verification/verification.json", "Open first independent check");
            addBootEvidenceLink(outcome.links.regression, job.id,
              "regression/qa-summary.json", "Open fresh QA evidence");
            addBootEvidenceLink(outcome.links.postRegressionVerification, job.id,
              "post-regression-verification/verification.json", "Open final independent check");
          }
        }
      }
      function renderSpaRouteHealth(job) {
        const capture = job.type === "spa-route-health";
        const accept = job.type === "spa-route-health-accept";
        const original = capture && job.spaRouteHealth && typeof job.spaRouteHealth === "object"
          ? job.spaRouteHealth : null;
        const result = accept && job.spaRouteHealthAcceptance && typeof job.spaRouteHealthAcceptance === "object"
          ? job.spaRouteHealthAcceptance : null;
        const terminal = ["completed", "partial", "failed"].includes(job.state);
        const pinned = original && typeof original.originalSha256 === "string"
          && /^[0-9a-f]{64}$/.test(original.originalSha256) ? original.originalSha256 : null;
        spaSummary.hidden = !capture;
        spaAcceptSummary.hidden = !accept;
        document.getElementById("spa-route-health-original-pin").textContent = pinned || "No validated original SHA-256 available";
        const ready = capture && job.state === "completed" && original?.status === "VERIFIED_ORIGINAL"
          && original.acceptReady === true && pinned !== null && historyUuid.test(job.id || "");
        spaAcceptButton.hidden = !ready;
        spaAcceptButton.disabled = !ready || spaAcceptPending;
        spaAcceptOriginalId = accept && terminal && (job.state === "failed"
          || ["INCONCLUSIVE", "REPRODUCED", "NEW_VERIFIED", "ERROR"].includes(result?.status))
          && typeof job.spaRouteHealthOriginalId === "string" && historyUuid.test(job.spaRouteHealthOriginalId)
          ? job.spaRouteHealthOriginalId : null;
        spaRetryButton.hidden = spaAcceptOriginalId === null;
        spaRetryButton.disabled = spaRetryButton.hidden || spaAcceptPending;
        document.getElementById("spa-route-health-retry-guidance").textContent = accept && terminal
          && result?.status !== "ROUTE_CONTENT_RESTORED"
          ? spaAcceptOriginalId === null
            ? "Retry needs the exact previously pinned original UUID. No new capture can replace the original witness after repair."
            : "After another repair, retry the exact pinned original. The server independently checks original/config SHA and fresh browser QA again."
          : "";
        if (capture) {
          document.getElementById("spa-route-health-detail").textContent = job.state === "running" || job.state === "cancelling"
            ? "Capturing a real source GET and exactly one safe same-document link transition. No missing-content defect is confirmed yet."
            : ready
              ? "VERIFIED ORIGINAL: a source-bound blank MAIN destination was independently observed and SHA-pinned. This proves only the original condition, not that it was defective or is now fixed."
              : "INCONCLUSIVE: no complete source-bound blank-destination witness was established. Hydration, an intentional empty state, route drift or unsafe navigation may explain the observation.";
          document.getElementById("spa-route-health-accept-guidance").textContent = ready
            ? "Repair the authored destination first. Then use the pinned original to verify exact expected heading and MAIN text in fresh Chromium, run separate bounded QA and independently recheck."
            : "Independent acceptance requires a completed server-pinned original; HTTP 200 or a disappeared REVIEW lead cannot enable verification.";
          if (ready) {
            const originalUrl = original.links?.original;
            if (typeof originalUrl === "string" && originalUrl === "/reports/" + job.id + "/original.json") {
              addLink(originalUrl, "Open pinned SPA original evidence");
            }
            addSpaConfigLink(original.configDownloadUrl, job.id);
          }
        }
        if (accept) {
          const running = !terminal;
          const first = result?.verification;
          const final = result?.postRegressionVerification;
          const regression = result?.regression;
          const independentlyRestored = spaAcceptIsRestored(job);
          document.getElementById("spa-route-health-accept-detail").textContent = running
            ? "Acceptance underway: original source-bound replay, separate QA and final independent recheck must complete. No repair verdict yet."
            : independentlyRestored
              ? "ROUTE CONTENT RESTORED: the exact authored heading and healthy MAIN hash were independently reobserved twice around complete fresh QA with zero VERIFIED findings. This is limited to the tested route."
              : result?.status === "REPRODUCED"
                ? "REPRODUCED: the original blank SPA condition persisted or returned. The destination is not verified as repaired."
                : result?.status === "NEW_VERIFIED"
                  ? "NEW VERIFIED findings in fresh QA require investigation. They do not independently establish a repaired route."
                  : "INCONCLUSIVE / ERROR: required original replay, fresh QA or final positive recheck did not complete with matching independent evidence. No FIXED verdict is supported.";
          const safeStage = (value) => ["ROUTE_CONTENT_RESTORED", "REPRODUCED", "INCONCLUSIVE",
            "COMPLETED", "INCOMPLETE", "FAILED", "NOT_RUN"].includes(value)
            ? value.replaceAll("_", " ") : "Unknown / unverified";
          document.getElementById("spa-route-health-verification-status").textContent = "Fresh authored-content re-observation: "
            + (running ? "Pending" : safeStage(first?.status));
          document.getElementById("spa-route-health-regression-status").textContent = "Separate QA outcome: "
            + (running ? "Pending" : safeStage(regression?.status));
          document.getElementById("spa-route-health-final-status").textContent = "Independent post-QA recheck: "
            + (running ? "Pending" : safeStage(final?.status));
          const count = (value) => !running && ["COMPLETED", "INCOMPLETE"].includes(regression?.status)
            && Number.isSafeInteger(value) && value >= 0 && value <= 1000000 ? String(value) : "—";
          document.getElementById("spa-route-health-verified").textContent = count(regression?.verified);
          document.getElementById("spa-route-health-review").textContent = count(regression?.review);
          document.getElementById("spa-route-health-untested").textContent = count(regression?.untested);
          if (result?.links && typeof result.links === "object") {
            addSpaEvidenceLink(result.links.summary, job.id, "spa-route-health-accept.json",
              "Open SPA acceptance summary");
            addSpaEvidenceLink(result.links.verification, job.id, "verification/verification.json",
              "Open independent first verification");
            addSpaEvidenceLink(result.links.regression, job.id, "regression/qa-summary.json",
              "Open separate fresh QA results");
            addSpaEvidenceLink(result.links.postRegressionVerification, job.id,
              "post-regression-verification/verification.json", "Open independent final recheck");
          }
        }
      }
      function spaAcceptIsRestored(job) {
        const result = job.type === "spa-route-health-accept" ? job.spaRouteHealthAcceptance : null;
        return job.state === "completed" && result?.status === "ROUTE_CONTENT_RESTORED"
          && typeof job.spaRouteHealthOriginalId === "string"
          && historyUuid.test(job.spaRouteHealthOriginalId)
          && result.verification?.status === "ROUTE_CONTENT_RESTORED"
          && result.postRegressionVerification?.status === "ROUTE_CONTENT_RESTORED"
          && result.regression?.status === "COMPLETED"
          && Number.isSafeInteger(result.regression.verified) && result.regression.verified === 0;
      }
      function validEvidenceUrl(value) {
        return typeof value === "string"
          && /^\\/reports\\/[0-9a-f-]{36}\\/(?:original\\/|pages\\/[0-9]{3}\\/)?(?:report\\.html|evidence\\/TVDOCTOR-[A-Za-z0-9-]{1,150}\\/(?:before|after)-screenshot\\.(?:png|jpg|jpeg)|evidence\\/TVDOCTOR-[A-Za-z0-9-]{1,150}\\/issue-video\\.webm|exports\\/TVDOCTOR-[A-Za-z0-9-]{1,150}\\.spec\\.js|responsive\\/(?:mobile|tablet|desktop)\\/page-[0-9]{2}\\.png|spa\\/(?:graph\\.html|spa-journey\\.json|evidence\\/(?:back-edge|back-interrupted-edge)-[0-9]{3}\\.png))(?:#[A-Za-z0-9._%:-]{1,200})?$/i.test(value);
      }
      function textNode(tag, text, className) {
        const element = document.createElement(tag);
        element.textContent = String(text);
        if (className) element.className = className;
        return element;
      }
      function makeLink(href, label) {
        if (!validEvidenceUrl(href)) return null;
        const anchor = document.createElement("a");
        anchor.href = href;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        anchor.textContent = label + " ↗";
        return anchor;
      }
      const triageSeverities = ["critical", "high", "medium", "low", "info", "unrated"];
      const triageConfidences = ["deterministic", "heuristic", "inference", "unobservable", "unspecified"];
      const triageRuleNames = new Map([
        ["web.safe-link-document-failure", "Document link reached an error"],
        ["web.safe-keyboard-page-error", "Page error after keyboard action"],
        ["keyboard.modal-focus-escape", "Focus escaped a modal dialog"],
        ["keyboard.modal-tab-wrap-failure", "Modal keyboard focus did not wrap"],
        ["spa.route-content-missing", "Possible missing MAIN content after SPA navigation"],
        ["spa.history-back-stale-view", "Possible stale view after browser Back"],
        ["spa.history-back-interrupted-stale-view", "Possible stale view after two browser Backs"],
        ["spa.expanded-panel-mismatch", "Possible disclosure panel mismatch"],
        ["spa.http-response-error", "SPA action observed an HTTP error"],
        ["spa.network-request-failed", "SPA action observed a network failure"],
        ["spa.runtime-page-error", "SPA action observed a page exception"],
        ["spa.runtime-console-error", "SPA action observed a console error"],
        ["responsive.document-overflow", "Possible horizontal document overflow"],
        ["responsive.offscreen-control", "Possible offscreen control"],
        ["responsive.clipped-control", "Possible clipped control"],
        ["responsive.control-overlap", "Possible overlapping controls"],
        ["responsive.obscured-control", "Possible obscured control"],
      ]);
      // The server emits bounded static guidance. Keep exact rule-scoped expected text here
      // rather than rendering arbitrary text from a network response or application page.
      const triageApprovedGuidance = new Map([
        ["spa.route-content-missing", [
          "An SPA route changed while its main content remained empty. A user may reach a blank workspace, but a deliberately empty screen can be valid.",
          "Open the recorded private route checkpoints on an authorised test instance. Inspect client-router matching, component render guards, data fetches, Suspense/loading boundaries, hydration timing and empty-state design. Do not infer cause from HTTP 200.",
          "REVIEW only. Define the intended destination content independently, reproduce the exact client-side journey and assert visible main content in fresh Chromium after hydration, then run separate regression QA. A disappeared finding or HTTP 200 cannot certify FIXED.",
        ]],
        ["web.safe-link-document-failure", [
          "An opted-in keyboard navigation reached an HTTP error page. Users following the link may not reach the intended content.",
          "Confirm this is an intended destination on a disposable test instance. Check the source anchor, application route, hosting response, access restrictions and any redirected login or soft-404 content.",
          "REVIEW only. Recheck the intended page and content manually. A changed HTTP status or missing finding cannot certify FIXED.",
        ]],
        ["web.safe-keyboard-page-error", [
          "The browser observed a page exception during a bounded keyboard action. The affected workflow might not complete.",
          "Inspect the original local action context and actual application code; reproduce in the same authorised state before attributing the exception to the input.",
          "REVIEW only. Absence of a later exception is not independent proof of a corrected workflow.",
        ]],
        ["keyboard.modal-focus-escape", [
          "Keyboard focus escaped a visible modal. Users may reach controls behind an unfinished dialog.",
          "Inspect dialog focus trapping, initial focus, TAB ordering and restoration after closing. Preserve the original route and semantic control identity.",
          "Use the original source-bound verify-fix command only if its exact replay and positive modal-focus oracle are supported, followed by a separate fresh regression scan.",
        ]],
        ["keyboard.modal-tab-wrap-failure", [
          "Keyboard focus may fail to wrap within a modal at its edge, potentially preventing predictable dialog navigation.",
          "Reproduce the original keyboard edge transition and check the modal's focusable-element order and dialog lifecycle.",
          "An independent FIXED result requires the exact supported original modal oracle and restored semantic context; otherwise keep the outcome INCONCLUSIVE.",
        ]],
      ]);
      function triageSource(source) {
        if (source === "Navigation" || source === "QA original") return source;
        if (source === "Experimental SPA · REVIEW") return "Experimental SPA";
        if (["mobile", "tablet", "desktop"].includes(source)) return "Responsive " + source;
        if (typeof source === "string" && /^Route (0[1-9]|1[0-2])$/.test(source)) return "Site route scan";
        return "Recorded audit";
      }
      function triageOwnedUrl(href, jobId) {
        return typeof jobId === "string" && /^[0-9a-f-]{36}$/i.test(jobId)
          && typeof href === "string" && href.startsWith("/reports/" + jobId + "/")
          && validEvidenceUrl(href);
      }
      function triageActionGuidance(body, finding) {
        const approved = triageApprovedGuidance.get(finding.rule);
        const supplied = finding.guidance;
        const exact = approved && supplied && typeof supplied === "object"
          && supplied.impact === approved[0] && supplied.investigate === approved[1]
          && supplied.verification === approved[2];
        const guidance = exact ? approved : [
          "This observation may affect the recorded workflow; scope and user impact have not been independently established.",
          "Inspect the original local evidence, reproduce on an authorised test instance and identify the actual cause before changing the application.",
          "Repeat the exact supported original check when available, then run separate fresh regression QA. No finding disappearing is proof of FIXED.",
        ];
        const grid = document.createElement("div");
        grid.className = "triage-guidance";
        for (const [index, title] of ["Potential user impact", "Investigate the cause", "Verify after repair"].entries()) {
          const item = document.createElement("section");
          item.appendChild(textNode("h4", title));
          item.appendChild(textNode("p", guidance[index]));
          grid.appendChild(item);
        }
        body.appendChild(grid);
      }
      function displayTriage(job) {
        if (!job.triage || !Array.isArray(job.triage.findings)) {
          triageSection.hidden = true;
          displayedTriage = null;
          return;
        }
        const key = job.id + ":" + job.state + ":" + job.triage.total;
        if (displayedTriage === key) return;
        displayedTriage = key;
        groupFilter = "all";
        const data = job.triage;
        triageSection.hidden = false;
        const safeNumber = (value, cap = 1000000) => Number.isSafeInteger(value) && value >= 0
          && value <= cap ? value : null;
        const safeFindings = data.findings.slice(0, 80).filter((finding) => finding
          && typeof finding === "object" && triageSeverities.includes(finding.severity)
          && triageConfidences.includes(finding.confidence));
        safeFindings.sort((left, right) => triageSeverities.indexOf(left.severity) - triageSeverities.indexOf(right.severity)
          || triageConfidences.indexOf(left.confidence) - triageConfidences.indexOf(right.confidence));
        const total = safeNumber(data.total);
        const omitted = safeNumber(data.omitted);
        triageCount.textContent = (total === null ? "Recorded" : String(total)) + " extracted finding(s), "
          + String(safeFindings.length) + " shown" + (omitted ? " · " + omitted + " omitted from this view" : "") + ".";
        triageOpenPriority.disabled = safeFindings.length === 0;
        const priority = safeFindings[0];
        triagePriorityDetail.textContent = priority
          ? "Highest priority: " + priority.severity.toUpperCase() + ". "
            + (priority.confidence === "deterministic" ? "Deterministic original observation; independently verify any repair."
              : "REVIEW lead; not a confirmed defect.")
          : "No ranked finding available. Unvisited paths are not verified.";
        coverageDetails.replaceChildren();
        const observed = Array.isArray(data.coverage) ? data.coverage : [];
        coverageDetails.appendChild(textNode("p", job.state === "partial" || job.state === "cancelled" || job.state === "failed"
          ? "Incomplete run: absence of findings is not a pass."
          : "Finished within recorded limits. Unvisited paths remain unverified."));
        const safeCoverage = new RegExp("^(?:(?:Actions|Focus states|Transitions): [0-9]{1,8} observed|(?:Routes scanned: [0-9]{1,8}(?: [/] [0-9]{1,8} cap)?|Routes discovered: [0-9]{1,8}|Routes deferred: [0-9]{1,8}|Route audits (?:failed|skipped): [0-9]{1,8}|Experimental SPA (?:states observed|states deferred|transitions|review leads): [0-9]{1,8}|Experimental SPA validated review leads: [0-9]{1,8} [(]heuristic only[)]|Browser Back checks deferred by probe limit: [0-9]{1,8}|Rapid two-Back checks deferred or incomplete: [0-9]{1,8}|Possible blank client-side routes [(]REVIEW only[)]: [0-9]{1,8}|(?:Completed|Partial|Failed) page[/]viewport checks: [0-9]{1,8}))$");
        const limits = Array.isArray(data.limits) ? data.limits : [];
        const details = [...observed.slice(0, 12).filter((text) => typeof text === "string" && safeCoverage.test(text)),
          ...limits.slice(0, 18).filter((token) => typeof token === "string"
            && /^[a-z][a-z0-9-]{0,63}$/.test(token)).map((token) => "Limit / interruption: " + token.replaceAll("-", " "))];
        if (details.length > 0) {
          const list = document.createElement("ul");
          details.forEach((detail) => list.appendChild(textNode("li", detail)));
          coverageDetails.appendChild(list);
        }
        if (Array.isArray(data.extraLinks)) {
          data.extraLinks.slice(0, 2).forEach((entry) => {
            const label = entry?.label === "Experimental SPA state graph"
              ? "Open private SPA journey graph"
              : entry?.label === "SPA journey details (may contain private page data)"
                ? "Open private SPA journey details" : null;
            const anchor = label && triageOwnedUrl(entry.url, job.id) ? makeLink(entry.url, label) : null;
            if (anchor) coverageDetails.appendChild(anchor);
          });
        }
        const groups = [];
        const countsByGroup = new Map();
        safeFindings.forEach((finding) => {
          const groupName = finding.severity + ":" + finding.confidence;
          countsByGroup.set(groupName, (countsByGroup.get(groupName) || 0) + 1);
        });
        countsByGroup.forEach((count, groupName) => {
          const [severity, confidence] = groupName.split(":");
          groups.push({ severity, confidence, count });
        });
        function filter(group) {
          groupFilter = group;
          triageGroups.querySelectorAll("button").forEach((item) => {
            item.setAttribute("aria-pressed", String(item.dataset.group === group));
          });
          triageList.replaceChildren();
          let matched = 0;
          safeFindings.forEach((finding, index) => {
            const groupName = finding.severity + ":" + finding.confidence;
            if (group !== "all" && group !== groupName) return;
            matched += 1;
            const detail = document.createElement("details");
            detail.dataset.priority = finding.severity;
            detail.dataset.review = finding.confidence === "deterministic" ? "observation" : "review";
            const summary = document.createElement("summary");
            summary.appendChild(textNode("strong", "Priority " + (index + 1) + " · "
              + (triageRuleNames.get(finding.rule) || "Recorded finding for manual review")));
            summary.appendChild(textNode("span", finding.severity.toUpperCase() + " · "
              + (finding.confidence === "deterministic" ? "Deterministic original observation"
                : "REVIEW · " + finding.confidence) + " · " + triageSource(finding.source)));
            detail.appendChild(summary);
            const body = document.createElement("div");
            body.className = "triage-body";
            body.appendChild(textNode("p", finding.confidence === "deterministic"
              ? "This is a recorded original observation, not proof of a repaired outcome."
              : "REVIEW ONLY. Confirm the observation and expected behaviour before treating this as a defect."));
            triageActionGuidance(body, finding);
            if (finding.rule === "spa.route-content-missing" && finding.confidence === "heuristic") {
              body.appendChild(textNode("p", "Optional next step: independently author the expected healthy destination MAIN content and its SHA-256 (not from the blank route or a repaired response). Run tvdoctor spa-route-health --help in your own terminal to review the authorised capture, verify and acceptance workflow. This REVIEW lead remains unverified; do not assume FIXED without source-bound fresh-browser proof and separate regression QA."));
            }
            if (finding.spaBackReview && finding.spaBackReview.reviewRequired === true
              && ["spa.history-back-stale-view", "spa.history-back-interrupted-stale-view"].includes(finding.rule)) {
              const back = finding.spaBackReview;
              const doubleBack = finding.rule === "spa.history-back-interrupted-stale-view"
                && back.observedBackTransitions === 2;
              body.appendChild(textNode("p", "REVIEW ONLY — a bounded "
                + (doubleBack ? "pair of rapid, genuine Chromium browser Back actions" : "browser Back observation")
                + " suggests a stale heading. This is not a verified replay or a confirmed defect."));
              if ([back.observedBackTransitions, back.settledSamples, back.expectedStateNumber,
                back.forwardStateNumber, back.forwardEdgeNumber, back.recordedForwardSetupSteps]
                .every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 10000)) {
                body.appendChild(textNode("p", "Back observation: " + back.observedBackTransitions
                  + " native history transition(s) after " + back.settledSamples
                  + " bounded settle samples. Expected restored state " + back.expectedStateNumber
                  + "; recorded final forward state " + back.forwardStateNumber + "."));
              }
              body.appendChild(textNode("p", "Check the recorded Back evidence and deferred frontier manually. Browser history may change after this scan."));
              if (triageOwnedUrl(finding.imageUrl, job.id) && (doubleBack
                ? /\\/spa\\/evidence\\/back-interrupted-edge-[0-9]{3}\\.png$/i.test(finding.imageUrl)
                : /\\/spa\\/evidence\\/back-edge-[0-9]{3}\\.png$/i.test(finding.imageUrl))) {
                body.appendChild(textNode("p", "A witnessed browser " + (doubleBack ? "two-Back" : "Back")
                  + " screenshot is available. It may contain private page content; load it only when ready to review locally. No video or deterministic replay of Back is implied."));
                const loadImage = textNode("button", "Load local Back screenshot");
                loadImage.type = "button";
                loadImage.className = "secondary";
                const image = document.createElement("img");
                image.loading = "lazy";
                image.alt = "Recorded browser Back screenshot; heuristic evidence only";
                image.hidden = true;
                loadImage.addEventListener("click", () => {
                  image.src = finding.imageUrl;
                  image.hidden = false;
                  loadImage.hidden = true;
                });
                body.appendChild(loadImage);
                body.appendChild(image);
              }
            } else if (finding.spaReview && finding.spaReview.reviewRequired === true
              && typeof finding.rule === "string" && finding.rule.startsWith("spa.")) {
              const spa = finding.spaReview;
              body.appendChild(textNode("p", finding.rule === "spa.route-content-missing"
                ? "REVIEW ONLY — blank MAIN content after a client-side route change is an observation, not proof that the destination is broken."
                : "REVIEW ONLY — observed UI mismatch; not a verified accessibility defect."));
              if ([spa.stateNumber, spa.stateDepth, spa.edgeNumber, spa.stateReplaySteps,
                spa.edgeReplaySteps, spa.verifiedCheckpoints].every((value) => Number.isSafeInteger(value)
                && value >= 0 && value <= 10000)) {
                body.appendChild(textNode("p", "Observed state " + spa.stateNumber + " (depth " + spa.stateDepth
                  + "), observed edge " + spa.edgeNumber + "."));
                body.appendChild(textNode("p", "State path: " + spa.stateReplaySteps
                  + " checkpoint-verified step(s); observed edge replay: " + spa.edgeReplaySteps
                  + " recorded step(s) and " + spa.verifiedCheckpoints + " recorded verified checkpoint(s)."));
              }
              body.appendChild(textNode("p", "Replay steps are not a guarantee of future reproduction. Check the graph and deferred frontier before filing."));
            } else {
              body.appendChild(textNode("p", "Confidence describes evidence certainty; reproduce suspected failures before filing."));
            }
            if (finding.freshContextVerification && finding.confidence !== "deterministic") {
              const proof = finding.freshContextVerification;
              if (["reobserved", "not-reobserved", "deferred"].includes(proof.status)
                && ["matched-observation", "observation-differed", "source-checkpoint-drift",
                  "action-blocked", "post-action-unsettled", "budget-exhausted", "unsupported-rule"].includes(proof.reason)
                && [proof.replayStepsVerified, proof.actions, proof.durationMs]
                  .every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 120000)) {
                body.appendChild(textNode("p", "Fresh Chromium-context re-observation: " + proof.status
                  + " (" + proof.reason + "). " + proof.replayStepsVerified + " exact checkpoint(s), "
                  + proof.actions + " extra action(s), " + proof.durationMs + " ms. "
                  + "This remains a heuristic review lead, not a deterministic bug proof. "
                  + "Replaying an interaction may have side effects."));
              }
            }
            const open = triageOwnedUrl(finding.reportUrl, job.id)
              ? makeLink(finding.reportUrl, "Inspect local evidence") : null;
            if (open) body.appendChild(open);
            if (Number.isSafeInteger(finding.recordedReplayActions) && finding.recordedReplayActions >= 0
              && finding.recordedReplayActions <= 250) {
              body.appendChild(textNode("p", "Recorded replay actions: " + finding.recordedReplayActions
                + " (not a fresh verified replay or checkpoint count)."));
            }
            if (!finding.spaBackReview && triageOwnedUrl(finding.imageUrl, job.id)
              && /\\.(?:png|jpg|jpeg)$/i.test(finding.imageUrl)) {
              const preview = document.createElement("img");
              preview.src = finding.imageUrl;
              preview.loading = "lazy";
              preview.alt = "Recorded image evidence for finding";
              body.appendChild(preview);
            }
            if (triageOwnedUrl(finding.videoUrl, job.id) && /\\.webm$/i.test(finding.videoUrl)) {
              const videoLink = makeLink(finding.videoUrl, "Open issue-specific witnessed replay video");
              if (videoLink) body.appendChild(videoLink);
              const load = textNode("button", "Load local issue video");
              load.type = "button";
              load.className = "secondary";
              const clip = document.createElement("video");
              clip.controls = true;
              clip.preload = "none";
              clip.playsInline = true;
              clip.hidden = true;
              clip.setAttribute("aria-label", "Issue-specific replay recording");
              load.addEventListener("click", () => {
                clip.src = finding.videoUrl;
                clip.hidden = false;
                load.hidden = true;
                clip.load();
              });
              body.appendChild(load);
              body.appendChild(clip);
              body.appendChild(textNode("p", "Local video can contain private page content. Review before sharing."));
            }
            if (triageOwnedUrl(finding.testExportUrl, job.id) && /\\.spec\\.js$/i.test(finding.testExportUrl)) {
              const script = makeLink(finding.testExportUrl, "Open validated Playwright test (contains target URL)");
              if (script) body.appendChild(script);
            }
            detail.appendChild(body);
            triageList.appendChild(detail);
          });
          if (matched === 0) {
            triageList.appendChild(textNode("p",
              total === 0 ? "No findings recorded for observed coverage. This does not certify the application." : "No displayed findings in this group.",
              "muted"));
          }
        }
        triageGroups.replaceChildren();
        const all = textNode("button", "All · " + safeFindings.length);
        all.type = "button";
        all.dataset.group = "all";
        all.addEventListener("click", () => filter("all"));
        triageGroups.appendChild(all);
        groups.forEach((group) => {
          const filterKey = String(group.severity) + ":" + String(group.confidence);
          const item = textNode("button", group.severity + " · " + group.confidence + " (" + group.count + ")");
          item.type = "button";
          item.dataset.group = filterKey;
          item.addEventListener("click", () => filter(filterKey));
          triageGroups.appendChild(item);
        });
        filter("all");
        triageOpenPriority.onclick = () => {
          if (safeFindings.length === 0) return;
          filter("all");
          const first = triageList.querySelector("details");
          if (first) {
            first.open = true;
            first.querySelector("summary")?.focus();
          }
        };
      }
      function displayVideo(job) {
        const url = job.videoUrl;
        const safe = typeof url === "string"
          && /^\\/reports\\/[0-9a-f-]{36}\\/video\\/audit-session\\.webm$/i.test(url);
        videoPanel.hidden = !safe;
        if (!safe) {
          displayedVideo = null;
          sessionVideo.pause();
          sessionVideo.removeAttribute("src");
          sessionVideo.hidden = true;
          loadVideo.hidden = false;
          return;
        }
        if (displayedVideo !== url) {
          displayedVideo = url;
          sessionVideo.pause();
          sessionVideo.removeAttribute("src");
          sessionVideo.hidden = true;
          loadVideo.hidden = false;
        }
      }
      loadVideo.addEventListener("click", () => {
        if (!displayedVideo) return;
        sessionVideo.src = displayedVideo;
        sessionVideo.hidden = false;
        loadVideo.hidden = true;
        sessionVideo.load();
      });
      const historyTypes = new Map([
        ["navigation", "Navigation scan"], ["site", "Website routes"],
        ["responsive", "Responsive check"], ["qa", "Website QA"],
        ["qa-accept", "QA repair verification"], ["project", "Project QA"],
        ["project-accept", "Project repair verification"],
        ["route-health", "Public route capture"],
        ["route-health-accept", "Public route verification"],
        ["spa-route-health", "SPA route-content capture"],
        ["spa-route-health-accept", "SPA route-content acceptance"],
        ["boot-health", "Initial blank-page capture"],
        ["boot-health-accept", "Initial page repair acceptance"],
      ]);
      const historyStates = new Map([
        ["running", "Running"], ["cancelling", "Stopping"],
        ["completed", "Completed"], ["partial", "Partial"],
        ["failed", "Failed"], ["cancelled", "Cancelled"],
      ]);
      const historyStatuses = new Set([
        "ACTION_REQUIRED", "REVIEW_REQUIRED", "NO_VERIFIED_FAILURES_IN_COVERAGE", "INCONCLUSIVE",
        "REPRODUCED", "REGRESSION_FOUND", "PASS", "NEW_VERIFIED", "ROUTE_RESTORED",
        "VERIFIED_ORIGINAL", "ROUTE_CONTENT_RESTORED", "PAGE_CONTENT_RESTORED",
        "FINDINGS", "ERROR", "COMPLETED", "INCOMPLETE", "FAILED",
      ]);
      const historyUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      function historyTime(value) {
        if (typeof value !== "string" || !/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$/.test(value)) return "";
        const timestamp = Date.parse(value);
        return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : "";
      }
      function historyCounts(summary) {
        if (!summary || typeof summary !== "object" || Array.isArray(summary)) return "";
        const names = [["verified", "VERIFIED"], ["review", "REVIEW"], ["untested", "UNTESTED"]];
        return names.filter(([key]) => Number.isSafeInteger(summary[key])
          && summary[key] >= 0 && summary[key] <= 1000000)
          .map(([key, name]) => name + " " + summary[key]).join(" · ");
      }
      function updateHistorySelection() {
        historyList.querySelectorAll("button").forEach((item) => {
          item.setAttribute("aria-current", String(item.dataset.jobId === selectedHistoryId));
        });
      }
      async function openHistory(id) {
        if (!historyUuid.test(id) || historyBusy && loadingHistoryId === id) return;
        loadingHistoryId = id;
        historyStatus.textContent = "Opening saved result…";
        try {
          const response = await fetch("/api/jobs/" + id, { cache: "no-store" });
          if (!response.ok) throw new Error("Unavailable");
          const job = await response.json();
          if (loadingHistoryId !== id) return;
          if (!job || job.id !== id || !historyTypes.has(job.type)
            || !historyStates.has(job.state)) throw new Error("Invalid saved result");
          selectedHistoryId = id;
          // The trusted server owns job status. Do not repeat any application-authored message.
          render({ ...job, message: undefined }, true);
          historyStatus.textContent = "Previous result opened. Live scanning continues separately.";
          updateHistorySelection();
        } catch {
          if (loadingHistoryId === id) historyStatus.textContent = "Previous result is unavailable in this session. Live scanning is unaffected.";
        } finally {
          if (loadingHistoryId === id) loadingHistoryId = null;
        }
      }
      async function refreshHistory() {
        if (historyBusy) return;
        historyBusy = true;
        historyRefresh.disabled = true;
        try {
          const response = await fetch("/api/history", { cache: "no-store" });
          if (!response.ok) throw new Error("History unavailable");
          const data = await response.json();
          if (!data || data.schemaVersion !== "tvdoctor.local-history/v1" || !Array.isArray(data.jobs)) {
            throw new Error("Invalid history");
          }
          const seen = new Set();
          const entries = data.jobs.slice(0, 10).filter((entry) => {
            if (!entry || typeof entry !== "object" || !historyUuid.test(entry.id || "")
              || !historyTypes.has(entry.type) || !historyStates.has(entry.state)
              || seen.has(entry.id)) return false;
            seen.add(entry.id);
            return true;
          });
          historyList.replaceChildren();
          entries.forEach((entry) => {
            const item = document.createElement("button");
            item.type = "button";
            item.dataset.jobId = entry.id;
            item.setAttribute("aria-label", "Open previous result: " + historyTypes.get(entry.type)
              + ", " + historyStates.get(entry.state) + ", run " + entry.id.slice(0, 8));
            const label = document.createElement("strong");
            label.textContent = historyTypes.get(entry.type);
            const state = document.createElement("span");
            state.textContent = historyStates.get(entry.state)
              + (historyStatuses.has(entry.status) ? " · " + entry.status.replaceAll("_", " ") : "");
            const started = document.createElement("span");
            const time = historyTime(entry.startedAt);
            started.textContent = time ? "Started " + time : "Time unavailable";
            item.appendChild(label);
            item.appendChild(state);
            item.appendChild(started);
            const counts = historyCounts(entry.summary);
            if (counts) {
              const totals = document.createElement("span");
              totals.textContent = counts;
              item.appendChild(totals);
            }
            const action = document.createElement("span");
            action.textContent = "Open previous result";
            item.appendChild(action);
            item.addEventListener("click", () => { void openHistory(entry.id); });
            historyList.appendChild(item);
          });
          historyStatus.textContent = entries.length ? "Showing " + entries.length + " recent run(s)."
            : "No runs recorded in this local session yet.";
          lastHistoryStamp = historyStamp(currentLiveJob);
          updateHistorySelection();
        } catch {
          historyStatus.textContent = "Recent runs unavailable. The current scan is unaffected.";
        } finally {
          historyBusy = false;
          historyRefresh.disabled = false;
        }
      }
      function historyStamp(job) {
        return String(job?.id || "idle") + ":" + String(job?.state || "idle");
      }
      historyRefresh.addEventListener("click", () => { void refreshHistory(); });
      historyBackLive.addEventListener("click", () => {
        loadingHistoryId = null;
        selectedHistoryId = null;
        render(currentLiveJob);
        updateHistorySelection();
        historyStatus.textContent = "Showing live/current result.";
      });
      function render(job, historical = false) {
        resultsHeading.textContent = historical ? "Previous run result" : "Latest result";
        resultsDescription.textContent = historical ? "Saved result from this local session."
          : "Updates automatically as the scanner runs.";
        historyViewNote.hidden = !historical;
        historyBackLive.hidden = !historical;
        const state = job.state || "idle";
        const qa = job.type === "qa";
        const acceptance = job.type === "qa-accept";
        const project = job.type === "project";
        const projectAcceptance = job.type === "project-accept";
        const routeHealth = job.type === "route-health";
        const routeHealthAcceptance = job.type === "route-health-accept";
        const spaHealth = job.type === "spa-route-health";
        const spaAcceptance = job.type === "spa-route-health-accept";
        const bootHealth = job.type === "boot-health";
        const bootAcceptance = job.type === "boot-health-accept";
        activeJobId = !historical && typeof job.id === "string" ? job.id : null;
        status.dataset.state = state;
        status.dataset.qaStatus = qa && job.qa ? job.qa.status
          : acceptance && job.acceptance ? job.acceptance.status
            : project && job.project ? job.project.status
              : projectAcceptance && job.projectAcceptance ? job.projectAcceptance.status
                : routeHealth && job.routeHealth ? job.routeHealth.status
                  : routeHealthAcceptance && job.routeHealthAcceptance ? job.routeHealthAcceptance.status
                  : spaHealth && job.spaRouteHealth
                    ? ["VERIFIED_ORIGINAL", "INCONCLUSIVE"].includes(job.spaRouteHealth.status)
                      ? job.spaRouteHealth.status : "INCONCLUSIVE"
                    : spaAcceptance && job.spaRouteHealthAcceptance
                      ? spaAcceptIsRestored(job) ? "ROUTE_CONTENT_RESTORED" : "INCONCLUSIVE"
                      : bootHealth && job.bootHealth
                        ? ["VERIFIED_ORIGINAL", "INCONCLUSIVE"].includes(job.bootHealth.status)
                          ? job.bootHealth.status : "INCONCLUSIVE"
                        : bootAcceptance && job.bootHealthAcceptance
                          ? bootAcceptIsRestored(job) ? "PAGE_CONTENT_RESTORED" : "INCONCLUSIVE" : "";
        status.textContent = state === "idle" ? "Ready"
          : state === "running" ? "Scanning…"
          : state === "cancelling" ? "Stopping…"
          : state === "cancelled" ? "Cancelled"
          : qa && job.qa ? job.qa.status.replaceAll("_", " ")
          : acceptance && job.acceptance ? job.acceptance.status.replaceAll("_", " ")
          : project && job.project ? job.project.status.replaceAll("_", " ")
          : projectAcceptance && job.projectAcceptance ? job.projectAcceptance.status.replaceAll("_", " ")
          : routeHealth && job.routeHealth ? routeHealthStatus(job.routeHealth.status)
          : routeHealthAcceptance && job.routeHealthAcceptance ? routeHealthStatus(job.routeHealthAcceptance.status)
          : spaHealth && job.spaRouteHealth ? routeHealthStatus(job.spaRouteHealth.status)
          : spaAcceptance && job.spaRouteHealthAcceptance
            ? job.spaRouteHealthAcceptance.status === "ROUTE_CONTENT_RESTORED"
              ? spaAcceptIsRestored(job) ? "ROUTE CONTENT RESTORED" : "INCONCLUSIVE"
              : ["REPRODUCED", "NEW_VERIFIED", "INCONCLUSIVE", "ERROR"].includes(job.spaRouteHealthAcceptance.status)
                ? job.spaRouteHealthAcceptance.status.replaceAll("_", " ") : "Unverified"
          : bootHealth && job.bootHealth
            ? ["VERIFIED_ORIGINAL", "INCONCLUSIVE"].includes(job.bootHealth.status)
              ? job.bootHealth.status.replaceAll("_", " ") : "INCONCLUSIVE"
          : bootAcceptance && job.bootHealthAcceptance
            ? job.bootHealthAcceptance.status === "PAGE_CONTENT_RESTORED"
              ? bootAcceptIsRestored(job) ? "PAGE CONTENT RESTORED" : "INCONCLUSIVE"
              : ["REPRODUCED", "NEW_VERIFIED", "INCONCLUSIVE", "ERROR"].includes(job.bootHealthAcceptance.status)
                ? job.bootHealthAcceptance.status.replaceAll("_", " ") : "INCONCLUSIVE"
          : state === "partial" ? "Partial · review limits"
          : state === "completed" ? "Scan finished" : "Scan failed";
        const acceptanceLead = !acceptance || !job.acceptance ? null
          : job.acceptance.status === "REPRODUCED"
            ? ["Original failures still reproduced", job.acceptance.verification.reproduced]
            : job.acceptance.status === "REGRESSION_FOUND"
              ? ["Fresh QA verified failures", job.acceptance.regression.verified]
              : job.acceptance.status === "PASS"
                ? ["Original issues independently fixed", job.acceptance.verification.fixed]
                : job.acceptance.status === "INCONCLUSIVE"
                  ? ["Original checks inconclusive", job.acceptance.verification.status === "NOT_RUN"
                    ? null : job.acceptance.verification.inconclusive]
                  : ["Acceptance did not complete", null];
        const projectAcceptanceLead = !projectAcceptance || !job.projectAcceptance ? null
          : job.projectAcceptance.status === "INCONCLUSIVE"
            ? ["Original checks inconclusive", job.projectAcceptance.verification?.status === "NOT_RUN"
              ? null : job.projectAcceptance.verification?.inconclusive]
            : job.projectAcceptance.status === "REPRODUCED"
              ? ["Original failures still reproduced", job.projectAcceptance.verification?.reproduced]
              : job.projectAcceptance.status === "NEW_VERIFIED"
                ? ["Fresh QA verified failures", job.projectAcceptance.regression?.verified]
                : job.projectAcceptance.status === "PASS"
                  ? ["Original issues independently fixed", job.projectAcceptance.verification?.fixed]
                  : ["Acceptance did not complete", null];
        metricName.textContent = bootHealth ? "Original blank-page content witness"
          : bootAcceptance ? "Fresh QA VERIFIED findings"
          : spaHealth ? "Original SPA missing-content witness"
          : spaAcceptance ? "Fresh QA VERIFIED findings"
          : routeHealth ? "Original public HTTP 404/410"
          : routeHealthAcceptance ? "Fresh QA VERIFIED findings"
          : projectAcceptance ? (projectAcceptanceLead?.[0] || "Project verification in progress")
          : project ? "Original project VERIFIED findings"
            : acceptance ? (acceptanceLead?.[0] || "Verification in progress")
              : qa ? "Verified original findings" : "Findings reported";
        findings.textContent = bootHealth ? (job.bootHealth?.status === "VERIFIED_ORIGINAL" ? "Pinned" : "—")
          : bootAcceptance ? (job.bootHealthAcceptance?.regression?.status === "COMPLETED"
            && Number.isSafeInteger(job.bootHealthAcceptance.regression.verified)
            && job.bootHealthAcceptance.regression.verified >= 0
              ? String(job.bootHealthAcceptance.regression.verified) : "—")
          : spaHealth ? (job.spaRouteHealth?.status === "VERIFIED_ORIGINAL" ? "Pinned" : "—")
          : spaAcceptance ? (job.spaRouteHealthAcceptance?.regression?.status === "COMPLETED"
            && Number.isSafeInteger(job.spaRouteHealthAcceptance.regression.verified)
            && job.spaRouteHealthAcceptance.regression.verified >= 0
              ? String(job.spaRouteHealthAcceptance.regression.verified) : "—")
          : routeHealth ? (job.routeHealth?.status === "VERIFIED_ORIGINAL" ? "404/410" : "—")
          : routeHealthAcceptance ? (job.routeHealthAcceptance?.regression?.status === "COMPLETED"
            && Number.isSafeInteger(job.routeHealthAcceptance.regression.verified)
              ? String(job.routeHealthAcceptance.regression.verified) : "—")
          : projectAcceptance
          ? (Number.isSafeInteger(projectAcceptanceLead?.[1]) ? String(projectAcceptanceLead[1]) : "—")
          : project ? (Number.isSafeInteger(job.project?.summary?.verified) ? String(job.project.summary.verified) : "—")
          : acceptance
          ? (Number.isSafeInteger(acceptanceLead?.[1]) ? String(acceptanceLead[1]) : "—")
          : qa
          ? (Number.isSafeInteger(job.qa?.summary?.verified) ? String(job.qa.summary.verified) : "—")
          : (Number.isSafeInteger(job.issueCount) ? String(job.issueCount) : "—");
        const currentState = historical ? currentLiveJob.state : state;
        button.disabled = historical || currentState === "running" || currentState === "cancelling";
        button.textContent = state === "running" ? "Scan running…"
          : state === "cancelling" ? "Stopping scan…" : isBootHealth() ? "Capture original blank public page"
            : isSpaRouteHealth() ? "Capture original SPA route observation"
            : isRouteHealth() ? "Capture original 404/410"
            : isProject() ? "Run project QA"
            : isQa() ? "Run website QA" : "Start " + scanType.value + " scan";
        cancel.hidden = historical || state !== "running" && state !== "cancelling";
        cancel.disabled = historical || state !== "running";
        message.textContent = bootHealth || bootAcceptance
          ? bootAcceptance ? "Independent verification checks authored complete MAIN content twice around fresh QA; this is never a whole-site safety verdict."
            : "Blank initial MAIN content can be intentional or a hydration delay; a source-bound original witness is not a FIXED claim."
          : spaHealth || spaAcceptance
          ? spaAcceptance ? "Exact SPA route acceptance requires two independent authored-content observations and complete separate QA."
            : "An observed blank SPA destination remains REVIEW until an original witness and independent repaired-state proof are available."
          : job.message || (state === "running"
          ? "Checking observed paths within the selected limits. Browser setup may extend the run."
          : isProject() ? "Run project QA to review original results by route."
            : isQa() ? "Run QA to see verified originals, review leads, coverage limits and a repair brief."
              : "Start a scan to see findings and coverage.");
        const metrics = job.metrics || {};
        const routesVisited = metrics.routesVisited;
        const routeLimit = Number.isSafeInteger(metrics.routesLimit) ? metrics.routesLimit : job.maxRoutes;
        routesCount.hidden = !Number.isSafeInteger(routesVisited);
        if (!routesCount.hidden) routeValue.textContent = String(routesVisited) + (Number.isSafeInteger(routeLimit) ? " / " + routeLimit : "");
        viewportsCount.hidden = !Number.isSafeInteger(metrics.viewportsTested);
        if (!viewportsCount.hidden) {
          viewportValue.textContent = String(metrics.viewportsTested)
            + (Number.isSafeInteger(metrics.viewportsRequested) ? " / " + metrics.viewportsRequested : "");
        }
        counts.hidden = routesCount.hidden && viewportsCount.hidden;
        links.replaceChildren();
        acceptButton.hidden = !(qa && job.acceptReady && state === "completed");
        acceptSummary.hidden = !acceptance || !job.acceptance;
        renderProject(job);
        renderRouteHealth(job);
        renderSpaRouteHealth(job);
        renderBootHealth(job);
        if (qa) {
          addLink(job.qa?.links?.brief, "Open coding-agent repair brief");
          addLink(job.qa?.links?.report, "Inspect original QA report");
          addLink(job.qa?.links?.handoff, "Open structured repair handoff");
          addLink(job.qa?.links?.summary, "Open QA run summary");
          qaSummary.hidden = !job.qa;
          acceptGuidance.textContent = job.qa?.status === "ACTION_REQUIRED" && !job.acceptReady
            ? "The current run cannot be accepted independently here, typically because coverage is incomplete or the original evidence is unsupported. Run a complete QA scan before verifying repairs."
            : job.acceptReady
              ? "Only click after deploying your repair to the same authorized URL. The original evidence will be retained while a fresh run checks for new VERIFIED failures."
              : "Use the original evidence and repair brief to decide what needs investigation.";
          if (job.qa) {
            const result = job.qa;
            document.getElementById("qa-status-detail").textContent = result.status === "ACTION_REQUIRED"
              ? "VERIFIED originals are supported by the recorded run. The repair brief contains the evidence and supported reproduction commands."
              : result.status === "REVIEW_REQUIRED"
                ? "The recorded run has review leads or incomplete coverage. They require inspection before being called defects."
                : result.status === "NO_VERIFIED_FAILURES_IN_COVERAGE"
                  ? "No verified failures appeared in the measured coverage. This is not a comprehensive pass."
                  : result.summary
                    ? "INCONCLUSIVE: recorded counts are partial observations. Some paths or evidence are incomplete. No clean-run verdict is implied."
                    : "INCONCLUSIVE: the QA engine could not establish complete evidence. Counts are unknown.";
            for (const [id, key] of [["qa-verified", "verified"], ["qa-review", "review"],
              ["qa-untested", "untested"], ["qa-incomplete", "incompleteRoutes"]]) {
              const value = result.summary && result.summary[key];
              document.getElementById(id).textContent = Number.isSafeInteger(value) ? String(value) : "—";
            }
          }
        } else if (acceptance) {
          qaSummary.hidden = true;
          addLink(job.acceptance?.links?.summary, "Open acceptance summary");
          addLink(job.acceptance?.links?.verification, "Inspect independent original verification");
          addLink(job.acceptance?.links?.regression, "Inspect fresh post-repair QA");
          addLink(job.acceptance?.originalLinks?.brief, "Reopen original repair brief");
          addLink(job.acceptance?.originalLinks?.report, "Reopen original QA report");
          if (job.acceptance) {
            const result = job.acceptance;
            const verification = result.verification.status === "NOT_RUN" ? null : result.verification;
            const regression = result.regression.status === "NOT_RUN" ? null : result.regression;
            document.getElementById("accept-detail").textContent = result.status === "PASS"
              ? "PASS: supported original findings were independently FIXED and the new bounded QA had zero VERIFIED failures. Remaining REVIEW and UNTESTED evidence still require attention."
              : result.status === "REPRODUCED"
                ? "REPRODUCED: at least one original failure persisted after the repair. Inspect the independent verification."
                : result.status === "REGRESSION_FOUND"
                  ? "Fresh QA found VERIFIED failures. The result alone does not show whether the repair introduced them."
                  : result.status === "INCONCLUSIVE"
                    ? "INCONCLUSIVE: replay or regression QA did not supply complete evidence. No FIXED verdict is implied."
                    : "Acceptance could not complete. No repair verdict was certified.";
            for (const [id, value] of [
              ["accept-fixed", verification?.fixed],
              ["accept-reproduced", verification?.reproduced],
              ["accept-inconclusive", verification?.inconclusive],
              ["accept-regression", regression?.verified],
              ["accept-review", regression?.review],
              ["accept-untested", regression?.untested],
            ]) document.getElementById(id).textContent = Number.isSafeInteger(value) ? String(value) : "—";
          }
        } else if (!project && !projectAcceptance && !routeHealth && !routeHealthAcceptance
          && !spaHealth && !spaAcceptance && !bootHealth && !bootAcceptance) {
          qaSummary.hidden = true;
          addLink(job.reportUrl, "Open HTML report");
          addLink(job.graphUrl, "Explore navigation graph");
          addLink(job.videoUrl, "Open session recording");
          if (Array.isArray(job.evidenceUrls)) {
            job.evidenceUrls.slice(0, 6).forEach((path, index) => addLink(path, "Evidence " + (index + 1)));
          }
        }
        displayVideo(job);
        displayTriage(job);
        if (historical) {
          acceptButton.hidden = true;
          projectAcceptButton.hidden = true;
          routeHealthAcceptButton.hidden = true;
          routeHealthRetryButton.hidden = true;
          spaAcceptButton.hidden = true;
          spaRetryButton.hidden = true;
          bootHealthAcceptButton.hidden = true;
          bootHealthRetryButton.hidden = true;
        }
      }
      cancel.addEventListener("click", async () => {
        if (activeJobId === null) return;
        cancel.disabled = true;
        error.textContent = "";
        try {
          const response = await fetch("/api/scans/" + encodeURIComponent(activeJobId) + "/cancel", {
            method: "POST", credentials: "same-origin",
            headers: { "X-TVDoctor-CSRF": csrfToken },
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || "Unable to cancel the scan.");
          render(result);
        } catch (failure) {
          error.textContent = failure instanceof Error ? failure.message : "Unable to cancel the scan.";
          await refresh();
        }
      });
      acceptButton.addEventListener("click", async () => {
        if (activeJobId === null || acceptButton.hidden) return;
        acceptButton.disabled = true;
        acceptError.textContent = "";
        try {
          const response = await fetch("/api/qa/" + encodeURIComponent(activeJobId) + "/accept", {
            method: "POST", credentials: "same-origin",
            headers: { "X-TVDoctor-CSRF": csrfToken },
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || "Unable to start post-repair verification.");
          render(result);
        } catch (failure) {
          acceptError.textContent = failure instanceof Error ? failure.message : "Unable to start post-repair verification.";
          await refresh();
        } finally { acceptButton.disabled = false; }
      });
      projectAcceptButton.addEventListener("click", async () => {
        if (activeJobId === null || projectAcceptButton.hidden || projectAcceptButton.disabled) return;
        projectAcceptButton.disabled = true;
        document.getElementById("project-action-error").textContent = "";
        try {
          const response = await fetch("/api/project/" + encodeURIComponent(activeJobId) + "/accept", {
            method: "POST", credentials: "same-origin",
            headers: { "X-TVDoctor-CSRF": csrfToken },
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || "Unable to independently verify project repairs.");
          render(result);
        } catch (failure) {
          document.getElementById("project-action-error").textContent = failure instanceof Error
            ? failure.message : "Unable to independently verify project repairs.";
          await refresh();
        } finally { projectAcceptButton.disabled = false; }
      });
      routeHealthAcceptButton.addEventListener("click", async () => {
        if (activeJobId === null || routeHealthAcceptButton.hidden || routeHealthAcceptPending
          || routeHealthAcceptButton.disabled) return;
        routeHealthAcceptPending = true;
        routeHealthAcceptButton.disabled = true;
        const actionError = document.getElementById("route-health-action-error");
        actionError.textContent = "";
        try {
          const response = await fetch("/api/route-health/" + encodeURIComponent(activeJobId) + "/accept", {
            method: "POST", credentials: "same-origin",
            headers: { "X-TVDoctor-CSRF": csrfToken },
          });
          const result = await response.json();
          if (!response.ok) throw new Error("Could not start independent public route acceptance. Check the pinned original and retry.");
          render(result);
        } catch {
          actionError.textContent = "Could not start independent public route acceptance. Check the pinned original and retry.";
          await refresh();
        } finally {
          routeHealthAcceptPending = false;
          routeHealthAcceptButton.disabled = routeHealthAcceptButton.hidden;
        }
      });
      routeHealthRetryButton.addEventListener("click", async () => {
        const originalId = routeHealthRetryOriginalId;
        if (routeHealthRetryButton.hidden || routeHealthRetryButton.disabled || routeHealthAcceptPending
          || originalId === null) return;
        routeHealthAcceptPending = true;
        routeHealthRetryButton.disabled = true;
        const actionError = document.getElementById("route-health-retry-error");
        actionError.textContent = "";
        try {
          const response = await fetch("/api/route-health/" + originalId + "/accept", {
            method: "POST", credentials: "same-origin",
            headers: { "X-TVDoctor-CSRF": csrfToken },
          });
          if (!response.ok) throw new Error(response.status === 409
            ? "Retry rejected: the original evidence or configuration is no longer valid or available."
            : "Retry could not start. Review the latest local verification status.");
          render(await response.json());
        } catch (failure) {
          actionError.textContent = failure instanceof Error ? failure.message
            : "Retry could not start. Review the latest local verification status.";
          await refresh();
        } finally {
          routeHealthAcceptPending = false;
          routeHealthRetryButton.disabled = routeHealthRetryButton.hidden;
        }
      });
      async function submitSpaAcceptance(originalId, actionButton, errorId) {
        if (spaAcceptPending || actionButton.hidden || actionButton.disabled
          || typeof originalId !== "string" || !historyUuid.test(originalId)) return;
        spaAcceptPending = true;
        actionButton.disabled = true;
        const actionError = document.getElementById(errorId);
        actionError.textContent = "";
        try {
          const response = await fetch("/api/spa-route-health/" + originalId + "/accept", {
            method: "POST", credentials: "same-origin", headers: { "X-TVDoctor-CSRF": csrfToken },
          });
          if (!response.ok) throw new Error(response.status === 409
            ? "The server rejected the original witness or source configuration. Repair verification is unavailable until the original SHA-pinned evidence is valid."
            : "Could not start independent SPA route verification. Review the local server status.");
          const accepted = await response.json();
          currentLiveJob = accepted;
          selectedHistoryId = null;
          render(accepted);
          updateHistorySelection();
        } catch (failure) {
          actionError.textContent = failure instanceof Error ? failure.message
            : "Could not start independent SPA route verification.";
          await refresh();
        } finally {
          spaAcceptPending = false;
          actionButton.disabled = actionButton.hidden;
        }
      }
      spaAcceptButton.addEventListener("click", async () => {
        if (!activeJobId || !historyUuid.test(activeJobId)) return;
        await submitSpaAcceptance(activeJobId, spaAcceptButton, "spa-route-health-action-error");
      });
      spaRetryButton.addEventListener("click", async () => {
        await submitSpaAcceptance(spaAcceptOriginalId, spaRetryButton, "spa-route-health-retry-error");
      });
      async function submitBootAcceptance(originalId, control, errorId) {
        if (bootAcceptPending || control.hidden || control.disabled || selectedHistoryId !== null
          || typeof originalId !== "string" || !historyUuid.test(originalId)) return;
        bootAcceptPending = true;
        control.disabled = true;
        const actionError = document.getElementById(errorId);
        actionError.textContent = "";
        try {
          const response = await fetch("/api/boot-health/" + originalId + "/accept", {
            method: "POST", credentials: "same-origin", headers: { "X-TVDoctor-CSRF": csrfToken },
          });
          if (!response.ok) throw new Error(response.status === 409
            ? "The server rejected the pinned original evidence or private configuration; no repair result was established."
            : "Could not start independent blank-page repair verification. Inspect local server status.");
          const accepted = await response.json();
          currentLiveJob = accepted;
          selectedHistoryId = null;
          loadingHistoryId = null;
          render(accepted);
          updateHistorySelection();
        } catch (failure) {
          actionError.textContent = failure instanceof Error ? failure.message
            : "Could not start independent blank-page repair verification.";
          actionError.focus();
          await refresh();
        } finally {
          bootAcceptPending = false;
          control.disabled = control.hidden;
        }
      }
      bootHealthAcceptButton.addEventListener("click", async () => {
        if (activeJobId === null || !historyUuid.test(activeJobId)) return;
        await submitBootAcceptance(activeJobId, bootHealthAcceptButton, "boot-health-action-error");
      });
      bootHealthRetryButton.addEventListener("click", async () => {
        await submitBootAcceptance(bootAcceptOriginalId, bootHealthRetryButton, "boot-health-retry-error");
      });
      async function refresh() {
        try {
          const response = await fetch("/api/status", { cache: "no-store" });
          if (response.ok) {
            const current = await response.json();
            if (!current || typeof current !== "object") return;
            currentLiveJob = current;
            if (selectedHistoryId === null) render(current);
            if (historyStamp(current) !== lastHistoryStamp) void refreshHistory();
          }
        } catch {
          if (selectedHistoryId === null) message.textContent = "Local UI connection interrupted.";
        }
      }
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        error.textContent = "";
        document.getElementById("project-route-error").textContent = "";
        let requestBody;
        try {
          requestBody = isBootHealth() ? bootHealthRequest()
            : isSpaRouteHealth() ? spaRouteHealthRequest()
            : isRouteHealth() ? routeHealthRequest() : isProject() ? projectRequest() : isQa() ? {
            url: document.getElementById("target").value,
            mode: document.getElementById("scan-mode").value,
            safeInteractions: qaInteractions.checked,
            safeLinks: qaLinks.checked,
          } : {
            url: document.getElementById("target").value,
            type: scanType.value,
            input: scanType.value === "navigation" ? inputMode.value : "keyboard",
            mode: document.getElementById("scan-mode").value,
            recordVideo: document.getElementById("record-video").checked,
            ...(scanType.value === "site" ? { maxRoutes: Number(document.getElementById("max-routes").value) } : {}),
            ...(scanType.value === "site" ? { exploreSpa: document.getElementById("explore-spa").checked } : {}),
            ...(scanType.value === "responsive" ? { viewportProfile: document.getElementById("viewport-profile").value } : {}),
          };
        } catch (failure) {
          (isProject() ? document.getElementById("project-route-error") : error).textContent = failure instanceof Error
            ? failure.message : "Review the selected route and authorization.";
          if (isSpaRouteHealth() || isBootHealth()) error.focus();
          return;
        }
        button.disabled = true;
        try {
          const response = await fetch(isBootHealth() ? "/api/boot-health"
            : isSpaRouteHealth() ? "/api/spa-route-health"
            : isRouteHealth() ? "/api/route-health"
            : isProject() ? "/api/project" : isQa() ? "/api/qa" : "/api/scans", {
            method: "POST", credentials: "same-origin",
            headers: { "Content-Type": "application/json", "X-TVDoctor-CSRF": csrfToken },
            body: JSON.stringify(requestBody),
          });
          const result = await response.json();
          if (!response.ok) throw new Error(isBootHealth()
            ? "Could not witness the exact public blank-page original. Check authorization, path and independently authored healthy-content oracle."
            : isSpaRouteHealth()
            ? "Could not capture the exact SPA route observation. Check source, safe link, permission and original expected content."
            : isRouteHealth()
            ? "Could not capture this route. Check that it is public, canonical and authorised, then retry."
            : result.error || "Unable to start scan.");
          selectedHistoryId = null;
          loadingHistoryId = null;
          currentLiveJob = result;
          render(result);
          updateHistorySelection();
          if (lastHistoryStamp !== null) void refreshHistory();
        } catch (failure) {
          error.textContent = failure instanceof Error ? failure.message : "Unable to start scan.";
          if (isSpaRouteHealth() || isBootHealth()) error.focus();
          await refresh();
        } finally {
          if (status.dataset.state !== "running" && status.dataset.state !== "cancelling") button.disabled = false;
        }
      });
      void refresh();
      setInterval(() => { void refresh(); }, 2200);
    })();
  </script>
</body>
</html>`;
}

export interface LocalUiReportEntry {
  /** Human-readable label authored by TVDoctor; page content does not become markup. */
  readonly label: string;
  readonly status: string;
  readonly findings: number;
  /** Prevalidated relative artifact path; untrusted URLs are never inserted. */
  readonly artifact?: string;
  readonly preview?: boolean;
}

function html(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? "");
}

/** Local, static report landing page for scan types that write separate evidence files. */
export function renderLocalUiOverview(options: {
  readonly title: string;
  readonly status: "completed" | "partial" | "failed" | "cancelled";
  readonly summary: readonly string[];
  readonly entries: readonly LocalUiReportEntry[];
  readonly kind: "site" | "responsive";
}): string {
  const permittedArtifact = (path: string): boolean => (
    options.kind === "site"
      ? /^pages\/[0-9]{3}\/report\.html$/u.test(path)
      : /^responsive\/(?:mobile|tablet|desktop)\/page-[0-9]{2}\.png$/u.test(path)
  );
  const summary = options.summary.slice(0, 12).map((line) => `<li>${html(line.slice(0, 180))}</li>`).join("");
  const entries = options.entries.slice(0, 80).map((entry) => {
    const link = entry.artifact !== undefined && permittedArtifact(entry.artifact)
      ? `<a href="./${entry.artifact}">Open evidence ↗</a>`
      : "<span class=\"muted\">No evidence file available</span>";
    const preview = options.kind === "responsive" && entry.preview === true
      && entry.artifact !== undefined && permittedArtifact(entry.artifact)
      ? `<a href="./${entry.artifact}"><img loading="lazy" src="./${entry.artifact}" alt="Screenshot evidence for ${html(entry.label)}"></a>`
      : "";
    return `<article><header><div><strong>${html(entry.label.slice(0, 120))}</strong><span>${html(entry.status.slice(0, 80))} · ${String(entry.findings)} finding(s)</span></div>${link}</header>${preview}</article>`;
  }).join("");
  const extra = options.kind === "site"
    ? `<p class="note">Static same-origin link discovery. The route ceiling is a limit, not a coverage guarantee. <a href="./site-index.md">Detailed route index</a></p>`
    : `<p class="note">Responsive findings are heuristic layout observations for review; measurements and screenshots do not prove a usability failure in isolation.</p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>TVDoctor | ${html(options.title)}</title>
<style>
:root{color-scheme:dark;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:#0c1620;color:#e8f1f3}
*{box-sizing:border-box}body{margin:0}main{max-width:970px;margin:0 auto;padding:45px 24px 65px}
h1{font-size:clamp(30px,5vw,48px);letter-spacing:-1px;line-height:1.1;margin:8px 0 15px}h2{font-size:21px}
p,li,.muted,article span{color:#a8bcc7}ul{line-height:1.9;padding-left:22px}
a{color:#77ebc2;text-decoration:underline;text-underline-offset:4px}
a:focus-visible{outline:3px solid #77ebc2;outline-offset:4px}
.eyebrow{font-size:12px;letter-spacing:2px;color:#72e9c3;text-transform:uppercase;font-weight:800}
.pill{display:inline-block;border:1px solid #46615a;border-radius:99px;padding:5px 12px;margin-bottom:15px;text-transform:uppercase;font-size:12px;font-weight:700}
section{margin-top:35px}article{background:#162833;border:1px solid #2a4651;border-radius:13px;padding:17px 20px;margin:13px 0}
article header{display:flex;justify-content:space-between;gap:16px;align-items:center;flex-wrap:wrap}
article strong,article span{display:block}article img{display:block;width:100%;max-width:600px;margin-top:18px;border-radius:8px;border:1px solid #37505b}
.note{padding-top:12px;font-size:13px}footer{margin-top:38px;border-top:1px solid #2b424c;padding-top:25px;font-size:12px;color:#899faa}
</style></head><body><main>
<div class="eyebrow">TVDoctor · Local audit result</div>
<h1>${html(options.title)}</h1><div class="pill">${html(options.status)}</div>
<ul>${summary}</ul>${extra}
<section><h2>Observed ${options.kind === "site" ? "routes" : "viewport evidence"}</h2>
${entries || "<p>No route or viewport evidence was recorded.</p>"}</section>
<footer>Bounded local evidence. Unvisited routes and untested states remain unknown.</footer>
</main></body></html>`;
}
