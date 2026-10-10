# Physical Android TV and Fire TV proof

TVDoctor does not claim physical-device compatibility until a complete proof is
recorded on each named device and firmware version. The repository includes a
bounded proof runner that rejects emulators and verifies the resulting report.

## Before running

Use a test device without personal accounts or data. Enable developer options,
ADB debugging, and authorize the host. Build TVDoctor and enable **TVDoctor
Observer** in the device accessibility settings as described in the
[Android driver guide](drivers/android.md). The app APK must be authorized for
testing and should use a disposable test account if it needs one.

Confirm that exactly the intended serial is online:

```powershell
adb devices -l
```

## Record Android TV proof

```powershell
npm run build:packages
node scripts/run-physical-device-proof.mjs `
  --platform android-tv `
  --serial DEVICE_SERIAL `
  --apk D:\apps\test-build.apk `
  --output D:\tvdoctor-evidence\android-tv-proof
```

For Fire TV, connect it through ADB and use `--platform fire-tv`. The runner
requires physical hardware, the Android TV device characteristic, and Amazon
firmware identity before it accepts Fire TV proof. Amazon hardware is rejected
from an `--platform android-tv` run so a Fire TV row cannot be qualified by
accident.

Google TV uses the Android TV driver/report platform, so run it with
`--platform android-tv`. The proof runner records whether the physical device has
the Google TV Launcher package (`com.google.android.apps.tv.launcherx`) and marks
that exact model/firmware row as `family: "google-tv"`. Other non-Amazon Android
TV hardware is recorded as `family: "android-tv"`; Amazon hardware is always
`family: "fire-tv"`. This family label is proof metadata, not a claim that every
device using that branding is compatible.

If no real device is configured, run the script without `--serial`. It exits
successfully with `Physical proof was not run: no real device was configured
with --serial.` This status is intentionally not compatibility evidence; an
emulator run cannot be promoted into the physical-device matrix.

The scan must complete with no exhausted budget or incomplete pack. Findings may
exist; proof means that the driver and evidence lifecycle completed honestly, not
that the tested app was defect-free. The runner writes the normal local report
bundle plus a sibling `-physical-device-proof.json`. Its bounded compatibility row
records the manufacturer, stable Android device name and model, firmware
fingerprint, Android API, detected Android TV or Fire TV platform, TVDoctor Git
commit and version, APK SHA-256, proof date/run status, report/proof SHA-256, and
issue/action/screen/focus-target/transition counts. Rows also carry the physical
device family (`android-tv`, `google-tv`, or `fire-tv`). The detailed evidence
keeps effective display width/height/density, the Google TV Launcher qualifier,
and the QEMU/hardware signals used to reject emulators. It does not copy the ADB
serial from the private command input or rely on the public report target
location containing that serial.

`hashes.proofSha256` covers the stable proof evidence payload before the derived
`hashes` and `compatibility` fields are added. Matrix aggregation recomputes this
hash and rejects changed evidence. `hashes.reportSha256` and `hashes.apkSha256`
identify the exact report and APK bytes used for the proof.

## Aggregate a compatibility matrix

Pass one or more completed proof files with repeated `--aggregate` arguments:

```powershell
node scripts/run-physical-device-proof.mjs `
  --aggregate D:\tvdoctor-evidence\sony-proof-physical-device-proof.json `
  --aggregate D:\tvdoctor-evidence\fire-tv-proof-physical-device-proof.json `
  --matrix-output D:\tvdoctor-evidence\physical-compatibility-matrix.json
```

The matrix contains only the bounded compatibility rows. Duplicate proof hashes
collapse to one row. Aggregation rechecks the physical-TV identity and proof hash,
including the recorded hardware/QEMU emulator signals and Android/Google/Fire TV
family classification, so emulator evidence or tampered proof metadata is
rejected instead of becoming a physical compatibility entry.

Review both files before sharing because device metadata, screenshots, logs, and
app content may be sensitive. Keep proof bundles out of source control.

## Evidence needed for a compatibility claim

Record at least the manufacturer, Android device name/model, firmware fingerprint,
Android API, detected report platform, device family, TVDoctor commit/version,
app build hash, proof date/status, complete report, proof file, and the resulting
report/proof hashes.
Repeat on a maintained minimum matrix and after material observer, driver, or
firmware changes. One device run supports only that model and firmware; it does
not establish compatibility with every Android TV or Fire TV device.
