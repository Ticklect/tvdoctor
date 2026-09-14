import { access, constants, readdir } from "node:fs/promises";
import { delimiter, join } from "node:path";
import process from "node:process";

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
  readonly platform?: NodeJS.Platform;
  readonly exists?: (path: string) => Promise<boolean>;
  readonly resolveFromPath?: (name: string) => Promise<string | null>;
  readonly listDirectories?: (path: string) => Promise<readonly string[]>;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function directories(path: string): Promise<readonly string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function resolveExecutableFromPath(
  name: string,
  environment: NodeJS.ProcessEnv,
  exists: (path: string) => Promise<boolean>,
): Promise<string | null> {
  for (const directory of (environment["PATH"] ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name);
    if (await exists(candidate)) return candidate;
  }
  return null;
}

async function firstExisting(
  candidates: readonly string[],
  exists: (path: string) => Promise<boolean>,
): Promise<string | null> {
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

export async function locateAndroidSdkTools(
  options: AndroidSdkLocatorOptions = {},
): Promise<AndroidSdkTools> {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? pathExists;
  const listDirectories = options.listDirectories ?? directories;
  const executable = (windows: string, unix: string): string => platform === "win32" ? windows : unix;

  const sdkRoot = environment["ANDROID_SDK_ROOT"]?.trim()
    || environment["ANDROID_HOME"]?.trim()
    || (platform === "win32" && environment["LOCALAPPDATA"]?.trim()
      ? join(environment["LOCALAPPDATA"], "Android", "Sdk")
      : null);

  const resolveFromPath = options.resolveFromPath
    ?? (async (name: string) => await resolveExecutableFromPath(name, environment, exists));

  const adbName = executable("adb.exe", "adb");
  const aapt2Name = executable("aapt2.exe", "aapt2");
  const aaptName = executable("aapt.exe", "aapt");
  const emulatorName = executable("emulator.exe", "emulator");
  const sdkManagerName = executable("sdkmanager.bat", "sdkmanager");
  const avdManagerName = executable("avdmanager.bat", "avdmanager");

  const rootAdb = sdkRoot === null ? null : join(sdkRoot, "platform-tools", adbName);
  const adbPath = options.explicitAdbPath !== undefined && await exists(options.explicitAdbPath)
    ? options.explicitAdbPath
    : rootAdb !== null && await exists(rootAdb)
      ? rootAdb
      : await resolveFromPath(adbName) ?? adbName;

  let aaptPath: string | null = null;
  if (sdkRoot !== null) {
    const buildTools = [...await listDirectories(join(sdkRoot, "build-tools"))]
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
    for (const version of buildTools) {
      aaptPath = await firstExisting([
        join(sdkRoot, "build-tools", version, aapt2Name),
        join(sdkRoot, "build-tools", version, aaptName),
      ], exists);
      if (aaptPath !== null) break;
    }
  }
  aaptPath ??= await resolveFromPath(aapt2Name) ?? await resolveFromPath(aaptName);

  const emulatorPath = sdkRoot === null
    ? await resolveFromPath(emulatorName)
    : await firstExisting([join(sdkRoot, "emulator", emulatorName)], exists)
      ?? await resolveFromPath(emulatorName);

  const commandLineCandidates = (tool: string): readonly string[] => sdkRoot === null ? [] : [
    join(sdkRoot, "cmdline-tools", "latest", "bin", tool),
    join(sdkRoot, "tools", "bin", tool),
  ];
  const sdkManagerPath = await firstExisting(commandLineCandidates(sdkManagerName), exists)
    ?? await resolveFromPath(sdkManagerName);
  const avdManagerPath = await firstExisting(commandLineCandidates(avdManagerName), exists)
    ?? await resolveFromPath(avdManagerName);

  return {
    sdkRoot,
    adbPath,
    aaptPath,
    emulatorPath,
    sdkManagerPath,
    avdManagerPath,
  };
}
