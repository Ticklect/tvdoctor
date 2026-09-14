# Zero-Config Scan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a URL or APK the only required input for TVDoctor’s normal interactive scan, recover safely from common setup problems in the same command, and surface the result through a findings-first report without weakening deterministic evidence or advanced CLI behavior.

**Architecture:** Add a thin zero-config orchestration layer above the existing CLI operations, drivers, explorer, and reporters. Keep target classification, Android SDK discovery, Android device selection, managed-emulator lifecycle, startup interaction, and report workflow classification as focused units with narrow interfaces. Existing `tvdoctor test`, CI, replay, explorer, and `tvdoctor.report/v1` semantics remain the lower-level source of truth.

**Tech Stack:** Node.js 24, npm 11, TypeScript 7 ESM, Vitest, Playwright, ADB/Android SDK tools, Android API 36 TV emulator, static HTML reporters.

**Spec:** `docs/superpowers/specs/2026-09-14-zero-config-scan-design.md`

## Global Constraints

- Work from the latest TVDoctor integration state at execution time. Preserve all unrelated and concurrent working-tree changes; do not reset, clean, reformat, or overwrite work from the performance/Android audit effort.
- Before editing a task’s files, inspect their current callers because `packages/cli/src/android-product.ts` and `packages/cli/src/node-audit-runner.ts` have concurrent work in flight.
- The normal zero-config profile is the existing completion-driven `deep` profile. UI copy calls it **Scan**; the advanced CLI still exposes `quick`, `deep`, and the compatibility `standard` alias where currently supported.
- Named commands (`test`, `start`, `doctor`, `setup`, `replay`, `ci`, `baseline`, `accessibility`, `version`, `help`) are resolved before target autodetection.
- Interactive setup waits are bounded to `300_000` ms and remain cancellable through the command’s existing `AbortSignal`.
- Do not automatically accept cookies, permissions, age/region choices, credentials, purchases, subscriptions, destructive actions, Android accessibility access, or SDK licences.
- Zero-config Android auto-selection requires proven `isTelevision === true`; identity-unknown devices remain available only through the explicit advanced `--device` path.
- Any external Android target, including a user-managed emulator, requires explicit approval before replacing an already-installed package with the same package name. A TVDoctor-owned managed emulator may replace it automatically.
- Managed-emulator v1 targets Windows/x64, Android API 36, `android-tv`, `x86_64`, and a TVDoctor-owned AVD. Stop an emulator started for the scan, but retain its AVD and downloaded SDK packages.
- Do not change `tvdoctor.report/v1` solely for presentation changes. Keep report CSP scriptless; do not add client-side JavaScript for copy buttons or interactions.
- Keep advanced `tvdoctor test` and CI prompt-free. They must never auto-start or auto-install a managed emulator unless an explicit future advanced option requests it.
- Run the focused test named in each task before broadening validation. Do not rewrite unrelated snapshots or fixtures to make changed behavior pass.

---

## Task 1: Add a typed zero-config target classifier

**Files**

- Create: `packages/cli/src/zero-config-target.ts`
- Modify: `packages/cli/src/index.ts`
- Create: `packages/cli/test/zero-config-target.test.ts`

**Interfaces**

Consumes:

```ts
safeTarget(input: string): string | null
```

Produces:

```ts
export type ZeroConfigTarget =
  | { readonly kind: "web"; readonly target: string }
  | { readonly kind: "android-apk"; readonly apkPath: string };

export type ZeroConfigClassification =
  | { readonly status: "target"; readonly target: ZeroConfigTarget }
  | { readonly status: "invalid"; readonly message: string }
  | { readonly status: "not-target" };

export interface ZeroConfigTargetDependencies {
  readonly stat?: (path: string) => Promise<{ readonly isFile: () => boolean }>;
  readonly resolvePath?: (path: string) => string;
}

export async function classifyZeroConfigTarget(
  input: string,
  dependencies?: ZeroConfigTargetDependencies,
): Promise<ZeroConfigClassification>;
```

- [ ] **Step 1: Write failing classifier tests.** Cover canonical HTTP/HTTPS URLs, embedded-credential rejection, readable APK paths, missing APKs, directories ending in `.apk`, arbitrary unknown text, and quoted Windows paths after shell parsing.

```ts
it("classifies a readable apk without launching Android tooling", async () => {
  const result = await classifyZeroConfigTarget("D:/apps/example.apk", {
    resolvePath: (value) => value,
    stat: async () => ({ isFile: () => true }),
  });
  expect(result).toEqual({
    status: "target",
    target: { kind: "android-apk", apkPath: "D:/apps/example.apk" },
  });
});

it("keeps arbitrary command-like text out of target autodetection", async () => {
  await expect(classifyZeroConfigTarget("something-unknown")).resolves.toEqual({
    status: "not-target",
  });
});
```

- [ ] **Step 2: Run the focused test and confirm failure.**

```text
npx vitest run packages/cli/test/zero-config-target.test.ts
```

Expected: FAIL because `zero-config-target.ts` does not exist.

- [ ] **Step 3: Implement the classifier only.** URL detection should use `safeTarget`. APK detection should resolve the path, require `.apk`, `stat()` it, and require `isFile()`. Treat an explicit-looking URL/APK that is malformed or unreadable as `invalid`; arbitrary text is `not-target`.

```ts
export async function classifyZeroConfigTarget(
  input: string,
  dependencies: ZeroConfigTargetDependencies = {},
): Promise<ZeroConfigClassification> {
  const web = safeTarget(input);
  if (web !== null) return { status: "target", target: { kind: "web", target: web } };

  if (/^https?:/iu.test(input)) {
    return { status: "invalid", message: "Enter an absolute HTTP(S) URL without credentials." };
  }
  if (!/\.apk$/iu.test(input)) return { status: "not-target" };

  const apkPath = (dependencies.resolvePath ?? resolve)(input);
  try {
    const metadata = await (dependencies.stat ?? stat)(apkPath);
    if (!metadata.isFile()) throw new Error("not a file");
  } catch {
    return { status: "invalid", message: "The APK path must point to a readable .apk file." };
  }
  return { status: "target", target: { kind: "android-apk", apkPath } };
}
```

