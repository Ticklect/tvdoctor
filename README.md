![TVDoctor — remote-first QA for TV apps](docs/assets/tvdoctor-hero.svg)

# TVDoctor

<p align="center">
  <a href="https://github.com/Ticklect/tvdoctor/actions/workflows/ci.yml"><img alt="TVDoctor CI" src="https://github.com/Ticklect/tvdoctor/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT Licence" src="https://img.shields.io/badge/licence-MIT-36A3FF"></a>
  <a href="package.json"><img alt="Node 24" src="https://img.shields.io/badge/Node-24-42E8E0"></a>
  <a href="package.json"><img alt="npm 11" src="https://img.shields.io/badge/npm-11-42E8E0"></a>
  <a href="RELEASE.md"><img alt="0.1.0 release candidate" src="https://img.shields.io/badge/0.1.0-release%20candidate-FFBE55"></a>
</p>

## Find TV navigation bugs before your users do

TVDoctor explores TV interfaces with the same controls people actually use:
**Up, Down, Left, Right, Select, and Back**. It looks for broken focus and
navigation, records the path that exposed the problem, and gives you evidence you
can inspect instead of a vague "test failed" message.

No authored navigation journey is required for the normal explorer. TVDoctor runs
locally and does not require an AI service, cloud account, API key, or telemetry
service.

### What it finds

- lost or disappearing focus;
- focus traps and navigation loops;
- visible controls that cannot be reached with the remote;
- broken or surprising Back behaviour;
- directional navigation that gets stuck or skips a likely target;
- pointer-only controls and other TV-unfriendly UI behaviour;
- selected streaming, layout, performance, console, and crash signals when the
  active driver can observe them.

### What you get

Every audit produces a self-contained report bundle with the evidence available
for that run:

- a human-readable `report.html`;
- screenshots and UI excerpts;
- the exact D-pad path to each finding;
- transition, log, network, and runtime evidence where supported;
- machine-readable `report.json`;
- deterministic replay for supported focus-transition failures.

TVDoctor also **fails closed**. If required observation is missing, a coverage
budget is exhausted, or replay cannot classify the result, the run is not reported
as clean.

## Try it on your app

TVDoctor `0.1.0` is currently a source release candidate and has not been published
to npm yet. Use Node.js 24 and npm 11 for the source workspace.

```sh
git clone https://github.com/Ticklect/tvdoctor.git
cd tvdoctor
npm ci
npx playwright install chromium
npm run build
npm run tvdoctor -- doctor
npm run tvdoctor -- start
```

`start` gives you a guided choice:

```text
What would you like to test?

> Website
  Android TV app - Experimental
  Exit
```

For a website, enter the URL. For Android TV, choose a local APK and an authorised
Android TV emulator/device. TVDoctor handles the supported install, launch,
exploration, evidence, and cleanup flow.

Android TV support is **Experimental**. The automated release gate currently
verifies an Android TV API 36 emulator; physical-device and vendor compatibility
are not claimed yet. First use also requires explicitly enabling TVDoctor
Observer accessibility access on the selected Android device.

For prompt-free runs:

```sh
# Web
npm run tvdoctor -- test http://127.0.0.1:3000 --mode quick

# Android TV
npm run tvdoctor -- test --apk D:\apps\example.apk --device emulator-5554 --mode quick
```

On Linux CI, Playwright may need system dependencies:

```sh
npx playwright install chromium --with-deps
```

## See a guaranteed broken example

Northstar is TVDoctor's deliberately broken fixture. It exists to prove the tool
against known defects, not to pretend a controlled fixture represents every real
TV app.

One seeded route looks like this:

```text
Home -> Details -> Play -> Controls -> Settings -> Captions -> Appearance
                                                                |
                                                                v
                                                        Text Colour visible
                                                        but no D-pad path

TVDoctor  HIGH  remote.reachability
           |- before/after screenshots
           |- UI and navigation evidence
           |- report.html / report.json / report.md
           `- portable focus-transition replay
```

Run it from a source checkout:

```sh
# terminal 1
npm run fixture:dev

# terminal 2
npm run tvdoctor -- test http://127.0.0.1:5173 \
  --pack navigation \
  --pack streaming \
  --mode standard \
  --output tvdoctor-report \
  --query N
