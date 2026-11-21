# Android Compose TV integration

Compose for TV apps use the same experimental Android TV path as other native
Android applications. TVDoctor tests the built APK from outside the process: it
sends DPAD input through ADB and observes focus, windows, visible controls, and
content changes through the TVDoctor Observer accessibility service.

```powershell
tvdoctor test --apk .\app-tv-release.apk --device emulator-5554 --mode quick --output tvdoctor-compose-tv
```

TVDoctor does not require a Compose dependency. The important integration point
is the semantics emitted by the running app. Controls that users can reach with a
remote should also expose stable focusable/accessibility nodes, useful labels,
and repeatable state after DPAD input. Custom drawing that omits semantics can
make a visually interactive surface opaque to the observer.

For deterministic navigation, keep focus ownership explicit in the app and avoid
depending on transient animation frames to decide which control receives focus.
When a dialog or overlay is visible, its semantics should reflect the same focus
boundary that the user experiences. TVDoctor waits for bounded accessibility and
content-change settling, but it will mark unstable or unavailable observation as
partial rather than infer a clean result.

## CI and emulator use

The repository's strongest automated Android evidence is an API 36 Android TV
x86_64 emulator. That is a useful place to start for Compose TV pull-request
checks. Keep emulator image, APK build, mode, and device/display facts fixed when
comparing runtime or coverage across revisions.

## Current limits

TVDoctor does not inspect Compose's internal focus graph or test composables in
process. It sees only the Android surface exposed at runtime. A GitHub Actions run
may separately correlate exact runtime identifiers with literal source matches in
Kotlin/XML or other checked-out text files, but it does not infer a composable
name when no exact identifier is present. Screenshot evidence
does not replace missing semantic nodes. Emulator evidence does not prove physical
device, firmware, launcher, or vendor behaviour, and a complete bounded scan does
not certify every app state. Actions that cannot be exercised safely remain
unexplored and keep the relevant coverage explicit.

See the [Android TV driver guide](../drivers/android.md) for setup and the
[physical-device proof guide](../physical-device-proof.md) before making hardware
compatibility claims. For repeatable app/build observations, use the
[real-app benchmark workflow](../BENCHMARKING.md#reusable-real-app-benchmark-workflow).
