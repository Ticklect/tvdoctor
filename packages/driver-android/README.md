# @tvdoctor/driver-android

Experimental Android TV adapter backed by the persistent TVDoctor Observer APK.
It implements the existing platform-neutral `TVDoctorDriver` contract.

Normal exploration uses:

- one persistent, authenticated, framed local observer connection;
- Android accessibility window/focus/content events;
- bounded event-driven settling and canonical snapshots;
- one ADB `input keyevent` call per remote action;
- on-demand ADB screenshots and bounded logcat evidence.

ADB remains responsible for device discovery, observer/target installation,
launch, reset, input, screenshots, port forwarding, and cleanup. UIAutomator
hierarchy dumping is not part of the production action loop.

All public device operations share one FIFO queue, including discovery,
installation, metadata collection, force-stop, and screenshots. This gives
screenshots and lifecycle changes a defined boundary relative to input and
observer requests. Operations that accept `DriverOperationOptions` also pass
its `AbortSignal` through observer and ADB work for cooperative cancellation.

```ts
import { AndroidTvDriver } from "@tvdoctor/driver-android";

const driver = new AndroidTvDriver({ serial: "emulator-5554" });
try {
  await driver.install("example.apk");
  await driver.launch({ id: "org.example.tv", launchUri: ".MainActivity" });
  const result = await driver.press("RIGHT");
  console.log(result.timing.profile?.totalMs, result.postActionSnapshot);
} finally {
  await driver.close();
}
```

The packaged observer asset is versioned, checksum-validated, and tied to host
protocol version 2. `prepack` verifies that exact release asset and never creates
or publishes a signing key. Maintainers use `build:observer` with controlled
signing material when updating the tracked APK. First use requires explicit
accessibility enablement on the device. See the repository's Android driver
guide for setup, security, CI, privacy, support boundaries, and uninstall
instructions.

## Verification

```sh
npm run build:observer --workspace @tvdoctor/driver-android
npm run typecheck --workspace @tvdoctor/driver-android
npm test --workspace @tvdoctor/driver-android
npm run lint --workspace @tvdoctor/driver-android
npm run build --workspace @tvdoctor/driver-android
```