- [ ] **Step 4: Re-export the types/function from `packages/cli/src/index.ts` and rerun the focused test.**

Expected: PASS.

- [ ] **Step 5: Commit.**

```text
git add packages/cli/src/zero-config-target.ts packages/cli/src/index.ts packages/cli/test/zero-config-target.test.ts
git commit -m "feat(cli): classify zero-config scan targets"
```

---

## Task 2: Make terminal output persistent and normalize zero-config completion/report handling

**Files**

- Create: `packages/cli/src/zero-config-output.ts`
- Modify: `packages/cli/src/interactive.ts`
- Modify: `packages/cli/src/start.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/test/product-flow.test.ts`

**Interfaces**

Consumes:

```ts
export interface ReportActionHandlers {
  openReport(path: string): Promise<boolean>;
  showFolder(path: string): Promise<boolean>;
  copyPath(path: string): Promise<boolean>;
}
```

Produces:

```ts
export interface ScanCompletionLike {
  readonly status: "completed" | "partial" | "failed" | "setup-blocker";
  readonly issueCount: number;
  readonly highestSeverity: "critical" | "high" | "medium" | "low" | "info" | null;
  readonly reportPath: string | null;
  readonly details: readonly string[];
}

export async function finishInteractiveScan(
  context: CliContext,
  terminal: StartTerminal,
  result: ScanCompletionLike,
  startedAtMs: number,
): Promise<void>;
```

- [ ] **Step 1: Add failing tests proving selection no longer clears the whole terminal and that report auto-open leaves a permanent verdict/path.** Do not test raw implementation strings only; capture writes through injected terminal/report actions.

```ts
it("auto-opens a retained report and keeps the final path visible", async () => {
  let stdout = "";
  let opened = "";
  await finishInteractiveScan(context, terminal, {
    status: "completed",
    issueCount: 3,
    highestSeverity: "high",
    reportPath: "D:/reports/report.json",
    details: [],
  }, 0);
  expect(opened).toMatch(/report\.html$/u);
  expect(stdout).toContain("3 findings");
  expect(stdout).toContain("highest: HIGH");
  expect(stdout).toContain("report.html");
});
```

- [ ] **Step 2: Run focused product-flow tests and confirm failure.**

```text
npx vitest run packages/cli/test/product-flow.test.ts
```

- [ ] **Step 3: Change `ProcessStartTerminal.select()` to redraw only its own menu lines.** Remove `\u001b[2J\u001b[H`. Track the number of rendered lines and use cursor-up/clear-line sequences only for those lines. Printed scan output above the menu must remain untouched.

- [ ] **Step 4: Add `finishInteractiveScan()`.** Convert `report.json` to sibling `report.html`, print one permanent summary, always print the report path, attempt `openReport()` automatically, and show `Show folder / Copy path / Exit` only if opening fails.

```ts
const reportHtml = result.reportPath === null
  ? null
  : join(dirname(result.reportPath), "report.html");

write(context, formatCompletion(result, elapsedMs));
if (reportHtml !== null) {
  write(context, `Report: ${reportHtml}`);
  const opened = await actions.openReport(reportHtml);
  if (!opened) await offerReportFallbacks(context, terminal, reportHtml);
}
```

- [ ] **Step 5: Route the existing guided web and Android completion blocks through the shared helper without changing their scan-selection behavior yet.** This removes duplicated status/report code before zero-config routing is added.

- [ ] **Step 6: Rerun `product-flow.test.ts` and update its existing report-action expectations to the new auto-open behavior.**

Expected: PASS; no test should require the old four-option post-scan menu.

- [ ] **Step 7: Commit.**

```text
git add packages/cli/src/zero-config-output.ts packages/cli/src/interactive.ts packages/cli/src/start.ts packages/cli/src/index.ts packages/cli/test/product-flow.test.ts
git commit -m "feat(cli): keep scan verdicts visible and auto-open reports"
```

---

## Task 3: Add zero-config web routing, browser self-setup, and truthful progress

**Files**

- Create: `packages/cli/src/zero-config.ts`
- Modify: `packages/cli/src/cli.ts`
- Modify: `packages/cli/src/start.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/test/cli.test.ts`
- Modify: `packages/cli/test/product-flow.test.ts`

**Interfaces**

Consumes:

```ts
classifyZeroConfigTarget(input: string): Promise<ZeroConfigClassification>
finishInteractiveScan(...): Promise<void>
CliContext.runtimeProbe?: () => Promise<RuntimeProbeResult>
CliContext.runtimeSetup?: (signal?: AbortSignal) => Promise<void>
CliOperations.testTarget?(request: TestCommandRequest): Promise<TestCommandResult>
```

Produces:

```ts
export async function runZeroConfigTarget(
  target: ZeroConfigTarget,
  context: CliContext,
): Promise<number>;

export async function runGuidedStart(
  context: CliContext & { readonly startTerminal?: StartTerminal },
  initialInput?: string,
): Promise<number>;
```

- [ ] **Step 1: Add failing dispatch tests.** Named commands must still win; an unknown first token that classifies as a URL routes to zero-config; `start TARGET` accepts one target; bare `start` prompts once for URL/APK and never asks platform or scan depth.

```ts
it("routes a root URL through the zero-config deep scan", async () => {
  let request: TestCommandRequest | null = null;
  const code = await runCli(["https://example.test/tv"], {
    ...context,
    runtimeProbe: async () => ({ capabilities: [] }),
    operations: {
      replayIssue: async () => ({ status: "fixed", details: [] }),
      testTarget: async (value) => {
        request = value;
        return { status: "completed", issueCount: 0, highestSeverity: null, reportPath: null, details: [] };
      },
    },
  });
  expect(code).toBe(EXIT_CODES.success);
  expect(request).toMatchObject({ mode: "deep", packs: ["all"] });
});
```

- [ ] **Step 2: Add a failing browser-recovery test.** First `runtimeProbe()` fails, `runtimeSetup()` runs exactly once, second probe succeeds, and the scan runs without restarting the command.

