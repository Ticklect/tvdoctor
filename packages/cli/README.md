# `tvdoctor`

The TVDoctor command-line interface runs bounded, remote-control-style audits
against TV web applications and writes evidence-linked local report bundles.

## Requirements

- Node.js 24
- Chromium installed by TVDoctor

```sh
npm install --save-dev tvdoctor
npx tvdoctor setup
```

## First audit

Check the local runtime, then launch the guided flow or audit an absolute
HTTP(S) target directly:

```sh
npx tvdoctor doctor
npx tvdoctor start
npx tvdoctor test http://127.0.0.1:3000 --mode standard --output tvdoctor-report
```

`start` guides an interactive website or Android TV scan. Android TV support is
experimental and requires a connected, authorized ADB device plus an APK or
installed package. Use `test` for non-interactive web and CI runs.

`test` supports `quick` and `deep` modes; `standard` remains an advanced alias.
Use repeated `--pack`
options to select `navigation`, `streaming`, `search`, `settings`,
`accessibility`, `layout`, `performance`, or `crashes`; the default is `all`.
Run `npx tvdoctor test --help` for the complete option reference.

For a focused labels, remote-focus, and captions audit, run:

```sh
npx tvdoctor accessibility https://example.test/tv --mode quick
```

This profile selects the streaming and accessibility packs. Its browser result
does not claim TalkBack, device text scaling, audio-description preference, or
autoplay proof.

Targets that need a deterministic sign-in or profile-selection path can use a
bounded journey file:

```sh
TVDOCTOR_JOURNEY_PASSWORD='test-account-password' npx tvdoctor test https://example.test/app --journey journey.json
```

Journey files cannot contain typed values. They may only name scoped
`TVDOCTOR_JOURNEY_*` environment variables. A replay from that report requires
the same journey file and verifies its fingerprint before browser startup.

The output directory contains a human HTML report, portable Markdown, the
versioned `tvdoctor.report/v1` JSON document, evidence files, and any available
portable replay documents. A partial audit is inconclusive, not a clean pass.

## Replay

Replay a deterministic finding by its issue ID:

```sh
npx tvdoctor replay ISSUE_ID --report tvdoctor-report/report.json
```

Replay distinguishes a reproduced finding, a fixed finding, an inconclusive
run, and an execution error. Executing a replay is not itself proof that the
original defect reproduced; use the reported classification and fresh evidence.

## Regression baselines

```sh
npx tvdoctor baseline create --report tvdoctor-report/report.json --output tvdoctor-baseline.json
npx tvdoctor baseline compare --baseline tvdoctor-baseline.json --report current-report/report.json
```

Both commands use `inventory.json` beside the selected report unless
`--inventory` is supplied. Creation accepts only complete reviewed runs;
comparison fails closed when equivalent observation coverage is unavailable.

## Exit codes

| Code | Meaning |
| ---: | --- |
| 0 | Command completed successfully. |
| 1 | The local environment check failed. |
| 2 | Command usage was invalid. |
| 3 | The audit or replay was inconclusive. |
| 4 | Execution failed. |

Run `npx tvdoctor --help` for all commands. TVDoctor stores reports locally and
does not require an AI service, API key, cloud account, or telemetry service.
