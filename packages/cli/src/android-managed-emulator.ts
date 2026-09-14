import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { AndroidTvDriver } from "@tvdoctor/driver-android";

import type { AndroidSdkTools } from "./android-sdk.js";

const execFileAsync = promisify(execFile);

export const MANAGED_ANDROID_AVD_NAME = "tvdoctor-api36-android-tv-x86_64";
export const MANAGED_ANDROID_SYSTEM_IMAGE = "system-images;android-36;android-tv;x86_64";

export interface ManagedAndroidEmulatorHandle {
  readonly serial: string;
  readonly owned: true;
  stop(): Promise<void>;
}

export interface ManagedEmulatorProcess {
  readonly pid: number | null;
  stop(): Promise<void>;
}

export interface ManagedAndroidEmulatorDependencies {
  readonly runTool: (
    command: string,
    arguments_: readonly string[],
    options?: { readonly signal?: AbortSignal },
  ) => Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>;
  readonly runInteractiveTool: (
    command: string,
    arguments_: readonly string[],
    options?: { readonly signal?: AbortSignal },
  ) => Promise<number>;
  readonly startEmulator: (
    command: string,
    arguments_: readonly string[],
    options?: { readonly signal?: AbortSignal },
  ) => Promise<ManagedEmulatorProcess>;
  readonly waitForReady: (
    adbPath: string,
    serial: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly sleep: (durationMs: number, signal?: AbortSignal) => Promise<void>;
}

export interface ManagedAndroidEmulatorOptions {
  readonly tools: AndroidSdkTools;
  readonly signal?: AbortSignal;
  readonly confirmDownload: (packages: readonly string[]) => Promise<boolean>;
  readonly dependencies?: Partial<ManagedAndroidEmulatorDependencies>;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
}

async function runTool(
  command: string,
  arguments_: readonly string[],
  options: { readonly signal?: AbortSignal } = {},
): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }> {
  try {
    const result = await execFileAsync(command, [...arguments_], {
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const candidate = error as { readonly stdout?: string; readonly stderr?: string; readonly code?: number | string };
    return {
      stdout: candidate.stdout ?? "",
      stderr: candidate.stderr ?? (error instanceof Error ? error.message : String(error)),
      exitCode: typeof candidate.code === "number" ? candidate.code : 1,
    };
  }
}

async function runInteractiveTool(
  command: string,
  arguments_: readonly string[],
  options: { readonly signal?: AbortSignal } = {},
): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(command, [...arguments_], {
      stdio: "inherit",
      windowsHide: true,
    });
    const onAbort = (): void => child.kill();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", reject);
    child.once("close", (code) => {
      options.signal?.removeEventListener("abort", onAbort);
      resolve(code ?? 1);
    });
    if (options.signal?.aborted === true) onAbort();
  });
}

async function startEmulator(
  command: string,
  arguments_: readonly string[],
  options: { readonly signal?: AbortSignal } = {},
): Promise<ManagedEmulatorProcess> {
  const child = spawn(command, [...arguments_], {
    detached: false,
    stdio: "ignore",
    windowsHide: true,
  });
  const onAbort = (): void => child.kill();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return {
    pid: child.pid ?? null,
    async stop(): Promise<void> {
      options.signal?.removeEventListener("abort", onAbort);
      if (child.exitCode === null) child.kill();
    },
  };
}

async function waitForReady(adbPath: string, serial: string, signal?: AbortSignal): Promise<void> {
  const driver = new AndroidTvDriver({ adbPath, serial, ...(signal === undefined ? {} : { signal }) });
  try {
    await driver.waitForDeviceReady(180_000);
  } finally {
    await driver.close();
  }
}

async function sleep(durationMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) throw signal.reason ?? new Error("Managed Android setup was cancelled.");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, durationMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Managed Android setup was cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function parseDeviceSerials(output: string): readonly string[] {
  return output.split(/\r?\n/u)
    .slice(1)
    .map((line) => line.trim().split(/\s+/u))
    .filter((parts) => parts.length >= 2 && parts[1] === "device")
    .map((parts) => parts[0] ?? "")
    .filter((serial) => /^emulator-\d+$/u.test(serial));
}

function installedPackages(output: string): ReadonlySet<string> {
  const packages = new Set<string>();
  for (const line of output.split(/\r?\n/u)) {
    const packageName = line.split("|", 1)[0]?.trim() ?? "";
    if (packageName.length > 0) packages.add(packageName);
  }
  return packages;
}

