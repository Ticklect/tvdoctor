from __future__ import annotations

import re
from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text(encoding="utf-8")
    if text.count(old) != 1:
        raise RuntimeError(f"expected exactly one literal match in {path}: {old[:100]!r}")
    target.write_text(text.replace(old, new, 1), encoding="utf-8")


def sub_once(path: str, pattern: str, replacement: str) -> None:
    target = Path(path)
    text = target.read_text(encoding="utf-8")
    result, count = re.subn(pattern, lambda _match: replacement, text, count=1, flags=re.S)
    if count != 1:
        raise RuntimeError(f"expected exactly one regex match in {path}: {pattern[:120]!r}")
    target.write_text(result, encoding="utf-8")


driver = "packages/driver-android/src/android-driver.ts"
replace_once(
    driver,
    '''  FAST_FORWARD: "KEYCODE_MEDIA_FAST_FORWARD",\n};\n\ninterface NormalisedOptions''',
    '''  FAST_FORWARD: "KEYCODE_MEDIA_FAST_FORWARD",\n};\nconst SYSTEM_SETUP_PACKAGES: ReadonlySet<string> = new Set([\n  "com.android.permissioncontroller",\n  "com.google.android.permissioncontroller",\n  "com.android.packageinstaller",\n  "com.google.android.packageinstaller",\n]);\nfunction isSystemSetupPackage(value: string | null): boolean {\n  return value !== null && SYSTEM_SETUP_PACKAGES.has(value);\n}\nfunction snapshotPackageName(snapshot: AndroidStateSnapshot): string | null {\n  if (snapshot.location.status !== "available") return null;\n  return /^android:\\/\\/([^/]+)\\//u.exec(snapshot.location.value)?.[1] ?? null;\n}\nfunction snapshotBelongsToPackage(snapshot: AndroidStateSnapshot, packageName: string): boolean {\n  return snapshotPackageName(snapshot) === packageName;\n}\n\ninterface NormalisedOptions''',
)
replace_once(
    driver,
    '''  async press(key: RemoteKey, options?: DriverOperationOptions): Promise<ActionResult> {\n    const signal = combinedSignal(this.#options.signal, options?.signal);\n    return await this.#enqueueOperation(() => this.#press(key, signal), signal);\n  }\n  async #press(key: RemoteKey, signal?: AbortSignal): Promise<ActionResult> {''',
    '''  async press(key: RemoteKey, options?: DriverOperationOptions): Promise<ActionResult> {\n    const signal = combinedSignal(this.#options.signal, options?.signal);\n    return await this.#enqueueOperation(() => this.#press(key, "target", signal), signal);\n  }\n  async pressSystemSetup(\n    key: "SELECT" | "BACK",\n    options?: DriverOperationOptions,\n  ): Promise<ActionResult> {\n    const signal = combinedSignal(this.#options.signal, options?.signal);\n    return await this.#enqueueOperation(() => this.#press(key, "system-setup", signal), signal);\n  }\n  async #press(\n    key: RemoteKey,\n    foreground: "target" | "system-setup",\n    signal?: AbortSignal,\n  ): Promise<ActionResult> {''',
)
replace_once(
    driver,
    '''      if (begin.actionId === undefined) throw new Error("Android observer did not return an action identity.");\n      const inputStarted = performance.now();''',
    '''      if (begin.actionId === undefined) throw new Error("Android observer did not return an action identity.");\n      if (foreground === "target") await this.#assertTargetForeground(signal);\n      else await this.#assertSystemSetupForeground(signal);\n      const inputStarted = performance.now();''',
)
replace_once(
    driver,
    '''      const timing = parseSettleTiming(settled.timing);\n      const conversionStarted = performance.now();\n      const snapshot = this.#snapshotFromState(parseObserverState(settled.state));\n      const hostConversionMs = performance.now() - conversionStarted;''',
    '''      const timing = parseSettleTiming(settled.timing);\n      const conversionStarted = performance.now();\n      const snapshot = await this.#snapshotFromObservedState(parseObserverState(settled.state), signal);\n      const hostConversionMs = performance.now() - conversionStarted;''',
)
replace_once(
    driver,
    '''        ...(timing.noOpConfirmed ? { message: "Observer confirmed a canonical no-op." } : {}),\n        postActionSnapshot: snapshot,''',
    '''        ...(timing.noOpConfirmed && this.#currentApp !== null\n          && snapshotBelongsToPackage(snapshot, this.#currentApp.id)\n          ? { message: "Observer confirmed a canonical no-op." } : {}),\n        postActionSnapshot: snapshot,''',
)
replace_once(
    driver,
    '''  async snapshot(options?: DriverOperationOptions): Promise<AndroidStateSnapshot> {\n    const signal = combinedSignal(this.#options.signal, options?.signal);\n    return await this.#enqueueOperation(() => this.#snapshot(signal), signal);\n  }''',
    '''  async assertTargetForeground(options?: DriverOperationOptions): Promise<void> {\n    const signal = combinedSignal(this.#options.signal, options?.signal);\n    return await this.#enqueueOperation(() => this.#assertTargetForeground(signal), signal);\n  }\n\n  async snapshot(options?: DriverOperationOptions): Promise<AndroidStateSnapshot> {\n    const signal = combinedSignal(this.#options.signal, options?.signal);\n    return await this.#enqueueOperation(() => this.#snapshot(signal), signal);\n  }''',
)
replace_once(
    driver,
    '''    const response = await observer.request({ type: "current_state", forceFull: this.#cachedTree === null }, {\n      ...(signal === undefined ? {} : { signal }),\n    });\n    return this.#snapshotFromState(parseObserverState(response.state));''',
    '''    const response = await observer.request({ type: "current_state", forceFull: this.#cachedTree === null }, {\n      ...(signal === undefined ? {} : { signal }),\n    });\n    return await this.#snapshotFromObservedState(parseObserverState(response.state), signal);''',
)
replace_once(
    driver,
    '''    this.#ensureOpen();\n    if (!/\\.png$/iu.test(artifactPath)) throw new TypeError("Android screenshots require a .png artifact path.");\n    const absolutePath = resolve(artifactPath); const capturedAt = new Date().toISOString();''',
    '''    this.#ensureOpen();\n    if (!/\\.png$/iu.test(artifactPath)) throw new TypeError("Android screenshots require a .png artifact path.");\n    await this.#assertTargetForeground(signal);\n    const absolutePath = resolve(artifactPath); const capturedAt = new Date().toISOString();''',
)
replace_once(
    driver,
    '''    const dimensions = pngDimensions(result.stdout);\n    signal?.throwIfAborted();''',
    '''    const dimensions = pngDimensions(result.stdout);\n    await this.#assertTargetForeground(signal);\n    signal?.throwIfAborted();''',
)
replace_once(
    driver,
    '''  async #waitForTargetState(packageName: string, forceFull: boolean, signal?: AbortSignal): Promise<AndroidStateSnapshot> {''',
    '''  async #focusedWindowOwner(signal?: AbortSignal): Promise<string | null> {\n    const output = await this.#deviceText(["shell", "dumpsys", "window"], {\n      timeoutMs: this.#options.commandTimeoutMs,\n      maxOutputBytes: this.#options.maxCommandOutputBytes,\n      ...(signal === undefined ? {} : { signal }),\n    });\n    return focusedWindowPackage(output);\n  }\n\n  async #assertTargetForeground(signal?: AbortSignal): Promise<void> {\n    const packageName = this.#currentApp?.id;\n    if (packageName === undefined) throw new Error("No Android app has been launched.");\n    const focusedPackage = await this.#focusedWindowOwner(signal);\n    if (focusedPackage !== packageName) {\n      throw new Error(\n        `Android target ${packageName} does not own the focused window; current focused window package is ${focusedPackage ?? "unknown"}.`,\n      );\n    }\n  }\n\n  async #assertSystemSetupForeground(signal?: AbortSignal): Promise<void> {\n    const focusedPackage = await this.#focusedWindowOwner(signal);\n    if (!isSystemSetupPackage(focusedPackage)) {\n      throw new Error(\n        `Android system setup does not own the focused window; current focused window package is ${focusedPackage ?? "unknown"}.`,\n      );\n    }\n  }\n\n  #redactedBoundarySnapshot(state: ObserverState, focusedPackage: string | null): AndroidStateSnapshot {\n    const current = this.#currentApp;\n    if (current === null) throw new Error("No Android app has been launched.");\n    this.#stateMessages += 1;\n    if (state.nodes !== undefined) this.#fullTreeMessages += 1;\n    this.#canonicalPayloadBytes += Buffer.byteLength(JSON.stringify(state), "utf8");\n    if (state.packageName !== current.id\n      && (state.focused !== null || state.nodeCount !== 0 || (state.nodes?.length ?? 0) !== 0)) {\n      throw new Error("Android observer exposed foreign UI content outside the provisioned target package.");\n    }\n    this.#cachedTree = null;\n    const locationPackage = focusedPackage ?? "unknown";\n    const locationClass = state.packageName === focusedPackage && state.windowClassName !== null\n      ? state.windowClassName\n      : `window-${String(state.windowId ?? "unknown")}`;\n    return {\n      capturedAt: new Date(state.timestampMs).toISOString(),\n      location: availableObservation(`android://${locationPackage}/${locationClass}`),\n      focusedElement: availableObservation(null),\n      uiTree: availableObservation([]),\n      device: this.#deviceMetadata === null\n        ? unavailableObservation("Android device metadata has not been collected.")\n        : availableObservation(this.#deviceMetadata),\n      app: this.#appMetadata === null\n        ? unavailableObservation("Android app metadata has not been collected.")\n        : availableObservation(this.#appMetadata),\n      hierarchyMetadata: availableObservation({\n        capturedNodeCount: 0,\n        maxNodeCount: 4_096,\n        maxDepth: 0,\n        truncated: false,\n      }),\n    };\n  }\n\n  async #snapshotFromObservedState(\n    state: ObserverState,\n    signal?: AbortSignal,\n  ): Promise<AndroidStateSnapshot> {\n    const current = this.#currentApp;\n    if (current === null) throw new Error("No Android app has been launched.");\n    const focusedPackage = await this.#focusedWindowOwner(signal);\n    if (focusedPackage !== current.id) return this.#redactedBoundarySnapshot(state, focusedPackage);\n    return this.#snapshotFromState(state);\n  }\n\n  async #waitForTargetState(packageName: string, forceFull: boolean, signal?: AbortSignal): Promise<AndroidStateSnapshot> {''',
)
sub_once(
    driver,
    r'''  async #waitForTargetState\(packageName: string, forceFull: boolean, signal\?: AbortSignal\): Promise<AndroidStateSnapshot> \{.*?\n  \}\n  async #waitForStableTargetState''',
    '''  async #waitForTargetState(packageName: string, forceFull: boolean, signal?: AbortSignal): Promise<AndroidStateSnapshot> {\n    const observer = await this.#requiredObserver(signal);\n    const deadline = performance.now() + 8_000;\n    let latestPackage: string | null = null;\n    while (performance.now() < deadline) {\n      const response = await observer.request({ type: "current_state", forceFull }, {\n        timeoutMs: this.#options.observerRequestTimeoutMs,\n        ...(signal === undefined ? {} : { signal }),\n      });\n      const state = parseObserverState(response.state);\n      const latest = await this.#snapshotFromObservedState(state, signal);\n      latestPackage = snapshotPackageName(latest);\n      if (latestPackage === packageName || isSystemSetupPackage(latestPackage)) return latest;\n      await delay(75, signal);\n    }\n    throw new Error(`Android observer did not observe ${packageName}; current window package is ${latestPackage ?? "unknown"}.`);\n  }\n  async #waitForStableTargetState''',
)
sub_once(
    driver,
    r'''  async #waitForStableTargetState\(packageName: string, signal\?: AbortSignal\): Promise<AndroidStateSnapshot> \{.*?\n  \}\n  async #waitForFocusedTargetWindow''',
    '''  async #waitForStableTargetState(packageName: string, signal?: AbortSignal): Promise<AndroidStateSnapshot> {\n    const deadline = performance.now() + this.#options.resetSettleTimeoutMs;\n    let previousFingerprint: string | null = null;\n    let stableSince = performance.now();\n    while (performance.now() < deadline) {\n      const observer = await this.#requiredObserver(signal);\n      const response = await observer.request({ type: "resync" }, {\n        timeoutMs: Math.max(1, Math.min(\n          this.#options.observerRequestTimeoutMs,\n          Math.ceil(deadline - performance.now()),\n        )),\n        ...(signal === undefined ? {} : { signal }),\n      });\n      const state = parseObserverState(response.state);\n      const latest = await this.#snapshotFromObservedState(state, signal);\n      const owner = snapshotPackageName(latest);\n      if (isSystemSetupPackage(owner)) return latest;\n      if (owner !== packageName) {\n        throw new Error(`Android focused window crossed into ${owner ?? "an unknown package"}; expected ${packageName}.`);\n      }\n      const observedAt = performance.now();\n      if (state.stateFingerprint !== previousFingerprint) {\n        previousFingerprint = state.stateFingerprint;\n        stableSince = observedAt;\n      } else if (observedAt - stableSince >= this.#options.resetStableWindowMs) {\n        return latest;\n      }\n      const remainingMs = deadline - performance.now();\n      if (remainingMs <= 0) break;\n      await delay(Math.min(this.#options.quietWindowMs, remainingMs), signal);\n    }\n    throw new Error(`Android target ${packageName} did not remain stable before the deadline.`);\n  }\n  async #waitForFocusedTargetWindow''',
)
sub_once(
    driver,
    r'''  async #stabilizeTargetLaunch\(packageName: string, forceFull: boolean, signal\?: AbortSignal\): Promise<void> \{.*?\n  \}\n  async #serial''',
    '''  async #stabilizeTargetLaunch(packageName: string, forceFull: boolean, signal?: AbortSignal): Promise<void> {\n    let latestError: unknown;\n    for (let attempt = 1; attempt <= 2; attempt += 1) {\n      try {\n        const observed = await this.#waitForTargetState(packageName, forceFull, signal);\n        if (!snapshotBelongsToPackage(observed, packageName)) {\n          await this.#assertSystemSetupForeground(signal);\n          return;\n        }\n        await this.#waitForFocusedTargetWindow(packageName, signal);\n        const stable = await this.#waitForStableTargetState(packageName, signal);\n        if (!snapshotBelongsToPackage(stable, packageName)) {\n          await this.#assertSystemSetupForeground(signal);\n          return;\n        }\n        await this.#waitForFocusedTargetWindow(packageName, signal);\n        return;\n      } catch (error) {\n        latestError = error;\n        if (attempt < 2) {\n          this.#cachedTree = null;\n          if (signal?.aborted === true) throw signal.reason;\n          await this.#launchPackage(packageName, this.#component, signal);\n        }\n      }\n    }\n    const detail = cleanText(latestError instanceof Error ? latestError.message : String(latestError));\n    throw new Error(`Android could not establish a stable focused launch for ${packageName}. ${detail}`);\n  }\n  async #serial''',
)


