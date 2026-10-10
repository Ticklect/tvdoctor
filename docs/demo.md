# Demo and exact reproduction

`tvdoctor demo` is the fastest way to see the current v0.1 product path without
supplying an application URL or authoring a navigation script. It runs the
packaged Northstar navigation-only fixture through the same quick navigation
engine used by normal web scans, writes a regular report bundle, then replays the
known deterministic failure.

## Run the packaged demo

Install the matched Chromium runtime, then run:

```sh
tvdoctor setup
tvdoctor demo
```

The proven packaged run completes **6 actions, 1 state, 1 issue**. TVDoctor finds
the seeded Home `More info` `remote.reachability` failure and the stored replay
classifies it as **REPRODUCED**.

This is **controlled seeded evidence, not a measure of production accuracy**.
Northstar is deliberately broken so the command has a stable first-success
contract. The result verifies packaging, browser launch, bounded navigation,
evidence/report generation, replay correlation, and deterministic replay against
that fixture. It does not establish production recall, precision, compatibility,
or release readiness for arbitrary TV applications.

For an instant evidence view, open the checked-in [sample report](sample-report.md).

## What the demo proves

The controlled failure is intentionally small and obvious:

| Field | Demo contract |
| --- | --- |
| Fixture | Packaged Northstar, navigation-only |
| Screen | Home |
| Rule | `remote.reachability` |
| Starting focus | `hero-watch` |
| Remote action | `RIGHT` |
| Expected target | visible `More info` / `hero-more-info` |
| Observed target | focus remains on `hero-watch` |
| Audit result | 6 actions, 1 state, 1 issue |
| Replay result | `REPRODUCED` |

The demo serves the packaged static fixture on a loopback-only ephemeral port
for the audit. Replay is then verified against a freshly served copy of the same
packaged fixture, so the saved report does not depend on the original ephemeral
port remaining alive. Both loopback servers are shut down automatically. It does
not require Vite or a second terminal.

Typical proof includes:

```text
Packs 1/1 completed
Actions 6/300
States 1; issues 1; evidence failures 0
Seeded More info D-pad failure VERIFIED
Replay classification REPRODUCED
Demo VERIFIED: the seeded D-pad failure was found with deterministic evidence.
Replay: REPRODUCED
Replay command: tvdoctor replay TVDOCTOR-NAV-... --report ".../report.json"
```

That saved replay command remains usable after `tvdoctor demo` exits: TVDoctor
recognises the controlled packaged-demo marker in the report and serves a fresh
local fixture for replay without restoring the redacted ephemeral URL.

## Windows release bundle

After extracting the Windows bundle:

```powershell
.\install.ps1
tvdoctor setup
tvdoctor doctor
tvdoctor demo
```

`tvdoctor setup` explicitly installs and verifies the Chromium build matched to
this TVDoctor version. The demo and normal web scans can recover by installing a
missing runtime automatically, but explicit setup is preferable for a predictable
first run or CI preflight.

## Source checkout

From the repository root:

```sh
npm ci
npm run build
npm run tvdoctor -- setup
npm run tvdoctor -- doctor
npm run tvdoctor -- demo
```

The source build stages the fixture into the CLI package. The demo therefore
exercises the same packaged-asset boundary used by installed-package smoke tests.

## Future npm usage

The `tvdoctor` package is not published to npm yet. After a future publication,
the intended equivalent will be:

```sh
npx tvdoctor setup
npx tvdoctor demo
```

Until then, use the Windows bundle or source checkout rather than assuming the
registry command exists.

## Exit semantics

`tvdoctor demo` exits `0` only when the controlled audit completes, the expected
seeded issue is present with its correlated replay, and replay returns
`REPRODUCED`. A partial/inconclusive demo exits `3`; invalid usage exits `2`; an
execution or contract-verification failure exits `4`; missing required local
runtime support can exit `1`.

That demo-specific success rule is intentionally different from a standalone
`tvdoctor replay ISSUE_ID`: for a real target, a standalone replay that returns
`REPRODUCED` exits `1` because the defect is still present.

## Move from demo to your app

Once the demo works, point the navigation-first scan at your own running web app:

```sh
tvdoctor scan https://your-tv-app.example --mode quick
```

Web support is Experimental. Android TV support is also Experimental and has a
different ADB/Observer prerequisite path. A clean result only describes completed
observed coverage, so review [Current limitations](limitations.md) and
[Benchmarking](BENCHMARKING.md) before using a run as release evidence.

If you capture the demo for documentation or a video, keep the Northstar/seeded
fixture label visible and do not present the controlled result as third-party app
accuracy evidence.
