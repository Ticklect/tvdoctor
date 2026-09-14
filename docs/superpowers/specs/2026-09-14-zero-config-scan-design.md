# Zero-Config Scan Design

## Purpose

TVDoctor should let a first-time user move from “I have a website or APK” to a useful local report with almost no product knowledge. The normal path should require one target, recover from safe setup problems in the same run, show truthful progress, and open the result automatically.

The current guided flow exposes implementation choices before it delivers value: platform selection, scan depth, device confirmation, APK path entry, separate runtime setup, manual observer onboarding, and a post-scan menu. Some recoverable states terminate the run and tell the user to rerun. The report also places general release guidance before the most actionable findings.

This design replaces that experience with a zero-config product shell around the existing deterministic explorer, drivers, packs, evidence model, and report schema. It does not weaken TVDoctor’s local-first, fail-closed, or deterministic-evidence rules.

## Product principle

The normal TVDoctor workflow has one required input:

- an absolute HTTP(S) URL; or
- a local `.apk` path.

Everything else is automatic when TVDoctor can make the decision safely and deterministically. TVDoctor asks the user only when a choice changes consent, credentials, persistent account state, an existing personal-device installation, or a large local SDK/emulator download.

Advanced users keep the existing explicit `test`, `accessibility`, `ci`, `baseline`, `doctor`, `setup`, and `replay` surfaces.

## Goals

- Make a URL or APK the only required input for a normal scan.
- Remove platform, Quick/Deep, single-device confirmation, and post-scan action menus from the normal path.
- Use the current completion-driven Deep profile as the normal zero-config scan profile while retaining the existing safety ceilings and stopping early when the frontier is exhausted.
- Install the required Chromium runtime automatically when it is missing, then continue the same command.
- Give web and Android scans consistent live progress and completion summaries.
- Inspect an APK before choosing an Android target so compatibility drives device selection.
- Discover Android SDK tools consistently, including a normal Windows Android Studio installation under `%LOCALAPPDATA%\Android\Sdk`.
- Enforce Android TV suitability, observer minimum API, ABI compatibility, online state, and boot readiness before installation.
- Turn first-use TVDoctor Observer accessibility setup into a same-run onboarding step: open the correct settings flow, wait for explicit user enablement, detect it, restore the target, and continue.
- Treat recoverable setup states as resumable phases instead of reasons to restart TVDoctor.
- Automatically open `report.html` after a retained guided/zero-config result and always leave a visible textual verdict and report path.
- Put actionable findings before general release/hardware guidance in the HTML report.
- Use one shared actionability/replay-readiness classification across the HTML report and generated coding tasks.
- Preserve the existing explicit advanced CLI behavior and report/replay contracts where practical.

## Non-goals

- Replacing the explorer, navigation diagnostics, pack algorithms, or deterministic replay model.
- Automatically accepting cookies, permissions, age gates, region choices, account creation, sign-in, purchases, subscriptions, payments, destructive actions, or other ambiguous consent/state changes.
- Automatically granting Android accessibility access or using privileged settings writes to bypass Android consent.
- Claiming physical Android TV, Google TV, Fire TV, vendor firmware, DRM, or launcher compatibility that has not been proven.
- Making a GUI or Electron/Tauri desktop application in this change.
- Removing the advanced `test --mode quick|deep` interface.
- Changing the canonical `tvdoctor.report/v1` schema solely for presentation convenience.

## User-facing command model

### Shortest path

TVDoctor accepts a target directly at the root command:

```text
tvdoctor https://example.test/tv
tvdoctor D:\apps\example.apk
```

The root dispatcher classifies the first argument as an absolute HTTP(S) URL or a local `.apk` path. Any other first argument continues through normal command dispatch so existing commands remain unambiguous.

The zero-config target form uses the completion-driven Deep scan profile internally. The UI calls this simply **Scan**. It does not teach scan-depth terminology before the run starts.

### Guided compatibility path

`tvdoctor start` remains available. With no argument it asks one prompt:

```text
What do you want to test? Paste a website URL or APK path:
```

It does not ask the user to choose Website vs Android or Quick vs Deep. `tvdoctor start TARGET` is equivalent to the root target form.

### Advanced path

The existing explicit form remains the place for tuning:

```text
tvdoctor test URL --mode quick|deep ...
tvdoctor test --apk PATH --device SERIAL --mode quick|deep ...
```

The legacy `standard` alias remains accepted where it is currently accepted for compatibility, but normal onboarding and first-audit documentation stop foregrounding it.

## Target classification

A small target-classification unit owns only input parsing and validation.

For a URL it:

- requires `http:` or `https:`;
- rejects embedded credentials;
- canonicalizes through the existing safe-target behavior;
- preserves the original authorized target only where the current audit/replay design already permits it.

For an APK it:

- resolves a local path;
- requires an `.apk` extension;
- requires a readable regular file before Android setup begins.

Classification does not inspect the APK or launch any platform runtime. It returns a typed `web` or `android-apk` target to orchestration.

## Zero-config orchestration

A new orchestration layer coordinates product setup without absorbing driver or explorer responsibilities. It is responsible for:

1. target classification;
2. runtime/tool readiness;
3. target-specific readiness;
4. recoverable setup phases;
5. starting the existing scan operation;
6. normalizing progress and completion output;
7. opening the local report.

It must call existing lower-level operations rather than duplicating browser, ADB, observer, exploration, report, or replay logic.

The orchestration state is explicit so a recoverable failure can resume the same command:

```text
classify-target
runtime-readiness
platform-readiness
target-readiness
interactive-setup
scan
report
complete
```

Each phase either advances, waits for a user-controlled prerequisite, returns a trustworthy partial/setup result, or fails with one concrete recovery action.

## Web flow

For a normal URL scan the experience is:

```text
TVDoctor
Target: https://example.test/
Checking browser…
Installing browser…        # only when missing
Scanning… 00:18 · 7 screens · 19 states · 42 actions · 2 findings
Scan complete · 2 findings · highest: HIGH
Opening report…
Report: D:\...\report.html
```

### Browser readiness

The zero-config path calls the existing runtime probe. If the matching Playwright Chromium build is missing and `runtimeSetup` is available, TVDoctor:

1. prints that it is installing the browser;
2. runs the existing setup callback in the same process;
3. probes again;
4. continues the pending scan.

A failed installation ends with the classified installer error and the exact command can be rerun after the environment is repaired. A missing browser must not require the user to discover and run a separate setup command first.

### Web startup screens

TVDoctor continues to observe startup blockers conservatively.

- A cookie-consent wall may only use the existing explicit reject/accept choice when TVDoctor can identify the corresponding control reliably. It must never convert “control not found” into an empty action sequence.
- Login, onboarding, age, region, and other stateful blockers are not auto-cleared.
- When a blocker can be completed manually inside the active TVDoctor-controlled browser session, TVDoctor keeps that session available, waits, re-observes, and continues once the blocker has disappeared and the starting state is stable.
- If the blocker requires credentials or a deterministic preparation path that cannot be safely captured interactively, the run stops as setup-blocked and points advanced users to a journey file. It must not imply that changing an unrelated normal-browser session will automatically transfer into TVDoctor’s isolated session.

Manual waiting is bounded. The normal interactive setup wait is five minutes and remains cancellable with Ctrl+C. Expiry produces a setup-blocked result rather than a clean pass.

### Web progress

Guided/zero-config web scans use the same progress model as Android. The orchestration surface should show, when available:

- elapsed time;
- screens;
- focus states;
- physical/logical actions;
- findings.

Where the web audit cannot yet supply every counter continuously, elapsed time is mandatory and unsupported counters are omitted rather than fabricated.

## Android flow

For a normal APK scan the target is inspected before any device is selected:

