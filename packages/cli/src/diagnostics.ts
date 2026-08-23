export const SUPPORTED_NODE_MAJOR = 24;

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
  readonly ai: DiagnosticCheck;
}

function nodeMajor(version: string): number | undefined {
  const match = /^v?(\d+)(?:\.|$)/u.exec(version);
  const majorText = match?.[1];

  if (majorText === undefined) {
    return undefined;
  }

  const major = Number.parseInt(majorText, 10);
  return Number.isNaN(major) ? undefined : major;
}

export function diagnoseEnvironment(
  environment: RuntimeEnvironment,
): DoctorReport {
  const major = nodeMajor(environment.nodeVersion);
  const runtimeSupported = major === SUPPORTED_NODE_MAJOR;
  const runtimeDetail = runtimeSupported
    ? `${environment.nodeVersion} (supported)`
    : `${environment.nodeVersion} (unsupported; requires >=24.0.0 <25)`;

  return {
    project: {
      status: "ok",
      detail: "Milestone 6 semantic streaming and player pack (experimental)",
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
      status: "ok",
      detail: "Playwright web adapter (experimental library)",
    },
    audits: {
      status: "unavailable",
      detail: "CLI audit orchestration is not implemented",
    },
    ai: {
      status: "ok",
      detail: "not required",
    },
  };
}

export function doctorSucceeded(report: DoctorReport): boolean {
  return report.runtime.status === "ok";
}

export function renderDoctorReport(report: DoctorReport): string {
  const rows: readonly (readonly [string, DiagnosticCheck])[] = [
    ["Project", report.project],
    ["Node.js", report.runtime],
    ["Host", report.host],
    ["Platform drivers", report.drivers],
    ["Runnable audits", report.audits],
    ["AI/API key", report.ai],
  ];

  const renderedRows = rows.map(
    ([label, check]) => `${label}: ${check.detail} [${check.status}]`,
  );

  return [
    "TVDoctor environment diagnosis",
    "",
    ...renderedRows,
    "",
    "Experimental web-library support only; no production TV platform support is claimed.",
  ].join("\n");
}