```

The fixture gate completes 17 stages and reports four in-scope seeded defects.
That is deterministic fixture evidence, not a general accuracy claim.

**[See the full demo and exact reproduction guide →](docs/demo.md)**

## What works today

| Surface | Status | Current boundary |
| --- | --- | --- |
| [Web audit](docs/drivers/web.md) | Experimental | Playwright Chromium with controlled fixtures and bounded production stress evidence. |
| [Android TV](docs/drivers/android.md) | Experimental | Persistent observer, event-driven accessibility state, APK install/launch, Quick/Deep exploration, report and replay gates on an API 36 emulator. Physical-device/vendor verification is still pending. |
| [Reports](#report-bundle) | Beta format | Human-readable HTML/Markdown plus canonical `tvdoctor.report/v1`. |
| [Replay](#replay) | Beta format | Executes supported deterministic focus-transition failures; other findings can remain evidence-only. |
| [Baselines](docs/baselines-and-ci.md) | Experimental | Versioned comparison library for issues, screens, focus targets, transitions, and latency. |

> **Release candidate:** source and publishable packages are versioned `0.1.0`,
> but npm publication has not happened. Acceptance requires clean local and hosted
> gates at the exact candidate SHA. Earlier green runs are supporting evidence,
> not proof of a changed candidate.

## Why trust the result

### Remote-first exploration

TVDoctor drives the UI with the small remote vocabulary a TV user has rather than
assuming pointer access. Exploration is bounded and records the actions and states
it actually reached.

### Fail-closed outcomes

TVDoctor distinguishes findings, partial/inconclusive runs, invalid usage, and
execution failures. A partial run with zero findings is **not** evidence that the
target is clean.

### Evidence before claims

Findings link back to the observations used to justify them. Unavailable evidence
is represented explicitly rather than silently substituted with a guess.

### Local-first operation

No AI API or hosted analysis service is required. Reports can contain sensitive UI
text, screenshots, URLs, and logs, so review bundles before sharing them.

## Registry installation

These are the intended commands after npm publication; they are not an assertion
that `tvdoctor@0.1.0` is currently available from the registry:

```sh
npm install --save-dev tvdoctor
npx playwright install chromium
npx tvdoctor test http://127.0.0.1:3000
```

Until publication is verified, use the source-checkout commands above.

## CLI reference

```text
tvdoctor test URL [--pack NAME] [--mode MODE] [--output PATH] [--query TEXT]
tvdoctor test URL [--startup-actions KEY[,KEY...]] [--max-duration-ms N]
tvdoctor doctor
tvdoctor replay ISSUE_ID [--report PATH] [--target URL]
tvdoctor version
tvdoctor --help
```

`test` accepts one absolute HTTP(S) URL without embedded credentials:

| Option | Values and behaviour |
| --- | --- |
| `--pack NAME` | `navigation`, `streaming`, `search`, `settings`, `accessibility`, `layout`, `performance`, or `crashes`. Repeat to select several. Omit it (or use `all` alone) to run every pack. |
| `--mode MODE` | `quick` or `deep`; the advanced `standard` alias remains accepted for existing scripts. Modes select predefined bounded action/state/depth/time profiles; the report records the effective combined budgets. |
| `--output PATH` | New report-bundle directory. Omit it to create a readable collision-safe bundle under `Tests\`. Choose a trusted, writable, non-existing path and do not reuse a bundle directory. |
| `--query TEXT` | Printable, non-sensitive search text, at most 64 characters. Defaults to `N`. It may be entered into the target and retained as evidence. |
| `--startup-actions KEY[,KEY...]` | Explicit caller-selected remote keys used only after TVDoctor detects a focused setup wall. Observation-only is the default; TVDoctor never chooses consent. |
| `--max-duration-ms N` | Advanced navigation safety-ceiling override for CI or exhaustive runs. |

`doctor` checks the declared Node runtime, host, installed Playwright Chromium,
and whether the audit host is available. Run it before a long audit.

`version`, `--version`, and `-V` print the installed CLI package version.

### Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | Command completed successfully: an audit found no issues, replay classified the issue fixed, or doctor/help/version succeeded. |
| `1` | The audit completed and found one or more issues; replay reproduced an issue; or doctor found an unavailable requirement. |
| `2` | Invalid command, option, URL, identifier, or other usage. |
| `3` | Partial audit or inconclusive replay. The result is not clean. |
| `4` | Execution failed before a trustworthy result was produced. |

CI must fail on every non-zero code unless a workflow is deliberately collecting
a known seeded-fixture result. In particular, never translate code 3 into pass.

## Complete, partial, and failed runs

A complete audit exhausted no required coverage boundary. It can still exit 1
because confirmed findings are the product output.

A partial audit records which pack or stage could not complete and exits 3.
Common causes include a safety ceiling with queued work, target disappearance,
missing capabilities, unstable reset/replay, interrupted evidence capture, or an
unresolved startup setup blocker. A safety-ceiling result is bounded-incomplete,
not an engine crash; its ledger records the remaining frontier and candidate
actions. Open the bundle, read **Run status**, **Pack coverage**, and
unavailable-evidence reasons, address the stated cause when applicable, and rerun
into a new output directory. A partial run with zero findings does not show that
the target is clean.

Exit 4 means no trustworthy command result was produced. A partial bundle may
still exist after a late failure; treat it as diagnostic material only.

## Report bundle

```text
tvdoctor-report/
|- report.html       interactive human report
|- report.md         portable human summary
|- report.json       canonical tvdoctor.report/v1 document
|- ai-report.md      deterministic evidence-linked work items
|- stage-ledger.json internal stage/recovery record
|- inventory.json    semantic baseline inventory
|- evidence/         screenshots, UI excerpts, transitions, and logs
`- replays/          available tvdoctor.replay/v1 documents
```

