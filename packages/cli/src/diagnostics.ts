export const SUPPORTED_NODE_RANGE = ">=22.13.0 <23 || >=24.0.0 <25";

export type DiagnosticStatus = "ok" | "unsupported" | "unavailable";

export interface RuntimeEnvironment {
  readonly nodeVersion: string;
  readonly platform: string;
  readonly architecture: string;
}

export interface DiagnosticCheck {
  readonly status: DiagnosticStatus;
  readonly detail: string;
}

export interface DoctorReport {
  readonly project: DiagnosticCheck;
  readonly runtime: DiagnosticCheck;
  readonly host: DiagnosticCheck;
  readonly drivers: DiagnosticCheck;
  readonly audits: DiagnosticCheck;
  readonly androidAdb: DiagnosticCheck;
  readonly androidBuildTools: DiagnosticCheck;
  readonly androidDevice: DiagnosticCheck;
  readonly androidObserver: DiagnosticCheck;
  readonly android: DiagnosticCheck;
  readonly ai: DiagnosticCheck;
}

export interface AndroidEnvironmentCapabilities {
  readonly adb: DiagnosticCheck;
  readonly buildTools: DiagnosticCheck;
  readonly device: DiagnosticCheck;
  readonly observer: DiagnosticCheck;
}

export interface EnvironmentCapabilities {
  readonly auditOrchestrationAvailable: boolean;
  readonly browser: DiagnosticCheck;
  readonly androidAuditOrchestrationAvailable?: boolean;
  readonly android?: AndroidEnvironmentCapabilities;
}

function nodeVersionParts(version: string): readonly [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(version);
  if (match === null) return undefined;
  const values = match.slice(1, 4).map((part) => Number.parseInt(part, 10));
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) return undefined;
  const [major, minor, patch] = values;
  return major === undefined || minor === undefined || patch === undefined
    ? undefined
    : [major, minor, patch];
}

export function isSupportedNodeVersion(version: string): boolean {
  const parts = nodeVersionParts(version);
  if (parts === undefined) return false;
  const [major, minor] = parts;
  return major === 24 || (major === 22 && minor >= 13);
}

function unavailable(detail: string): DiagnosticCheck {
  return { status: "unavailable", detail };
}

function androidSummary(
  android: AndroidEnvironmentCapabilities,
  webReady: boolean,
  auditOrchestrationAvailable: boolean,
): DiagnosticCheck {
  const checks = [android.adb, android.buildTools, android.device, android.observer];
  if (checks.every((check) => check.status === "ok")) {
    return auditOrchestrationAvailable
      ? { status: "ok", detail: "ready" }
      : { status: "unavailable", detail: "audit operation unavailable in this host" };
  }
  const firstBlocker = checks.find((check) => check.status !== "ok");
  return {
    status: firstBlocker?.status ?? "unavailable",
    detail: webReady
      ? "not configured; web audits are still ready"
      : "not configured",
  };
}

export function diagnoseEnvironment(
  environment: RuntimeEnvironment,
  capabilities: EnvironmentCapabilities = {
    auditOrchestrationAvailable: false,
    browser: {
      status: "unavailable",
      detail: "Browser runtime was not probed",
    },
  },
): DoctorReport {
  const runtimeSupported = isSupportedNodeVersion(environment.nodeVersion);
  const runtimeDetail = runtimeSupported
    ? `${environment.nodeVersion} (supported)`
    : `${environment.nodeVersion} (unsupported; requires ${SUPPORTED_NODE_RANGE})`;
  const android = capabilities.android ?? {
    adb: unavailable("Android platform-tools (ADB) were not probed."),
    buildTools: unavailable("Android SDK build-tools (aapt2/aapt) were not probed."),
    device: unavailable("No Android TV device was probed."),
    observer: unavailable("TVDoctor Observer accessibility readiness was not probed."),
  };
  const webReady = capabilities.browser.status === "ok" && capabilities.auditOrchestrationAvailable;

  return {
    project: {
      status: "ok",
      detail: "TVDoctor command-line audit",
    },
    runtime: {
      status: runtimeSupported ? "ok" : "unsupported",
      detail: runtimeDetail,
    },
    host: {
      status: "ok",
      detail: `${environment.platform} ${environment.architecture}`,
    },
    drivers: {
      status: capabilities.browser.status,
      detail: capabilities.browser.detail,
    },
    audits: {
      status: capabilities.auditOrchestrationAvailable ? "ok" : "unavailable",
      detail: capabilities.auditOrchestrationAvailable
        ? "ready"
        : "unavailable in this host",
    },
    androidAdb: android.adb,
    androidBuildTools: android.buildTools,
    androidDevice: android.device,
    androidObserver: android.observer,
    android: androidSummary(
      android,
      webReady,
      capabilities.androidAuditOrchestrationAvailable === true,
    ),
    ai: {
      status: "ok",
      detail: "not required",
    },
  };
}

export function doctorSucceeded(report: DoctorReport): boolean {
  return report.runtime.status === "ok"
    && ((report.drivers.status === "ok" && report.audits.status === "ok")
      || report.android.status === "ok");
}

export function renderDoctorReport(report: DoctorReport): string {
  const rows: readonly (readonly [string, DiagnosticCheck])[] = [
    ["Project", report.project],
    ["Node.js", report.runtime],
    ["Host", report.host],
    ["Web / Chromium", report.drivers],
    ["Web audits", report.audits],
    ["Android ADB", report.androidAdb],
    ["Android build-tools", report.androidBuildTools],
    ["Android device", report.androidDevice],
    ["Android Observer", report.androidObserver],
    ["Android TV", report.android],
    ["AI/API key", report.ai],
  ];

  const renderedRows = rows.map(
    ([label, check]) => `${label}: ${check.detail} [${check.status}]`,
  );

  const webCheck = report.runtime.status !== "ok"
    ? report.runtime
    : report.drivers.status !== "ok"
      ? report.drivers
      : report.audits.status !== "ok"
        ? report.audits
        : report.drivers;
  const androidCheck = report.runtime.status !== "ok" ? report.runtime : report.android;
  const surfaceRows: readonly (readonly [string, DiagnosticCheck])[] = [
    ["Web", webCheck],
    ["Android TV", androidCheck],
  ];
  const surfaceStatus = (check: DiagnosticCheck): string => (
    check.status === "ok" ? "READY" : check.status.toUpperCase()
  );
  const matrix = [
    "Surface    Status       Detail",
    ...surfaceRows.map(([surface, check]) => (
      `${surface.padEnd(11)}${surfaceStatus(check).padEnd(13)}${check.detail}`
    )),
  ];
  const remediationRows = rows
    .filter(([, check]) => check.status !== "ok")
    .map(([label, check]) => `- ${label}: ${check.detail}`);

  return [
    "TVDoctor environment diagnosis",
    "",
    ...matrix,
    ...(remediationRows.length === 0
      ? []
      : ["", "Remediation", ...remediationRows]),
    "",
    "Detailed checks",
    ...renderedRows,
    "",
    "Android TV is optional for web-only use. A surface is ready only when every prerequisite shown for that surface is ready.",
    "Doctor checks this host and connected devices only; target application availability is verified when an audit starts.",
  ].join("\n");
}
