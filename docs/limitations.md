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
