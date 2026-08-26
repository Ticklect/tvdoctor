import process from "node:process";
import { spawn } from "node:child_process";
import { basename, dirname, join } from "node:path";
import type { CliContext, WebsiteStartupDetection } from "./cli.js";
import { safeTarget } from "./cli.js";
import { ProgressRenderer, type StartTerminal } from "./interactive.js";
import { defaultOutputDirectory } from "./product-output.js";

interface ApkCompatibilityLike {
  readonly compatible: boolean;
  readonly blockers: readonly string[];
}

function evaluateApkCompatibility(apk: { minSdk: number | null; supportedAbis: readonly string[] }, device: {
  apiLevel: number | null;
  supportedAbis: readonly string[];
}): ApkCompatibilityLike {
  const blockers: string[] = [];
  if (apk.minSdk !== null && device.apiLevel !== null && apk.minSdk > device.apiLevel) blockers.push(
    `The APK requires Android API ${String(apk.minSdk)}, but this device provides API ${String(device.apiLevel)}.`,
  );
  if (apk.supportedAbis.length > 0 && device.supportedAbis.length > 0) {
    const overlap = apk.supportedAbis.filter((abi) => device.supportedAbis.includes(abi));
    if (overlap.length === 0) blockers.push(
      `APK architectures (${apk.supportedAbis.join(", ")}) do not overlap the device architectures (${device.supportedAbis.join(", ")}).`,
    );
  }
  return { compatible: blockers.length === 0, blockers };
}

function write(context: CliContext, line: string): void {
  context.io.writeStdout(`${line}\n`);
}

function friendlyBlocker(kind: string): string {
  const labels: Readonly<Record<string, string>> = {
    "consent-wall": "cookie consent screen",
    onboarding: "onboarding screen",
    login: "login screen",
    "region-selection": "region selection screen",
    "age-gate": "age gate",
    "system-setup": "setup screen",
  };
  return labels[kind] ?? "startup setup screen";
}

function openWithSystem(path: string): void {
  const command = process.platform === "win32"
    ? "cmd.exe"
    : process.platform === "darwin" ? "open" : "xdg-open";
  const arguments_ = process.platform === "win32"
    ? ["/c", "start", "", path]
    : [path];
  const child = spawn(command, arguments_, { detached: true, stdio: "ignore" });
  child.unref();
}

function showInFolder(path: string): void {
  const command = process.platform === "win32"
    ? "explorer.exe"
    : process.platform === "darwin" ? "open" : "xdg-open";
  const arguments_ = process.platform === "win32"
    ? ["/select,", path]
    : process.platform === "darwin" ? ["-R", path] : [dirname(path)];
  const child = spawn(command, arguments_, { detached: true, stdio: "ignore" });
  child.unref();
}

