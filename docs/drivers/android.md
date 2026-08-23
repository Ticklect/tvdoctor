# Android TV driver status

`@tvdoctor/driver-android` is an **Experimental** local adapter that executes the
Android SDK's `adb` binary with structured arguments. It never invokes a command
shell.

## Implemented surface

- select exactly one online device, preferably by explicit serial;
- wait for device readiness and expose bounded device/app metadata;
- install a caller-supplied APK;
- launch an explicit package/component or its `LEANBACK_LAUNCHER` entry;
- force-stop/relaunch and clear application data;
- send DPAD Up, Down, Left, Right, Center/Select, and Back;
- dump and parse a bounded UIAutomator hierarchy with focus and bounds;
- capture and validate bounded PNG screenshots;
- collect bounded process-filtered logcat entries.

The adapter advertises remote input, UI/accessibility hierarchy, screenshot,
logs, install, and launch capabilities. It does not advertise network,
performance, player-state, or video capture.

## Evidence boundary

Current automated tests use a bounded fake ADB executor. At the time of this
documentation, the disposable real Android TV emulator gate has **not** passed.
There is no claim of:

- successful installation/navigation/report/replay on a real emulator;
- physical Android TV or Google TV device compatibility;
- vendor launcher, permission, DRM, or system-dialog coverage;
- emulator creation, startup, snapshot, shutdown, or cleanup by the driver;
- Fire TV compatibility.

Those omissions are release facts, not documentation gaps. The status must stay
Experimental until the complete gate is recorded.

## Intended local use

Start and own a disposable emulator outside TVDoctor, then provide the exact ADB
path and serial:

```ts
import { AndroidTvDriver } from "@tvdoctor/driver-android";

const driver = new AndroidTvDriver({
  adbPath: "C:/Android/sdk/platform-tools/adb.exe",
  serial: "emulator-5554",
});

await driver.waitForDeviceReady();
await driver.install("fixtures/broken-android-tv/app/build/outputs/apk/debug/app-debug.apk");
await driver.launch({
  id: "org.tvdoctor.fixture",
  launchUri: "org.tvdoctor.fixture/.MainActivity",
});
```

The example describes the implemented API, not a verified emulator result.
`launchUri` is an Android component rather than a URL. Without it, the driver
uses Android's launcher discovery. The caller owns driver/emulator cleanup.

## Safety

- Use a disposable emulator with no personal accounts or data.
- Pass an explicit serial; ambiguous, offline, or unauthorised device lists fail
  closed.
- Confirm the selected package before install, clear-data, or force-stop.
- Never run device jobs with elevated credentials against untrusted pull request
  code.
- APK paths and screenshot destinations are trusted operator inputs.
- The structured executor rejects unsafe serial/package/component shapes and
  bounds output, time, hierarchy, logs, and screenshots.

## Required real-emulator gate

A status review requires one disposable Android TV emulator run that proves, in
order:

1. device identity and readiness;
2. fixture APK build and install;
3. launch and focused UI hierarchy;
4. real DPAD navigation, Select, and Back;
5. screenshot and process-filtered logs;
6. graph construction and seeded diagnostic detection;
7. local report/evidence generation;
8. deterministic replay where the schema supports it;
9. force-stop/relaunch and clean teardown.

A fake ADB test, successful APK build, or emulator boot alone does not satisfy
this gate.

## Unit verification

```sh
npm run typecheck --workspace @tvdoctor/driver-android
npm test --workspace @tvdoctor/driver-android
npm run lint --workspace @tvdoctor/driver-android
npm run build --workspace @tvdoctor/driver-android
```
