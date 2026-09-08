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
firmware identity before it accepts Fire TV proof.

The scan must complete with no exhausted budget or incomplete pack. Findings may
exist; proof means that the driver and evidence lifecycle completed honestly, not
that the tested app was defect-free. The runner writes the normal local report
bundle plus a sibling `-physical-device-proof.json` containing device metadata,
the report hash, run ID, issue count, and action count.

Review both files before sharing because device metadata, screenshots, logs, and
app content may be sensitive. Keep proof bundles out of source control.

## Evidence needed for a compatibility claim

Record at least the manufacturer, model, firmware fingerprint, Android API,
TVDoctor commit/version, app build hash, command, complete report, and proof file.
Repeat on a maintained minimum matrix and after material observer, driver, or
firmware changes. One device run supports only that model and firmware; it does
not establish compatibility with every Android TV or Fire TV device.
