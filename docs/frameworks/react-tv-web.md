# React TV / web integration

TVDoctor can test a React TV interface when the app is exposed as an HTTP(S)
site and its remote-navigation surface is represented by normal focusable DOM
elements. The web path launches real Chromium, sends Arrow keys, Enter, and
Escape through the Playwright driver, then observes focus and DOM-derived
semantics while it explores the navigation graph.

## Recommended setup

Run the same production-like build you use for TV browser testing on a local or
otherwise authorised URL. Keep the initial route deterministic: use test data,
a fixed profile, and a known viewport where possible.

With the **published v0.1.0 Windows ZIP**, use the available `test` command:

```sh
tvdoctor test http://127.0.0.1:3000 --pack navigation --mode quick --output tvdoctor-react-report
```

The **unreleased source checkout** also provides the shorter `scan` command:

```sh
npm run tvdoctor -- scan http://127.0.0.1:3000 --mode quick --output tvdoctor-react-report
```

React does not need a TVDoctor package or hook. What matters is the rendered UI:
interactive controls should be focusable DOM elements with stable semantic
labels, focus should move in response to the same keyboard events that represent
the remote, and dialogs/overlays should expose their focus boundary in the DOM.

If login, consent, or profile selection is required before the TV surface appears,
use a bounded [custom preparation journey](../custom-web-journeys.md). Keep
credentials in the supported environment variables rather than in the target URL
or the benchmark manifest.

## Complete GitHub Actions example

This example is for a **Vite-based React TV web app** with a committed
`package-lock.json` and `npm run build` / `npm run preview` scripts. Adapt the
build and server commands if your app uses another framework. The same GitHub
Actions job starts the app, waits until it responds over loopback, then runs the
**published** `Ticklect/tvdoctor@v0.1.0` Action with its required policy inputs.
Save it as `.github/workflows/tv-navigation.yml` in your **TV app repository**:

```yaml
name: TV remote navigation

on:
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  tv-navigation:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - name: Check out TV app
        uses: actions/checkout@v4

      - name: Set up app Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: npm

      - name: Install and build TV app
        run: |
          npm ci
          npm run build

      - name: Start TV app on loopback
        run: |
          nohup npm run preview -- --host 127.0.0.1 --port 3000 --strictPort > "$RUNNER_TEMP/tv-app.log" 2>&1 &

      - name: Wait for TV app to become ready
        run: |
          for attempt in $(seq 1 60); do
            if curl --fail --silent --output /dev/null http://127.0.0.1:3000/; then
              exit 0
            fi
            sleep 2
          done
          cat "$RUNNER_TEMP/tv-app.log"
          exit 1

      - name: Audit TV remote navigation
        uses: Ticklect/tvdoctor@v0.1.0
        with:
          target: http://127.0.0.1:3000/
          pack: navigation
          mode: quick
          fail-on: high

      - name: Show app startup logs on failure
        if: failure()
        run: cat "$RUNNER_TEMP/tv-app.log" || true
```

The Action runs on the same GitHub-hosted runner, installs its own matched
Chromium, and uploads a `tvdoctor-report-*` artifact even when the audit fails.
It also writes a GitHub job summary and exposes the `report` and `junit`
outputs. The published `v0.1.0` Action does **not** accept a baseline or PR
comment input, perform source correlation, or produce the unreleased
`navigation-graph` and `comparison` Action outputs. Those features exist only
in the current source checkout until a newer release is tagged.

This workflow presumes the app loads the intended screen without manual login
or profile selection. An HTTP 200 response only proves the server is ready;
review the resulting report for blocked or untested navigation. A run may fail
because the specified severity threshold was reached or because exploration was
partial. A clean result only applies to observed Chromium navigation, and does
not certify the app on a physical smart TV or establish production accuracy.

To make regressions meaningful, create a reviewed semantic baseline from a
complete comparable run. See [Baselines and CI](../baselines-and-ci.md) for the
CLI workflow and the unreleased Action baseline integration.

## What this catches well

- focus loss after Arrow-key navigation;
- self-loops where an aligned focusable target should be reachable;
- remote-unreachable controls when local coverage is complete enough;
- focus traps and focus leaking behind visible dialogs;
- broken Back/Escape navigation and abnormal directional jumps; and
- deterministic failures that can be replayed from the stored report.

## Current limits

TVDoctor reads DOM semantics, not the browser accessibility tree. Canvas-only or
video-rendered controls, closed shadow roots, cross-origin frames, browser chrome,
DRM prompts, permission surfaces, and external players can reduce or remove
observability. A Chromium run does not prove behaviour in a smart-TV browser,
embedded webview, Firefox, or WebKit. Framework choice does not change those
boundaries: React is supported only to the extent that it renders an observable,
keyboard-operable web surface.

The **unreleased Action in the source checkout** can perform bounded exact
source correlation after the report is written. If a stable
runtime element ID such as `hero-more-info` appears literally in JSX, TypeScript,
CSS, or another scanned text file, the source-correlation export can record its
relative path and line. It does not parse the React component tree or guess a
component when the identifier is absent.

For broader evidence, run the same app/build more than once and record the result
with the [real-app benchmark workflow](../BENCHMARKING.md#reusable-real-app-benchmark-workflow).