cli = "packages/cli/src/android-product.ts"
replace_once(
    cli,
    '''export const ANDROID_ACTION_SETTLING = {\n  strategy: "stable-snapshot",\n  maxSnapshots: 6,\n  requiredStableSnapshots: 3,\n  pollIntervalMs: 250,\n  keyOverrides: {\n    SELECT: { maxSnapshots: 14, requiredStableSnapshots: 7 },\n    BACK: { maxSnapshots: 14, requiredStableSnapshots: 7 },\n  },\n} as const;''',
    '''export const ANDROID_ACTION_SETTLING = {\n  strategy: "stable-snapshot",\n  maxSnapshots: 6,\n  requiredStableSnapshots: 3,\n  pollIntervalMs: 250,\n  keyOverrides: {\n    SELECT: { maxSnapshots: 14, requiredStableSnapshots: 7 },\n    BACK: { maxSnapshots: 14, requiredStableSnapshots: 7 },\n  },\n} as const;\n\nconst ANDROID_LAUNCH_SETTLING = {\n  resetStableWindowMs: 2_000,\n  resetSettleTimeoutMs: 20_000,\n} as const;\nconst ANDROID_LAUNCH_WARMUP_MS = 8_000;\nconst SYSTEM_SETUP_PACKAGES: ReadonlySet<string> = new Set([\n  "com.android.permissioncontroller",\n  "com.google.android.permissioncontroller",\n  "com.android.packageinstaller",\n  "com.google.android.packageinstaller",\n]);\n\nasync function waitForAndroidLaunchWarmup(): Promise<void> {\n  await new Promise<void>((resolveWarmup) => setTimeout(resolveWarmup, ANDROID_LAUNCH_WARMUP_MS));\n}''',
)
replace_once(
    cli,
    '''  const packages = [...new Set(nodes.map((node) => node.packageName).filter((value): value is string => value !== null))];\n  const isPermissionUi = packages.some((value) => /(?:permissioncontroller|packageinstaller)/iu.test(value))\n    || /\\b(?:allow .* to (?:access|take pictures|record audio)|runtime permission|system permission)\\b/u.test(text);''',
    '''  const packages = [...new Set(nodes.map((node) => node.packageName).filter((value): value is string => value !== null))];\n  const locationOwner = snapshot.location.status === "available"\n    ? /^android:\\/\\/([^/]+)/u.exec(snapshot.location.value)?.[1] ?? null\n    : null;\n  const isPermissionUi = (locationOwner !== null && SYSTEM_SETUP_PACKAGES.has(locationOwner))\n    || packages.some((value) => SYSTEM_SETUP_PACKAGES.has(value))\n    || /\\b(?:allow .* to (?:access|take pictures|record audio)|runtime permission|system permission)\\b/u.test(text);''',
)
replace_once(
    cli,
    '''  return {\n    kind,\n    heading: (headingNode?.name ?? headingNode?.text ?? kind).replace(/\\s+/gu, " ").trim(),\n    controls,\n  };\n}\n\nexport async function scanAndroidApk''',
    '''  const fallbackHeading = `${kind.slice(0, 1).toUpperCase()}${kind.slice(1)}`;\n  return {\n    kind,\n    heading: (headingNode?.name ?? headingNode?.text ?? fallbackHeading).replace(/\\s+/gu, " ").trim(),\n    controls,\n  };\n}\n\nfunction androidSnapshotBelongsToTarget(snapshot: AndroidStateSnapshot, packageName: string): boolean {\n  return snapshot.location.status === "available"\n    && snapshot.location.value.startsWith(`android://${packageName}/`);\n}\n\nexport async function restoreAndroidTargetForFinalEvidence(\n  driver: Pick<AndroidTvDriver, "snapshot" | "reset" | "assertTargetForeground">,\n  packageName: string,\n  waitForWarmup: () => Promise<void> = waitForAndroidLaunchWarmup,\n): Promise<AndroidStateSnapshot> {\n  let snapshot = await driver.snapshot();\n  if (androidSnapshotBelongsToTarget(snapshot, packageName)) {\n    try {\n      await driver.assertTargetForeground();\n      return snapshot;\n    } catch {\n      // The focused-window owner is authoritative; relaunch once before final evidence.\n    }\n  }\n  await driver.reset("relaunch");\n  await waitForWarmup();\n  snapshot = await driver.snapshot();\n  if (!androidSnapshotBelongsToTarget(snapshot, packageName)) {\n    throw new Error(`Android scan ended outside ${packageName}.`);\n  }\n  try {\n    await driver.assertTargetForeground();\n  } catch (error) {\n    throw new Error(`Android scan ended without a focused window owned by ${packageName}.`, { cause: error });\n  }\n  return snapshot;\n}\n\nexport function androidRunStatus(\n  explorationComplete: boolean,\n  finalTargetValidationError: string | null,\n): "completed" | "partial" {\n  return explorationComplete && finalTargetValidationError === null ? "completed" : "partial";\n}\n\nexport async function scanAndroidApk''',
)
replace_once(
    cli,
    '''  let latestFindings = 0;\n  let latestProgress: ExplorationProgress | null = null;\n  let exploration: ExplorationResult | null = null;\n  let progressTimer: ReturnType<typeof setInterval> | undefined;''',
    '''  let latestFindings = 0;\n  let latestProgress: ExplorationProgress | null = null;\n  let latestActivityLabel: string | null = null;\n  let progressTimer: ReturnType<typeof setInterval> | undefined;''',
)
replace_once(
    cli,
    '''    serial: options.serial,\n    ...(options.signal === undefined ? {} : { signal: options.signal }),\n  });''',
    '''    serial: options.serial,\n    ...ANDROID_LAUNCH_SETTLING,\n    ...(options.signal === undefined ? {} : { signal: options.signal }),\n  });''',
)
replace_once(
    cli,
    '''    if (apk.packageName === null) throw new Error("TVDoctor could not determine the APK package name.");\n    selectedPackage = apk.packageName;\n    const component = apk.leanbackActivity ?? apk.launchableActivities.at(0) ?? null;''',
    '''    if (apk.packageName === null) throw new Error("TVDoctor could not determine the APK package name.");\n    const packageName = apk.packageName;\n    selectedPackage = packageName;\n    const component = apk.leanbackActivity ?? apk.launchableActivities.at(0) ?? null;''',
)
replace_once(
    cli,
    '''    await driver.launch({\n      id: apk.packageName,\n      ...(component === null ? {} : { launchUri: component }),\n    });\n    const initial = await driver.snapshot();''',
    '''    await driver.launch({\n      id: packageName,\n      ...(component === null ? {} : { launchUri: component }),\n    });\n    await waitForAndroidLaunchWarmup();\n    const initial = await driver.snapshot();\n    latestActivityLabel = initial.location.status === "available" ? initial.location.value : null;''',
)
replace_once(
    cli,
    '''      await driver.press(decision === "select-highlighted" ? "SELECT" : "BACK");\n      const observed = await driver.snapshot();''',
    '''      const setupKey = decision === "select-highlighted" ? "SELECT" : "BACK";\n      const setupIsExternal = initial.location.status === "available"\n        && !initial.location.value.startsWith(`android://${packageName}/`);\n      const setupAction = setupIsExternal\n        ? await driver.pressSystemSetup(setupKey)\n        : await driver.press(setupKey);\n      if (setupAction.outcome !== "applied") {\n        throw new Error(setupAction.message ?? `TVDoctor could not safely operate the ${setup.kind} screen.`);\n      }\n      const observed = await driver.snapshot();\n      latestActivityLabel = observed.location.status === "available" ? observed.location.value : null;''',
)
sub_once(
    cli,
    r'''    const explorationPromise = explore\(driver, \{.*?    \}\)\.then\(\(result\) => \{\n      exploration = result;\n      return result;\n    \}\);''',
    '''    const explorationPromise = explore(driver, {\n      profile: options.mode,\n      budgets: ANDROID_EXPLORATION_BUDGETS[options.mode],\n      settling: ANDROID_ACTION_SETTLING,\n      restoreInitialSnapshot: async () => {\n        latestActivityLabel = null;\n        await driver.reset("relaunch");\n        await waitForAndroidLaunchWarmup();\n        const restored = await driver.snapshot();\n        latestActivityLabel = restored.location.status === "available" ? restored.location.value : null;\n        return restored;\n      },\n      shouldExpand: (snapshot) => {\n        if (snapshot.location.status !== "available") return false;\n        latestActivityLabel = snapshot.location.value;\n        return snapshot.location.value.startsWith(`android://${packageName}/`);\n      },\n      ...(options.signal === undefined ? {} : { signal: options.signal }),\n      onProgress: (progress) => {\n        latestProgress = progress;\n      },\n    });''',
)
replace_once(
    cli,
    '''          currentActivityLabel: exploration?.graph.screens.states.at(-1)?.fingerprint.value ?? null,''',
    '''          currentActivityLabel: latestActivityLabel,''',
)
replace_once(
    cli,
    '''    const issues = findings.map((finding) => finding.issue);\n    const completedAt = new Date();\n    const complete = result.termination.complete;\n    const exhausted: CoverageBudget[] = [];\n    if (!complete) {\n      if (result.termination.reason === "max-actions") exhausted.push("actions");\n      if (result.termination.reason === "max-states") exhausted.push("states");\n      if (result.termination.reason === "max-depth") exhausted.push("depth");\n      if (result.termination.reason === "max-duration") exhausted.push("duration");\n    }\n    try {''',
    '''    const issues = findings.map((finding) => finding.issue);\n    let finalTargetValidationError: string | null = null;\n    try {\n      await restoreAndroidTargetForFinalEvidence(driver, packageName);\n    } catch (error) {\n      finalTargetValidationError = error instanceof Error ? error.message : String(error);\n    }\n    if (finalTargetValidationError === null) try {''',
)
replace_once(
    cli,
    '''    } catch {\n      // Log capture is supplementary; the scan result remains authoritative.\n    }\n    try {\n      const explorationEvidence = sanitiseEvidenceJson(JSON.parse(JSON.stringify({\n        termination: result.termination,\n        budgets: result.budgets,\n        actionOrder: result.actionOrder,\n        statistics: result.statistics,\n      })) as JsonValue);''',
    '''    } catch {\n      // Log capture is supplementary; the scan result remains authoritative.\n    }\n    if (finalTargetValidationError === null) {\n      try {\n        await restoreAndroidTargetForFinalEvidence(driver, packageName);\n      } catch (error) {\n        finalTargetValidationError = error instanceof Error ? error.message : String(error);\n      }\n    }\n    const completedAt = new Date();\n    const runStatus = androidRunStatus(result.termination.complete, finalTargetValidationError);\n    const complete = runStatus === "completed";\n    const exhausted: CoverageBudget[] = [];\n    if (!result.termination.complete) {\n      if (result.termination.reason === "max-actions") exhausted.push("actions");\n      if (result.termination.reason === "max-states") exhausted.push("states");\n      if (result.termination.reason === "max-depth") exhausted.push("depth");\n      if (result.termination.reason === "max-duration") exhausted.push("duration");\n    }\n    try {\n      const explorationEvidence = sanitiseEvidenceJson(JSON.parse(JSON.stringify({\n        termination: result.termination,\n        budgets: result.budgets,\n        actionOrder: result.actionOrder,\n        statistics: result.statistics,\n        finalTargetValidation: finalTargetValidationError === null\n          ? { status: "verified" }\n          : { status: "failed", message: finalTargetValidationError },\n      })) as JsonValue);''',
)
replace_once(cli, '        status: complete ? "completed" : "partial",', '        status: runStatus,')
replace_once(
    cli,
    '''      details: complete\n        ? ["All reachable navigation work was exhausted."]\n        : result.termination.reason === "interrupted"''',
    '''      details: finalTargetValidationError !== null\n        ? [\n          finalTargetValidationError,\n          "Navigation coverage was retained as partial because final target ownership could not be verified.",\n        ]\n        : complete\n          ? ["All reachable navigation work was exhausted."]\n        : result.termination.reason === "interrupted"''',
)

print("Android V2 host-side foreground-integrity source transformations applied.")