- [ ] **Step 3: Run the focused CLI/product-flow tests and confirm failure.**

```text
npx vitest run packages/cli/test/cli.test.ts packages/cli/test/product-flow.test.ts
```

- [ ] **Step 4: Implement `runZeroConfigTarget()` for `web`.** It must use `deep`, all packs, default query `N`, collision-safe output, self-install Chromium when probe fails and `runtimeSetup` exists, then re-probe before scanning.

```ts
async function ensureWebRuntime(context: CliContext): Promise<void> {
  try {
    await context.runtimeProbe?.();
    return;
  } catch (firstError) {
    if (context.runtimeSetup === undefined) throw firstError;
    write(context, "Installing TVDoctor's browser…");
    await context.runtimeSetup(context.signal);
    await context.runtimeProbe?.();
  }
}
```

- [ ] **Step 5: Add an elapsed progress renderer around the web scan.** Use a one-second interactive update and a 30-second non-interactive update only for the zero-config/guided path. Do not invent screens/states/actions until the audit operation exposes them.

```ts
const startedAtMs = Date.now();
const timer = setInterval(() => {
  progress.update({
    elapsedSeconds: Math.floor((Date.now() - startedAtMs) / 1_000),
    screens: 0,
    states: 0,
    actions: 0,
    findings: 0,
  });
}, 1_000);
```

Display only `elapsed` when counters are unavailable; extend `ProgressRenderer` so omitted counters are not rendered as misleading zeroes.

- [ ] **Step 6: Change root dispatch in `runCli()`.** Resolve known commands first. For an otherwise unknown first token, call the target classifier. `target` routes to zero-config, `invalid` returns usage error with its message, and `not-target` keeps the existing unknown-command usage error.

- [ ] **Step 7: Simplify `runGuidedStart()`.** `start` takes zero or one target argument. Zero args prompt once with `What do you want to test? Paste a website URL or APK path:`. One arg is classified directly. Do not render Website/Android or Quick/Deep menus.

- [ ] **Step 8: Add `START_HELP_TEXT`, support both `tvdoctor start --help` and `tvdoctor help start`, and update global usage with the root target forms.**

- [ ] **Step 9: Rerun focused tests and typecheck.**

```text
npx vitest run packages/cli/test/cli.test.ts packages/cli/test/product-flow.test.ts
npm run typecheck --workspace tvdoctor
```

Expected: PASS.

- [ ] **Step 10: Commit.**

```text
git add packages/cli/src/zero-config.ts packages/cli/src/cli.ts packages/cli/src/start.ts packages/cli/src/index.ts packages/cli/test/cli.test.ts packages/cli/test/product-flow.test.ts
git commit -m "feat(cli): add zero-config web scans"
```

---

## Task 4: Move interactive web startup recovery into the active audit session

**Files**

- Create: `packages/cli/src/web-startup-interaction.ts`
- Modify: `packages/cli/src/cli.ts`
- Modify: `packages/cli/src/node-audit-runner.ts`
- Modify: `packages/cli/src/node-audit-navigation.ts`
- Modify: `packages/cli/src/zero-config.ts`
- Modify: `packages/cli/test/node-audit-hardening.test.ts`
- Modify: `packages/cli/test/product-flow.test.ts`

**Interfaces**

Produces:

```ts
export interface WebsiteStartupDetection {
  readonly status: "ready" | "blocked" | "unavailable";
  readonly blockerKind?: string;
  readonly textSample?: string;
  readonly detail: string;
  readonly canReject?: boolean;
  readonly canAccept?: boolean;
}

export type WebsiteStartupAction = "reject" | "accept" | "wait" | "stop";

export type WebsiteStartupHandler = (
  detection: WebsiteStartupDetection,
) => Promise<WebsiteStartupAction>;
```

Extends:

```ts
export interface TestCommandRequest {
  // existing fields...
  readonly onStartupBlocker?: WebsiteStartupHandler;
  readonly interactiveSetupTimeoutMs?: number;
}
```

- [ ] **Step 1: Move/re-export `WebsiteStartupDetection` from `cli.ts` into `web-startup-interaction.ts` and add the handler/action types.** Keep external imports working through `index.ts`.

- [ ] **Step 2: Write a failing test for the consent-control edge.** A detected consent wall with no reliable reject/accept control must return setup-blocked/partial; it must never construct an empty `remote-sequence` startup policy.

```ts
it("does not turn a missing consent control into an empty startup sequence", async () => {
  // fixture driver returns a consent blocker with no matching controls
  const result = await runAudit(requestWithStartupHandler("reject"), dependencies);
  expect(result.status).toBe("partial");
  expect(result.details.join(" ")).toMatch(/consent|setup/iu);
});
```

- [ ] **Step 3: Write failing same-session wait tests.** The active audit driver first reports login/onboarding, the handler returns `wait`, later snapshots become ready, and the same driver instance proceeds into exploration. Add timeout and abort cases.

- [ ] **Step 4: Run focused hardening tests and confirm failure.**

```text
npx vitest run packages/cli/test/node-audit-hardening.test.ts packages/cli/test/product-flow.test.ts
```

- [ ] **Step 5: Add a bounded `waitForStartupReady()` helper in `node-audit-navigation.ts`.** Poll the already-running driver, reuse existing startup classification/stability logic, respect `interactiveSetupTimeoutMs ?? 300_000`, and use the request `AbortSignal`. Do not open a second browser.

- [ ] **Step 6: Invoke the handler from `node-audit-runner.ts` only when the current audit session observes a blocker.** `reject`/`accept` require a verified matching control; `wait` calls the bounded wait helper; `stop` returns setup-blocked. Advanced `test` without a handler remains observation-only.

```ts
const action = await request.onStartupBlocker?.(detection);
if (action === "wait") {
  navigationStartup = await waitForStartupReady(driver, {
    timeoutMs: request.interactiveSetupTimeoutMs ?? 300_000,
    signal: request.signal,
  });
}
```

