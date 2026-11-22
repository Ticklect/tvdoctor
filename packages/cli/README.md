# `tvdoctor`

TVDoctor is a local MCP server and CLI for finding UI bugs and verifying coding
agent fixes. The agent inspects findings and changes your application code.
TVDoctor scans the running browser, records evidence, and independently
retests supported original findings.

## Connect your coding agent

From the TVDoctor source checkout, use Node 22.13+ or 24 and run these commands.

```sh
npm ci
npm run build:packages
npm run tvdoctor -- setup
```

Register the compiled `packages/cli/dist/mcp-bin.js` as a local MCP server.
Run this command from the source checkout to register it with Codex.

```sh
codex mcp add tvdoctor -- node "$PWD/packages/cli/dist/mcp-bin.js"
```

Open a new agent session in your app project and start your development server.
Give the agent the exact local URL and authorize the scan. The agent calls
`tvdoctor_scan`, polls `tvdoctor_status`, and uses `tvdoctor_triage` on a
completed single-page scan. `tvdoctor_findings` exposes observations and
coverage, including partial runs. The agent can inspect the reproduction,
edit your source, and call `tvdoctor_verify_fix` with the original scan and
issue IDs after the app reloads. Keep that session open through verification.
Supported verification returns `FIXED`, `REPRODUCED`, or `INCONCLUSIVE`.
Clients that expose MCP prompts can also use `tvdoctor_repair_workflow`.

See the [MCP setup and tool guide](../../docs/mcp-server.md) for Claude Code,
other clients, and the full scan-to-fix workflow.

## Current scope

- TV web apps through Playwright Chromium: **Experimental**.
- Coding agents through the local stdio MCP server: **Experimental**; supports
  bounded web scans, finding/evidence inspection, independent verification of
  supported original findings and comparison of compatible completed scans.
  `tvdoctor_verify_fix` uses independent, compiler-proven corrected-state
  oracles for `keyboard.modal-focus-escape`, `keyboard.modal-tab-focus-loss`,
  and source-proven `keyboard.modal-open-focus-not-transferred`. Other
  deterministic transitions remain diagnostics, not certified fixes. Host
  registration is required before MCP agents can use authenticated journeys.
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

From the built source checkout, run the self-contained TV navigation fixture.

```sh
npm run tvdoctor -- setup
npm run tvdoctor -- demo
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

The published v0.1.0 Windows release bundle provides the earlier TV-navigation
preview. Use the source checkout for MCP, the agent repair workflow, and the
self-contained demo. After extracting the bundle, run the commands below.

```powershell
.\install.ps1
tvdoctor setup
tvdoctor doctor
tvdoctor start
```

The bundle does not require an npm account.

## Source checkout

For a framework-agnostic web project, the recommended first workflow is:

```sh
npm run tvdoctor -- qa http://127.0.0.1:3000 --source-root .
# Save the generated AGENT_REPAIR_BRIEF.md with the original evidence.
# After the agent edits the app, execute the exact original SHA-pinned
# verify-fix command only for independently supported keyboard modal rules,
# or verify all original modal rules in one command:
npm run tvdoctor -- qa-verify --original PATH/TO/QA_BUNDLE \
  --target http://127.0.0.1:3000 --authorized --output PATH/TO/FRESH_VERIFICATION --json
# Or gate both original repairs and a new post-repair QA scan together:
npm run tvdoctor -- qa-accept --original PATH/TO/QA_BUNDLE \
  --target http://127.0.0.1:3000 --authorized --output PATH/TO/FRESH_ACCEPTANCE --json
