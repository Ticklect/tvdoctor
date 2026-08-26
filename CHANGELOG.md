# Changelog

All notable public changes will be recorded here. TVDoctor intends to follow
Semantic Versioning after its first public release.

## [0.1.0] - Unreleased

This section describes the intended initial public preview. It is not a claim
that `tvdoctor@0.1.0` has been published.

### Added

- platform-neutral driver, snapshot, issue, report, and replay contracts;
- bounded deterministic screen/focus exploration and navigation diagnostics;
- semantic streaming and web diagnostic packs;
- experimental Playwright Chromium and ADB/UIAutomator drivers;
- deterministic local HTML, Markdown, JSON, AI-coder, evidence, and replay
  output;
- exact focus-transition replay and fail-closed semantic baseline comparison;
- deliberately broken Northstar web fixture with a machine-readable defect
  manifest;
- public documentation, contribution guidance, security policy, issue forms,
  and MIT Licence.
- complete controlled M7 multi-pack CLI audit and exact CLI integration gate;
- priority-frontier/carousel stress coverage, fail-closed baseline lifecycle,
  and bounded production-site probes;
- disposable Android TV API 36 emulator evidence for fixture install, DPAD input,
  seeded focus-loss detection, screenshot/log capture, and teardown;
- package tarball/clean-consumer smoke automation and least-privilege hosted CI.
- event-driven initial page settling that observes boot work without an
  unconditional pre-reset sleep;
- per-prefix replay checkpoints that reject divergent paths before they can
  reconverge to the expected final focus state;
- navigation and web-driver performance profiling fields for bounded
  diagnostics ledgers;
- explicit deterministic-replay guidance across HTML, Markdown, and AI-coder
  reports, including a navigable AI finding index;
- pack-aware exhausted-duration reasons and protocol-bounded punctuation for
  unavailable reproduction reasons.
- generic startup preparation and explicit setup-blocker classification for
  consent, onboarding, login, region, age, and system walls;
- caller-selected remote preparation sequences with fresh-reset reproducibility
  verification and fail-closed prepared-state replay;
- completion-driven Deep exploration with a 30-minute default safety ceiling,
  advanced/CI duration overrides, and explicit remaining-frontier reporting;
- safer structural identity for dynamic sites by ignoring explicitly invisible
  template/sprite state while preserving enabled, focusable, and modal
  distinctions.

### Verification status

- Controlled browser, CLI, baseline, package-consumer, Android emulator, and
  earlier hosted Linux gates have passed. Their exact records are retained in
  the implementation and production-stress documents.
- A selected release candidate is accepted only after one clean
  aggregate/package gate and a successful hosted run at its exact commit SHA;
  that proof belongs in the release audit record.
- Repository visibility and npm publication remain explicit operator decisions.
  This changelog does not claim that `tvdoctor@0.1.0` is published.
- Physical Android/Google TV devices, macOS CI, non-Chromium browsers, and
  Fire TV/Roku/Tizen/webOS remain outside the supported evidence.
