# Browser audit workflows (unreleased source checkout)

TVDoctor is a local-first navigation and evidence tool. Browser capabilities
described here are implemented in the **current source checkout**, not the
published v0.1.0 Windows ZIP or an npm-registry package. TVDoctor never
certifies an entire site clean simply because a bounded scan found no issues.

For an install-to-scan-to-evidence Windows PowerShell guide, including real
Chromium Back reproduction and MCP issue inspection, see
[Windows SPA first run](windows-spa-first-run.md).

## Fast first run

With Node 22.13+ or 24 and npm installed, from the repository root:

```sh
npm ci
npm run build:packages
npm run tvdoctor -- setup
npm run ui
```

Open the local URL printed by TVDoctor. Choose **Navigation**, **Website
routes**, or **Responsive layout review**, then paste a URL for a website you
own or have permission to test. The dashboard serves only on `127.0.0.1` and
requires same-origin requests with a local CSRF token. Reports stay on disk.

For a controlled target, run `node fixtures/reliability-lab-v2/server.mjs`
in a second terminal and open `http://127.0.0.1:4191/knowledge`. The paired
`/knowledge-fixed` route serves the repaired variant. [Local fixture guide](../fixtures/reliability-lab-v2/README.md)

## Terminal workflows

```sh
# Explore keyboard focus, without activating page controls (default).
npm run tvdoctor -- scan http://127.0.0.1:3000 --input keyboard --mode quick

# Explicitly opt into a very limited Enter/Escape semantic allowlist.
npm run tvdoctor -- scan http://127.0.0.1:3000 --input keyboard --keyboard-interactions --mode quick

# Scan static same-origin HTML link destinations, each with its own focus graph.
npm run tvdoctor -- site http://127.0.0.1:3000 --input keyboard --max-pages 5 --mode quick

# Opt in to additional experimental, checkpoint-verified SPA state exploration.
npm run tvdoctor -- site http://127.0.0.1:3000 --input keyboard --max-pages 5 --spa --mode quick

# Check desktop/tablet/mobile rendering at bounded same-origin routes.
npm run tvdoctor -- responsive http://127.0.0.1:3000 --mode quick

# Review two independently saved responsive runs with paired screenshots.
# The output folder must not exist. Changed warnings do not prove a fix.
npm run tvdoctor -- responsive http://127.0.0.1:3000 --capture-comparison-evidence --output ./before-layout
npm run tvdoctor -- responsive http://127.0.0.1:3000/fixed --capture-comparison-evidence --output ./after-layout
npm run tvdoctor -- responsive compare ./before-layout ./after-layout --output ./layout-comparison

# Opt into visual recording; screenshots are available independently by default.
npm run tvdoctor -- scan http://127.0.0.1:3000 --input keyboard --record-video --mode quick
```

Every command requires an explicitly authorised target. Running a browser may
load third-party application resources or execute page JavaScript. Use
disposable test accounts and data. Avoid scanning sensitive sessions unless you
have reviewed the local evidence retention policy.

## What each run proves