- [ ] **Step 7: Wire zero-config web UI to the handler.** Cookie walls offer only actions that `canReject`/`canAccept` actually support plus `Leave unchanged and stop`. Login/onboarding/age/region instruct the user to finish setup in the TVDoctor browser and return `wait`; no unrelated-browser guidance remains.

- [ ] **Step 8: Rerun focused tests and typecheck.**

```text
npx vitest run packages/cli/test/node-audit-hardening.test.ts packages/cli/test/product-flow.test.ts
npm run typecheck --workspace tvdoctor
```

Expected: PASS.

- [ ] **Step 9: Commit.**

```text
git add packages/cli/src/web-startup-interaction.ts packages/cli/src/cli.ts packages/cli/src/node-audit-runner.ts packages/cli/src/node-audit-navigation.ts packages/cli/src/zero-config.ts packages/cli/test/node-audit-hardening.test.ts packages/cli/test/product-flow.test.ts
git commit -m "feat(web): resume zero-config scans after startup setup"
```

---

## Task 5: Centralize Android SDK/tool discovery and prove boot-ready TV candidates

**Files**

- Create: `packages/cli/src/android-sdk.ts`
- Create: `packages/cli/src/android-selection.ts`
- Modify: `packages/cli/src/android-product.ts`
- Modify: `packages/cli/src/index.ts`
- Create: `packages/cli/test/android-sdk.test.ts`
- Create: `packages/cli/test/android-selection.test.ts`
- Modify: `packages/cli/test/product-flow.test.ts`

**Interfaces**

Produces:

```ts
export interface AndroidSdkTools {
  readonly sdkRoot: string | null;
  readonly adbPath: string;
  readonly aaptPath: string | null;
  readonly emulatorPath: string | null;
  readonly sdkManagerPath: string | null;
  readonly avdManagerPath: string | null;
}

export interface AndroidSdkLocatorOptions {
  readonly explicitAdbPath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly exists?: (path: string) => Promise<boolean>;
  readonly resolveFromPath?: (name: string) => Promise<string | null>;
}

export async function locateAndroidSdkTools(
  options?: AndroidSdkLocatorOptions,
): Promise<AndroidSdkTools>;

export interface AndroidDeviceEvaluation {
  readonly device: AndroidPreflightDevice;
  readonly compatible: boolean;
  readonly reasons: readonly string[];
}

export function evaluateZeroConfigAndroidDevice(
  apk: ApkMetadata,
  device: AndroidPreflightDevice,
): AndroidDeviceEvaluation;
```

- [ ] **Step 1: Write SDK-locator tests for the exact precedence.** Explicit ADB, `ANDROID_SDK_ROOT`, `ANDROID_HOME`, Windows `%LOCALAPPDATA%/Android/Sdk`, then PATH executable fallback. Verify `aapt2`, emulator, `sdkmanager`, and `avdmanager` come from the same selected root when present.

- [ ] **Step 2: Write device-evaluation tests.** Reject offline, `isTelevision !== true`, API below observer minimum/API below APK minimum, ABI mismatch; accept exactly one compatible proven TV. Unknown ABI is a warning only when installation is still testable, matching current compatibility semantics.

```ts
expect(evaluateZeroConfigAndroidDevice(apk, {
  ...device,
  online: true,
  isTelevision: null,
}).compatible).toBe(false);
```

- [ ] **Step 3: Run focused tests and confirm failure.**

```text
npx vitest run packages/cli/test/android-sdk.test.ts packages/cli/test/android-selection.test.ts
```

- [ ] **Step 4: Implement `locateAndroidSdkTools()`.** Move the duplicated SDK-root logic out of `android-product.ts`. Keep executable names platform-specific and select the newest numeric build-tools directory for `aapt2`/`aapt` as today.

- [ ] **Step 5: Make both `inspectApk()` and `androidPreflight()` consume the locator.** A default Windows Android Studio SDK must allow both ADB preflight and APK inspection without setting environment variables.

- [ ] **Step 6: Change the preflight driver boundary to prove boot readiness.** Use the already-public `AndroidTvDriver.waitForDeviceReady(timeoutMs)` instead of metadata-only inspection for online entries.

```ts
export interface AndroidPreflightDriver {
  listDevices(): Promise<readonly AndroidDeviceListEntry[]>;
  waitForDeviceReady(timeoutMs?: number): Promise<AndroidDeviceMetadata>;
  close(): Promise<void> | void;
}
```

Keep test doubles explicit; do not silently treat a merely listed `device` state as boot-ready.

- [ ] **Step 7: Implement the pure zero-config device evaluator and export it.** Use an exported observer minimum API constant from the Android driver package if one exists by execution time; otherwise add `ANDROID_OBSERVER_MIN_SDK = 23` beside the observer asset and export it from `@tvdoctor/driver-android` instead of duplicating 23 in CLI code.

- [ ] **Step 8: Rerun focused tests plus existing product-flow tests.**

```text
npx vitest run packages/cli/test/android-sdk.test.ts packages/cli/test/android-selection.test.ts packages/cli/test/product-flow.test.ts
npm run typecheck --workspace tvdoctor
```

Expected: PASS.

- [ ] **Step 9: Commit.**

```text
git add packages/cli/src/android-sdk.ts packages/cli/src/android-selection.ts packages/cli/src/android-product.ts packages/cli/src/index.ts packages/cli/test/android-sdk.test.ts packages/cli/test/android-selection.test.ts packages/cli/test/product-flow.test.ts packages/driver-android/src/observer-asset.ts packages/driver-android/src/index.ts
git commit -m "refactor(android): centralize sdk and tv-device readiness"
```

---

## Task 6: Add same-run Observer onboarding primitives to the Android driver

**Files**

- Modify: `packages/driver-android/src/android-driver.ts`
- Modify: `packages/driver-android/src/types.ts`
- Modify: `packages/driver-android/src/index.ts`
- Modify: `packages/driver-android/test/android-v2-driver.test.ts`
- Verify only: `packages/driver-android/observer/AndroidManifest.xml`
- Verify only: `packages/driver-android/observer/src/org/tvdoctor/observer/SetupActivity.java`

