# Android TV testing

Android TV app testing is experimental. The normal product entry point remains:

```powershell
tvdoctor start
```

Choose **Android TV app - Experimental**, select a local APK, and TVDoctor
handles device discovery, observer deployment, APK installation, launch,
exploration, evidence, and cleanup.

## Requirements and support boundary

- Node.js and npm versions supported by the TVDoctor package;
- Android SDK platform-tools (`adb`) and build-tools (`aapt` or `aapt2`);
- one authorized Android TV emulator/device, or an explicitly selected serial;
- Android API 23 or newer;
- TVDoctor Observer accessibility access enabled on the selected device.

The automated release gate verifies a disposable Android TV API 36 x86_64
emulator. API 23 is the observer's minimum SDK, not a claim that every vendor
device between API 23 and API 36 has been validated. Physical Android TV and
Google TV compatibility remains an explicit experimental limitation.

## TVDoctor Observer setup

TVDoctor installs `org.tvdoctor.observer`, a small TVDoctor-owned APK. It does
not modify or instrument the APK under test. On first use, the observer opens a
device-local setup screen explaining why accessibility access is required.

Enable **TVDoctor Observer** in Android accessibility settings, then rerun the
scan. TVDoctor checks the setting and fails closed if it is unavailable; it does
not silently grant accessibility access or report a successful test without UI
observation.

When access is already enabled, the token-provisioning activity verifies the
canonical enabled-service component, stores the per-run token, and immediately
closes. It does not leave the first-use warning in front of the app under test.

To open the correct device settings page from a host terminal:

```powershell
adb -s SERIAL shell am start -a android.settings.ACCESSIBILITY_SETTINGS
adb -s SERIAL shell settings get secure enabled_accessibility_services
```

Use the TV remote to enable **TVDoctor Observer**. The second command is a
read-only verification aid; TVDoctor does not use privileged `settings put`
commands to bypass user consent.

The observer uses Android's `AccessibilityService`, `AccessibilityEvent`, and
`AccessibilityNodeInfo` APIs because they provide the supported cross-app focus,
window, visible-control, and content-change data needed by TVDoctor. Android
does not give an ordinary accessibility service permission to synthesize
arbitrary DPAD keys into another app, so TVDoctor deliberately retains the fast
ADB `input keyevent` primitive for input. ADB is not used to dump UIAutomator
hierarchies during normal exploration.

Automatic exploration remains bounded to `UP`, `DOWN`, `LEFT`, `RIGHT`,
`SELECT`, and `BACK`. Explicit startup/replay actions additionally support
`HOME`, `PLAY_PAUSE`, `PLAY`, `PAUSE`, `STOP`, `NEXT`, `PREVIOUS`, `REWIND`,
and `FAST_FORWARD`. HOME and media controls are never added to the automatic
frontier, so a scan cannot unexpectedly leave the tested app or control media.

To remove the observer:

```powershell
adb -s SERIAL uninstall org.tvdoctor.observer
```

Removing it also removes its local settings. Android may retain the disabled
accessibility entry until the settings screen refreshes.

## How actions settle

For each action TVDoctor:

1. arms a uniquely identified observer action;
2. sends one structured ADB key event synchronously after the target window
   has proven continuously focused, preventing late input from crossing a
   replay reset boundary;
3. waits for focus, selection, scroll, window, or content events;
4. requires a 100 ms event-quiet window, bounded by a 2.5 second deadline;
5. uses a 220 ms event-free grace period plus a second canonical sample for
   no-op confirmation;
6. samples the returned canonical state at 250 ms intervals; DPAD movement
   requires three equivalent observations (at most six snapshots), while the
   screen-transition-prone `SELECT` and `BACK` actions require seven (at most
   fourteen snapshots);
7. returns the final proven-stable snapshot, or ends partial if that bounded
   post-settle check cannot converge.

Focus-only movement returns a lightweight state and reuses the last validated
tree on the host. Structural/text/selection changes return a fresh bounded tree.
Resource identifiers are combined with deterministic structural-path suffixes,
so repeated RecyclerView rows remain unique while retaining their semantic ID.
Screenshots and logcat are captured for evidence, not on every normal action.
Launch and replay resets require both a stable canonical observer state and a
continuously focused target-app window before another remote key is sent. A
bounded relaunch retry handles TV launchers that briefly reclaim focus.

