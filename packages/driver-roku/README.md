# `@tvdoctor/driver-roku`

This package is an **unvalidated contributor adapter** for Roku's first-party
WebDriver service. It maps the supported Roku WebDriver session, launch, remote
keypress, active-element, current-app, and screen-source endpoints into the
platform-neutral TVDoctor driver contract.

It is not a Roku compatibility claim. TVDoctor does not yet ship a supported Roku
CLI product path, a maintained real-device matrix, or a redistributable real-Roku
gate. The adapter remains below Experimental support until those proofs exist.

The Roku WebDriver process must already be running locally. The adapter accepts a
loopback WebDriver URL and the target Roku device IP separately; it will not send
WebDriver control requests to an arbitrary remote HTTP origin.

```ts
import { RokuTvDriver } from "@tvdoctor/driver-roku";

const driver = new RokuTvDriver({
  deviceIp: "192.0.2.10",
  webDriverUrl: "http://127.0.0.1:8080",
});

await driver.launch({ id: "dev" });
try {
  console.log(await driver.snapshot());
  console.log(await driver.press("RIGHT"));
} finally {
  await driver.close();
}
```

Before proposing support, run the shared `runDriverConformance()` gate against a
safe fixture, then repeat the complete exploration/report/replay lifecycle on a
named authorized Roku device. See `docs/drivers/authoring.md` and
`docs/drivers/roku.md`.