```text
TVDoctor
APK: Example TV 1.0.0
Checking Android tools…
Finding a compatible Android TV…
Using: Google Android TV · API 36 · x86_64
Preparing TVDoctor Observer…
Scanning… 00:21 · 5 screens · 14 states · 31 actions · 1 finding
Scan complete · 1 finding · highest: HIGH
Opening report…
```

### SDK and tool discovery

ADB, `aapt`/`aapt2`, emulator tooling, and system-image tooling share one Android SDK locator.

Search order is deterministic and platform-aware:

1. explicit caller path when an advanced option supplies one;
2. `ANDROID_SDK_ROOT`;
3. `ANDROID_HOME`;
4. on Windows, `%LOCALAPPDATA%\Android\Sdk`;
5. supported PATH fallback for individual executables.

A path accepted by ADB preflight must also be available to APK inspection when the required build-tools exist there. TVDoctor must not report Android readiness and then fail solely because two subsystems searched different SDK locations.

### APK-first compatibility

APK inspection yields package, launch activity, minimum SDK, target SDK, label, version, and ABI information before device selection.

Candidate devices are then filtered by:

- `state === device`;
- Android TV/television characteristic when known;
- API level at or above the observer minimum and APK minimum;
- ABI overlap when both sides expose ABI information;
- successful boot/readiness proof before installation.

A non-TV Android device must not be labelled or auto-selected as an Android TV merely because ADB can see it.

If exactly one compatible TV target remains, zero-config mode selects it automatically. If several compatible targets remain, TVDoctor asks which one to use. If none remain, it moves to managed-emulator recovery when that capability is available.

### Personal-device install guard

Before `adb install -r`, TVDoctor checks whether the target package is already installed.

- On a disposable emulator, replacement is allowed as part of the requested APK test.
- On a physical device, if the same package is already installed, TVDoctor does not silently replace it. It offers the user an explicit replace-and-test choice or the disposable TVDoctor test device when available.
- If the package is absent, the user’s explicit APK scan request is sufficient authorization for installation on the selected compatible target.

This guard prevents a zero-config convenience feature from overwriting an existing personal installation unexpectedly.

## TVDoctor Observer first-run onboarding

Observer onboarding is a same-command state, not an error followed by “retry.”

When the observer package is installed and verified but accessibility access is disabled, TVDoctor:

1. launches the packaged Observer setup activity;
2. the setup activity opens the Android accessibility settings using its existing explicit user-facing flow;
3. prints one instruction: enable **TVDoctor Observer** on the device;
4. polls the existing read-only accessibility settings and device readiness;
5. when the service becomes enabled, reprovisions a fresh per-run token;
6. re-establishes the local ADB forward/observer connection;
7. relaunches/restores the target application;
8. continues the same pending scan.

TVDoctor never uses `settings put`, root-only bypasses, hidden APIs, or synthetic UI actions to enable the service.

The onboarding wait is bounded to five minutes and cancellable. Timeout is a setup-blocked result with the observer left installed; it is not reported as a target defect.

A stale or failed observer connection may be reprovisioned and reconnected once automatically. Repeated failure ends with a phase-specific error.

## Android app setup recovery

The current one-action setup handling becomes a small re-observation loop.

For permission, login, onboarding, region, age, or other setup screens:

- TVDoctor may identify and describe visible controls;
- it does not choose consent or stateful controls automatically;
- the user may complete the setup on the device;
- TVDoctor waits for target focus to return and repeatedly re-observes until a stable target-owned state is reached;
- the scan then resumes without restarting the CLI process.

An explicitly safe Back action may still be offered when it is clearly a dismissal/navigation action. Ambiguous Select remains user-controlled.

A setup flow that cannot reach a stable target-owned state within the interactive wait becomes setup-blocked/inconclusive.

## Managed TVDoctor test device

A managed disposable Android TV emulator is part of the zero-config end state, implemented as a separate orchestration component rather than inside `AndroidTvDriver`.

The managed emulator uses the repository’s already-proven baseline where host support permits it:

- Android API 36;
- Android TV system image;
- x86_64 on compatible x64 hosts;
- `tv_1080p`-class profile;
- headless/no-audio/no-boot-animation settings suitable for deterministic local testing.

