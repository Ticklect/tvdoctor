# Examples

These examples keep the v1 workflow centered on automatic remote-navigation
discovery. The source packages are versioned `0.1.0`; GitHub Release bundles are
the documented distribution path for the public preview.

## 1. Prove the packaged path with `tvdoctor demo`

After installing the matched Chromium runtime:

```sh
tvdoctor setup
tvdoctor demo
```

The packaged Northstar demo is navigation-only. The proven bounded run completes
**6 actions, 1 state, 1 issue**: it finds the seeded Home `More info`
`remote.reachability` failure and the deterministic replay returns
**REPRODUCED**.

This is **controlled seeded evidence, not a measure of production accuracy**.
Use it to verify that your TVDoctor installation can launch Chromium, run the
navigation engine, write evidence, correlate a replay, and reproduce the known
fixture defect. See the [sample report](sample-report.md) for the sanitized
evidence excerpt.

## 2. Audit navigation without writing a path

With a built source checkout and a target already running:

```sh
npm run tvdoctor -- test http://127.0.0.1:3000 \
  --pack navigation \
  --mode quick \
  --output tvdoctor-report
```

TVDoctor explores the remote graph itself. You do not supply the expected route,
screen list, or sequence of D-pad presses. Open `report.html`, then check the run
status before treating zero findings as clean. Navigation scans also write
`navigation-graph.json` for machine-readable graph data and
`navigation-graph.md` for a reviewable graph of observed screens, focus targets,
remote edges, and evidence-backed problem annotations. `inventory.json` remains
alongside them for semantic baseline input.

If the app starts behind login, consent, or another setup wall, prepare that state
explicitly. Automatic navigation discovery begins from the resulting auditable
surface.

## 3. Put the same check in CI

```sh
tvdoctor ci http://127.0.0.1:3000 \
  --pack navigation \
  --mode quick \
  --fail-on high
```

The CI command adds a Markdown summary and JUnit export. Findings at or above the
configured threshold fail the command; partial and failed runs are always
non-successful.

## 4. Create and compare a baseline

```sh
tvdoctor baseline create \
  --report tvdoctor-report/report.json \
  --output tvdoctor-baseline.json

tvdoctor baseline compare \
  --baseline tvdoctor-baseline.json \
  --report current-report/report.json
```

Create the baseline only from a reviewed complete run. The comparison tracks
semantic findings, screens, focus targets, transitions, and named latency
observations and fails closed when observability is not comparable. A comparison
written as JSON also gets a sibling Markdown rendering with the same basename.

## 5. Replay one deterministic navigation failure

```sh
npm run tvdoctor -- replay ISSUE_ID \
  --report tvdoctor-report/report.json \
  --target http://127.0.0.1:3000
```

Replay restores the target, executes the stored setup actions, checks the
pre-action focus checkpoint, sends the final remote key, and compares the
observed transition. Unsupported issue semantics are rejected instead of being
approximated.

## 6. Use the web driver directly

```ts
import { PlaywrightWebDriver } from "@tvdoctor/driver-web";

const driver = new PlaywrightWebDriver();
await driver.launch({
  id: "local-tv-app",
  launchUri: "http://127.0.0.1:3000",
});

try {
  await driver.press("RIGHT");
  const snapshot = await driver.snapshot();
  console.log(snapshot.focusedElement);
} finally {
  await driver.close();
}
```

The web driver exposes DOM-derived semantics. It does not claim browser
accessibility-tree coverage.

## 7. Run bounded core exploration as a library

```ts
import { explore } from "@tvdoctor/core";

const result = await explore(driver, {
  profile: "quick",
  actions: ["UP", "DOWN", "LEFT", "RIGHT", "SELECT", "BACK"],
});

console.log(result.termination);
console.log(result.statistics);
```

The core builds screen/focus graphs under action, state, depth, and duration
budgets. A cutoff is incomplete rather than clean.

## Secondary diagnostic packs

Streaming, search, settings, accessibility, layout, performance, and crash packs
remain available. They are useful when the selected driver exposes the required
semantics, but they are secondary to the v1 navigation workflow. Missing required
observability produces partial/unavailable results instead of an inferred pass.

See [Baselines and CI](baselines-and-ci.md), [Benchmarking](BENCHMARKING.md), and
[Current limitations](limitations.md) before using a result as release evidence.
