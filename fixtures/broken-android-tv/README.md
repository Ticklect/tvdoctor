# Broken Android TV fixture

A small original native Android TV application used only for TVDoctor's
Milestone 9 emulator gate. It has no network permission, remote assets,
accounts, media, or destructive actions.

The launcher surface contains three real Android `Button` controls:

- **Focus Probe** has initial focus and moves Right to Safe Control.
- **Safe Control** moves Left back to Focus Probe, Right to Recreate Activity,
  and retains focus on Select.
- **Recreate Activity** calls Android's `Activity.recreate()` on the current
  `MainActivity`. The recreated instance exposes a status marker and returns
  initial focus to Focus Probe, providing a deterministic same-package lifecycle
  transition without changing the manifest's `configChanges` behavior.

Exactly one defect is seeded. Selecting Focus Probe moves input focus to a
transparent non-accessibility sink while Safe Control remains visible, enabled,
and focusable. A truthful Android accessibility snapshot should expose an
available `null` focused element after `SELECT`, allowing `remote.lost-focus` to be
detected and replayed. The canonical seed is in `seeded-defects.json`.

## Build

The build is Gradle-free and uses only JDK tools, pinned Android build-tools
36.0.0, and an installed compile platform at API 36 or newer while explicitly
targeting API 36. It never starts, wipes, or changes an emulator.

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
aligns the APK, signs it with the repository-owned fixture-only key under
`signing/`, and runs structural/signature verification. That password-`android`
test key is intentionally committed so local and hosted builds remain
upgrade-compatible. It is never used for the observer or a release artifact.
APK container bytes can differ between operating systems and JDK releases due
to archive metadata, so hosted CI verifies the fixture's package, signature,
structure, seeded behavior, report, and replay instead of relying on a
platform-specific file hash.

## Static tests and APK verification

```sh
npm test --workspace @tvdoctor/broken-android-tv
npm run verify:apk --workspace @tvdoctor/broken-android-tv
npm run verify:recreation --workspace @tvdoctor/broken-android-tv -- --device emulator-5554
```

`verify:recreation` installs the built fixture on the selected emulator, launches
`MainActivity`, navigates to **Recreate Activity**, activates it, and requires
lifecycle evidence for instance 1 destruction followed by instance 2 creation
inside the same `org.tvdoctor.fixture` process. It also verifies the recreated
UI reports completion and restores focus to Focus Probe.

The real acceptance gate must use a disposable Android TV emulator, install the
APK through `@tvdoctor/driver-android`, prove initial and directional focus,
capture UI hierarchy/screenshot/logs, detect exactly the manifest seed, generate
a report, and reproduce it after a force-stop/relaunch. Static tests and a
successful APK build do not by themselves establish Android platform support.
