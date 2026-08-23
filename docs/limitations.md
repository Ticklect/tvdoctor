# Current limitations

TVDoctor is a pre-1.0 developer preview. Its strongest evidence comes from
controlled fixtures designed to expose deterministic remote-navigation defects.

## Product and release

- Workspaces are currently private and versioned `0.0.0`; there is no supported
  registry install yet.
- The local CLI has a bounded `tvdoctor test URL` host, but its complete
  controlled real-browser release gate is still pending. Treat it as
  Experimental and never turn a partial/inconclusive exit into a clean result.
- There is no Stable surface. Beta and Experimental APIs may change before 1.0.
- No hosted CI success, package publication, download count, or external user
  adoption is claimed.
- Generated `ai-report.md` files are deterministic text views. TVDoctor does not
  call an AI model or guarantee an automated fix.

## Detection and exploration

- A bounded run can end at action, state, depth, duration, tree, or stage limits.
  A cutoff is incomplete, not clean.
- State fingerprints are conservative semantic approximations. Highly dynamic,
  canvas-only, game-engine, video-overlay, or inaccessible UIs may have low
  observability.
- Repeated carousel compression reduces equivalent states by proven structural
  patterns; statistics expose what was compressed or deferred. It cannot prove
  every hidden content item is defect-free.
- Heuristic focus visibility is not deterministic visual truth. Theme,
  animation, HDR, device scaling, and platform rendering can change perception.
- Packs deliberately avoid destructive/account/payment/subscription actions.
  Those journeys are not audited automatically.
- Controlled fixture recall is not a benchmark for arbitrary real applications.

## Web

- Only the Playwright Chromium path has controlled real-browser evidence.
- The DOM-derived UI tree is not the browser accessibility tree.
- Cross-origin frames, closed shadow roots, canvas controls, browser/OS dialogs,
  DRM surfaces, and native players can be unavailable.
- Network capture is bounded metadata; it is not request/response body analysis,
  privacy scanning, or security testing.
- Performance timings are environment-sensitive. Fixture thresholds are not
  universal service-level objectives.
- Target code runs in a browser and may make external requests. Use authorised,
  disposable non-production targets.

## Android

- The ADB/UIAutomator adapter has fake-executor unit tests but no completed real
  Android TV emulator gate at the time of writing.
- The driver does not create, start, configure, stop, or delete emulators.
- No physical Android TV, Google TV, vendor firmware, permission-dialog, DRM,
  launcher, or Fire TV compatibility is claimed.
- UIAutomator can omit semantic properties; missing values remain unavailable.
- Install, clear-data, force-stop, and input commands can alter the selected
  device. Use an explicit serial and disposable emulator.

## Replay

- Replay V1 asserts one remote focus transition after a reset-relative setup
  path.
- Numeric media state, caption selection, focus styling, clipping, latency,
  console errors, crashes, screenshots, and arbitrary element properties are not
  portable Replay V1 assertions.
- A reproduced issue does not prove root cause. A fixed result requires trusted
  issue provenance and an explicit corrected-state match.
- Target drift, missing focus, unavailable driver capabilities, or ambiguous
  elements produce inconclusive/error rather than pass.

## Reports, privacy, and baselines

- Redaction covers common credential forms but cannot guarantee removal of every
  secret or personal datum. Review output before sharing.
- Screenshots and UI/log excerpts may contain target content.
- Reports are local static artifacts, not an access-control system.
- Baseline comparison requires equivalent complete observability. Missing packs,
  capabilities, inventory, or latency observations fail closed.
- The baseline library is not yet a released CLI/hosted-CI workflow.

If a limitation affects the reliability of a finding, include it with the issue
report rather than weakening the status language.
