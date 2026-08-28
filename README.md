# TVDoctor

Automated QA for TV apps and ten-foot interfaces.

TVDoctor explores the journeys people perform with Up, Down, Left, Right,
Select, and Back, then writes the evidence needed to understand and reproduce a
failure. It runs locally: no AI service, cloud account, API key, or telemetry
service is required.

> **Release status:** the source candidate and publishable packages are versioned
> `0.1.0`, but `tvdoctor@0.1.0` has not been published to npm. The web path has
> controlled real-Chromium evidence, the disposable Android TV emulator gate has
> passed, and hosted GitHub Actions runs have passed for earlier exact candidates.
> A selected release candidate is accepted only after its own clean gate and
> exact-SHA hosted run; the release audit records that proof. All surfaces remain
> Beta, Experimental, or Planned—nothing is Stable before the preview is released
> and observed in wider use. Public repository visibility is also an explicit
> owner decision; this README does not claim anonymous source access.

## What it finds

- unreachable or lost remote focus, focus traps, broken Back behaviour, and
  pointer-only controls;
- semantic streaming, search, settings, accessibility, layout, performance,
  console-error, and crash problems where the driver can observe them;
- regressions in issues, screens, focus targets, transitions, and latency through
  a versioned, fail-closed baseline library;
- deterministic focus-transition reproductions where Replay V1 can express the
  finding.

Results are bounded and evidence-based. Missing observability or an exhausted
budget becomes partial/inconclusive, never a clean pass.

## Verified demo

The Northstar fixture contains deliberate defects. The controlled streaming gate
discovers this journey semantically:

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

The fixture gate completes 17 stages and reports four in-scope seeded defects.
That is deterministic fixture evidence, not a general accuracy claim. See the
[demo and reproduction guide](docs/demo.md).

## Install from a clean source checkout

With repository access, the declared development environment is Node.js 24 and
npm 11. The lockfile is the dependency authority.

```sh
git clone https://github.com/Ticklect/tvdoctor.git
cd tvdoctor
npm ci
npx playwright install chromium
npm run build
npm run tvdoctor -- doctor
```

On Linux CI, Playwright may need system dependencies:

```sh
npx playwright install chromium --with-deps
```

Start TVDoctor in an interactive terminal:

```sh
npm run tvdoctor -- start
```

`start` guides website and experimental Android TV testing, asks before changing
a consent or setup screen, writes normal bundles under `Tests\`, and offers to
open the report. Android scans stop the tested app afterward but never shut down
an emulator unless you explicitly ask for that in a separate workflow; the APK is
intentionally retained. TVDoctor installs its checksum-validated observer APK;
first use requires explicit accessibility enablement on the Android device. For
prompt-free automation, use:

```powershell
tvdoctor test --apk D:\apps\example.apk --device emulator-5554 --mode quick
```

Start the deliberately broken local target in one terminal:

```sh
npm run fixture:dev
```

Open `http://127.0.0.1:5173` manually, or audit it from a second terminal:

```sh
npm run tvdoctor -- test http://127.0.0.1:5173 \
  --pack navigation \
  --pack streaming \
  --mode standard \
  --output tvdoctor-report \
  --query N
```

Use Arrow keys, Enter, and Escape in the fixture. Northstar is a benchmark, not
a reference TV interface.

### Registry installation

These commands are the intended npm experience after publication; they are not
an assertion that `tvdoctor@0.1.0` is currently available from the registry:

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

Reports strip credentials and may strip an original URL's query or fragment. If
the audited route depended on a query string or hash, replay must not guess it:
pass the exact authorised route again with `--target`. Never put passwords,
tokens, session IDs, or personal data in that URL.

## CI and release checks

The repository workflow uses Node 24, installs Playwright Chromium, runs build,
lint, typecheck, unit and real-browser integration gates, executes the exact CLI
M7 integration, performs clean tarball/consumer smoke testing, and uploads useful
failure artifacts. It uses no repository secrets.

Run the same release-relevant checks locally:

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
- **Target cannot be reached:** open the URL in Chromium from the same host,
  confirm the local server is still running, and avoid production/authenticated
  targets.
- **Output directory already exists or is unwritable:** choose a new directory
  under a trusted writable location. TVDoctor does not merge report bundles.
- **Audit seems slow:** packs intentionally reset and replay paths; dynamic pages
  can consume the bounded settle and duration budgets. Use `quick` for an initial
  probe, then inspect partial reasons before increasing scope.
- **Replay is inconclusive:** confirm the target version and route match the
  report, supply `--target` when query/hash routing was redacted, and check the
  issue has an available deterministic replay.
- **Interrupted run:** confirm the target and browser processes stopped, retain
  any partial bundle for diagnosis, and rerun into a fresh directory.

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
Read [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md). Do not put secrets, proprietary target
data, or unredacted report bundles in an issue.

Report suspected vulnerabilities through GitHub's private vulnerability-reporting
flow described in [SECURITY.md](SECURITY.md). TVDoctor is available under the
[MIT Licence](LICENSE).
