import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  NavigationDiagnosticFinding,
  StartupPreparationResult,
} from "@tvdoctor/core";
import type {
  ArtifactDescriptor,
  TVDoctorIssue,
} from "@tvdoctor/protocol";
import {
  buildTVDoctorReportV1,
  aggregateReportJsonChunks,
  createArtifactStore,
  highestVerifiedSeverity,
  stableJson,
  writeReportBundle,
  type ArtifactStore,
  type JsonValue,
  type ReportBundleOptions,
} from "@tvdoctor/reporters";
import type {
  TestCommandRequest,
  TestCommandResult,
} from "./cli.js";
import { selectedPacks } from "./node-audit-selection.js";
import { CLI_VERSION } from "./version.js";

export function highestSeverity(issues: readonly TVDoctorIssue[]): TestCommandResult["highestSeverity"] {
  const order = ["critical", "high", "medium", "low", "info"] as const;
  return order.find((severity) => issues.some((issue) => issue.severity === severity)) ?? null;
}

export function targetRequiresReplayOverride(target: string): boolean {
  const parsed = new URL(target);
  return parsed.search.length > 0 || parsed.hash.length > 0;
}

export function publicTargetLocation(request: Pick<TestCommandRequest, "target" | "targetRedaction">): string {
  if (request.targetRedaction !== "origin") return request.target;
  return new URL(request.target).origin;
}

type FailedRunCode =
  | "network-unreachable"
  | "browser-runtime-unavailable"
  | "filesystem-access"
  | "browser-session-failed";

function classifyFailedRun(error: unknown): { readonly code: FailedRunCode; readonly summary: string } {
  const raw = error instanceof Error ? error.message : String(error);
  if (/page\.goto|net::|ERR_(?:CONNECTION|NAME|TIMED)|ECONNREFUSED|ENOTFOUND/iu.test(raw)) {
    return {
      code: "network-unreachable",
      summary: "The website could not be reached. Check the address and network connection.",
    };
  }
  if (/executable.*doesn.t exist|browser.*(?:not found|missing)|playwright.*install/iu.test(raw)) {
    return {
      code: "browser-runtime-unavailable",
      summary: "Chromium is unavailable for web testing.",
    };
  }
  if (/EACCES|EPERM|ENOENT/iu.test(raw)) {
    return {
      code: "filesystem-access",
      summary: "TVDoctor could not access a required file or folder.",
    };
  }
  return {
    code: "browser-session-failed",
    summary: "TVDoctor could not complete this scan because the browser session failed.",
  };
}

/** Exclusively reserve a new output leaf before constructing a browser. */
export async function reserveAuditOutput(outputPath: string): Promise<ArtifactStore> {
  const absoluteOutput = resolve(outputPath);
  await mkdir(dirname(absoluteOutput), { recursive: true });
  await mkdir(absoluteOutput);
  return await createArtifactStore(absoluteOutput);
}

export async function writeFailedRunReport(
  store: ArtifactStore,
  request: TestCommandRequest,
  startedAt: Date,
  error: unknown,
  bundleOptions: Pick<ReportBundleOptions, "htmlSidecars"> = {},
): Promise<TestCommandResult> {
  const failure = classifyFailedRun(error);
  await store.writeBundleFile(
    "failure-debug.json",
    `${stableJson({ schemaVersion: 1, code: failure.code, summary: failure.summary })}\n`,
  );
  const completedAt = new Date();
  const report = buildTVDoctorReportV1({
    run: {
      id: `failed-${startedAt.getTime().toString(36)}`,
      tvdoctorVersion: CLI_VERSION,
      mode: request.mode,
      status: "failed",
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
    },
    target: {
      name: request.targetName ?? new URL(request.target).hostname,
      platform: "web",
      location: publicTargetLocation(request),
      environment: { browser: "chromium", failure: failure.summary },
    },
    coverage: {
      screenStatesDiscovered: 0,
      focusStatesDiscovered: 0,
      transitionsTested: 0,
      actionsSent: 0,
      capabilitiesObserved: [],
      packs: [...selectedPacks(request)].map((pack) => ({ pack, status: "skipped" as const })),
      budget: {
        maxActions: null,
        maxStates: null,
        maxDepth: null,
        maxDurationMs: null,
        maxRepetitiveItems: null,
        exhausted: [],
      },
    },
    issues: [],
    artifacts: [],
    replays: [],
  });
  const bundle = await writeReportBundle(
    store,
    report,
    {
      ...bundleOptions,
      ...(request.ciFailOn === undefined ? {} : { ci: { failOn: request.ciFailOn } }),
    },
  );
  return {
    status: "failed",
    issueCount: 0,
    highestSeverity: null,
    highestVerifiedSeverity: null,
    reportPath: bundle.reportJson.absolutePath,
    details: [
      "The scan could not complete.",
      failure.summary,
      "A bounded failure classification was retained in failure-debug.json.",
      `Report: ${bundle.reportHtml.absolutePath}`,
    ],
  };
}