Start with `report.html`. It shows run and pack status, target environment,
coverage/budgets, issue severity and confidence, expected versus observed
behaviour, exact steps, runtime evidence, artifact links, and replay availability.
`report.json` is the canonical machine-readable result; Markdown is a portable
view, not a second source of truth.

Open the static HTML locally:

```sh
# macOS
open tvdoctor-report/report.html

# Linux
xdg-open tvdoctor-report/report.html

# Windows PowerShell
Start-Process .\tvdoctor-report\report.html
```

Unavailable evidence is represented explicitly. Report generation escapes
target-controlled content and redacts common credential shapes, but screenshots,
UI text, logs, URLs, and search input can still contain sensitive information.
Review the entire bundle before sharing or uploading it.

## Replay

With the target running, copy a deterministic issue ID from the report:

```sh
npm run tvdoctor -- replay ISSUE_ID \
  --report tvdoctor-report/report.json \
  --target http://127.0.0.1:5173
```

Replay V1 resets the target, executes the stored setup path, checks the focus
precondition, sends the final remote action, and compares the observed transition.
It does not rerun the audit and it does not prove root cause.

Only deterministic focus-transition findings with an available, correlated V1
replay are executable. Numeric playback state, selection, focus styling,
geometry, clipping, latency, log, crash, and screenshot findings remain
review-only when V1 cannot express their corrected state.

Replay can also be inconclusive. Checkpoint drift, assertion drift, unavailable
observation, unobserved input, interruption, and exhausted budgets are kept
separate from a proven fixed result.

Reports strip credentials and may strip an original URL's query or fragment. If
the audited route depended on a query string or hash, replay must not guess it:
pass the exact authorised route again with `--target`. Never put passwords,
tokens, session IDs, or personal data in that URL.

## Android TV notes

Android testing uses a TVDoctor-owned observer APK for focus, window, visible
control, and content-change observation. Normal remote input is deliberately sent
with structured ADB `input keyevent` commands; normal exploration does **not** use
ADB UIAutomator hierarchy dumps.

The observer's accessibility access must be explicitly enabled by the user on the
selected device. TVDoctor does not use privileged `settings put` commands to
bypass that consent.

The observer uses a versioned, authenticated loopback protocol over an ephemeral
ADB port forward. See the [Android driver guide](docs/drivers/android.md) for the
support boundary, security model, settling behaviour, CI path, and known
limitations.

## CI and release checks

The repository workflow uses Node 24, installs Playwright Chromium, runs build,
lint, typecheck, presentation checks, unit and real-browser integration gates,
executes the CLI integration, performs clean tarball/consumer smoke testing, and
uploads useful failure artifacts. The Android workflow also runs the observer
integration on an API 36 Android TV emulator.

Run the release-relevant checks locally:

```sh
npm ci
npx playwright install chromium
npm run check
npm run test:package-smoke
node examples/baseline-ci-example.mjs
```

Generated artifacts are ignored by Git. The [release procedure](RELEASE.md)
requires a clean worktree and a hosted run at the exact candidate commit; an
older green run is supporting evidence, not proof of a changed candidate.

