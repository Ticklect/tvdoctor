import { describe, expect, it } from "vitest";

import {
  diagnoseEnvironment,
  renderDoctorReport,
  type DoctorReport,
} from "../src/diagnostics.js";

describe("doctor report presentation", () => {
  it("renders a compact no-color Web / Android TV readiness matrix", () => {
    const report = diagnoseEnvironment(
      { nodeVersion: "v24.18.0", platform: "win32", architecture: "x64" },
      {
        auditOrchestrationAvailable: true,
        browser: { status: "ok", detail: "Chromium ready" },
        androidAuditOrchestrationAvailable: false,
        android: {
          adb: { status: "unavailable", detail: "Android platform-tools (ADB) were not found. Install Android SDK platform-tools." },
          buildTools: { status: "unavailable", detail: "Android SDK build-tools were not found. Install Android SDK build-tools." },
          device: { status: "unavailable", detail: "No authorized Android TV device is online." },
          observer: { status: "unavailable", detail: "Observer was not probed." },
        },
      },
    );
    const rendered = renderDoctorReport(report);

    expect(rendered).toContain("Surface    Status       Detail");
    expect(rendered).toContain("Web        READY        Chromium ready");
    expect(rendered).toContain("Android TV UNAVAILABLE  not configured; web audits are still ready");
    expect(rendered).toContain("Remediation");
    expect(rendered).toContain("Android ADB: Android platform-tools (ADB) were not found. Install Android SDK platform-tools.");
    expect(rendered).not.toContain(String.fromCharCode(27));
  });

  it("puts exact blocker remediation below the matrix", () => {
    const report: DoctorReport = {
      project: { status: "ok", detail: "TVDoctor command-line audit" },
      runtime: { status: "unsupported", detail: "v23.0.0 (unsupported; requires supported range)" },
      host: { status: "ok", detail: "win32 x64" },
      drivers: { status: "unavailable", detail: "Chromium is unavailable. Run \"tvdoctor setup\" and try again." },
      audits: { status: "ok", detail: "ready" },
      androidAdb: { status: "ok", detail: "ADB ready" },
      androidBuildTools: { status: "ok", detail: "aapt2 ready" },
      androidDevice: { status: "ok", detail: "Google TV" },
      androidObserver: { status: "ok", detail: "Observer ready" },
      android: { status: "ok", detail: "ready" },
      ai: { status: "ok", detail: "not required" },
    };

    const rendered = renderDoctorReport(report);
    expect(rendered).toContain("Web        UNSUPPORTED  v23.0.0 (unsupported; requires supported range)");
    expect(rendered).toContain("Android TV UNSUPPORTED  v23.0.0 (unsupported; requires supported range)");
    expect(rendered).toContain("- Node.js: v23.0.0 (unsupported; requires supported range)");
    expect(rendered).toContain("- Web / Chromium: Chromium is unavailable. Run \"tvdoctor setup\" and try again.");
  });
});
