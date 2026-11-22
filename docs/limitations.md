# Current limitations

TVDoctor is a pre-1.0 developer preview. Its strongest evidence is controlled,
deterministic remote-navigation validation. A clean-looking report is meaningful
only when the run is complete and the selected driver could observe the relevant
surface.

Reports use three actionability states: `VERIFIED` requires deterministic failure
evidence plus a portable replay; `REVIEW` records an observation without enough
proof to certify a defect; and `UNTESTED` marks unavailable or skipped coverage.
In particular, zero tested remote transitions means navigation coverage is
unavailable, not clean.

## Automatic discovery boundaries

- TVDoctor discovers D-pad/focus paths automatically after it reaches the target
  surface. You do not have to author the navigation graph first.
- Login, consent, profile selection, account state, payment, subscription, and
  other persistent/destructive flows are intentionally constrained. An explicit
  startup choice or bounded custom journey may be required to reach the surface
  you intend to audit.
- A bounded run can stop at action, state, depth, duration, evidence, tree, or
  safe-action limits. A cutoff is incomplete, not clean.
- State fingerprints are conservative semantic approximations. Highly dynamic,
  canvas-only, game-engine, video-overlay, or inaccessible UIs may have weak
  observability.
- Repeated-item compression can reduce equivalent carousel work when conservative
  structural signals match. It cannot prove every hidden content item is
  defect-free.
- Heuristic focus visibility is not deterministic visual truth. Theme, animation,
  HDR, scaling, and platform rendering can change perception.

## Product and release

- The public preview is versioned `0.1.0`. GitHub Release bundles are the current
  documented distribution; public npm-registry publication is not assumed.
- Nothing is Stable. Beta and Experimental APIs, formats, and behavior can change
  before 1.0.
- Fixture recall is not an arbitrary-app accuracy percentage.
- `exports/agent-fix-tasks.md` is deterministic derived text. TVDoctor does not
  call an AI model or guarantee an automated fix.

## Web

- Sequential `Tab`/`Shift+Tab` browser navigation is an **implemented,
  unreleased source feature**, distinct from current TV remote/D-pad scans.
  It does not certify general accessibility or all keyboard interaction. See
  [browser keyboard navigation](keyboard-navigation.md).
- The interactive graph viewer summarizes observed evidence but does not discover
  additional routes; the bounded JSON graph is the source of truth.
- A keyboard-focused control entirely outside the observed browser viewport is
  flagged as **review-only**. Intentional scrolling and browser positioning can
  create the same geometry; the warning does not prove a visual defect.
- The source-only local dashboard runs bounded navigation, static-route and
  responsive scans; it is not a destructive click crawler or a device farm.
  The site crawler uses safe-looking same-origin static GET anchors only: it
  cannot prove that a GET endpoint is side-effect-free or discover every route.
  Test authorised disposable environments only.
- Opt-in `site --spa` adds experimental guarded Chromium exploration of
  same-origin client-side state/route changes and narrowly allowlisted
  reversible menu/dialog controls. It uses per-step replay checkpoints,
  action/state/depth limits, request-method restrictions and explicit deferred
  branches. JavaScript handlers on apparently safe controls can still cause
  unexpected local state changes or side effects, and replay may drift; it is
  not a general safe crawler or exhaustive SPA audit.
- Browser Back inspection is attempted only after at most two observed,
  same-document, safe-looking History.pushState forward transitions with
  distinct route and heading fingerprints. It checks two post-Back snapshots
  over a bounded asynchronous settling window and can miss defects or flag
  unusually slow but legitimate rendering. A stale heading is a heuristic
  review lead, not a portable verified replay or auto-exportable test. Eligible
  browser Back paths beyond the two-probe ceiling are explicitly deferred as
  `history-back-limit`, making the SPA exploration partial instead of clean.
  A matching optional screenshot is captured **after the genuine Back**
  observation and its bounded settling; it can be absent due to timeout or
  capture limits, and does not convert the heuristic into verified replay.
  The PNG is capped at 8 MiB; the local dashboard validates a maximum
  6 MiB screenshot, while MCP only transmits acknowledged images up to 1 MiB.
