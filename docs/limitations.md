# Current limitations

TVDoctor is a pre-1.0 developer preview. Its strongest evidence comes from
controlled fixtures designed to expose deterministic remote-navigation defects.

## Product and release

- Publishable packages are versioned `0.1.0`, but no supported npm registry
  installation is claimed until publication and post-publication installation
  are verified.
- The CLI's controlled M7 real-browser fixture gate has passed. The general audit
  remains Experimental: fixture recall is not an accuracy claim for arbitrary
  applications, frameworks, browsers, or devices.
- Earlier exact candidates passed hosted Linux CI. A green run for an older SHA
  does not prove a changed release candidate; final release requires a clean
  hosted run at the exact candidate commit.
- There is no Stable surface. Beta and Experimental APIs and formats can change
  before 1.0.
- No package download count or external-adoption claim is made.
- `exports/agent-fix-tasks.md` is a deterministic text view. TVDoctor does not call an AI model
  or guarantee an automated fix.

## Detection and exploration

- A bounded run can end at action, state, depth, duration, tree, evidence, or
  stage limits. A cutoff is incomplete, not clean.
- State fingerprints are conservative semantic approximations. Highly dynamic,
  canvas-only, game-engine, video-overlay, or inaccessible UIs may have low
  observability.
- Repeated-carousel compression reduces equivalent states by proven structural
  patterns; statistics expose what was compressed or deferred. It cannot prove
  every hidden content item is defect-free.
- Heuristic focus visibility is not deterministic visual truth. Theme,
  animation, HDR, device scaling, and platform rendering can change perception.
- Packs avoid destructive, account, payment, and subscription actions. Those
  journeys are not discovered automatically. A caller can supply a bounded
  [custom web journey](custom-web-journeys.md), but must maintain that explicit
  preparation path and its dedicated test account.
- Controlled fixture recall is not a benchmark for arbitrary real applications.

## Web

- Only the Playwright Chromium path has controlled real-browser evidence.
- The DOM-derived UI tree is not the browser accessibility tree.
- Cross-origin frames, closed shadow roots, canvas controls, browser/OS dialogs,
  DRM surfaces, and native players can be unavailable.
- Network capture is bounded metadata. It is not request/response body analysis,
  privacy scanning, or security testing.
- Performance timings are environment-sensitive. Fixture thresholds are not
  universal service-level objectives.
- Reset-and-replay exploration can be slow on large or continuously changing
  pages even though every action and duration budget is finite.
- Target code runs in a browser and may make external requests. Use authorised,
  disposable, non-production targets.

## Android

- A disposable Android TV API 36 emulator gate proved observer deployment,
  event-driven focus/window/content state, real DPAD input, seeded focus-loss
  detection, screenshot/log capture, deterministic relaunch/replay, Deep
  exploration, cancellation, and teardown. This is emulator evidence only.
- The driver does not create, start, configure, stop, or delete emulators.
- No physical Android TV, Google TV, vendor firmware, permission-dialog, DRM,
  launcher, or Fire TV compatibility is claimed.
- A physical-device proof runner now rejects emulators and incomplete scans, but
  no physical hardware was attached for the current candidate, so no hardware
  compatibility claim has been recorded.
- Android accessibility can omit semantic properties; missing values remain
  unavailable. Protected/secure surfaces may block state or screenshots.
- HOME and media actions are supported only when explicitly requested in
  startup/replay data; automatic exploration remains navigation-only.
- Dynamic apps must reach three equivalent canonical observations for DPAD
  movement and seven for activation/back inside the bounded post-action window.
  Continuous churn remains partial rather than being accepted as a replay match.
- VLC for Android 3.7.1 reached the 300-physical-action Quick ceiling after 27
  focus states, 12 screens, and 87 deterministic resets with no replay
  divergence or observer timeout; 11 frontier entries remained, so the result
  is retained as partial/inconclusive rather than reported clean.
- Hosted release-signing verification cannot run until maintainers provision the
  protected workflow with the release keystore and certificate digest;
  pull-request CI verifies only the tracked APK's checksum/certificate metadata
  and disposable-emulator behavior.
- Install, clear-data, force-stop, and input commands alter the selected device.
  Use an explicit serial and a disposable emulator without personal data.

## Replay

- Replay V1 asserts one remote focus transition after a reset-relative setup
  path. It does not rerun the complete audit or prove root cause.
- Numeric media state, caption selection, focus styling, clipping, latency,
  console errors, crashes, screenshots, and arbitrary element properties are not
  portable Replay V1 assertions.
- A fixed result requires trusted issue/replay provenance and an explicit
  corrected-state match.
- Target drift, missing focus, unavailable driver capabilities, or ambiguous
  elements produce inconclusive/error rather than pass.
- Reports can redact an original query string or fragment. Route-dependent replay
  requires the exact authorised URL supplied again with `--target`; secrets do
  not belong in target URLs.

## Reports, privacy, and baselines

- Redaction covers common credential forms but cannot guarantee removal of every
  secret, personal datum, proprietary string, or sensitive image. Review the
  whole bundle before sharing.
- Screenshots, UI/log excerpts, target metadata, and search text can contain
  target content.
- Reports are local static artifacts, not an access-control system.
- Baseline comparison requires equivalent complete observability. Missing packs,
  capabilities, inventory, or latency observations fail closed.
- The baseline package and CLI have controlled lifecycle evidence; registry
  release and broader external-project evidence remain pending.

If a limitation affects the reliability of a finding, retain it with the issue
instead of weakening the run status.
