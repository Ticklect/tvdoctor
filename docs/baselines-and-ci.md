# Baselines and CI

## Ready-made audit output

`tvdoctor ci URL --fail-on LEVEL` runs the normal bounded audit and adds two
files under `exports/`: `ci-summary.md` for pull-request/job summaries and
`junit.xml` for CI test-result viewers. The required policy level is `any`,
`critical`, `high`, `medium`, `low`, `info`, or `never`. A partial or failed run
is always non-successful, even with `--fail-on never`.

GitHub Actions users can run `Ticklect/tvdoctor@v0.1.0` with `target`, `mode`,
and the required `fail-on` input. The action appends the summary to the job,
uploads the report bundle, and exposes `report` and `junit` outputs.

`@tvdoctor/baseline` compares one complete semantic audit with a compatible
complete current audit. The same fail-closed comparison is available through
the Experimental `tvdoctor baseline` CLI.

## Baseline contents

A `tvdoctor.baseline/v1` document records:

- stable target identity and platform;
- source report schema, run ID, mode, and TVDoctor version;
- capabilities and completed packs required for equivalent observability;
- deterministic/heuristic issue identity, rule, pack, severity, and confidence;
- semantic screens and focus targets;
- remote transitions;
- named latency observations.

It does not use traversal-order IDs as semantic identity and does not copy
screenshots or report prose into the comparison model.

## Create and compare

For normal use:

```sh
tvdoctor baseline create --report tvdoctor-report/report.json --output tvdoctor-baseline.json
tvdoctor baseline compare --baseline tvdoctor-baseline.json --report current-report/report.json
```

The CLI finds `inventory.json` beside each report by default, refuses to
overwrite an existing baseline or comparison, writes the full versioned JSON,
and prints new, resolved, and unchanged finding counts.

For library integrations:

```ts
import {
  compareBaseline,
  createBaseline,
  renderBaselineJson,
  renderComparisonJson,
} from "@tvdoctor/baseline";

const baseline = createBaseline(cleanReport, cleanInventory);
const baselineJson = renderBaselineJson(baseline);

const comparison = compareBaseline(
  baseline,
  currentReport,
  currentInventory,
  {
    latencyAbsoluteToleranceMs: 100,
    latencyRatioThreshold: 1.2,
  },
);
const comparisonJson = renderComparisonJson(comparison);

if (comparison.shouldFail) process.exitCode = 1;
```

The host owns trusted file reads/writes for `baselineJson` and
`comparisonJson`. The library accepts validated report models and semantic
inventory; it does not launch a driver or choose paths.

## Comparison outcomes

| Status | Meaning | CI treatment |
| --- | --- | --- |
| `identical` | No semantic change | Pass |
| `changed` | Only non-regressive additions/resolutions | Project policy decides; default library `shouldFail` is false |
| `regressed` | New issue, removed screen/focus/transition, changed transition, or latency regression | Fail |
| `failed-closed` | Comparison is not trustworthy | Fail and inspect blockers |

The change model includes new and resolved issues, screens/focus targets added
or removed, transitions added/removed/changed, and latency regressions. A
latency regression must cross both configured absolute and relative thresholds.

## Fail-closed observability

A comparison cannot report clean when:

- the baseline is invalid or incompatible;
- target identity or platform differs;
- the current report is partial, failed, or exhausted a coverage budget;
- the current semantic inventory is partial;
- a baseline capability is missing;
- a baseline pack did not complete;
- a required latency observation disappeared.

Do not override these blockers to make CI green. Regenerate a baseline only from
a deliberately reviewed complete run.

## Controlled fixture regression

Northstar exposes two test-only surfaces:

```text
http://127.0.0.1:5173/?baselineVariant=clean
http://127.0.0.1:5173/?baselineVariant=regressed
```

The regressed variant removes focus in one controlled probe after Select. It is
for proving baseline behaviour, not a public URL feature. The release gate must
show clean → regressed as exactly one new high regression, regressed → restored
as exactly one resolved issue, and clean → clean as no change before this
workflow is promoted.

## Repository CI safety model

The repository's aggregate release-candidate CI job:

1. grants only read access to repository contents;
2. pins official actions to reviewed commit SHAs;
3. installs the declared Node/npm versions from the lockfile;
4. installs Playwright Chromium and its Linux dependencies;
5. runs bounded unit, fixture, driver, core, report/replay, streaming, exact CLI
   M7, baseline-example, and package/consumer smoke gates under one job timeout;
6. fails on focused or flaky Playwright tests in CI;
7. uploads bounded diagnostic artifacts on failure with short retention; and
8. uses no secrets, privileged Android devices, or publish credentials.

An independent Android job boots a disposable hosted API 36 Android TV x86_64
emulator, builds the controlled fixture, installs the packaged observer, enables
its accessibility service only inside that disposable emulator, and requires a
completed seeded-defect report plus correlated replay. It uses no production
APK, persistent device, or signing secret.

Observer release signing is a separate, manual, environment-protected workflow.
Its keystore, passwords, and expected certificate digest are repository secrets
and are never available to pull-request jobs. The workflow must reproduce the
tracked APK and checksum/certificate manifest byte-for-byte.

## Hosted status

Earlier exact candidates have recorded green GitHub Actions runs on
`ubuntu-latest`, including the aggregate browser gates and baseline example. That
is valid historical evidence. It does not transfer to a changed commit: the final
release record must cite the exact candidate SHA, workflow run, attempt number,
and conclusion after all release changes are committed.

The workflow also runs `npm run test:package-smoke`, which builds tarballs,
inspects their contents, installs all packages into a clean consumer directory,
and checks public imports and CLI startup. This proves local tarball consumption;
it does not prove that npm publication has occurred.
