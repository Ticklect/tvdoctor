# @tvdoctor/driver-android

Experimental, local-first Android TV adapter for TVDoctor. It uses the Android
SDK's `adb` executable directly and never invokes a command shell.

Implemented capabilities:

- install a caller-supplied APK;
- launch and force-stop an application, with relaunch and clear-data resets;
- send real DPAD Up/Down/Left/Right, DPAD Center (Select), and Back key events;
- capture bounded UIAutomator accessibility hierarchies, current focus, roles,
  names, visibility evidence, and screen bounds;
- capture and validate PNG screenshots;
- collect bounded, process-filtered logcat records;
- expose bounded device and installed-app metadata.

The driver does not start or modify emulators. A caller must select an already
running device (preferably with an explicit `serial`) and owns emulator cleanup.
If no serial is supplied, exactly one online device must be present; ambiguous,
offline, or unauthorised device lists fail closed.

```ts
import { AndroidTvDriver } from "@tvdoctor/driver-android";

const driver = new AndroidTvDriver({
  adbPath: process.env.ANDROID_SDK_ROOT
    ? `${process.env.ANDROID_SDK_ROOT}/platform-tools/adb`
    : "adb",
  serial: "emulator-5554",
});

await driver.waitForDeviceReady();
await driver.install("fixtures/broken-android-tv/app/build/outputs/apk/debug/app-debug.apk");
await driver.launch({
  id: "org.tvdoctor.fixture",
  launchUri: "org.tvdoctor.fixture/.MainActivity",
});
```

`launchUri` is an Android component, not a web URL. If it is omitted, the
driver launches the package's `LEANBACK_LAUNCHER` entry via Android's `monkey`
tool. `reload` and `relaunch` both perform a native force-stop/relaunch;
`clear-data` additionally runs `pm clear` for the selected package.

UIAutomator does not expose every platform property. Missing values remain
`null` or an explicit unavailable observation. Inclusion in the active
UIAutomator dump plus a positive bounds rectangle is used as the conservative
visibility signal. The adapter does not claim network, performance,
player-state, or video-capture capabilities.

## Verification

```sh
npm run typecheck --workspace @tvdoctor/driver-android
npm test --workspace @tvdoctor/driver-android
npm run lint --workspace @tvdoctor/driver-android
npm run build --workspace @tvdoctor/driver-android
```

These unit tests use a bounded fake ADB executor. Platform support must remain
experimental until the Milestone 9 conformance and disposable Android TV
emulator gate passes install, launch, real DPAD input, hierarchy observation,
screenshot, logs, graph diagnostics, report generation, and replay.
