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

### Release blockers

- pass the newly wired integrated `tvdoctor test` release gate and clean
  consumer install;
- complete the disposable real Android TV emulator gate without inflating
  physical-device support;
- validate the baseline regression workflow and CI example locally;
- complete package versioning, tarball inspection, and publishability checks;
- capture and verify the short public demo.
