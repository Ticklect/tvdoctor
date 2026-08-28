# Broken Android TV fixture

A small original native Android TV application used only for TVDoctor's
Milestone 9 emulator gate. It has no network permission, remote assets,
accounts, media, or destructive actions.

The launcher surface contains two real Android `Button` controls:

- **Focus Probe** has initial focus and moves Right to Safe Control.
- **Safe Control** moves Left back to Focus Probe and retains focus on Select.

Exactly one defect is seeded. Selecting Focus Probe blocks descendant focus and
clears the selected view while Safe Control remains visible, enabled, and
focusable. A truthful Android accessibility snapshot should therefore expose an available
`null` focused element after `SELECT`, allowing `remote.lost-focus` to be
detected and replayed. The canonical seed is in `seeded-defects.json`.

## Build

The build is Gradle-free and uses only JDK tools plus Android SDK API/build-tools
36. It never starts, wipes, or changes an emulator.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-apk.ps1 `
  -AndroidSdk "C:\path\to\android-sdk"
```

Alternatively set `TVDOCTOR_ANDROID_SDK` or `ANDROID_SDK_ROOT`, then run:

```sh
npm run build --workspace @tvdoctor/broken-android-tv
```

Output:

```text
build/outputs/apk/debug/tvdoctor-broken-android-tv-debug.apk
```

The script compiles resources, compiles Java 17 bytecode, converts it with D8,
aligns the APK, creates an ephemeral fixture-only debug key under ignored
`build/`, signs the APK, and runs structural/signature verification. No signing
material is committed.

## Static tests and APK verification

```sh
npm test --workspace @tvdoctor/broken-android-tv
npm run verify:apk --workspace @tvdoctor/broken-android-tv
```

The real acceptance gate must use a disposable Android TV emulator, install the
APK through `@tvdoctor/driver-android`, prove initial and directional focus,
capture UI hierarchy/screenshot/logs, detect exactly the manifest seed, generate
a report, and reproduce it after a force-stop/relaunch. Static tests and a
successful APK build do not by themselves establish Android platform support.