The component owns SDK package discovery, system-image availability, AVD creation, launch, boot readiness, identity, and cleanup policy. The Android driver continues to receive an ordinary serial and remains unaware of how the device was created.

### Emulator user experience

When no compatible target exists:

- if a TVDoctor-managed emulator is already installed, TVDoctor starts or reuses it automatically;
- if the required system image or emulator package requires a large download or licence acceptance, TVDoctor asks one explicit question before starting that download;
- once ready, the same APK scan continues automatically.

The first implementation supports Windows/x64 hosts with Android SDK tooling because that matches the main local-development target. Unsupported hosts receive a concise explanation and retain the manual-device path.

Historical AVD creation failures, including missing `devices.xml`, must be handled as an emulator-setup failure with actionable diagnostics. The implementation must not delete arbitrary existing AVDs or SDK content.

## Progress and terminal behavior

The zero-config path uses one progress renderer for both platforms.

An interactive terminal updates one line in place and never clears prior scan output. Selection widgets used for exceptional choices render locally without `\u001b[2J` whole-screen clearing.

The final verdict is printed after progress is cleared and remains visible permanently:

```text
✓ Scan complete · 3 findings · highest: HIGH · 01:42
Report: D:\Tv Docter\Tests\...\report.html
```

Partial and failed runs use equally explicit wording:

```text
◐ Scan incomplete · 2 findings retained · setup blocked
✗ Scan failed · observer connection could not be established
```

The summary includes the report path whenever a trustworthy bundle exists.

## Report opening

After any guided/zero-config run that produced a report bundle, TVDoctor attempts to open `report.html` automatically with the existing OS integration.

- Successful open: print `Opening report…` and still print the path.
- Failed open: print the path and offer only fallback actions that do not erase the verdict (`Show folder`, `Copy path`, `Exit`).
- Ctrl+C after scan completion must not delete or hide the report path.

The advanced non-interactive `test` and CI surfaces do not auto-open reports.

## Findings-first HTML report

The HTML report’s first screen should answer four questions:

1. Did the scan complete?
2. How many findings are there and what is the highest severity?
3. Which finding should I deal with first?
4. Can TVDoctor reproduce it exactly?

The hero contains:

- verdict;
- target;
- scan profile/mode as secondary metadata;
- duration;
- finding count/highest severity;
- concise incomplete/failure reason when applicable.

Immediately below the hero, render the first actionable finding or a short “no findings” state. The current large hardware-confidence checklist moves below the findings into a collapsed **Release checks** section. Repeated-pattern summaries also move below the first actionable findings so they do not delay the first concrete problem.

## Shared finding workflow state

Severity, evidence confidence, and replay readiness are distinct concepts. The current HTML `FIX NOW` label can imply a stronger workflow than the coding-task export can support.

Create one shared presentation classifier used by HTML and AI/coder exports. Its user-facing states are:

- **Verified · Replay ready** — deterministic finding, deterministic-failure evidence, and a supported embedded deterministic CLI replay.
- **Verified · Replay unavailable** — deterministic observed failure but no complete supported CLI replay package.
- **Needs review** — heuristic, inference, unobservable, or otherwise non-deterministic finding.
- **Setup / info** — startup/environment/setup information that is not a target code defect.

Severity remains visible independently.

A **Verified · Replay ready** issue shows its reproduction command near the top of the issue card. Other states show a concise reason the command is unavailable instead of burying that fact inside technical details.

The generated `exports/agent-fix-tasks.md` and HTML report must agree on whether a finding is replay-ready.

## Report exports

The HTML footer/supporting section links directly to the fixed local bundle exports when present:

- portable summary;
- coding/agent fix tasks;
- canonical JSON report.

The report remains static and script-free. This change does not add client-side JavaScript or weaken the current Content Security Policy merely to provide copy buttons.

## Error handling and recovery

Errors are presented by phase, with one primary recovery action.