## Transport and security

The observer binds TCP only to device loopback on port 38337. TVDoctor creates
an ephemeral local ADB forward, opens one persistent socket, and removes the
forward during cleanup. The protocol uses a four-byte big-endian length prefix,
bounded UTF-8 JSON frames, protocol version 2, unique request identities, and a
random per-run 256-bit token delivered through the observer setup activity.

Messages are size-checked and schema-checked. Unknown versions, malformed
frames, stale identities, unsupported operations, timeouts, disconnects, and
cancellation fail closed. The observer supports a fixed operation allowlist; it
does not offer arbitrary shell commands, file reads, intents, or network access.
It does not collect credentials or log visible application text.

## Non-interactive and CI execution

Use the existing `test` command with an explicit APK and device:

```powershell
tvdoctor test --apk D:\apps\example.apk --device emulator-5554 --mode quick
```

Optional flags are `--adb PATH`, `--output PATH`, and `--mode deep`. This path
never prompts. Observer accessibility access must already be explicitly enabled;
missing setup returns a deterministic non-zero exit with actionable diagnostics.
Android Quick mode has a twelve-minute wall-clock ceiling so the stronger
1.5-second activation/back proof does not silently trade away frontier coverage.
The repository CI runs the same observer/fixture path on a disposable hosted
Android TV API 36 x86_64 emulator and validates a completed report, the seeded
deterministic HIGH finding, and its correlated replay.

Android reports contain canonical findings, screenshots, hashes, partial-run
semantics, portable replays, `android-action-performance.json`, and an
`android-exploration.json` record containing the exact termination reason,
bounded detail, budgets, action order, and statistics. Replay an Android finding
with the original APK and an explicit device:

```powershell
tvdoctor replay ISSUE_ID --report Tests\run\report.json `
  --apk D:\apps\example.apk --device emulator-5554
```

## Lifecycle and cleanup

Relaunch/reset force-stops and starts the tested package, waits for the package
window, then establishes an observer resynchronization boundary. Launch/reset
starts the exact TV activity in a new, cleared task so a stale permission-system
activity cannot absorb the intent; application data is not cleared. It then
requires the canonical fingerprint to remain unchanged for 600 ms, bounded by a
separate 8 second deadline. A canonical capture remains internally bounded at 5
seconds, while the transport allows 7.5 seconds to receive that bounded result.
Cached observer state is discarded across that
boundary.

The packaged observer manifest records both the APK SHA-256 and signer
certificate SHA-256. Normal package loading verifies the APK checksum. A
protected manual GitHub Actions workflow rebuilds with environment-scoped
keystore secrets, verifies the expected certificate digest, and requires the
APK and manifest to reproduce byte-for-byte before they can be treated as
release assets.

One Ctrl+C aborts observer waits and ADB work cooperatively, writes an honest
partial report when coverage exists, force-stops the tested app with a bounded
non-cancellable cleanup call, closes the socket, and removes the ADB forward.
The observer remains installed and Android may keep its enabled accessibility
service process alive for the next run.

## Known limitations

- support remains experimental and emulator evidence does not prove every
  physical/vendor device;
- accessibility trees reflect what the tested app exposes to Android;
- protected/secure surfaces may block screenshots or accessibility content;
- TVDoctor records transitions out of the tested package but does not expand
  the Android launcher or unrelated system UI during normal exploration;
- HOME and media keys are explicit-only and are not automatically explored;
- the tested APK and its startup state must be deterministic enough for replay;
- continuously changing accessibility trees can exhaust the bounded
  post-action stability or scan-duration budget and remain partial;
- VLC for Android 3.7.1 completed 300 physical actions, 87 deterministic resets,
  and 2,606 observer request/response frames without replay divergence or
  timeout on the API 36 emulator; Quick remained partial at its action ceiling
  with 11 frontier entries, so this is not a clean-app claim;
- release-signing verification requires repository maintainers to provision the
  protected keystore and expected certificate digest; CI never exposes those
  secrets to pull-request code.