function dependencies(
  overrides: Partial<ManagedAndroidEmulatorDependencies> | undefined,
): ManagedAndroidEmulatorDependencies {
  return {
    runTool,
    runInteractiveTool,
    startEmulator,
    waitForReady,
    sleep,
    ...overrides,
  };
}

export async function ensureManagedAndroidTvEmulator(
  options: ManagedAndroidEmulatorOptions,
): Promise<ManagedAndroidEmulatorHandle> {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  if (platform !== "win32" || architecture !== "x64") {
    throw new Error("TVDoctor managed Android TV is currently supported on Windows x64 hosts only.");
  }
  if (options.tools.sdkRoot === null) {
    throw new Error("TVDoctor managed Android TV requires a discoverable Android SDK root.");
  }
  if (options.tools.sdkManagerPath === null || options.tools.avdManagerPath === null) {
    throw new Error("Android SDK command-line tools are required to prepare the TVDoctor test device.");
  }

  const deps = dependencies(options.dependencies);
  const installedResult = await deps.runTool(options.tools.sdkManagerPath, ["--list_installed"], {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (installedResult.exitCode !== 0) {
    throw new Error(`TVDoctor could not inspect installed Android SDK packages: ${installedResult.stderr}`);
  }
  const installed = installedPackages(installedResult.stdout);
  const missing = [
    ...(installed.has("emulator") ? [] : ["emulator"]),
    ...(installed.has(MANAGED_ANDROID_SYSTEM_IMAGE) ? [] : [MANAGED_ANDROID_SYSTEM_IMAGE]),
  ];
  if (missing.length > 0) {
    if (!(await options.confirmDownload(missing))) {
      throw new Error("Android test-device download was declined.");
    }
    const code = await deps.runInteractiveTool(options.tools.sdkManagerPath, missing, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (code !== 0) {
      throw new Error("Android SDK package installation did not complete successfully. Review any licence or network message above.");
    }
  }

  const emulatorPath = options.tools.emulatorPath
    ?? join(options.tools.sdkRoot, "emulator", "emulator.exe");
  const avdResult = await deps.runTool(emulatorPath, ["-list-avds"], {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (avdResult.exitCode !== 0) {
    throw new Error(`TVDoctor could not list Android Virtual Devices: ${avdResult.stderr}`);
  }
  const avds = avdResult.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
  if (!avds.includes(MANAGED_ANDROID_AVD_NAME)) {
    const code = await deps.runInteractiveTool(options.tools.avdManagerPath, [
      "create", "avd",
      "-n", MANAGED_ANDROID_AVD_NAME,
      "-k", MANAGED_ANDROID_SYSTEM_IMAGE,
      "-d", "tv_1080p",
      "--force",
    ], {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (code !== 0) {
      throw new Error("TVDoctor could not create its Android TV test device. If avdmanager reports devices.xml/profile discovery problems, repair Android SDK command-line tools and retry.");
    }
  }

  const before = await deps.runTool(options.tools.adbPath, ["devices"], {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const beforeSerials = new Set(parseDeviceSerials(before.stdout));
  const emulator = await deps.startEmulator(emulatorPath, [
    "-avd", MANAGED_ANDROID_AVD_NAME,
    "-no-snapshot-save",
    "-no-window",
    "-gpu", "swiftshader_indirect",
    "-noaudio",
    "-no-boot-anim",
    "-no-metrics",
    "-camera-back", "none",
    "-camera-front", "none",
  ], {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  let serial: string | null = null;
  try {
    for (let attempt = 0; attempt < 360; attempt += 1) {
      options.signal?.throwIfAborted();
      const current = await deps.runTool(options.tools.adbPath, ["devices"], {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      serial = parseDeviceSerials(current.stdout).find((candidate) => !beforeSerials.has(candidate)) ?? null;
      if (serial !== null) break;
      await deps.sleep(500, options.signal);
    }
    if (serial === null) throw new Error("The TVDoctor Android TV emulator did not appear in ADB within three minutes.");
    await deps.waitForReady(options.tools.adbPath, serial, options.signal);
  } catch (error) {
    await emulator.stop().catch(() => undefined);
    throw error;
  }

  let stopped = false;
  return {
    serial,
    owned: true,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      await deps.runTool(options.tools.adbPath, ["-s", serial, "emu", "kill"], {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }).catch(() => ({ stdout: "", stderr: "", exitCode: 1 }));
      await emulator.stop().catch(() => undefined);
    },
  };
}
