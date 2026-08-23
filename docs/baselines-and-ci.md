# Baselines and CI

`@tvdoctor/baseline` compares one complete semantic audit with a compatible
complete current audit. It is an Experimental library surface; this repository
does not claim an active hosted CI run or a released baseline CLI workflow.

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

## CI safety model

An initial browser-only CI job should:

1. use a read-only source checkout where possible;
2. install the declared Node/npm versions and a pinned lockfile;
3. install only the Playwright Chromium dependency required by the job;
4. run bounded fixture gates with a job timeout;
5. upload report artifacts even when diagnostics fail;
6. avoid secrets for forked or untrusted pull requests;
7. retain artifacts for the shortest useful period;
8. fail when the run is partial or the comparison fails closed.

Android/emulator CI is a separate trust tier. Never expose privileged hardware,
signing keys, production APKs, or persistent emulator state to untrusted pull
request code.

## Hosted status

Workflow files can be syntax-checked and commands can be run locally, but that
does not prove a hosted service executed them. Until this repository has a real
remote and recorded green run, documentation and release notes must say “CI
example” or “locally validated workflow,” not “CI passing.”
