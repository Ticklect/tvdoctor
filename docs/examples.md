# Examples

These examples describe the current `0.1.0` source packages. Package/consumer
smoke tests exist, but registry commands remain unsupported until npm publication
and post-publication installation are verified.

## Inspect a web target through the driver

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
  await driver.captureScreenshot("artifacts/example/right.png");
} finally {
  await driver.close();
}
```

Only pass trusted screenshot paths. The driver creates parent directories but
does not derive paths from page content.

## Run bounded core exploration

```ts
import { explore } from "@tvdoctor/core";

const result = await explore(driver, {
  profile: "quick",
  actions: ["UP", "DOWN", "LEFT", "RIGHT", "SELECT", "BACK"],
});

console.log(result.termination);
console.log(result.statistics);
```

An explicit profile activates deterministic priority scheduling and conservative
repeated-item compression. It still enforces action, state, depth, and duration
limits. A cutoff is an incomplete result, not a clean audit.

## Run the streaming pack

```ts
import { runStreamingPack } from "@tvdoctor/pack-streaming";

const result = await runStreamingPack(driver);
for (const stage of result.stages) {
  console.log(stage.stage, stage.status);
}
for (const issue of result.issues) {
  console.log(issue.severity, issue.rule, issue.title);
}
```

The pack discovers semantics from observable roles, names, selection state,
player progress, and remote transitions. Platform-specific pointer proof must be
provided by a fresh isolated context; never fabricate it from fixture metadata.

## Run selected web stages

```ts
import { runWebPack } from "@tvdoctor/pack-web";

const result = await runWebPack(driver, {
  stages: ["search", "settings", "accessibility", "crash"],
  searchQuery: "N",
});

console.log(result.termination, result.statistics);
```

Some stages require web-host hooks for computed styling, viewport measurements,
pointer activation, text entry, performance timing, or logs. Without required
observability a stage reports partial/unobservable rather than passing.

## Create and compare a semantic baseline

```ts
import {
  compareBaseline,
  createBaseline,
  renderBaselineJson,
} from "@tvdoctor/baseline";

const baseline = createBaseline(cleanReport, cleanInventory);
await saveTrustedText("artifacts/baseline.json", renderBaselineJson(baseline));

const comparison = compareBaseline(baseline, currentReport, currentInventory);
if (comparison.shouldFail) {
  console.error(comparison.status, comparison.blockers, comparison.changes);
  process.exitCode = 1;
}
```

`cleanInventory` and `currentInventory` must contain complete semantic screens,
focus targets, transitions, and latency observations produced by the audit host.
`saveTrustedText` is intentionally application-owned; the baseline package does
not choose filesystem paths.

## Replay an issue from the CLI

```sh
npm run tvdoctor -- replay ISSUE_ID --report tvdoctor-report/report.json
```

Use `--target http://127.0.0.1:3000` to override a recorded web target. The CLI
accepts deterministic, correlated focus-transition replays; unsupported issue
semantics are rejected instead of approximated. When an audited route used a
query string or fragment, the report may redact it; pass the exact authorised
route again with `--target` rather than replaying a different page.

## Experimental local CLI audit

From a built source checkout with the target already running:

```sh
npm run tvdoctor -- test http://127.0.0.1:3000 --pack navigation --pack streaming --pack accessibility --mode standard --output tvdoctor-report --query N
```

Pack names are `navigation`, `streaming`, `search`, `settings`, `accessibility`,
`layout`, `performance`, and `crashes`. Repeating `--pack` selects several;
omitting it selects `all`. The complete controlled M7 fixture gate has passed;
the audit host remains Experimental because that evidence does not establish
arbitrary-app accuracy. After registry publication, the intended equivalent is
`npx tvdoctor test ...`.

A complete run can exit 1 when it finds issues. A partial/inconclusive run exits
3 and is never a clean result. Write each run to a new trusted output directory,
then open `report.html` and inspect pack coverage and unavailable evidence before
using `report.json` in automation.