**Interfaces**

Produces:

```ts
export interface AndroidObserverSetupState {
  readonly installed: boolean;
  readonly enabled: boolean;
}

export interface AndroidPackageState {
  readonly installed: boolean;
}

class AndroidTvDriver {
  prepareObserverSetup(options?: DriverOperationOptions): Promise<AndroidObserverSetupState>;
  openObserverSetup(options?: DriverOperationOptions): Promise<void>;
  observerAccessibilityEnabled(options?: DriverOperationOptions): Promise<boolean>;
  isPackageInstalled(packageName: string, options?: DriverOperationOptions): Promise<boolean>;
}
```

- [ ] **Step 1: Add failing driver tests.** Verify observer install/hash validation can complete while accessibility is disabled, `openObserverSetup()` executes `am start -n org.tvdoctor.observer/.SetupActivity`, status reads remain `settings get` only, and `isPackageInstalled()` uses a bounded package query without changing state.

```ts
expect(commands).toContainEqual([
  "-s", "emulator-5554", "shell", "am", "start", "-n",
  "org.tvdoctor.observer/.SetupActivity",
]);
expect(commands.flat().join(" ")).not.toContain("settings put");
```

- [ ] **Step 2: Run the driver test and confirm failure.**

```text
npx vitest run packages/driver-android/test/android-v2-driver.test.ts
```

- [ ] **Step 3: Extract the current install-and-hash portion of `#ensureObserver()` into one private `#installVerifiedObserver()` helper.** `prepareObserverSetup()` calls it and returns `{installed: true, enabled}` without provisioning a token or opening a forward.

- [ ] **Step 4: Implement `observerAccessibilityEnabled()` using the current read-only secure settings checks.** Keep the canonical enabled-service component comparison case-insensitive.

- [ ] **Step 5: Implement `openObserverSetup()` and `isPackageInstalled()`.** Validate package names with the existing package validator and keep all ADB calls serialized/cancellable through existing operation queues.

- [ ] **Step 6: Refactor `#ensureObserver()` to reuse the new helpers.** If accessibility is disabled, preserve the existing failure for advanced callers; zero-config orchestration will handle onboarding in the next task. Once enabled, provision a fresh token and connect exactly as before.

- [ ] **Step 7: Rerun driver tests and driver package typecheck.**

```text
npx vitest run packages/driver-android/test/android-v2-driver.test.ts
npm run typecheck --workspace @tvdoctor/driver-android
```

Expected: PASS.

- [ ] **Step 8: Commit.**

```text
git add packages/driver-android/src/android-driver.ts packages/driver-android/src/types.ts packages/driver-android/src/index.ts packages/driver-android/test/android-v2-driver.test.ts
git commit -m "feat(android): expose observer onboarding state"
```

---

## Task 7: Make Android scan setup resumable and add the external-package guard

**Files**

- Modify: `packages/cli/src/android-product.ts`
- Modify: `packages/cli/src/cli.ts`
- Modify: `packages/cli/src/node-replay.ts`
- Modify: `packages/cli/src/zero-config.ts`
- Modify: `packages/cli/test/product-flow.test.ts`
- Modify: `packages/driver-android/test/android-v2-driver.test.ts` only if a driver regression test is required by the final implementation seam

**Interfaces**

Extends:

```ts
export type AndroidSetupDecision =
  | "wait-for-user"
  | "press-back"
  | "select-highlighted"
  | "leave-unchanged";

export interface AndroidScanOptions {
  // existing fields...
  readonly onObserverSetupRequired?: () => Promise<"wait" | "stop">;
  readonly onSetupScreen?: (detection: AndroidSetupDetection) => Promise<AndroidSetupDecision>;
  readonly setupWaitTimeoutMs?: number;
}
```

Produces:

```ts
export async function androidPackageInstalled(request: {
  readonly adbPath?: string;
  readonly serial: string;
  readonly packageName: string;
  readonly signal?: AbortSignal;
}): Promise<boolean>;
```

- [ ] **Step 1: Add failing scan tests for Observer onboarding.** The first snapshot path reaches observer-disabled state; callback returns `wait`; test enables the observer on a later read; scan relaunches/restores the target and continues. Add timeout, abort, and `stop` cases.

- [ ] **Step 2: Add failing app-setup loop tests.** A two-screen onboarding sequence must be able to remain in `wait-for-user`, re-observe repeatedly, and continue once a stable target-owned state returns. One SELECT/BACK followed by another blocker must no longer throw immediately.

- [ ] **Step 3: Add failing package-presence helper tests.** Expose package presence through `CliOperations` so zero-config does not construct a second ad-hoc ADB subprocess implementation.

- [ ] **Step 4: Run focused CLI tests and confirm failure.**

```text
npx vitest run packages/cli/test/product-flow.test.ts
```

- [ ] **Step 5: In `scanAndroidApk()`, call `driver.prepareObserverSetup()` before the first observer-backed snapshot.** If disabled and a handler exists, call `openObserverSetup()`, let the handler choose `wait`, poll `observerAccessibilityEnabled()` every 500 ms up to `setupWaitTimeoutMs ?? 300_000`, then relaunch the target and continue. Without a handler, preserve the advanced prompt-free failure/setup-blocked semantics.

- [ ] **Step 6: Add a single reconnect/reprovision retry for an enabled-but-stale Observer connection.** Retry only the Observer establishment phase once; never repeat target input actions automatically.

- [ ] **Step 7: Replace one-shot app setup handling with a bounded re-observation loop.** `wait-for-user` polls/re-snapshots; `press-back` performs one explicit Back then re-enters the loop; `select-highlighted` remains available only when the interactive caller explicitly chooses it; `leave-unchanged` returns setup-blocked.

- [ ] **Step 8: Add `androidPackageInstalled()` and expose it through `CliOperations`.** Implement with `AndroidTvDriver.isPackageInstalled()` so target serial/path/signal handling stays centralized.

- [ ] **Step 9: Rerun focused tests and typecheck.**

