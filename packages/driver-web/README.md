# `@tvdoctor/driver-web`

Experimental Playwright driver for TVDoctor's deterministic web testing path.

It launches Chromium, sends the six initial remote keys as real keyboard input,
waits for focus/DOM/`aria-busy` stability, and records bounded DOM snapshots,
screenshots, console/page errors, HTML media state, navigation timing, and
sanitised request outcomes.

UI nodes explicitly distinguish visible, enabled, focusable, focused, modal,
selection, and finite numeric-value state. Web selection is normalised to
`on`, `off`, or `mixed` from native checked/selected controls and supported
ARIA state attributes. `valueNow` is read from finite ARIA, range, and progress
values. Unknown, inapplicable, invalid, or conflicting observations remain
`null`; diagnostics never infer state from a role alone.

The advertised capabilities are deliberately narrow. `ui-tree` is a
DOM-derived semantic tree, not the browser accessibility tree, so the driver
does not claim `accessibility-tree`. It also does not capture video, inspect
cookies/headers/bodies/storage, or claim native player observability.

Screenshot paths are explicit, trusted caller input; they are never derived
from target-page content. The driver accepts only `.png`, `.jpg`, and `.jpeg`
artifact paths.

Driver operations accept an optional per-operation `AbortSignal`. Because
Playwright cannot cancel every in-flight browser command cooperatively, an
aborted operation closes and permanently retires that driver instance before
the caller regains control. Create a new driver for subsequent work.

```ts
import { PlaywrightWebDriver } from "@tvdoctor/driver-web";

const driver = new PlaywrightWebDriver();
await driver.launch({ id: "local-app", launchUri: "http://127.0.0.1:3000" });
await driver.press("RIGHT");
const snapshot = await driver.snapshot();
await driver.captureScreenshot("artifacts/right.png");
await driver.close();
```