- The experimental rapid double-Back diagnostic
  `spa.history-back-interrupted-stale-view` uses **two genuine Chromium
  `page.goBack()` operations**, tests only **one eligible nested history
  path per scan**, and requires two settled post-return observations.
  Extra eligible paths or unverified interruptions are deferred under
  `history-back-interruption-unchecked` or the applicable budget reason
  and may make the scan partial.
  The issue's `observed-dom-after-interrupted-history-back` witness
  records `historyBack.historyDelta: 2` and
  `historyBack.interruptedBack` intermediate/final-forward identities;
  this remains **heuristic REVIEW**, not an exported regression test.
  A private optional `spa/evidence/back-interrupted-edge-NNN.png` is a
  post-Back visual witness only; `--no-spa-screenshots` suppresses it.
- Responsive severe clipping and obstructing-control overlap observations are
  geometry-based **review** leads, not validated cross-browser CSS bugs. The
  scanner intentionally misses some valid layout defects to avoid broad
  false-positive claims; scroll containers, sticky overlays and intended
  layering remain important review cases.
- Side-by-side responsive comparisons pair first-route screenshots by viewport.
  Same-origin runs with different route identities or dynamic state do not prove
  equivalence or a fix; even a disappeared warning needs manual verification.
  Controls hidden until a nested scroll action are not automatically scrolled
  into view, so their obstruction can remain untested.
- Modal-focus Playwright export proves only a narrow deterministic observed
  transition. A generated regression that observes temporary focus containment
  before a delayed leak is misleading; the current source exporter explicitly
  checks focus stability over a bounded interval instead. Other keyboard
  classes still need stronger provenance and portable assertions.
- Opt-in keyboard Enter/Escape exploration is a small semantic allowlist, not
  arbitrary web form automation. Possible focus traps, unvisited controls,
  missing focus after Escape and responsive overflow are review-only leads.
- Optional session and per-issue replay videos may contain confidential page
  content; some videos can be unavailable if Chromium cannot finalise them.
  Per-issue clips are a bounded proof attempt, not guaranteed for every issue.
  These recordings require single-page `scan --record-video`; there is no
  session WebM or issue replay video for `site --spa` Back heuristics.
  The separate lab-v2 `visual-back-proof.mjs` command makes **fixture-only**
  videos for real sequential and rapidly interrupted browser Back journeys.
  Those recordings are not attached to scanner findings, omit the browser
  address bar and require their independent URL/popstate manifest for provenance,
  even though the current source scanner now performs its own narrowly
  bounded, screenshot-only rapid two-Back check.
- MCP scan and evidence tools cannot make code edits and require explicit
  target authorisation. The server can only access reports it created in its
  current local session.
- MCP issue-details responses omit raw selectors, route URLs and page text.
  For a recorded deterministic issue they supply bounded keypress steps, but
  standalone `export-test` still needs an original, explicitly authorised
  unredacted local report. Opaque SPA checkpoint numbers are not executable
  selectors; reported browser Back evidence is separate from recorded forward
  setup checkpoints, not an executable Back replay. WebM evidence is
  metadata-only in the MCP protocol.
- MCP `tvdoctor_verify_fix` currently has a complete, rule-specific fixed-state
  predicate for **keyboard modal focus escape** only. It reuses the original
  scan ID, finding, modal checkpoint and exact saved Tab sequence, verifies
  checksum-sealed report bytes, and requires the same visible modal to contain
  focus throughout a bounded post-action sample window. Other deterministic
  rules, SPA/history leads and responsive layout heuristics remain
  **INCONCLUSIVE** for independent fix verification; the legacy
  `tvdoctor_replay` transition result must not be generalized into proof of a
  full rule fix. This distinction is covered by a real Chromium broken/repaired
  local fixture, not by arbitrary-app accuracy evidence.
  The MCP verifier correlates modal identity through a stable semantic ID in
  driver snapshots; this is not a persistent browser `ElementHandle`. If an app
  replaces a modal with a different DOM node while reusing the same stable ID,
  the current portable replay cannot independently prove DOM-node continuity.
  An exported Playwright regression offers stricter retained-element checks.
