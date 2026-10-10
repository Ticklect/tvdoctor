# `tvdoctor`

TVDoctor is a local command-line tool for teams building ten-foot interfaces who
want bounded D-pad/focus-navigation audits with evidence and deterministic
replay. Navigation is the primary v0.1 workflow; the additional diagnostic packs
are advanced options.

## Current scope

- TV web apps through Playwright Chromium: **Experimental**.
- Android TV through ADB plus the TVDoctor Observer: **Experimental**; current
  evidence is emulator-led and does not claim a maintained physical-device or
  vendor compatibility matrix.
- Fire TV: Android-derived ADB/Observer transport implemented and auto-identified
  as `fire-tv`, but **unvalidated** until named physical Fire TV proof exists.
- Roku: an unvalidated contributor adapter exists for Roku's first-party
  WebDriver, but there is no supported CLI path or real-device compatibility gate
  yet.
- Samsung Tizen and LG webOS: no supported adapter yet.

The `tvdoctor` package is **not published to npm yet**. Registry-based
`npx tvdoctor` and `npm install --global tvdoctor` are future usage examples,
not commands that resolve today. Current runnable paths are the Windows release
bundle and a source checkout.

## First success: packaged demo

Install the matched browser runtime once, then run the self-contained demo:

```sh
tvdoctor setup
tvdoctor demo
```

`tvdoctor demo` serves its packaged Northstar navigation-only fixture on
loopback, runs the real quick navigation engine, and writes the normal report
bundle. The proven demo completes **6 actions, 1 state, 1 issue**: on Home, the
visible `More info` control is reported by `remote.reachability`, and the stored
deterministic replay finishes `REPRODUCED`.

This is **controlled seeded evidence, not a measure of production accuracy**.
It demonstrates the packaged audit/evidence/replay path against a deliberately
broken fixture. It does not establish production recall, precision, device
compatibility, or release readiness. See the repository's
[sample report](../../docs/sample-report.md) and [demo guide](../../docs/demo.md).

`tvdoctor setup` is the explicit preflight: it installs and verifies the
Playwright Chromium build matched to this TVDoctor version. Web commands can
also attempt setup automatically when Chromium is missing, but explicit setup is
recommended before CI, demos, or troubleshooting.

## Windows release bundle

After extracting the Windows release bundle:

```powershell
.\install.ps1
tvdoctor setup
tvdoctor doctor
tvdoctor demo
```

The bundle does not require an npm account.

## Source checkout

From the repository root:

```sh
npm ci
npm run build
npm run tvdoctor -- setup
npm run tvdoctor -- doctor
npm run tvdoctor -- demo
```

The build stages the Northstar demo into the CLI package, so `demo` does not
require a separately running Vite fixture.
In a source checkout, later CLI examples use the same workspace entry point:
replace a leading `tvdoctor` with `npm run tvdoctor --`.

## Audit your own web app

With your target already running, use the installed command from the Windows
bundle:

```sh
tvdoctor scan http://127.0.0.1:3000 --mode quick
```

From a source checkout, use the workspace script instead; `npm ci` does not put
the workspace binary on your shell PATH:

```sh
npm run tvdoctor -- scan http://127.0.0.1:3000 --mode quick
```

`scan` selects the navigation pack; the unreleased source checkout defaults
to Standard mode (120 seconds, repeated-item compression disabled). Explicit
`--mode quick` still runs the short sample. `--mode deep` expands coverage;
`--max-duration-ms`, `--max-actions`, `--max-states`, and `--max-depth`
override its safety ceilings. A run can still be partial. Use `test` when
you need additional packs. From a source checkout, prefix these with
`npm run tvdoctor --` as above:

```sh
npm run tvdoctor -- test http://127.0.0.1:3000 --pack navigation --mode standard
npm run tvdoctor -- test http://127.0.0.1:3000 --pack all --mode deep
```

The Northstar fixture's harmless profile controls are blocked by the normal
SELECT policy. For local fixture validation only, pass `--fixture-profile-select`
to `scan` or `test` on a loopback URL. Exact fixture modal and control markers
and labels are still checked before every SELECT. See [fixture tests](../../docs/fixtures.md).

For `test`, the default is `navigation`. Available secondary packs are
`streaming`, `search`, `settings`, `accessibility`, `layout`, `performance`, and
`crashes`. `--pack all` explicitly selects the slower multi-pack suite.

Targets that need deterministic preparation can use a bounded journey file.
Typed secrets do not belong in the journey; they come from scoped
`TVDOCTOR_JOURNEY_*` environment variables, and replay verifies the journey
fingerprint before browser startup.

## Android TV

Android TV support is Experimental. A non-interactive APK scan requires Android
SDK tooling and an authorized TV/emulator; `--device` can be omitted only when
TVDoctor can unambiguously select the single online device.

```sh
tvdoctor test --apk ./app.apk --device emulator-5554 --mode quick
```

Use `tvdoctor doctor` to inspect browser readiness plus optional Android ADB,
build-tools, device, and Observer readiness. Missing Android tooling does not
change the web product boundary; it matters when you choose the Android path.

## Privacy and sharing

Run `tvdoctor privacy` for the static product policy. TVDoctor is local-first and
does not upload report bundles by default. To reduce persisted evidence, use
`--no-screenshots` on web or Android audits. Web audits additionally support
`--target-redaction origin`, which stores only the target origin as the public
identity and requires an explicit replay `--target` when the original route can
no longer be reconstructed.

Video evidence is deliberately opt-in and web-only:

```sh
tvdoctor scan https://your-tv-app.example --record-video
```

`--record-video` may capture sensitive target content. Redaction and evidence
suppression are defense in depth, not a sharing guarantee. Review every report
bundle before sharing it. See [`docs/privacy.md`](../../docs/privacy.md) for the
full capture, retention, and sharing guidance.

## Replay

Replay a deterministic issue from a generated report:

```sh
tvdoctor replay ISSUE_ID --report tvdoctor-report/report.json
```

A standalone replay classifies the issue as reproduced, fixed, inconclusive, or
error. A standalone replay classified `REPRODUCED` exits `1` because the defect
is still present; `FIXED` exits `0`, `INCONCLUSIVE` exits `3`, and execution
errors exit `4`. The `demo` command is different: reproducing its deliberately
seeded expected defect is the success condition.

## Regression baselines

```sh
tvdoctor baseline create --report tvdoctor-report/report.json --output tvdoctor-baseline.json
tvdoctor baseline compare --baseline tvdoctor-baseline.json --report current-report/report.json
```

Baseline creation requires a complete reviewed run. Comparison fails closed when
equivalent observation coverage is unavailable.

## Future npm usage

TVDoctor is not published to npm yet. Once it is published, the intended package
workflow is:

```sh
npm install --save-dev tvdoctor
npx tvdoctor setup
npx tvdoctor demo
npx tvdoctor scan http://127.0.0.1:3000 --mode quick
```

Global installation would use `npm install --global tvdoctor`. Until publication,
use the Windows release bundle or source checkout above.

## Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | Command completed successfully under the requested failure policy; the seeded `tvdoctor demo` also uses `0` only when its expected finding is found and replayed as `REPRODUCED`. |
| `1` | Findings failed policy, a standalone replay reproduced the issue, a baseline regressed, or a required local environment/device is unavailable. |
| `2` | Command usage is invalid. |
| `3` | The result is partial or inconclusive. |
| `4` | Execution failed before a trustworthy result was produced. |

Reports stay local. TVDoctor does not require an AI service, API key, cloud
account, or telemetry service. Run `tvdoctor --help` for the complete command
surface.
