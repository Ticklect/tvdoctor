import {
  NodeAdbCommandExecutor,
  type AdbCommandExecutor,
} from "@tvdoctor/driver-android";

const SERIAL_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;
const PACKAGE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u;
const OBSERVER_COMPONENT = "org.tvdoctor.observer/org.tvdoctor.observer.ObserverAccessibilityService";

export interface AndroidAdbTarget {
  readonly adbPath: string;
  readonly serial: string;
  readonly signal?: AbortSignal;
}

export interface AndroidPackageQuery extends AndroidAdbTarget {
  readonly packageName: string;
}

function executorFor(
  adbPath: string,
  injected?: AdbCommandExecutor,
): AdbCommandExecutor {
  return injected ?? new NodeAdbCommandExecutor(adbPath);
}

function validateTarget(target: AndroidAdbTarget): void {
  if (!SERIAL_PATTERN.test(target.serial)) throw new TypeError("Android device serial is invalid.");
  if (target.adbPath.trim().length === 0 || target.adbPath.includes("\0")) {
    throw new TypeError("adbPath must be a non-empty executable path.");
  }
}

export async function androidPackageInstalled(
  request: AndroidPackageQuery,
  executor?: AdbCommandExecutor,
): Promise<boolean> {
  validateTarget(request);
  if (!PACKAGE_PATTERN.test(request.packageName)) throw new TypeError("Android package name is invalid.");
  const result = await executorFor(request.adbPath, executor).execute([
    "-s", request.serial, "shell", "pm", "path", request.packageName,
  ], {
    timeoutMs: 10_000,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
  if (result.exitCode !== 0) return false;
  return Buffer.from(result.stdout).toString("utf8").trim().startsWith("package:");
}

export async function openObserverSetup(
  request: AndroidAdbTarget,
  executor?: AdbCommandExecutor,
): Promise<void> {
  validateTarget(request);
  const result = await executorFor(request.adbPath, executor).execute([
    "-s", request.serial, "shell", "am", "start", "-n",
    "org.tvdoctor.observer/.SetupActivity",
  ], {
    timeoutMs: 10_000,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
  if (result.exitCode !== 0) throw new Error("TVDoctor could not open Observer setup on the Android device.");
}

export async function observerAccessibilityEnabled(
  request: AndroidAdbTarget,
  executor?: AdbCommandExecutor,
): Promise<boolean> {
  validateTarget(request);
  const result = await executorFor(request.adbPath, executor).execute([
    "-s", request.serial, "shell", "settings", "get", "secure",
    "enabled_accessibility_services",
  ], {
    timeoutMs: 10_000,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
  if (result.exitCode !== 0) return false;
  const services = Buffer.from(result.stdout).toString("utf8")
    .trim()
    .split(":")
    .map((service) => service.trim().toLowerCase())
    .filter(Boolean);
  return services.includes(OBSERVER_COMPONENT.toLowerCase());
}