```text
npx vitest run packages/cli/test/product-flow.test.ts
npm run typecheck --workspace tvdoctor
```

Expected: PASS.

- [ ] **Step 10: Commit.**

```text
git add packages/cli/src/android-product.ts packages/cli/src/cli.ts packages/cli/src/node-replay.ts packages/cli/src/zero-config.ts packages/cli/test/product-flow.test.ts
git commit -m "feat(android): resume scans through observer and app setup"
```

---

## Task 8: Complete zero-config APK routing and compatibility-driven device choice

**Files**

- Modify: `packages/cli/src/zero-config.ts`
- Modify: `packages/cli/src/start.ts`
- Modify: `packages/cli/src/cli.ts`
- Modify: `packages/cli/test/product-flow.test.ts`
- Modify: `packages/cli/test/cli.test.ts`

**Interfaces**

Consumes:

```ts
CliOperations.inspectApk
CliOperations.androidPreflight
CliOperations.androidPackageInstalled
CliOperations.scanAndroidApk

evaluateZeroConfigAndroidDevice(apk, device)
```

- [ ] **Step 1: Add a failing APK-first ordering test.** Record operation order and assert `inspectApk` occurs before `androidPreflight`/device selection.

```ts
expect(events).toEqual([
  "inspect-apk",
  "preflight",
  "scan",
]);
```

- [ ] **Step 2: Add failing device-choice tests.** Exactly one compatible TV is auto-selected with no menu; multiple compatible TVs produce one selection; non-TV/unknown-TV/API/ABI failures are excluded with reasons; zero candidates return the managed-emulator recovery seam rather than mislabelling any Android device as TV.

- [ ] **Step 3: Add failing existing-package tests.** External target + package installed requires explicit `Replace existing app and test` approval; declining must not call `scanAndroidApk`. Absent package scans without an extra replacement prompt.

- [ ] **Step 4: Add a failing Observer first-use UX test.** Zero-config passes an Observer setup callback that prints one instruction, waits, and resumes the same `scanAndroidApk` call.

- [ ] **Step 5: Run focused tests and confirm failure.**

```text
npx vitest run packages/cli/test/product-flow.test.ts packages/cli/test/cli.test.ts
```

- [ ] **Step 6: Implement the `android-apk` branch in `runZeroConfigTarget()`.** Inspect first, locate/preflight tools, evaluate candidates, auto-select one, ask only when multiple candidates exist, enforce package replacement guard, and call `scanAndroidApk()` with `mode: "deep"`, setup timeout 300 seconds, progress, Observer setup handler, and app setup handler.

- [ ] **Step 7: Ensure `start TARGET` and root `tvdoctor TARGET` both use this same branch.** Delete obsolete platform/depth/device-confirmation wizard logic from `start.ts` once no caller uses it.

- [ ] **Step 8: Rerun focused tests and typecheck.**

```text
npx vitest run packages/cli/test/product-flow.test.ts packages/cli/test/cli.test.ts
npm run typecheck --workspace tvdoctor
```

Expected: PASS.

- [ ] **Step 9: Commit.**

```text
git add packages/cli/src/zero-config.ts packages/cli/src/start.ts packages/cli/src/cli.ts packages/cli/test/product-flow.test.ts packages/cli/test/cli.test.ts
git commit -m "feat(cli): add zero-config apk scans"
```

---

## Task 9: Add the Windows/x64 TVDoctor-managed Android TV emulator

**Files**

- Create: `packages/cli/src/android-managed-emulator.ts`
- Modify: `packages/cli/src/android-sdk.ts`
- Modify: `packages/cli/src/zero-config.ts`
- Modify: `packages/cli/src/index.ts`
- Create: `packages/cli/test/android-managed-emulator.test.ts`
- Modify: `packages/cli/test/product-flow.test.ts`
- Reference for parity: `.github/workflows/ci.yml`
- Reference for boot logic: `scripts/ensure-android-display-ready.mjs`

**Interfaces**

Produces:

```ts
export const MANAGED_ANDROID_AVD_NAME = "tvdoctor-api36-android-tv-x86_64";
export const MANAGED_ANDROID_SYSTEM_IMAGE = "system-images;android-36;android-tv;x86_64";

export interface ManagedAndroidEmulatorHandle {
  readonly serial: string;
  readonly owned: true;
  stop(): Promise<void>;
}

export interface ManagedAndroidEmulatorOptions {
  readonly tools: AndroidSdkTools;
  readonly signal?: AbortSignal;
  readonly confirmDownload: (packages: readonly string[]) => Promise<boolean>;
  readonly runTool?: (
    command: string,
    arguments_: readonly string[],
    options?: { readonly signal?: AbortSignal },
  ) => Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>;
}

export async function ensureManagedAndroidTvEmulator(
  options: ManagedAndroidEmulatorOptions,
): Promise<ManagedAndroidEmulatorHandle>;
```

- [ ] **Step 1: Write failing pure/subprocess-boundary tests.** Cover existing AVD reuse, missing system image requiring exactly one download confirmation, declined download, SDK licence prompt propagation, Windows/x64 host gate, owned AVD naming, emulator launch args, boot-ready serial detection, cancellation cleanup, and no deletion of unrelated AVDs.

- [ ] **Step 2: Run the focused emulator test and confirm failure.**

```text
npx vitest run packages/cli/test/android-managed-emulator.test.ts
```

- [ ] **Step 3: Implement capability checks.** Require Windows + x64 for v1, resolved `emulator`, `sdkmanager`, and `avdmanager`. Return a classified unsupported/setup error rather than guessing another image/architecture.

- [ ] **Step 4: Implement package/image discovery and explicit download confirmation.** Query installed SDK packages first. If downloads are needed, call `confirmDownload()` once with the exact package list before invoking `sdkmanager`. Leave SDK licence interaction attached to the user terminal; do not inject `yes` or accept flags.

- [ ] **Step 5: Implement owned AVD creation.** Reuse only `MANAGED_ANDROID_AVD_NAME`. If missing, invoke `avdmanager` with the API 36 Android TV x86_64 image and a TV profile where supported. If `devices.xml`/profile discovery prevents creation, raise a focused emulator-setup error; do not mutate other AVDs.