async function copyToClipboard(value: string): Promise<boolean> {
  const command = process.platform === "win32"
    ? "powershell.exe"
    : process.platform === "darwin" ? "pbcopy" : "wl-copy";
  const arguments_ = process.platform === "win32"
    ? ["-NoProfile", "-Command", "$input | Set-Clipboard"]
    : [];
  const child = spawn(command, arguments_, { stdio: ["pipe", "ignore", "ignore"] });
  const completed = new Promise<boolean>((resolve) => {
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
  child.stdin.end(value);
  return await completed;
}

async function chooseStartupPolicy(
  context: CliContext,
  terminal: StartTerminal,
  detection: WebsiteStartupDetection,
): Promise<"reject" | "accept" | null> {
  if (detection.status !== "blocked") return null;
  write(context, `TVDoctor found a ${friendlyBlocker(detection.blockerKind ?? "startup")}.`);
  if (detection.blockerKind !== "consent-wall") {
    write(context, "TVDoctor will leave this setup screen unchanged. Complete it manually, then rerun the scan.");
    return null;
  }
  const choice = await terminal.select("How should TVDoctor continue?", [
    { label: "Reject cookies and continue", detail: "Recommended when available" },
    { label: "Accept cookies and continue" },
    { label: "Leave unchanged and stop" },
  ]);
  if (choice === null || choice === 2) return null;
  return choice === 0 ? "reject" : "accept";
}

async function runWebsite(
  context: CliContext,
  terminal: StartTerminal,
): Promise<number> {
  if (context.operations?.testTarget === undefined) {
    context.io.writeStderr("Web auditing is unavailable in this TVDoctor installation.\n");
    return 4;
  }
  try {
    await context.runtimeProbe?.();
  } catch {
    context.io.writeStderr(
      "Chromium is required for web audits. Install it with: npx playwright install chromium\n",
    );
    return 1;
  }
  for (;;) {
    const targetInput = await terminal.prompt("Enter website:", context.signal);
    if (targetInput === null) return 2;
    const target = safeTarget(targetInput);
    if (target === null) {
      write(context, "Please enter an absolute HTTP or HTTPS web address without credentials.");
      continue;
    }
    const scanChoice = await terminal.select("Scan type", [
      { label: "Quick Scan", detail: "Fast navigation and product smoke checks" },
      { label: "Deep Scan", detail: "Completion-driven exploration with safety bounds" },
      { label: "Cancel" },
    ]);
    if (scanChoice === null || scanChoice === 2) continue;
    const mode = scanChoice === 0 ? "quick" : "deep";
    let startupDecision: "reject" | "accept" | undefined;
    const detection = await context.operations.detectWebsiteStartup?.(target);
    if (detection !== undefined) {
      const decision = await chooseStartupPolicy(context, terminal, detection);
      if (decision === null && detection.status === "blocked") {
        write(context, "The scan was not started.");
        return 3;
      }
      startupDecision = decision ?? undefined;
    }
    const outputPath = defaultOutputDirectory({ target, mode });
    write(context, `TVDoctor - ${mode === "quick" ? "Quick Scan" : "Deep Scan"}`);
    write(context, `Target: ${target}`);
    write(context, "Platform: Website");
    write(context, "Starting the audit. Press Ctrl+C to stop safely.");
    const result = await context.operations.testTarget({
      target,
      packs: ["all"],
      mode,
      outputPath,
      searchQuery: "N",
      ...(startupDecision === undefined ? {} : { startupDecision }),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    const interrupted = result.details.some((detail) => /interrupted/iu.test(detail));
    const statusLine = result.status === "completed"
      ? "\u2713 Scan complete"
      : result.status === "partial"
        ? interrupted
          ? "\u25d0 Scan interrupted; completed coverage retained"
          : "\u25d0 Scan stopped at safety limit"
        : "\u2717 Scan could not complete";
    write(context, `${statusLine}\n${result.details.join("\n")}`);
    if (result.reportPath !== null) {
      const reportPath = join(dirname(result.reportPath), "report.html");
      write(context, `\nFindings: ${String(result.issueCount)}\nReport:\n${reportPath}`);
      const action = await terminal.select("", [
        { label: "Open report" },
        { label: "Show folder" },
        { label: "Copy path" },
        { label: "Exit" },
      ]);
      if (action === 0) openWithSystem(reportPath);
      else if (action === 1) showInFolder(reportPath);
      else if (action === 2) await copyToClipboard(reportPath);
    }
    return result.status === "failed" ? 4 : result.status === "partial" ? 3 : 0;
  }
}

async function runAndroid(
  context: CliContext,
  terminal: StartTerminal,
): Promise<number> {
  if (context.operations?.androidPreflight === undefined
    || context.operations.inspectApk === undefined
    || context.operations.scanAndroidApk === undefined) {
    context.io.writeStderr("Android TV testing is unavailable in this TVDoctor installation.\n");
    return 4;
  }
  const preflight = await context.operations.androidPreflight();
  write(context, preflight.message);
  if (!preflight.available) {
    write(context, "Install Android SDK platform-tools, then add adb to PATH or set ANDROID_SDK_ROOT.");
    return 1;
  }
  const readyDevices = preflight.devices.filter((device) => device.online);
  if (readyDevices.length === 0) {
    for (const device of preflight.devices) {
      write(context, `${device.serial}: ${device.detail ?? device.state}`);
    }
    write(context, "Start or connect an Android TV device, accept its ADB authorisation prompt, then rerun TVDoctor.");
    return 1;
  }
  let selectedDeviceIndex: number | null;
  if (readyDevices.length === 1) {
    const device = readyDevices[0];
    if (device === undefined) return 2;
    write(context, `Found Android TV: ${device.manufacturer ?? "Android"} ${device.model ?? "device"}`);
    write(context, `${device.serial}; API ${device.apiLevel?.toString() ?? "unknown"}; ${
      device.supportedAbis.join(", ") || "architecture unknown"
    }`);
    const confirmation = await terminal.select("Use this device?", [
      { label: "Yes" },
      { label: "Choose another" },
    ]);
    if (confirmation === null) return 2;
    if (confirmation !== 0) return await runAndroid(context, terminal);
    selectedDeviceIndex = 0;
  } else {
    selectedDeviceIndex = await terminal.select(
      "Choose the device you want to test.",
      readyDevices.map((device) => ({
        label: `${device.manufacturer ?? "Android"} ${device.model ?? "device"}`.trim(),
        detail: `${device.serial}; API ${device.apiLevel?.toString() ?? "unknown"}`,
      })),
    );
  }
  if (selectedDeviceIndex === null) return 2;
  const selectedDevice = readyDevices[selectedDeviceIndex];
  if (selectedDevice === undefined) return 2;
  const device = selectedDevice;
  for (;;) {
    const apkPath = await terminal.prompt("Select APK (enter or paste its path):", context.signal);
    if (apkPath === null) return 2;
    try {
      const apk = await context.operations.inspectApk(apkPath);
      const compatibility = evaluateApkCompatibility(apk, device);
      write(context, `APK: ${apk.label ?? basename(apkPath)}`);
      if (apk.packageName !== null) write(context, `Package: ${apk.packageName}`);
      if (apk.versionName !== null) write(context, `Version: ${apk.versionName}`);
      write(context, `Architectures: ${apk.supportedAbis.join(", ") || "unknown"}`);
      if (!compatibility.compatible) {
        write(context, "TVDoctor cannot run this APK on the selected device.");
        for (const blocker of compatibility.blockers) write(context, blocker);
        continue;
      }
      const scanChoice = await terminal.select("Scan type", [
        { label: "Quick Scan" },
        { label: "Deep Scan (experimental)" },
        { label: "Choose another APK/device" },
      ]);
      if (scanChoice === null) return 2;
      if (scanChoice === 2) return await runAndroid(context, terminal);
      const outputPath = defaultOutputDirectory({
        target: apk.label ?? apk.packageName ?? basename(apkPath),
        platform: "android-tv",
        mode: scanChoice === 0 ? "quick" : "deep",
      });
      write(context, "Starting the Android scan. TVDoctor will stop the tested app afterward; the emulator and installed APK remain.");
      const progress = new ProgressRenderer(terminal.isInteractive, (line) => write(context, line));
      const result = await context.operations.scanAndroidApk({
        ...(preflight.adbPath === null ? {} : { adbPath: preflight.adbPath }),
        serial: device.serial,
        apkPath,
        mode: scanChoice === 0 ? "quick" : "deep",
        outputPath,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        onSetupScreen: async (detection) => {
          const focused = detection.controls.find((control) => control.focused);
          const choice = await terminal.select(
            `TVDoctor found a ${detection.kind} screen. How should it continue?`,
            [
              { label: "Leave unchanged and stop", detail: "Recommended when the choice is unclear" },
              {
                label: "Select the highlighted control",
                ...(focused === undefined ? {} : { detail: focused.label }),
              },
              { label: "Press Back" },
            ],
          );
          if (choice === 1) return "select-highlighted";
          if (choice === 2) return "press-back";
          return "leave-unchanged";
        },
        onProgress: (state) => progress.update(state),
      });
      progress.finish();
      if (result.status === "setup-blocker") {
        write(context, `\u25d0 Scan not started\n${result.details.join("\n")}`);
        return 3;
      }
      const interrupted = result.details.some((detail) => /interrupted/iu.test(detail));
      const statusLine = result.status === "completed"
        ? "\u2713 Scan complete"
        : result.status === "partial"
          ? interrupted
            ? "\u25d0 Scan interrupted; completed coverage retained"
            : "\u25d0 Scan stopped at safety limit"
          : "\u2717 Scan could not complete";
      write(context, `${statusLine}\n${result.details.join("\n")}`);
      if (result.reportPath !== null) {
        const reportPath = join(dirname(result.reportPath), "report.html");
        write(context, `\nReport:\n${reportPath}`);
      }
      return result.status === "failed" ? 4 : result.status === "partial" ? 3 : 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : "TVDoctor could not inspect this APK.";
      if (/No usable aapt\/aapt2/iu.test(message)) {
        write(context, "APK inspection needs Android SDK build-tools. Install them with Android Studio or: sdkmanager \"build-tools;36.0.0\"");
      } else {
        write(context, message);
      }
      write(context, "Enter an .apk file path, or press Enter to cancel.");
    }
  }
}

export async function runGuidedStart(
  context: CliContext & { readonly startTerminal?: StartTerminal },
): Promise<number> {
  const terminal = context.startTerminal;
  if (terminal === undefined || !terminal.isInteractive) {
    context.io.writeStderr(
      "TVDoctor start requires an interactive terminal; use tvdoctor test URL [options] in CI.\n",
    );
    return 2;
  }
  try {
    write(context, "TVDoctor");
    const home = await terminal.select("What would you like to test?", [
      { label: "Website" },
      { label: "Android TV app", detail: "Experimental" },
      { label: "Exit" },
    ]);
    if (home === null || home === 2) return 2;
    return home === 0 ? await runWebsite(context, terminal) : await runAndroid(context, terminal);
  } finally {
    terminal.close?.();
  }
}