Examples:

- `runtime-readiness`: Chromium missing → install and continue automatically.
- `platform-readiness`: Android SDK tools missing → show the detected SDK location and missing component.
- `target-readiness`: no compatible device → start/offer managed TVDoctor test device.
- `interactive-setup`: observer disabled → open setup and wait in the same run.
- `interactive-setup`: app login/onboarding → wait for the user or produce setup-blocked.
- `scan`: explorer safety ceiling → preserve partial coverage and report inconclusive.
- `report`: OS open failed → keep the report and print the path.

Automatic retry is limited to transitions where TVDoctor can prove the operation is idempotent or safely reconstructable. It must not loop indefinitely or turn missing evidence into success.

## Architecture boundaries

### `TargetClassifier`

Pure parsing/validation. Depends on path/URL utilities only.

### `ZeroConfigRunner`

Coordinates phases and existing operations. Owns user-facing state transitions, recovery, progress, and report opening. It does not implement browser/ADB/explorer behavior.

### `AndroidSdkLocator`

Single source of truth for SDK root and tool candidates. Used by ADB preflight, APK inspection, and managed-emulator orchestration.

### `AndroidTargetSelector`

Combines APK metadata and device metadata to produce compatible candidates and explicit blockers. It owns no ADB subprocesses itself.

### `AndroidSetupCoordinator`

Coordinates observer first-use setup and application setup waiting using existing driver operations and read-only state checks.

### `ManagedAndroidTvEmulator`

Creates/starts a TVDoctor-owned test AVD and returns a ready serial. It lives above the Android driver.

### `FindingWorkflowClassifier`

Pure report-domain classification shared by HTML and coder exports.

These units are small enough to test independently and prevent `start.ts` or `android-product.ts` from becoming a larger monolithic wizard.

## Compatibility

- Existing `tvdoctor test URL ...` behavior remains supported.
- Existing explicit Android `tvdoctor test --apk PATH --device SERIAL ...` remains prompt-free and does not silently start an emulator.
- CI never auto-installs browsers/emulators beyond what its workflow explicitly requests.
- `tvdoctor setup` and `tvdoctor doctor` remain useful advanced diagnostics even though the zero-config path self-recovers common setup problems.
- Replay semantics and report evidence remain unchanged.
- Existing output naming under `Tests` remains collision-safe.

## Documentation changes

The README and package README lead with:

```text
npx tvdoctor https://example.test/tv
npx tvdoctor D:\apps\example.apk
```

Then explain `tvdoctor start` as the one-prompt interactive form and move explicit `test --mode ...` usage into advanced/CI sections.

Android documentation must accurately describe the Observer behavior implemented by the product. It must no longer claim that first-use setup opens automatically unless the CLI actually opens it and resumes.

`tvdoctor start --help` and `tvdoctor help start` receive a real start/zero-config help surface.

## Testing strategy

### Unit tests

- target classification for valid/invalid URL and APK inputs;
- root-command dispatch without breaking named commands;
- shared Android SDK discovery, including Windows `%LOCALAPPDATA%` fallback;
- APK/device compatibility and TV/API filtering;
- personal-device existing-package guard;
- finding workflow classification agreement;
- terminal selection rendering does not clear the entire screen.

### Product-flow tests

- missing Chromium installs and resumes the same web scan;
- zero-config URL performs no platform/mode prompt;
- web progress is emitted while the scan runs;
- report auto-open succeeds and the textual verdict/path remain visible;
- report open failure falls back without erasing completion output;
- APK is inspected before device selection;
- one compatible device is auto-selected;
- multiple compatible devices cause one selection;
- non-TV/API/ABI-incompatible devices are not auto-selected;
- observer disabled launches setup, observes explicit enablement, and resumes the same scan;
- observer setup timeout produces setup-blocked, not a target defect;
- multi-step application onboarding can be completed manually and resumes without restarting;
- an existing physical-device package requires explicit replacement approval.

### Android integration tests

Extend the existing API 36 fixture gate to prove:

- fresh observer install with accessibility initially disabled enters the onboarding phase;
- after explicit enablement in the controlled test environment, the same process continues to the scan;
- the normal fixture finding and replay evidence are unchanged;
- stale observer provisioning reconnects once and does not leak ADB forwards;
- boot-readiness and TV identity are enforced.

Managed-emulator tests use temporary TVDoctor-owned AVD names and never delete pre-existing user AVDs.

### Reporter tests

- first actionable finding precedes release checks;
- `Verified · Replay ready` exactly matches coder fix-task eligibility;
- deterministic findings without complete replay show `Verified · Replay unavailable`;
- partial/failed reports show their concrete reason before general release guidance;
- export links render to the existing static bundle paths;
- CSP remains script-free.

## Acceptance criteria

The design is complete when all of the following are true:

1. A fresh web user with Node/npm and network access can run `npx tvdoctor https://example.test` without first running `setup`, choosing a platform, or choosing Quick/Deep; missing Chromium is installed and the same command continues.
2. The interactive web path shows continuous progress and never appears silent for a multi-minute scan.
3. A user who runs an APK on a normal Windows Android Studio installation does not need to set `ANDROID_SDK_ROOT` solely for TVDoctor if the SDK is present under `%LOCALAPPDATA%\Android\Sdk`.
4. APK metadata is known before TVDoctor selects an Android device.
5. Exactly one compatible, boot-ready Android TV target is selected automatically; unsuitable Android devices are excluded with recorded reasons.
6. First-use Observer accessibility setup opens the correct user-controlled Android setup flow and continues the same scan after the user enables the service.
7. Recoverable Android app setup can be completed by the user without rerunning TVDoctor.
8. No zero-config path silently replaces an existing same-package installation on a physical device.
9. When no compatible device exists and the managed-emulator capability is supported, TVDoctor can prepare a disposable API 36 Android TV test device and continue the pending APK scan, asking before any large SDK/system-image download.
10. The final terminal verdict and report path remain visible after completion.
11. A retained guided/zero-config report opens automatically when the OS integration succeeds.
12. The HTML report puts the first actionable finding before the general real-hardware/release checklist.
13. HTML and `agent-fix-tasks.md` agree exactly about replay readiness.
14. Existing explicit CLI, CI, deterministic evidence, partial-run semantics, and replay behavior remain valid.

## Delivery order

Implementation is staged so each step produces a usable improvement and can be verified independently:

1. **Zero-config web and completion UX** — root/start target input, hidden normal scan-depth choice, Chromium install-and-resume, web progress, non-clearing terminal completion, report auto-open, start help/docs.
2. **Android readiness and same-run recovery** — shared SDK locator, APK-first selection, TV/API/ABI/boot enforcement, Observer onboarding/resume, app-setup waiting, physical-package guard.
3. **Findings-first report** — shared workflow classifier, report hierarchy, replay-ready presentation, export links, partial/failure recovery copy.
4. **Managed Android TV test device** — TVDoctor-owned AVD orchestration, package/image readiness, boot/reuse, bounded cleanup and recovery.

Each stage must pass its focused unit/product tests plus the relevant existing integration suite before the next stage changes behavior.

## Risks and controls

The main implementation risk is the managed emulator. Android SDK package installation, licences, virtualization support, host architecture, and AVD metadata vary across machines. Keeping emulator lifecycle outside the driver limits the blast radius; unsupported hosts retain the manual-device path.

Automatic browser installation can be slow or fail behind restricted networks. The same-run setup path therefore reports installer progress/failure plainly and does not label the target failed.

Long completion-driven scans can still take significant time. Zero-config improves this with truthful progress and early completion when the frontier is exhausted; the existing hard safety ceilings remain. Advanced users retain Quick mode when they explicitly prefer a smaller resource envelope.

Same-run setup waiting must remain conservative. TVDoctor can observe that a blocker disappeared or accessibility became enabled, but it must not infer consent or perform ambiguous user choices on the user’s behalf.
