# Web driver

`@tvdoctor/driver-web` is the first experimental platform adapter. It uses
Playwright 1.62.1 to launch Chromium with a 1280×720 default viewport and maps
the six remote actions to keyboard input.

## Current evidence

The adapter has real-Chromium integration coverage for:

- launch, reset, and cleanup;
- Up, Down, Left, Right, Select, and Back input;
- bounded focus and DOM-derived UI hierarchy snapshots;
- visible, enabled, focusable, focused, modal, selection, bounds, and finite
  numeric-value observations;
- bounded focus/DOM/`aria-busy` settling;
- PNG/JPEG screenshots at trusted output paths;
- bounded console and page errors;
- sanitised request outcome metadata;
- navigation and action timing;
- HTML media playback observations.

The controlled Northstar integration is real browser evidence. It is not a
compatibility claim for every framework, browser, DRM player, cross-origin
frame, canvas UI, or production application.

## Use as a library

```ts
import { PlaywrightWebDriver } from "@tvdoctor/driver-web";

const driver = new PlaywrightWebDriver({
  headless: true,
  settle: {
    noResponseGraceMs: 250,
    quietWindowMs: 120,
    timeoutMs: 4_000,
  },
});

await driver.launch({
  id: "local-tv-app",
  launchUri: "http://127.0.0.1:3000",
});

try {
  await driver.press("RIGHT");
  const state = await driver.snapshot();
  const logs = await driver.getLogs();
  console.log(state.focusedElement, logs);
} finally {
  await driver.close();
}
```

Install the matching bundled browser before use:

```sh
npx playwright install chromium
```

## What it does not claim

- The UI tree is derived from DOM semantics; it is not the browser accessibility
  tree, so the driver does not advertise `accessibility-tree`.
- It does not record video or traces through the public driver contract.
- Network observation retains bounded request method/origin/path/status/timing
  metadata, not request or response bodies, cookies, or authentication headers.
- It cannot semantically inspect a TV interface rendered only to canvas/video
  without accessible DOM controls.
- Cross-origin frames and closed shadow roots may reduce observability.
- Native browser chrome, OS dialogs, DRM prompts, permission surfaces, and
  external players are outside its current contract.
- Chromium evidence does not imply Firefox, WebKit, smart-TV browser, or
  embedded-webview compatibility.
- Pointer proof used by a remote-reachability diagnostic must run in a fresh
  isolated context and demonstrate a concrete state change.

## Safety

Audit only authorised targets. Prefer a local disposable build with synthetic
data. Target code runs in a real browser and can initiate network requests.
Credentials in a URL are rejected by the CLI, but the driver itself is a library
and its caller owns target validation.

Driver text and URL metadata are bounded and common secret shapes are redacted.
This is defence in depth: inspect logs and reports before uploading them. Pass
only trusted `.png`, `.jpg`, or `.jpeg` screenshot destinations.

## Verification

```sh
npm run typecheck --workspace @tvdoctor/driver-web
npm test --workspace @tvdoctor/driver-web
npm run lint --workspace @tvdoctor/driver-web
npm run build --workspace @tvdoctor/driver-web
```

The package remains **Experimental** until broader framework, operating-system,
and consumer-project gates justify a status change.
