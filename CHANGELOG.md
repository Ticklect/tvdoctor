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