| Workflow | What is actually tested | What is *not* claimed |
| --- | --- | --- |
| Navigation | Observed D-pad or Tab/Shift+Tab focus transitions, modal escapes, proof-linked reports and replays | Every reachable user flow, all keyboard accessibility, all browser engines |
| Opt-in Enter/Escape | Enter on a narrowly identified safe menu/dismissal button; Escape while a visible modal is open, with the policy rechecked immediately before input | Arbitrary link activation, form submission, purchase flows or scripted keyboard shortcuts |
| Static website routes | Limited safe-looking GET anchor routes on the exact origin, independent page reports and a route ledger | JavaScript-generated routes, SPA internal transitions outside visited pages, authentication, full site crawling |
| Opt-in SPA journeys (`site --spa`) | A second bounded browser exploration pass through allowlisted same-origin anchors, reversible menu/dialog controls and state transitions, with root-relative replay checkpoints and deferred branches | Arbitrary scripted clicks, all SPA routes, reproducibility on nondeterministic pages or a proof of non-destructive behaviour by third-party JavaScript |
| Responsive | A bounded mobile/tablet/desktop viewport matrix with repeated measurement, a limited nested-scroll observation pass and screenshot-backed overflow, offscreen, severe clipping, overlapping or obscured controls | General CSS correctness, exhaustive scroll/virtualised-content coverage, all overlap cases, pixel-perfect baselines or a perfect match during dynamic animation |
| Responsive before/after | Offline, same-origin paired screenshots plus rule counts; only equal-route, complete/stable observations get per-finding comparisons | Proof of a fix when URL, site state or content differs, or when either scan is partial |
| Session/issue video (single-page `scan --record-video` only) | An opt-in full Chromium WebM recording plus up to three independently replayed, issue-specific clips if fresh deterministic evidence is reproduced | Session video for `site --spa`, clips for heuristic Back warnings, timestamp-perfect edits of exploration footage or a guaranteed video on every run |
| MCP | A stdio local agent interface for bounded scan, status, finding-specific reproducibility metadata, evidence and cancellation | Autonomous code changes, authenticated browsing, unrestricted filesystem reads or automatic test export from redacted targets |

Keyboard diagnostics distinguish **VERIFIED** modal focus escape from
**REVIEW** leads: possible traps (both Tab directions self-loop with visible
eligible peers), unvisited controls on a verified complete frontier, Escape
focus loss, and fully offscreen focus. Browser focus order and modal intentions
can legitimately vary; these warnings require developer review.

Responsive nested-scroll review samples only a small number of visible scroll
containers and positions. Stable new observations may have a separate private
screenshot (reserved `page-51` through `page-62` slots) instead of the route's
unscrolled `page-01` through `page-12` image. Each is a **REVIEW** lead, not a
certified defect. Scrolling can execute page JavaScript or trigger lazy network
loads, so use explicitly authorised, disposable targets and review partial or
unstable results before making changes.

## Report locations and partial runs

- Single-page navigation writes `report.html`, `report.json`,
  `navigation-graph.html`, `navigation-graph.json`, `navigation-graph.md`,
  screenshots and saved replay documents within its report directory.
- The static-site command writes `site-index.json`, `site-index.md`, `site-index.html` and
  `pages/NNN/report.json`/`report.html` for each attempted route. The index
  retains discovered-but-unvisited routes and the termination reason.
- Opt-in `site --spa` also writes `spa/spa-journey.json` with opaque state IDs,
  discovered transitions, bounded root-relative checkpoints and deferred edges;
  `spa/graph.html` is a local, script-free graph viewer. SPA review leads remain
  **heuristic**, not automatically verified bugs. The
  `spa.history-back-stale-view` rule requires a real browser Back observation
  after eligible forward navigation; forward replay checkpoints are **not**
  independently verified Back evidence. At most two eligible paths are probed;
  additional eligible paths become `history-back-limit` deferred entries,
  making the SPA result partial. A qualifying Back lead may additionally have
  an **optional post-Back PNG** at `spa/evidence/back-edge-NNN.png`,
  with edge-bound SHA-256 and byte length in `spa-journey.json`. It is a
  visual witness of the observed return state, **not** a deterministic replay
  or proof that every history path restores. Capture is limited to 8 MiB;
  validated dashboard preview is limited to 6 MiB, and MCP only transfers
  explicitly acknowledged PNGs at most 1 MiB. SPA progress and incompleteness
  appear in the same site index without inflating the static page-finding count.
- The **experimental, unreleased rapid two-Back diagnostic**
  `spa.history-back-interrupted-stale-view` independently issues **two
  browser-owned Chromium Back actions** after two observed safe, same-document
  forward pushes. Its heuristic evidence type is
  `observed-dom-after-interrupted-history-back`, with
  `historyBack.historyDelta: 2` and
  `historyBack.interruptedBack` identifying the intermediate and final
  forward state. **Only one eligible nested pair per scan** is attempted;
  further eligible or uncompleted checks become deferred
  `history-back-interruption-unchecked` or an applicable budget reason,
  not clean results.
  Any private post-Back PNG is separately recorded at
  `spa/evidence/back-interrupted-edge-NNN.png` with issue-specific
  path, size and SHA-256. As with the one-Back rule, this is **REVIEW**
  evidence, not a portable deterministic replay, Playwright export or video.
  The same `--no-spa-screenshots` opt-out also disables this PNG.
