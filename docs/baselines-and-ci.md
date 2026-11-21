# Baselines and CI

TVDoctor is most useful when automatic remote-navigation discovery becomes a
repeatable release check: explore the app, fail closed if coverage is incomplete,
and compare the complete result with a reviewed baseline.

No hand-authored navigation test is required for the discovered D-pad/focus
graph itself. If the application starts behind login, consent, profile selection,
or another setup wall, prepare that state explicitly before relying on the
comparison.

## Run navigation in CI

```sh
tvdoctor ci http://127.0.0.1:3000 \
  --pack navigation \
  --mode quick \
  --fail-on high
```

`tvdoctor ci URL --fail-on LEVEL` runs the normal bounded audit and writes two
CI-oriented exports: `exports/ci-summary.md` and `exports/junit.xml`. `LEVEL` is
`any`, `critical`, `high`, `medium`, `low`, `info`, or `never`.

A partial or failed run is always non-successful, including with `--fail-on
never`. The threshold controls findings; it never converts missing coverage into
a pass.

The **current unreleased source checkout** gates `--fail-on` severity using
**VERIFIED findings** only. `REVIEW` observations and `UNTESTED` coverage are
included in the CI summary and JUnit evidence, but do not individually trip a
severity threshold. Incomplete or failed exploration remains non-successful;
baseline comparison can also fail independently. The **published v0.1.0** CLI
and Action predate this `VERIFIED`-only distinction, so treat their severity
thresholds according to the older published version. This also changes the
meaning of **`--fail-on any`** on upgrade: in the new source checkout, it means
any **VERIFIED** finding, not any reported REVIEW/UNTESTED observation. Teams
that previously failed CI on every reported observation must review their
policy before adopting a future tagged version.

The **published `v0.1.0` composite Action** supports this invocation after your
application server has started and become ready:

```yaml
- name: Check TV remote navigation
  uses: Ticklect/tvdoctor@v0.1.0
  with:
    target: http://127.0.0.1:3000
    pack: navigation
    mode: quick
    fail-on: high
```

