# TVDoctor 0.1.0 for Windows

This GitHub Release bundle installs TVDoctor without an npm account and without
publishing TVDoctor packages to the npm registry. TVDoctor is installed in its
own directory under `%LOCALAPPDATA%\TVDoctor\0.1.0`; it does not globally
install or replace Playwright or the internal TVDoctor packages.

## Requirements

- Windows 10 or 11
- Node.js 24
- npm 11
- Internet access only for the optional first-time Chromium download performed
  by `tvdoctor setup`

## Install

Extract the ZIP, then run:

```powershell
.\install.ps1
tvdoctor setup
tvdoctor doctor
```

You can also double-click `install.cmd`. To install Chromium as part of the
same command:

```powershell
.\install.ps1 -SetupChromium
```

The installer uses only the tarballs in the local `packages\` directory and
creates a small `tvdoctor.cmd` launcher in npm's normal Windows command
directory. No npm sign-in is required.

## Use

```powershell
tvdoctor start
tvdoctor test https://example.com --mode quick
```

Android TV support is Experimental and is backed by Android TV API 36 emulator
evidence. This release does not claim broad physical-device or vendor support.

## Uninstall

```powershell
.\uninstall.ps1
```

or double-click `uninstall.cmd`.

Playwright browser downloads are stored separately from the npm packages and
are not deleted automatically by the uninstaller.

## Integrity

`CHECKSUMS-SHA256.txt` contains SHA-256 hashes for every file shipped inside
the bundle. The GitHub Release also publishes a SHA-256 file for the ZIP itself.