- [ ] **Step 6: Implement hidden/headless launch using the proven CI baseline.** Use equivalent options to:

```text
-no-snapshot-save -no-window -gpu swiftshader_indirect -noaudio -no-boot-anim -no-metrics -camera-back none -camera-front none
```

Use one spawned emulator process, discover its serial through ADB, and reuse `AndroidTvDriver.waitForDeviceReady()` for boot proof.

- [ ] **Step 7: Implement `stop()` for only the owned process/serial and make cancellation/finally call it.** Retain AVD and SDK packages.

- [ ] **Step 8: Wire zero-config Android fallback.** If no compatible external TV exists, reuse/start the managed device. If download confirmation is required, ask one explicit question. Mark the target as TVDoctor-owned so package replacement can proceed without the external-device guard.

- [ ] **Step 9: Rerun focused tests and typecheck.**

```text
npx vitest run packages/cli/test/android-managed-emulator.test.ts packages/cli/test/product-flow.test.ts
npm run typecheck --workspace tvdoctor
```

Expected: PASS.

- [ ] **Step 10: Commit.**

```text
git add packages/cli/src/android-managed-emulator.ts packages/cli/src/android-sdk.ts packages/cli/src/zero-config.ts packages/cli/src/index.ts packages/cli/test/android-managed-emulator.test.ts packages/cli/test/product-flow.test.ts
git commit -m "feat(android): manage a disposable tvdoctor test device"
```

---

## Task 10: Unify reporter workflow state across HTML and coder exports

**Files**

- Create: `packages/reporters/src/finding-workflow.ts`
- Modify: `packages/reporters/src/render-helpers.ts`
- Modify: `packages/reporters/src/render-ai.ts`
- Modify: `packages/reporters/src/render-html.ts`
- Modify: `packages/reporters/src/index.ts`
- Modify: `packages/reporters/test/reporters.test.ts`

**Interfaces**

Produces:

```ts
export type FindingWorkflowState =
  | "verified-replay-ready"
  | "verified-replay-unavailable"
  | "needs-review"
  | "setup-info";

export interface FindingWorkflow {
  readonly state: FindingWorkflowState;
  readonly label:
    | "Verified · Replay ready"
    | "Verified · Replay unavailable"
    | "Needs review"
    | "Setup / info";
  readonly replayCommand: string | null;
  readonly reason: string | null;
}

export function findingWorkflow(
  report: TVDoctorReportV1,
  issue: TVDoctorIssue,
): FindingWorkflow;
```

- [ ] **Step 1: Write a failing truth-table test.** At minimum cover deterministic + replay + deterministic-failure evidence, deterministic without embedded replay, deterministic replay without deterministic-failure evidence, heuristic/inference/unobservable, info, and `remote.startup-blocker`.

```ts
expect(findingWorkflow(reportWithReplay, deterministicIssue)).toMatchObject({
  state: "verified-replay-ready",
  label: "Verified · Replay ready",
});
```

- [ ] **Step 2: Run reporter tests and confirm failure.**

```text
npx vitest run packages/reporters/test/reporters.test.ts
```

- [ ] **Step 3: Implement the classifier from existing evidence helpers.** Move the private `hasPortableDeterministicReplay()` rule from `render-ai.ts` into this shared unit: replay-ready requires deterministic issue confidence, deterministic reproduction, a report replay for the issue, and `deterministic-failure` evidence.

- [ ] **Step 4: Replace `findingActionability()` grouping in HTML and the duplicate AI predicate with `findingWorkflow()`.** Severity stays separate; do not encode severity into replay readiness.

- [ ] **Step 5: Make coder export behavior and HTML labels agree exactly.** Only `verified-replay-ready` generates a fix task/validation command. `verified-replay-unavailable` is still a verified failure but gets review/reproduction guidance instead of an asserted CLI command.

- [ ] **Step 6: Rerun reporter tests and package typecheck.**

```text
npx vitest run packages/reporters/test/reporters.test.ts
npm run typecheck --workspace @tvdoctor/reporters
```

Expected: PASS.

- [ ] **Step 7: Commit.**

```text
git add packages/reporters/src/finding-workflow.ts packages/reporters/src/render-helpers.ts packages/reporters/src/render-ai.ts packages/reporters/src/render-html.ts packages/reporters/src/index.ts packages/reporters/test/reporters.test.ts
git commit -m "refactor(reports): share finding workflow classification"
```

---

## Task 11: Make the HTML report findings-first and link its local exports

**Files**

- Modify: `packages/reporters/src/render-html.ts`
- Modify: `packages/reporters/src/bundle.ts` only if fixed export path constants need to be exported rather than duplicated
- Modify: `packages/reporters/test/reporters.test.ts`

**Interfaces**

Consumes:

```ts
findingWorkflow(report, issue)
formatDuration(report.run.durationMs)
issueCounts(report)
replayCommand(report, issue.id)
```

- [ ] **Step 1: Rewrite the report hierarchy tests before production code.** Assert target/mode/duration in hero; concrete partial/failed reason before findings; first actionable issue before `Release checks`; replay-ready command near the issue title; repeated patterns after initial findings; and real links to local exports.

```ts
const html = renderReportHtml(report);
expect(html.indexOf(issue.title)).toBeLessThan(html.indexOf("Release checks"));
expect(html).toContain('href="exports/portable-summary.md"');
expect(html).toContain('href="exports/agent-fix-tasks.md"');
```

- [ ] **Step 2: Run reporter tests and confirm the ordering assertions fail.**

```text
npx vitest run packages/reporters/test/reporters.test.ts
```

- [ ] **Step 3: Build the compact hero.** Include verdict, target, mode as secondary metadata, duration, finding count/highest severity, and an incomplete/failure reason when relevant.

- [ ] **Step 4: Render the first actionable group immediately after the hero/run warning.** Workflow priority is replay-ready, replay-unavailable, needs-review, then setup/info; preserve severity inside each issue card.