- Responsive scans write `responsive-result.json`, a readable local overview
  and `responsive/mobile|tablet|desktop/page-NN.png` where capture succeeded.
  Findings are **review-only**, even when clipping, overlap or occlusion geometry
  is measured; unstable layouts remain partial without invented defect claims.
- `responsive compare` creates a new folder containing copied before/after
  screenshots, `responsive-comparison.json` and an offline `report.html`. The
  comparison uses the **first route** of each scan, paired only by viewport, and
  checks that both saved reports are from the same origin. Use the opt-in
  `--capture-comparison-evidence` switch on **both** source scans: otherwise a
  clean viewport might have no screenshot and the comparison must be partial.
  Different route IDs
  are not treated as proven matched issue identities. Screenshots may be private.
- `--record-video` may add `video/audit-session.webm` and
  `evidence/ISSUE_ID/issue-video.webm` to the report bundle. These are
  sensitive local files, not automatically safe to share. Recording is available
  with single-page `scan`, not `site --spa`. Back-state heuristic findings
  do not qualify for deterministic issue replay clips.
- The **independent v2 fixture** can generate two WebM recordings for a rapid
  *double* browser Back interruption with
  `node fixtures/reliability-lab-v2/visual-back-proof.mjs`, plus a
  `visual-provenance.json` manifest of actual browser URLs, two observed
  popstate events and screenshot hashes. These are **fixture-ground-truth
  assets**, never scanner-produced issue clips, even though the source
  scanner now separately attempts one real rapid two-Back witness per run.
  Videos show page pixels, not the browser address bar; inspect the
  manifest and reproduce manually.
  See [the Windows nested-Back walkthrough](windows-spa-first-run.md).
- Cancellation requests are cooperative. A scan is not finished until the
  underlying browser work has terminated and the partial report has settled.

The duration ceiling applies to a specific bounded phase; setup, route
discovery, screenshot/evidence capture, recording finalisation and report
writing can extend wall time. Coverage may end partial at a visited-state,
action, page, depth or duration bound. Zero findings with deferred work is
not a clean site.

## Coding agents

The source-checkout MCP server starts with `npm run mcp`; connect a client to
`packages/cli/dist/mcp-bin.js` using stdio and follow
[MCP connection and privacy instructions](mcp-server.md). Agent scan requests
need an explicit authorization flag. The server has no direct site credentials
or arbitrary file read capabilities.
After polling status and listing `tvdoctor_findings`, an agent can call
`tvdoctor_issue_details` with the returned `scan_id` and `issue_id`.
For deterministic recorded keyboard failures this supplies validated keypress
and reset information; SPA reviews return opaque candidate/checkpoint numbers,
and responsive reviews link to owned screenshots. The latter two remain
**heuristics, not deterministic browser replay scripts**. Site page findings
may need the `route_number` shown in the finding. Screen text, private report
paths and the exact target route are omitted. Video artifact metadata may be
available, but the MCP server deliberately does not transfer WebM bytes.

## Regression tests

Deterministic, fully completed **keyboard modal-escape** reports can be exported
to an actual Playwright assertion:

```sh
npm run tvdoctor -- export-test ISSUE_ID --report ./report/report.json --output ./modal-fix.spec.js
```

The generated test requires `TVDOCTOR_AUTHORIZED_TARGET_URL` to match the
recorded URL, checks its modal precondition and fails if keyboard focus escapes
while the same dialog stays open, including delayed escape after settling. If the original report redacted the route,
an unredacted authorised rerun is required before export. Other issue classes
are rejected until their correctness assertions can be proved. This includes
`spa.history-back-stale-view`: there is no Playwright export for its
heuristic Back observation.

See [current limitations](limitations.md).