- MCP `tvdoctor_compare` currently operates only between two completed,
  coverage-compatible single-page web navigation scans in one MCP session. Its
  `resolved_findings` means a previously reported exact finding identity was
  **not observed in the second complete scan**, not that its root cause was
  independently fixed. A changed identity can hide the same underlying defect.
  Original and current inventories require complete stable identities, recorded
  coverage, checksum-verified files, matching scan budgets and target settings.
  No durable cross-restart baselines, SPA history comparison or responsive
  resolution certification are claimed.
- Only the Playwright Chromium path has controlled real-browser evidence.
- The UI tree is derived from DOM semantics; it is not the browser accessibility
  tree.
- Cross-origin frames, closed shadow roots, canvas controls, browser/OS dialogs,
  DRM surfaces, and native players can be unavailable.
- Network evidence is bounded metadata, not request/response body analysis,
  privacy scanning, or security testing.
- Performance timings are environment-sensitive. Fixture thresholds are not
  universal service-level objectives.
- Reset/replay exploration can be slow on large or continuously changing pages
  even though action and duration budgets are bounded.
- Target code runs in Chromium and may make external requests. Use authorised,
  disposable targets and test data.

## Android TV

- Current compatibility evidence is a disposable Android TV API 36 emulator. It
  covers observer deployment, accessibility-event state, real DPAD input,
  deterministic relaunch/replay, screenshots/logs, cancellation, and teardown.
- The driver does not create, start, configure, stop, or delete emulators.
- A physical-device proof runner exists and rejects emulators/incomplete scans,
  but current release evidence does not establish a maintained physical Android
  TV, Google TV, vendor-firmware, or Fire TV compatibility matrix.
- Amazon hardware can be classified as `fire-tv` and uses the same ADB,
  accessibility-observer, exploration, report, and replay machinery. No named
  Fire TV model/firmware has been promoted to compatibility evidence yet.
- Android accessibility exposes only what the target makes available. Protected
  or secure surfaces may hide hierarchy or screenshot evidence.
- The automatic Android action policy is state-aware. Risky, persistent, or
  semantically ambiguous Select actions can be operator-gated. Media actions are
  eligible only when target-owned media/player evidence supports them.
- HOME and TAB are not automatic Android exploration actions in the currently
  integrated product path. Their absence must not be interpreted as tested
  launcher/system-boundary coverage.
- `android-coverage-ledger.json` records policy/evidence gaps. Incomplete safe
  coverage forces a partial result; an unattempted action must not be interpreted
  as implicitly covered.
- Continuous UI churn can exhaust bounded settling or scan-duration budgets and
  remain partial.
- VLC for Android 3.7.1 has bounded real-app emulator evidence: one recorded Quick
  run reached the 300-physical-action ceiling after 27 focus states, 12 screens,
  and 87 deterministic resets with no replay divergence or observer timeout. It
  retained 11 frontier entries, so it is partial evidence, not a clean-app claim
  or a compatibility guarantee.
- Install, clear-data, force-stop, and input operations alter the selected device.
  Use an explicit serial and disposable test environment without personal data.

## Replay

- Replay V1 asserts one stored remote focus transition after a reset-relative
  setup path. It does not rerun the complete audit or prove root cause.
- Numeric media state, selection, focus styling, geometry, clipping, latency,
  console errors, crashes, screenshots, and arbitrary element properties are not
  portable Replay V1 assertions.
- A fixed result requires trusted issue/replay provenance and an explicit
  corrected-state match.
- Target drift, missing focus, unavailable driver capabilities, or ambiguous
  elements produce inconclusive/error rather than pass.
- Reports can redact an original query or fragment. Route-dependent replay needs
  the exact authorised URL supplied again with `--target`; secrets do not belong
  in target URLs.

## Reports, privacy, and baselines

- Redaction covers common credential forms but cannot guarantee removal of every
  secret, personal datum, proprietary string, or sensitive image. Review the
  complete bundle before sharing it.
- Screenshots, UI/log excerpts, target metadata, and search/setup input can
  contain target content.
- Reports are local static artifacts, not an access-control system.
- Baseline comparison requires equivalent complete observability. Missing packs,
  capabilities, inventory, or required latency observations fail closed.

See [Benchmarking](BENCHMARKING.md) for the evidence categories TVDoctor uses and
what fixture, synthetic, and real-app results are allowed to claim.
