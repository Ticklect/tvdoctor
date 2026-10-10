# TVDoctor Product Overhaul Design

## Goal

Make TVDoctor feel like a fast, trustworthy developer tool for finding and
reproducing broken TV remote navigation, instead of a broad experimental audit
framework that produces technically correct but difficult-to-interpret output.

## User and success criteria

The primary user is a TV application developer or QA engineer running a local
check or pull-request audit. Their first successful interaction should be one
command, navigation-first, and finish with a clear answer in under the normal
quick-scan budget. A report must make it impossible to mistake zero observed
navigation coverage for a clean result.

Success means:

- the guided flow chooses navigation by default and does not silently run the
  legacy all-pack suite;
- command output exposes an explicit scan phase, useful progress, final status,
  coverage, and the single best next action;
- findings are consistently classified as verified, review, or untested across
  HTML, Markdown, AI-coder, and CI output;
- deterministic replay availability controls “verified”/“fix now” language;
- reports lead with human decisions, then expose technical evidence on demand;
- README and package help teach the shortest supported path before advanced
  features;
- `tvdoctor demo` gives an installed user a deterministic first success without
  requiring their own application, starts a packaged Northstar fixture locally,
  proves a known D-pad/navigation defect with the real audit engine, writes a
  sanitized report, and proves the stored replay can reproduce it;
- `tvdoctor doctor` reports web readiness and Android TV readiness separately,
  including Chromium, ADB, Android build-tools, connected/authorized device
  state, and Observer/accessibility readiness without implying that optional
  Android setup is required for web-only use;
- published-package artifacts are self-contained enough for normal `npx
  tvdoctor`, local dependency, and global-package use once publication is
  authorized, and their declared runtime range is no narrower than the versions
  exercised by compatibility tests;
- existing safety, redaction, fail-closed, Android, baseline, and protocol
  behavior remains intact.

## Design

### 1. Navigation-first first run

`tvdoctor start` uses the navigation pack only. The guided web flow offers a
clear “Quick navigation scan” and “Deep navigation scan”; other packs are
explicitly advanced. The scripted default remains navigation. Progress reports
phase, elapsed time, coverage, findings, and whether the run is still capable
of producing a trustworthy navigation verdict.

The CLI should describe the shortest path first and keep `--pack all` as an
explicit compatibility/advanced option. The existing safety ceiling and partial
exit behavior stay fail-closed.

### 2. One result vocabulary

Every finding has one user-facing actionability class:

- `VERIFIED`: deterministic failure evidence and a portable replay are present;
- `REVIEW`: evidence exists but replay or causal proof is incomplete;
- `UNTESTED`: the relevant surface or assertion was unavailable or skipped.

Severity remains a separate risk dimension. “Fix now” is only allowed for
`VERIFIED`; heuristics, startup-only logs, and non-replayable observations are
never promoted by renderer-specific rules. Coverage summaries distinguish
observed, tested, unavailable, and not attempted counts.

### 3. Findings-first report

The report top fold shows: verdict, run completeness, navigation coverage,
verified/review/untested counts, and one next action. A zero transition count
must say navigation coverage was unavailable or not exercised, never imply a
clean navigation result. Each finding shows expected behavior, observed
behavior, confidence/actionability, route/focus context, replay availability,
and the most useful evidence link before technical inventories.

### 4. Adoption surface

README and CLI help lead with the one-command quick navigation workflow and a
short explanation of the output. Advanced packs, baselines, Android, replay,
and protocol details move below the first-run path. Distribution guidance must
clearly separate source checkout, Windows bundle, and published package state;
it must not promise a package that is not actually available.

### 5. Deterministic activation demo

`tvdoctor demo` is the first-success path for a developer who has not yet wired
TVDoctor into their own application. It serves a packaged, local Northstar
fixture on loopback, runs the same navigation audit path used for real web
targets, verifies that the expected seeded remote-navigation failure is present,
and verifies its portable replay. The command must fail rather than print a
success story if the fixture cannot start, the expected finding is absent, the
report is incomplete, or replay does not reproduce the finding.

The demo report is ordinary TVDoctor output and must preserve the normal
redaction/sanitisation boundaries. Interactive runs may open the HTML report;
non-interactive runs print its location and the replay command instead of
launching desktop UI. The fixture is explicitly labelled as controlled seeded
evidence so it cannot be mistaken for production-app validation.

### 6. Surface-aware doctor

`tvdoctor doctor` distinguishes core runtime readiness from individual product
surfaces. Web readiness checks the supported Node runtime, packaged Playwright,
Chromium launch, and web audit orchestration. Android TV readiness checks ADB,
SDK build-tools (`aapt2`/`aapt`), device connection and authorization, TV device
metadata, and Observer/accessibility readiness where a device can be inspected.

Android is optional for a web-only developer, so an unconfigured Android SDK is
reported as an unavailable optional surface rather than making an otherwise
ready web installation unusable. Partially configured Android environments must
show the exact next remediation and must never be labelled ready.

### 7. Installable package contract

Every public package tarball contains the files needed by its declared exports
and runtime behavior. The CLI tarball also contains the deterministic demo
fixture. A clean consumer test installs the tarballs without workspace links,
exercises `npx --no-install`, exercises a global-prefix install, runs help/version
and the deterministic demo contract, and reports skipped external-device probes
as skipped instead of passing them implicitly.

The repository may pin newer Node/npm versions for contributor reproducibility,
but published `engines` ranges and the Windows bundle installer must accept every
runtime version that the compatibility matrix proves supported.

## Constraints

- Do not weaken fail-closed semantics or turn missing evidence into a pass.
- Do not discard existing user changes outside the files required by this design.
- Do not add a cloud service, telemetry, AI dependency, or large new runtime.
- Do not require a network-hosted demo; activation must work from the installed
  package after the normal Chromium setup/download step.
- Do not publish packages or create a public release as part of this overhaul.
- Preserve the canonical report schema unless a backwards-compatible derived
  field is required; renderers may derive the same classification from the
  canonical report.
- Use tests first for every behavior change.

## Verification

Unit tests cover guided pack selection, CLI progress/status wording, actionability
classification, zero-coverage wording, renderer consistency, deterministic demo
success/failure/replay behavior, web and Android doctor states, README/help
contracts, and supported runtime parsing. Package tests prove tarball contents,
clean-consumer `npx` usage, global installation, and truthful skipped probes.
Typecheck, lint, reporter/CLI tests, presentation tests, package smoke, runtime
compatibility checks, build, controlled fixture/demo execution, and the full
project check are run before completion.
