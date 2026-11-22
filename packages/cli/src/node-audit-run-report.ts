import type { ExplorationRestorationMode } from "@tvdoctor/core";
import type { WebDriverPerformanceProfile } from "@tvdoctor/driver-web";
import type { StreamingSettingsRouteResult } from "@tvdoctor/pack-streaming";
import type { Capability, TVDoctorReportV1 } from "@tvdoctor/protocol";
import type { JsonValue } from "@tvdoctor/reporters";
import type { TestCommandRequest } from "./cli.js";
import type { JourneyExecutionResult, JourneyV1 } from "./journey.js";
import type { AuditRunProducts } from "./node-audit-contracts.js";
import { publicTargetLocation } from "./node-audit-output.js";
import { exhaustedBudgets } from "./node-audit-selection.js";

interface AuditReportState {
  readonly request: TestCommandRequest;
  readonly products: AuditRunProducts;
  readonly packs: ReadonlySet<string>;
  readonly settingsRouteDiscovery: StreamingSettingsRouteResult | null;
  readonly journeyExecution: JourneyExecutionResult | null;
}

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function auditStageLedger({
  request, products, packs, settingsRouteDiscovery, journeyExecution,
  navigationRestorationMode, navigationDriverPerformance, journey,
  navigationExplorationMs, startupPreparationMs, navigationDiagnosticsMs, evidenceGenerationMs,
}: AuditReportState & {
  readonly navigationRestorationMode: ExplorationRestorationMode;
  readonly navigationDriverPerformance: WebDriverPerformanceProfile | null;
  readonly journey: JourneyV1 | null;
  readonly navigationExplorationMs: number;
  readonly startupPreparationMs: number;
  readonly navigationDiagnosticsMs: number;
  readonly evidenceGenerationMs: number;
}): JsonValue {
  const { navigation, navigationStartup, navigationFindings, streaming, web } = products;
  return asJson({
    schemaVersion: 1,
    target: publicTargetLocation(request),
    mode: request.mode,
    ...(request.inputMode === "keyboard" ? { inputMode: "keyboard" } : {}),
    selectedPacks: [...packs],
    navigationRestorationMode: packs.has("navigation") ? navigationRestorationMode : null,
    fixtureProfileSelectionEnabled: request.fixtureProfileSelection === true,
    startupPreparation: navigationStartup == null ? null : {
      status: navigationStartup.status,
      policy: navigationStartup.policy.kind,
      actions: navigationStartup.policy.kind === "remote-sequence" ? [...navigationStartup.policy.actions] : [],
      identityHash: navigationStartup.identityHash,
      blockers: navigationStartup.blockers,
      controls: navigationStartup.controls,
      steps: navigationStartup.steps,
    },
    journey: journey === null ? null : {
      schemaVersion: journey.schemaVersion,
      name: journey.name,
      sha256: journey.sha256,
      steps: journey.steps.map((step) => step.action === "type-from-env"
        ? { action: step.action, source: "environment" }
        : step),
      execution: journeyExecution,
    },
    timings: {
      navigationExplorationMs,
      startupPreparationMs,
      navigationDiagnosticsMs,
      evidenceGenerationMs,
    },
    navigationDriverPerformance,
    navigation: navigation === null ? null : { termination: navigation.termination, statistics: navigation.statistics },
    navigationFindings: navigationFindings.map((finding) => ({ id: finding.issue.id, rule: finding.issue.rule, classification: finding.classification })),
    streaming: streaming === null ? null : { status: streaming.status, termination: streaming.termination, statistics: streaming.statistics, stages: streaming.stages },
    settingsRouteDiscovery: settingsRouteDiscovery === null ? null : {
      status: settingsRouteDiscovery.status,
      detail: settingsRouteDiscovery.detail,
      sequence: settingsRouteDiscovery.sequence ?? null,
      statistics: settingsRouteDiscovery.statistics,
    },
    web: web === null ? null : { status: web.status, termination: web.termination, statistics: web.statistics, stages: web.stages },
  });
}

export function auditReportCoverage({
  request, products, packs, settingsRouteDiscovery, journeyExecution, capabilities, coverage,
}: AuditReportState & {
  readonly capabilities: ReadonlySet<Capability>;
  readonly coverage: TVDoctorReportV1["coverage"]["packs"];
}): TVDoctorReportV1["coverage"] {
  const { navigation, streaming, web } = products;
  return {
    screenStatesDiscovered: navigation?.statistics.screenStates ?? 0,
    focusStatesDiscovered: navigation?.statistics.focusStates
      ?? (streaming?.statistics.uniqueStates ?? settingsRouteDiscovery?.statistics.uniqueStates ?? 0)
        + (web?.statistics.uniqueStates ?? 0),
    transitionsTested: navigation?.graph.actions.length ?? 0,
    actionsSent: (journeyExecution?.actions ?? 0)
      + (navigation?.statistics.physicalActions ?? 0)
      + (streaming?.statistics.physicalActions ?? settingsRouteDiscovery?.statistics.physicalActions ?? 0)
      + (web?.statistics.physicalActions ?? 0),
    capabilitiesObserved: [...capabilities],
    packs: coverage,
    budget: {
      maxActions: (journeyExecution?.maxActions ?? 0)
        + (navigation?.budgets.maxActions ?? 0)
        + (streaming?.budgets.maxActions ?? settingsRouteDiscovery?.budgets.maxActions ?? 0)
        + (web?.budgets.maxActions ?? 0),
      maxStates: (navigation?.budgets.maxStates ?? 0)
        + (streaming?.budgets.maxStates ?? settingsRouteDiscovery?.budgets.maxStates ?? 0)
        + (web?.budgets.maxStates ?? 0),
      maxDepth: Math.max(
        navigation?.budgets.maxDepth ?? 0,
        streaming?.budgets.maxLocalDepth ?? settingsRouteDiscovery?.budgets.maxLocalDepth ?? 0,
        web?.budgets.maxLocalDepth ?? 0,
      ),
      maxDurationMs: (journeyExecution?.maxDurationMs ?? 0)
        + (navigation?.budgets.maxDurationMs ?? 0)
        + (streaming?.budgets.maxDurationMs ?? settingsRouteDiscovery?.budgets.maxDurationMs ?? 0)
        + (web?.budgets.maxDurationMs ?? 0),
      // The source-checkout scan command disables repetition compression.
      // Do not report the profile's compression allowance as an active cap.
      maxRepetitiveItems: request.disableRepetitionCompression === true
        ? null
        : request.mode === "quick" ? 1 : request.mode === "standard" ? 2 : 4,
      exhausted: exhaustedBudgets(products, packs),
    },
  };
}