- [ ] **Step 5: Move hardware guidance into a collapsed `<details>` labelled `Release checks` after findings.** Keep the existing caveats/content but remove it from the first-screen path.

- [ ] **Step 6: Move repeated-pattern summary below the first actionable findings and add fixed export links.** Keep the scriptless CSP unchanged.

- [ ] **Step 7: Rerun reporter tests and integration renderer test.**

```text
npx vitest run packages/reporters/test/reporters.test.ts
npm run test:integration --workspace @tvdoctor/reporters
```

Expected: PASS.

- [ ] **Step 8: Commit.**

```text
git add packages/reporters/src/render-html.ts packages/reporters/src/bundle.ts packages/reporters/test/reporters.test.ts
git commit -m "feat(reports): put actionable findings first"
```

---

## Task 12: Update help/docs and add end-to-end zero-config gates

**Files**

- Modify: `README.md`
- Modify: `packages/cli/README.md`
- Modify: `docs/drivers/android.md`
- Modify: `docs/limitations.md`
- Modify: `docs/architecture.md`
- Modify: `packages/cli/test/cli.test.ts`
- Modify: `packages/cli/integration/milestone7.integration.spec.ts`
- Modify: `scripts/package-smoke.mjs`
- Modify: `scripts/repository-presentation.test.mjs`
- Modify: `.github/workflows/ci.yml` only if an additional invocation can reuse the existing Android emulator job without increasing the support claim

**Interfaces / acceptance scenarios**

```text
npx tvdoctor https://example.test/tv
npx tvdoctor "D:\apps\example.apk"
npx tvdoctor start
npx tvdoctor start https://example.test/tv
```

- [ ] **Step 1: Add failing package-smoke/help assertions.** The packaged CLI help must show direct URL/APK forms, `start --help` and `help start` must work, and the published package must include every new compiled module.

- [ ] **Step 2: Add a real-browser zero-config integration case.** Run the existing controlled web fixture through the root URL form and assert a normal report bundle with the expected deterministic fixture finding/coverage semantics. Do not duplicate the entire M7 matrix.

- [ ] **Step 3: Extend the existing Android emulator CI script/job with one zero-config APK invocation after the lower-level observer gate is ready.** Reuse the already-running API 36 Android TV emulator; do not make CI download/start a second managed emulator. Verify the root APK path auto-selects the one proven TV and writes a complete report.

- [ ] **Step 4: Run focused smoke/integration checks and fix only zero-config regressions.**

```text
npm run test:package-smoke
npm run test:integration --workspace tvdoctor
npm run test:presentation
```

Expected: PASS.

- [ ] **Step 5: Rewrite onboarding docs around one-input usage.** README/package README lead with direct URL/APK examples; `tvdoctor start` is the one-prompt form; `test --mode` moves to advanced/CI. Android docs describe same-run Observer setup truthfully and identify the managed emulator’s Windows/x64 v1 boundary.

- [ ] **Step 6: Update architecture/limitations narrowly.** Record the new orchestration units and managed-emulator ownership/lifecycle without claiming physical/vendor support or changing evidence guarantees.

- [ ] **Step 7: Run the complete repository verification.**

```text
npm run lint
npm run typecheck
npm run test
npm run build
```

If these pass and the Android API 36 emulator is available, also run the existing Android integration gate. Do not claim that gate passed if it was not actually executed.

- [ ] **Step 8: Inspect the final diff for stale wizard language and unsafe automation claims.**

```text
git diff --check
git grep -n -E "Choose Android TV app|Quick Scan|Deep Scan \(experimental\)|Enable TVDoctor Observer.*retry|start requires.*platform"
```

Any remaining matches must be either advanced-mode documentation/tests or intentionally historical records.

- [ ] **Step 9: Commit docs/gates.**

```text
git add README.md packages/cli/README.md docs/drivers/android.md docs/limitations.md docs/architecture.md packages/cli/test/cli.test.ts packages/cli/integration/milestone7.integration.spec.ts scripts/package-smoke.mjs scripts/repository-presentation.test.mjs .github/workflows/ci.yml
git commit -m "docs: make zero-config scan the primary tvdoctor flow"
```

---

## Final Verification Checklist

- [ ] `tvdoctor URL` resolves named commands first and runs one completion-driven scan without platform/mode prompts.
- [ ] Missing Chromium invokes existing runtime setup once and resumes the same web command.
- [ ] Web startup setup is handled in the active audit browser; missing consent controls never produce an empty remote sequence.
- [ ] Web progress remains visible during long scans and the final verdict/report path are never erased by menus.
- [ ] APK inspection occurs before Android device selection.
- [ ] Android SDK discovery is shared across ADB, APK inspection, and emulator tooling, including `%LOCALAPPDATA%\Android\Sdk` on Windows.
- [ ] Zero-config Android auto-selects only boot-ready devices with proven TV identity, compatible API level, and compatible ABI where known.
- [ ] Existing package replacement on external targets requires explicit approval.
- [ ] First-use Observer onboarding opens `org.tvdoctor.observer/.SetupActivity`, waits for explicit user enablement, and resumes the same scan without `settings put` or equivalent bypasses.
- [ ] Multi-step Android setup screens can be completed manually and re-observed until the target is stable, bounded by the five-minute wait.
- [ ] With no compatible external TV, Windows/x64 zero-config can start/reuse the TVDoctor-owned API 36 Android TV emulator after explicit download approval when required.
- [ ] A managed emulator started by TVDoctor is stopped on completion/cancellation; the owned AVD/image remain for reuse and unrelated AVDs are untouched.
- [ ] HTML and `agent-fix-tasks.md` use the same replay-readiness classifier.
- [ ] The first actionable finding appears before release/hardware guidance; partial/failed reasons remain above findings.
- [ ] `report.html` keeps a scriptless CSP and links its local portable/coder exports.
- [ ] Advanced `test`, CI, replay, baseline, and `tvdoctor.report/v1` behavior remain compatible.
- [ ] Focused tests, `npm run lint`, `npm run typecheck`, `npm run test`, and `npm run build` pass before completion is claimed.