## Troubleshooting

- **Chromium executable is missing:** run `npx playwright install chromium`; on
  Linux CI use `--with-deps`, then rerun `tvdoctor doctor`.
- **Unsupported Node/npm:** install a Node 24/npm 11 environment and rerun
  `npm ci`. Do not use `--force` to bypass the declared engine range.
- **Target cannot be reached:** open the URL in Chromium from the same host and
  confirm the local server is still running.
- **Android observer is not enabled:** enable TVDoctor Observer in the device's
  accessibility settings, then rerun the scan.
- **Output directory already exists or is unwritable:** choose a new directory
  under a trusted writable location. TVDoctor does not merge report bundles.
- **Audit seems slow:** packs intentionally reset and replay paths; dynamic pages
  can consume the settle and duration budgets. Use `quick` for an initial probe,
  then inspect partial reasons before increasing scope.
- **Replay is inconclusive:** confirm the target version and route match the
  report, supply `--target` when query/hash routing was redacted, and check the
  issue has an available deterministic replay.
- **Interrupted run:** retain any partial bundle for diagnosis and rerun into a
  fresh directory after confirming the target is ready again.

## Compatibility and support

Status words are deliberate:

- **Stable** promises maintained production compatibility. Nothing is Stable in
  the v0.1 preview.
- **Beta** has repeatable controlled evidence, but can still change before 1.0.
- **Experimental** is useful for bounded evaluation with intentionally narrow
  support and evidence.
- **Planned** is not implemented or supported.

| Surface | Status | Evidence and boundary |
| --- | --- | --- |
| Node.js 24 + npm 11 source workspace | Beta | Clean local and hosted Linux installs have passed; other major versions are outside the declared engine range. |
| `tvdoctor.report/v1` and `tvdoctor.replay/v1` | Beta | Strict parsing, cross-link, redaction, rendering, and real-browser replay tests. Formats remain pre-1.0. |
| Deterministic core and streaming pack | Beta | Unit and controlled real-Chromium fixture gates; no arbitrary-app accuracy claim. |
| Playwright Chromium web driver | Experimental | Real Chromium and bounded production probes; DOM semantic tree is not the browser accessibility tree. |
| `tvdoctor test URL` audit host | Experimental | Complete controlled M7 fixture gate and bounded production stress evidence; broader framework/browser evidence is still limited. |
| Android TV persistent-observer driver | Experimental | Versioned framed local protocol, event-driven accessibility state, real API 36 emulator Quick/Deep/replay/cancellation gates; no physical-device/vendor compatibility claim. |
| Baseline comparison library | Experimental | Versioned fail-closed library, controlled lifecycle proof, hosted example; not yet a standalone CLI workflow. |
| Linux hosted verification | Beta evidence | Earlier exact candidates passed on `ubuntu-latest`; every changed release candidate needs a new exact-SHA run. |
| Windows development verification | Experimental evidence | Local release work has run on Windows; no hosted Windows matrix is claimed. |
| macOS release verification | Planned | No hosted matrix is claimed. |
| Physical Android/Google TV devices | Planned verification | Emulator evidence never implies physical-device support. |
| Fire TV, Roku, Tizen, and webOS | Planned | No adapters or compatibility commitments. |

Read [current limitations](docs/limitations.md), the
[architecture guide](docs/architecture.md), and [baselines and CI](docs/baselines-and-ci.md)
before relying on a result.

## Documentation

- [Demo and exact reproduction](docs/demo.md)
- [Examples](docs/examples.md)
- [Fixtures and benchmark controls](docs/fixtures.md)
- [Web driver](docs/drivers/web.md)
- [Android driver](docs/drivers/android.md)
- [Writing a driver](docs/drivers/authoring.md)
- [Baselines and CI](docs/baselines-and-ci.md)
- [Architecture](docs/architecture.md)
- [Limitations](docs/limitations.md)
- [Roadmap](docs/roadmap.md)
- [Release procedure](RELEASE.md)
- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## Contributing, security, and licence

Bug reports, fixtures, diagnostics, and carefully scoped driver work are welcome.
Read [CONTRIBUTING.md](CONTRIBUTING.md). Do not put secrets, proprietary target
data, or unredacted report bundles in an issue.

Report suspected vulnerabilities through GitHub's private vulnerability-reporting
flow described in [SECURITY.md](SECURITY.md). TVDoctor is available under the
[MIT Licence](LICENSE).