The published `v0.1.0` Action needs the policy inputs above explicitly. It appends
the summary to the job, uploads the report bundle, and exposes its original
`report` and `junit` outputs. Partial and failed runs still fail closed regardless
of `fail-on`. For a full example that checks out, builds, starts and waits for a
Vite/React TV application on the same runner, see the
[React TV CI workflow](frameworks/react-tv-web.md#complete-github-actions-example).

The repository's current `action.yml` contains the next, still-unreleased CI
experience: zero-configuration defaults of `mode: quick`, `pack: navigation`, and
`fail-on: high`, plus `navigation-graph`, `comparison`, and `baseline-source`
outputs and reviewed-baseline auto-discovery. External repositories should use
those features only after they are present in a later published tag; pinning the
moving `main` branch would trade away reproducibility.

With that unreleased Action, TVDoctor can also scan the checked-out source tree for
exact textual matches of stable element/resource identifiers from VERIFIED or
REVIEW findings. The bounded result is written to
`exports/source-correlation.json` and `exports/source-correlation.md`. Correlation
never invents a component or filename: it records only exact relative
`path:line:column` matches, skips generated/vendor/binary content, and stores no
source snippets. Missing or bounded correlation does not change the navigation
verdict.

## Create a reviewed semantic baseline

Create a baseline only from a complete run whose target, setup state, and findings
you have reviewed:

```sh
tvdoctor baseline create \
  --report tvdoctor-report/report.json \
  --output tvdoctor-baseline.json
```

For the **unreleased Action in the current source checkout**, the intended
repository convention is to write the accepted baseline at the path below.
The **published v0.1.0 Action does not detect this file, accept a `baseline`
input, or run comparisons automatically**; use the manual CLI comparison shown
below until a later tag ships that capability:

```sh
tvdoctor baseline create \
  --report tvdoctor-report/report.json \
  --output .tvdoctor/baseline.json
git add .tvdoctor/baseline.json
```

Review the baseline and the run's evidence before committing it. In the
**unreleased Action**, `.tvdoctor/baseline.json` is selected automatically when
no explicit `baseline` input is supplied. Its `baseline-source` output then
reports `committed`, `input`, or `none`, and `navigation-graph` points to the
reviewable `navigation-graph.md` artifact. Baseline creation uses create-only
file semantics, so an existing reviewed baseline is not silently overwritten.
For an intentional replacement, create a
separate candidate file, review it against the committed baseline, then replace
and commit the reviewed file explicitly.

The CLI finds `inventory.json` beside the report by default. A
`tvdoctor.baseline/v1` document records:

- stable target identity and platform;
- source report schema, run ID, mode, and TVDoctor version;
- capabilities and completed packs needed for equivalent observability;
- deterministic/heuristic finding identity, rule, severity, and confidence;
- semantic screens and focus targets;
- remote transitions; and
- named latency observations.

The baseline deliberately does not depend on traversal-order IDs, screenshots,
or report prose as semantic identity.

## Compare the next run

```sh
tvdoctor baseline compare \
  --baseline tvdoctor-baseline.json \
  --report current-report/report.json
```

The CLI refuses to overwrite an existing comparison and prints new, resolved,
and unchanged finding counts. It writes the JSON comparison to the requested
output path and a sibling Markdown comparison next to it. For example,
`comparison.json` is accompanied by `comparison.md`; if the requested output has
another extension, `.md` is appended to that path.

| Status | Meaning | Default CI treatment |
| --- | --- | --- |
| `identical` | No semantic change | Pass |
| `changed` | Only non-regressive additions/resolutions | Project policy decides; library `shouldFail` is false |
| `regressed` | New issue, removed screen/focus/transition, changed transition, or latency regression | Fail |
| `failed-closed` | Comparison is not trustworthy | Fail and inspect blockers |

A latency regression must cross both configured absolute and relative thresholds.

## Why comparison fails closed

A comparison cannot report clean when the baseline and current run are not
meaningfully comparable. Blockers include:

- invalid or incompatible baseline data;
- target identity or platform mismatch;
- a partial/failed current report or exhausted coverage budget;
- partial semantic inventory;
- a missing capability required by the baseline;
- a baseline pack that did not complete in the current run; or
- a required latency observation that disappeared.

Do not regenerate a baseline simply to make CI green. Regenerate it when an
intentional product change has been reviewed and the replacement run is complete.

## Why CI does not prune the navigation scan to changed files

TVDoctor currently keeps the pull-request audit as a full bounded navigation
scan. The report can correlate an observed finding back to exact source matches,
but that correlation is produced after the finding exists. It is not a complete
dependency map from every changed file or component to every navigation state,
focus target, transition, setup path, or runtime data dependency.

Using that evidence to skip graph regions would therefore be unsound: a change
with no prior source correlation could still alter focus order, visibility,
layout, routing, startup state, or shared navigation behavior. A partial scan
could then report no regression simply because the affected state was never
visited. Incremental CI scanning stays deferred until TVDoctor can prove that
every excluded graph region is unaffected; the current Action deliberately does
not add a changed-files shortcut or reinterpret partial coverage as clean.

## Library API

```ts
import {
  compareBaseline,
  createBaseline,
  renderBaselineJson,
  renderComparisonJson,
  renderComparisonMarkdown,
} from "@tvdoctor/baseline";

const baseline = createBaseline(reviewedReport, reviewedInventory);
const comparison = compareBaseline(
  baseline,
  currentReport,
  currentInventory,
  {
    latencyAbsoluteToleranceMs: 100,
    latencyRatioThreshold: 1.2,
  },
);

await saveTrustedText("baseline.json", renderBaselineJson(baseline));
await saveTrustedText("comparison.json", renderComparisonJson(comparison));
await saveTrustedText("comparison.md", renderComparisonMarkdown(comparison));

if (comparison.shouldFail) process.exitCode = 1;
```

The host owns trusted file reads/writes. The baseline library compares validated
report/inventory models; it does not launch a driver or choose paths.

## Controlled regression fixture

Northstar exposes test-only clean/regressed variants:

```text
http://127.0.0.1:5173/?baselineVariant=clean
http://127.0.0.1:5173/?baselineVariant=regressed
```

The regressed variant removes focus in one controlled probe after Select. This is
fixture validation of the baseline lifecycle, not a public URL feature or a claim
about arbitrary real applications. See [Benchmarking](BENCHMARKING.md).

## Repository release gates

The repository CI uses the declared Node/npm versions, installs Playwright
Chromium, runs bounded package/core/driver/report/replay/fixture checks, exercises
the baseline example, and smoke-tests package consumption. An independent Android
job uses a disposable API 36 Android TV x86_64 emulator and the controlled
fixture.

Historical green runs are evidence for their exact commit only. A changed release
candidate needs a new hosted result at the exact candidate SHA.
