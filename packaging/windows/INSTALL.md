# Published TVDoctor v0.1.0 for Windows

This guide describes the **published v0.1.0 Windows ZIP**. The development
checkout contains newer commands and a broader runtime matrix that are not
included in that downloadable ZIP. The bundle installs without an npm account
and keeps its packages under `%LOCALAPPDATA%\TVDoctor\0.1.0`. It does not
install Playwright globally.

## Requirements

- Windows 10 or 11
- **Node.js 24** (the published installer rejects Node 22)
- **npm 11** (the published installer rejects npm 10)
- Internet access for the first-time Chromium download performed by
  `tvdoctor setup` (or the `-SetupChromium` installer option)

## Install

Download `TVDoctor-v0.1.0-windows.zip` from the
[published release](https://github.com/Ticklect/tvdoctor/releases/tag/v0.1.0),
extract it, then run in PowerShell from the extracted directory:

```powershell
.\install.ps1
tvdoctor setup
tvdoctor doctor
tvdoctor start
```

`tvdoctor start` opens the guided first scan: choose **Website**, enter the URL
of your running TV web app, and select the navigation scan. You can also
double-click `install.cmd`. To install Chromium as part of the installer:

```powershell
.\install.ps1 -SetupChromium
```

The published installer uses only the tarballs in the local `packages\`
directory and creates `tvdoctor.cmd` in npm's global command directory. No npm
sign-in is required. **The published v0.1.0 installer replaces an existing
`%LOCALAPPDATA%\TVDoctor\0.1.0` directory and overwrites any existing
`tvdoctor.cmd` at the selected launcher location.** Check for an existing
installation or same-named launcher first. The ownership checks in the current
development installer are **unreleased**.

The published installer checks that the CLI returns a version but does not run
`tvdoctor doctor` automatically. Run `tvdoctor doctor` after setup as above. If
the shell cannot find `tvdoctor`, run the full launcher path printed during
installation or add npm's global command directory to `PATH`.

## Use

For a non-interactive first scan of a running TV web app, use the **published**
`test` command, selecting the navigation pack and quick mode explicitly:

```powershell
tvdoctor test http://127.0.0.1:3000 --pack navigation --mode quick --output tvdoctor-report
```

Open `tvdoctor-report/report.html` after the scan. A finding can make the audit
exit `1`; a partial run exits `3` and is not evidence of clean navigation.
The downloadable v0.1.0 ZIP does **not** have the `tvdoctor demo` or
`tvdoctor scan` shortcuts shown for the **unreleased source checkout** in newer
repository documentation. The [sample Northstar report](../../docs/sample-report.md)
is controlled seeded evidence, not a production-app accuracy measurement.

Android TV support is Experimental and is backed by Android TV API 36 emulator
evidence. This release does not claim broad physical-device or vendor support.

## Uninstall

```powershell
.\uninstall.ps1
```

or double-click `uninstall.cmd`.

The published uninstaller resolves the launcher directory using `npm prefix -g`
and removes `tvdoctor.cmd` there only if its contents point to this install. It
removes `%LOCALAPPDATA%\TVDoctor\0.1.0`. The more restrictive ownership
metadata in the development checkout is **unreleased**. Keep npm available
until after uninstalling this published release.

Playwright browser downloads are stored separately from the npm packages and
are not deleted automatically by the uninstaller.

## Integrity

`CHECKSUMS-SHA256.txt` contains SHA-256 hashes for every file shipped inside
the bundle. The GitHub Release also publishes a SHA-256 file for the ZIP itself.