export async function writeSetupNotStartedReport(
  store: ArtifactStore,
  request: TestCommandRequest,
  startedAt: Date,
  startup: StartupPreparationResult,
  findings: readonly NavigationDiagnosticFinding[],
  bundleOptions: Pick<ReportBundleOptions, "htmlSidecars"> = {},
): Promise<TestCommandResult> {
  const blocker = startup.blockers[0];
  const labels: Readonly<Record<string, string>> = {
    "consent-wall": "cookie consent screen",
    onboarding: "onboarding screen",
    login: "login screen",
    "region-selection": "region selection screen",
    "age-gate": "age gate",
    "system-setup": "setup screen",
  };
  const label = blocker === undefined ? "startup setup screen" : labels[blocker.kind] ?? blocker.kind;
  const completedAt = new Date();
  const issues = findings.map((finding) => finding.issue);
  const report = buildTVDoctorReportV1({
    run: {
      id: `setup-${startedAt.getTime().toString(36)}`,
      tvdoctorVersion: CLI_VERSION,
      mode: request.mode,
      status: startup.status === "setup-blocker" ? "partial" : "failed",
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
    },
    target: {
      name: request.targetName ?? new URL(request.target).hostname,
      platform: "web",
      location: publicTargetLocation(request),
      environment: { browser: "chromium", outcome: "scan-not-started" },
    },
    coverage: {
      screenStatesDiscovered: 0,
      focusStatesDiscovered: 0,
      transitionsTested: 0,
      actionsSent: 0,
      capabilitiesObserved: [],
      packs: [...selectedPacks(request)].map((pack) => ({
        pack,
        status: pack === "navigation" ? "partial" as const : "skipped" as const,
      })),
      budget: {
        maxActions: null,
        maxStates: null,
        maxDepth: null,
        maxDurationMs: null,
        maxRepetitiveItems: null,
        exhausted: [],
      },
    },
    issues,
    artifacts: [],
    replays: [],
  });
  const bundle = await writeReportBundle(
    store,
    report,
    {
      ...bundleOptions,
      ...(request.ciFailOn === undefined ? {} : { ci: { failOn: request.ciFailOn } }),
    },
  );
  const changedNothing = startup.status === "setup-blocker";
  return {
    status: startup.status === "setup-blocker" ? "partial" : "failed",
    issueCount: issues.length,
    highestSeverity: highestSeverity(issues),
    highestVerifiedSeverity: highestVerifiedSeverity(issues),
    reportPath: bundle.reportJson.absolutePath,
    details: [
      `The scan was not started because TVDoctor found a ${label}.`,
      changedNothing
        ? "No consent or persistent state was changed."
        : "TVDoctor could not safely complete the selected setup choice.",
      `Report: ${bundle.reportHtml.absolutePath}`,
    ],
  };
}

export async function writeAuditAuxiliaryArtifacts(
  store: ArtifactStore,
  ledgerValue: JsonValue,
  inventoryValue: JsonValue,
): Promise<readonly ArtifactDescriptor[]> {
  const ledgerFile = await store.writeBundleFileStream(
    "stage-ledger.json", aggregateReportJsonChunks(ledgerValue),
  );
  const inventoryFile = await store.writeBundleFileStream(
    "inventory.json", aggregateReportJsonChunks(inventoryValue),
  );
  return [
    {
      id: "run:stage-ledger",
      kind: "report",
      status: "available",
      path: "stage-ledger.json",
      mediaType: "application/json",
      byteLength: ledgerFile.byteLength,
      sha256: ledgerFile.sha256,
    },
    {
      id: "run:inventory",
      kind: "report",
      status: "available",
      path: "inventory.json",
      mediaType: "application/json",
      byteLength: inventoryFile.byteLength,
      sha256: inventoryFile.sha256,
    },
  ];
}