```

`qa` uses the existing `check`/`project` scanner, saved-report inspector and
handoff engine. It saves an original Chromium report, `handoff.json`, a
portable coding-agent task and `qa-summary.json` together in one fresh run.
Default bounded standard-profile scan includes safe menu/dialog activation;
`--no-interactions` restricts it, while `--safe-links` explicitly opts into
guarded same-origin document-link navigation and REVIEW-only HTTP failures.
`qa --config PROJECT_MANIFEST --authorized` covers defined authenticated
multi-route projects. Its JSON and exit codes can gate CI without reinterpreting
REVIEW observations as verified failures or certifying disappearing findings.
`qa-verify` reuses the existing independently proven `verify-fix` for all
original supported findings and writes its own `qa-verification.json`. It
does not modify the original or certify newly introduced regressions; run a
second fresh `qa` for that separate check. `qa-accept` runs these two checks as
separate, provenance-validated stages:
originals must independently be FIXED and the fresh scan must have complete
bounded coverage and zero VERIFIED findings for `PASS`. A post-repair VERIFIED
failure is not necessarily newly introduced by the repair; no blanket app
quality or WCAG claim is made. Both stages create their own new evidence.
For multi-route authenticated projects, use
`project-verify --config ... --original QA_DIR/original/summary.json
--authorized` with the unchanged original manifest and environment-sourced
journeys.
These are **current source-checkout features, not published npm/Windows v0.1.0**.

The lower-level commands remain available:

```sh
npm run tvdoctor -- check http://127.0.0.1:3000 --interactions --source-root .
npm run tvdoctor -- findings --report PATH/TO/report.json --json
```

The new `check` command reuses the actual Chromium keyboard navigation engine,
returns a concise prioritized report and optional JSON CI result, and preserves
exact finding IDs for replay and independent verification. `--source-root`
enables bounded local source-correlation hints, not source modification.
The `findings` command is a strictly offline reader of a saved report bundle,
including checksum-checked evidence links. See
[developer-first usage](../../docs/developer-first.md) for the supported
workflow and limits. These commands are **unreleased source-checkout features**.

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

The CLI also supports independent original-finding verification without MCP:

```sh
tvdoctor scan http://127.0.0.1:3000/modal --input keyboard --mode quick --output reports/original
# After fixing the actual modal focus issue at the same URL:
tvdoctor verify-fix ACTUAL_ISSUE_ID --report reports/original/report.json --authorized
```

Use `--scan-output reports/repeat --compare` to request a fresh Chromium scan
with a strict original-versus-current inventory comparison. JSON output and
exit codes distinguish `FIXED` (0), `REPRODUCED` (1), and `INCONCLUSIVE` (3).
Unknown original evidence, incomplete inventories and other issue rules are
not certified as fixed. See [the CLI/CI verification guide](../../docs/cli-workflow.md).

### Source-checkout browser UI bug-hunter workflows (unreleased)

The public v0.1.0 Windows ZIP does **not** contain these newer commands.
From the current source checkout, use `npm run ui` to build and start the
localhost scan dashboard. It supports navigation, a bounded same-origin
**static-anchor site scan** with opt-in SPA state discovery, and
screenshot-backed responsive review. For the actual PowerShell setup, output
paths, browser Back proof and agent commands, see the
[Windows SPA first-run guide](../../docs/windows-spa-first-run.md).

```sh
npm run ui
npm run tvdoctor -- scan http://127.0.0.1:3000 --input keyboard --mode quick
npm run tvdoctor -- scan http://127.0.0.1:3000 --input keyboard --keyboard-interactions --mode quick
npm run tvdoctor -- site http://127.0.0.1:3000 --input keyboard --max-pages 5 --mode quick
npm run tvdoctor -- site http://127.0.0.1:3000 --input keyboard --max-pages 5 --spa --mode quick
npm run tvdoctor -- site http://127.0.0.1:3000 --input keyboard --max-pages 5 --spa --no-spa-screenshots --mode quick
npm run tvdoctor -- responsive http://127.0.0.1:3000 --mode quick
npm run mcp
```

`--keyboard-interactions` opts into a tightly constrained Enter/Escape
navigation and modal-dismissal allowlist. The static-site scanner does not
execute JavaScript for link discovery, nor does it click forms or destructive
controls. `--spa` separately explores guarded Chromium UI journeys and
records remaining paths. Eligible browser Back paths beyond the two-probe cap
become `history-back-limit` deferred entries and mark the SPA scan partial.
The **experimental, unreleased** nested double-Back diagnostic separately
attempts **at most one eligible rapid pair of real Chromium browser Backs**
per run. It reports `spa.history-back-interrupted-stale-view` with
`observed-dom-after-interrupted-history-back` and
`historyBack.historyDelta: 2`; untested or incomplete additional nested
paths are explicitly deferred as `history-back-interruption-unchecked`
or an applicable budget reason.
Both Back rules remain **heuristic REVIEW** with no verified
Back replay or Playwright export. Responsive overflow/offscreen findings,
suspected keyboard traps and unvisited controls remain **review-only** leads.
A complete scan refers to its bounded visited frontier, not certification of
an entire site.

An observed stale-heading browser Back warning may save an optional
`spa/evidence/back-edge-NNN.png` witness after a single Back, or
`spa/evidence/back-interrupted-edge-NNN.png` after two genuine Backs.
The saved SPA report records its edge-bound SHA-256 and size; missing images
are allowed. The local dashboard validates images up to 6 MiB, while MCP
exposes eligible PNGs only up to 1 MiB after explicit sensitive-content
acknowledgment. This is **visual review evidence**, never verified Back replay.
Use `site --spa --no-spa-screenshots` to skip those optional private Back
PNGs for **both** rules while retaining the Back diagnostics, state graph
and findings.
`--no-spa-screenshots` is invalid without `--spa` and does not disable
screenshots from separate per-page keyboard scans. For MCP `tvdoctor_site`,
set `{"explore_spa":true,"spa_screenshots":false}` for the same opt-out;
`spa_screenshots` may only be supplied when SPA discovery is enabled.

`scan --record-video` optionally creates a Chromium session recording and,
for up to three deterministic findings when fresh replay succeeds, short
issue-specific clips. `site --spa` does **not** accept `--record-video` or
produce session WebM or replay clips. The recordings may contain private data.
The local MCP stdio server uses real
scan operations with authorization, bounded owned-report reads, and an
explicitly authorised verification tool for supported deterministic findings,
plus `tvdoctor_compare` for repeat completed single-page scans. It does
not grant arbitrary filesystem access. See
[browser workflows](../../docs/browser-audit.md),
[MCP configuration](../../docs/mcp-server.md), and
[current limitations](../../docs/limitations.md).

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

For coding agents, use `tvdoctor_verify_fix` through MCP to prove a supported
**original** finding was fixed under its recorded conditions. A legacy CLI/MCP
replay can match one expected focus transition without proving the full
rule-specific failure was corrected. Use `tvdoctor_compare` for a second scan
with identical settings; a no-longer-observed finding is not equivalent to
independently verified `FIXED`. See [MCP workflow](../../docs/mcp-server.md).

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
