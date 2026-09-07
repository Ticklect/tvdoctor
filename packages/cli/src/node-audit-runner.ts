import {
  createStartupBlockerFinding,
  diagnoseNavigation,
  explore,
  prepareStartup,
  type ExplorationResult,
  type NavigationDiagnosticFinding,
  type StartupPreparationResult,
} from "@tvdoctor/core";
import type {
  PlaywrightWebDriver,
  WebDriverPerformanceProfile,
} from "@tvdoctor/driver-web";
import {
  runStreamingPack,
  type StreamingPackResult,
} from "@tvdoctor/pack-streaming";
import {
  runWebPack,
  type WebPackResult,
} from "@tvdoctor/pack-web";
import type { Capability, RemoteKey } from "@tvdoctor/protocol";
import {
  buildTVDoctorReportV1,
  writeReportBundle,
  type JsonValue,
} from "@tvdoctor/reporters";
import type {
  TestCommandRequest,
  TestCommandResult,
} from "./cli.js";
import {
  REPLAY_TARGET_OVERRIDE_ENVIRONMENT_KEY,
  REPLAY_TARGET_OVERRIDE_REQUIRED,
  STREAMING_BUDGETS,
  WEB_BUDGETS,
  type AuditRunProducts,
} from "./node-audit-contracts.js";
import {
  captureIssue,
  captureIssuesWithinBudget,
} from "./node-audit-evidence.js";
import {
  createSafeExplorationDriver,
  navigationInventory,
  preferredStartupControl,
  specialisedReachabilityScreen,
  startupActivationSequence,
} from "./node-audit-navigation.js";
import {
  highestSeverity,
  reserveAuditOutput,
  targetRequiresReplayOverride,
  writeAuditAuxiliaryArtifacts,
  writeFailedRunReport,
  writeSetupNotStartedReport,
} from "./node-audit-output.js";
import {
  exhaustedBudgets,
  packCoverage,
  partialRunDetails,
  selectedPacks,
  selectedWebStages,
  streamingSettingsSequence,
} from "./node-audit-selection.js";
import {
  createStreamingAuditPointerProbe,
  createWebAuditHooks,
} from "./web-audit-hooks.js";
import { CLI_VERSION } from "./version.js";

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export async function runAudit(
  request: TestCommandRequest,
  createDriver: () => PlaywrightWebDriver,
): Promise<TestCommandResult> {
  const store = await reserveAuditOutput(request.outputPath);
  const startedAt = new Date();
  const packs = selectedPacks(request);
  const webStages = selectedWebStages(packs);
  const needStreamingJourney = packs.has("streaming") || webStages.includes("layout") || webStages.includes("performance");
  const driver = createDriver();
  let capabilities: ReadonlySet<Capability> = new Set();
  let navigation: ExplorationResult | null = null;
  let navigationFindings: readonly NavigationDiagnosticFinding[] = [];
  let navigationStartup: StartupPreparationResult | null = null;
  let startupFindings: readonly NavigationDiagnosticFinding[] = [];
  let startupPreparationMs = 0;
  let navigationDriverPerformance: WebDriverPerformanceProfile | null = null;
  let navigationExplorationMs = 0;
  let navigationDiagnosticsMs = 0;
  let streaming: StreamingPackResult | null = null;
  let web: WebPackResult | null = null;
  let runFailure: { readonly error: unknown } | null = null;
  try {
    await driver.launch({ id: "cli-web-audit", launchUri: request.target });
    capabilities = await driver.capabilities();
    if (packs.has("navigation")) {
      const preparationStartedAt = performance.now();
      navigationStartup = await prepareStartup(driver, {
        policy: request.startupActions === undefined
          ? { kind: "observe" }
          : { kind: "remote-sequence", actions: request.startupActions as RemoteKey[] },
        resetStrategy: "reload",
        stability: request.mode === "quick"
          ? { maxSnapshots: 4, requiredStableSnapshots: 2, pollIntervalMs: 100, timeoutMs: 8_000 }
          : { maxSnapshots: 8, requiredStableSnapshots: 2, pollIntervalMs: 200, timeoutMs: 20_000 },
      });
      startupPreparationMs = Math.max(0, performance.now() - preparationStartedAt);
      if (
        request.startupDecision !== undefined
        && navigationStartup.status === "setup-blocker"
        && navigationStartup.blockers[0] !== undefined
      ) {
        const blocker = navigationStartup.blockers[0];
        if (blocker === undefined) throw new TypeError("Startup blocker disappeared before preparation.");
        const control = preferredStartupControl(
          request.startupDecision,
          blocker.kind,
          navigationStartup.controls,
        );
        const actions = control === null ? [] : startupActivationSequence(
          navigationStartup.controls,
          control,
        );
        navigationStartup = await prepareStartup(driver, {
          policy: { kind: "remote-sequence", actions },
          resetStrategy: "reload",
          stability: request.mode === "quick"
            ? { maxSnapshots: 4, requiredStableSnapshots: 2, pollIntervalMs: 100, timeoutMs: 8_000 }
            : { maxSnapshots: 8, requiredStableSnapshots: 2, pollIntervalMs: 200, timeoutMs: 20_000 },
        });
      }
    }
    if (packs.has("navigation")
      && navigationStartup !== null
      && navigationStartup.representativeSnapshot !== undefined
      && navigationStartup.blockers.length > 0) {
      const startupBlocker = navigationStartup.blockers[0];
      if (startupBlocker === undefined) throw new TypeError("Startup blocker evidence disappeared.");
      startupFindings = [{
        classification: "deterministic",
        issue: createStartupBlockerFinding(
          startupBlocker,
          navigationStartup.representativeSnapshot,
          navigationStartup.resetStrategy,
          navigationStartup.status === "ready",
          navigationStartup.policy.kind === "remote-sequence"
            ? navigationStartup.policy.actions
            : [],
        ).issue,
        source: {
          kind: "screen-analysis",
          screenStateId: "startup-blocker",
          focusStateId: null,
          element: startupBlocker.element,
          actionAttemptId: null,
          relatedActionAttemptId: null,
          actionSequence: [],
          locallyComplete: null,
        },
        target: {
          screenStateId: "startup-blocker",
          focusStateId: null,
          element: startupBlocker.element,
          expectedElement: null,
          observedElement: startupBlocker.focusedElement,
        },
      }];
    }
    if (packs.has("navigation") && navigationStartup?.status === "ready" && navigationStartup.restoreToPreparedState !== undefined) {
      const explorationStartedAt = performance.now();
      navigation = await explore(createSafeExplorationDriver(driver), {
        profile: request.mode,
        resetStrategy: "reload",
        restoreInitialSnapshot: navigationStartup.restoreToPreparedState,
        ...(request.maxDurationMs === undefined ? {} : { budgets: { maxDurationMs: request.maxDurationMs } }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        settling: {
        strategy: "stable-snapshot",
        maxSnapshots: 3,
        pollIntervalMs: 20,
        requiredStableSnapshots: 2,
        },
      });
      navigationExplorationMs = Math.max(0, performance.now() - explorationStartedAt);
      navigationDriverPerformance = driver.getPerformanceProfile();
      const diagnosticsStartedAt = performance.now();
      navigationFindings = [
        ...startupFindings,
        ...diagnoseNavigation(navigation).findings.filter((finding) => (
          !specialisedReachabilityScreen(finding, navigation as ExplorationResult)
        )),
      ];
      navigationDiagnosticsMs = Math.max(0, performance.now() - diagnosticsStartedAt);
    }
    if (packs.has("navigation") && navigationStartup?.status !== "ready") {
      navigationFindings = startupFindings;
      if (navigationStartup !== null) {
        return await writeSetupNotStartedReport(
          store,
          request,
          startedAt,
          navigationStartup,
          navigationFindings,
        );
      }
    }
    if (request.signal?.aborted !== true && needStreamingJourney) {
      streaming = await runStreamingPack(driver, {
        budgets: STREAMING_BUDGETS[request.mode],
        resetStrategy: "reload",
        pointerProbe: createStreamingAuditPointerProbe(request.target, createDriver),
      });
    }
    if (request.signal?.aborted !== true && webStages.length > 0) {
      const playerSettingsSequence = streamingSettingsSequence(streaming);
      web = await runWebPack(driver, {
        stages: webStages,
        budgets: WEB_BUDGETS[request.mode],
        resetStrategy: "reload",
        searchQuery: request.searchQuery,
        ...(playerSettingsSequence === undefined
          ? {}
          : { playerSettingsSequence }),
        ...(webStages.includes("performance") ? { menuResponseThresholdMs: 1_000 } : {}),
        hooks: createWebAuditHooks({ target: request.target, driver, createDriver }),
      });
    }
  } catch (error) {
    runFailure = { error };
  } finally {
    await driver.close().catch((error: unknown) => {
      if (runFailure === null && request.signal?.aborted !== true) throw error;
    });
  }
  if (runFailure !== null) {
    return await writeFailedRunReport(store, request, startedAt, runFailure.error);
  }

  const products: AuditRunProducts = {
    navigation,
    navigationStartup,
    navigationFindings,
    streaming,
    web,
  };
  const rawIssues = [
    ...navigationFindings.map((finding) => finding.issue),
    ...(packs.has("streaming") ? streaming?.issues ?? [] : []),
    ...(web?.issues ?? []),
  ];
  const uniqueIssues = rawIssues.filter((issue, index) =>
    rawIssues.findIndex((candidate) => candidate.id === issue.id) === index
  );
  const evidenceStartedAt = performance.now();
  const captured = await captureIssuesWithinBudget(
    store,
    request.target,
    products,
    uniqueIssues,
    createDriver,
    captureIssue,
    Date.now,
    request.signal,
  );
  const evidenceGenerationMs = Math.max(0, performance.now() - evidenceStartedAt);
  const inventory = navigationInventory(navigation, web);
  const ledgerValue = asJson({
    schemaVersion: 1,
    target: request.target,
    mode: request.mode,
    selectedPacks: [...packs],
    startupPreparation: navigationStartup === null ? null : {
      status: navigationStartup.status,
      policy: navigationStartup.policy.kind,
      actions: navigationStartup.policy.kind === "remote-sequence" ? [...navigationStartup.policy.actions] : [],
      identityHash: navigationStartup.identityHash,
      blockers: navigationStartup.blockers,
      controls: navigationStartup.controls,
      steps: navigationStartup.steps,
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
    web: web === null ? null : { status: web.status, termination: web.termination, statistics: web.statistics, stages: web.stages },
  });
  const globalArtifacts = await writeAuditAuxiliaryArtifacts(store, ledgerValue, asJson(inventory));
  const evidenceFailed = captured.some((entry) => entry.failed);
  const coverage = packCoverage(products, packs);
  const runPartial = request.signal?.aborted === true
    || evidenceFailed
    || coverage.some((entry) => entry.status !== "completed");
  const completedAt = new Date();
  const report = buildTVDoctorReportV1({
    run: {
      id: `audit-${startedAt.getTime().toString(36)}`,
      tvdoctorVersion: CLI_VERSION,
      mode: request.mode,
      status: runPartial ? "partial" : "completed",
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
    },
    target: {
      name: new URL(request.target).hostname,
      platform: "web",
      location: request.target,
      environment: {
        browser: "chromium",
        viewport: "1280x720",
        orchestration: "bounded semantic local audit",
        ...(targetRequiresReplayOverride(request.target)
          ? { [REPLAY_TARGET_OVERRIDE_ENVIRONMENT_KEY]: REPLAY_TARGET_OVERRIDE_REQUIRED }
          : {}),
      },
    },
    coverage: {
      screenStatesDiscovered: navigation?.statistics.screenStates ?? 0,
      focusStatesDiscovered: navigation?.statistics.focusStates
        ?? (streaming?.statistics.uniqueStates ?? 0) + (web?.statistics.uniqueStates ?? 0),
      transitionsTested: navigation?.graph.actions.length ?? 0,
      actionsSent: (navigation?.statistics.physicalActions ?? 0)
        + (streaming?.statistics.physicalActions ?? 0)
        + (web?.statistics.physicalActions ?? 0),
      capabilitiesObserved: [...capabilities],
      packs: coverage,
      budget: {
        maxActions: (navigation?.budgets.maxActions ?? 0)
          + (streaming?.budgets.maxActions ?? 0)
          + (web?.budgets.maxActions ?? 0),
        maxStates: (navigation?.budgets.maxStates ?? 0)
          + (streaming?.budgets.maxStates ?? 0)
          + (web?.budgets.maxStates ?? 0),
        maxDepth: Math.max(
          navigation?.budgets.maxDepth ?? 0,
          streaming?.budgets.maxLocalDepth ?? 0,
          web?.budgets.maxLocalDepth ?? 0,
        ),
        maxDurationMs: (navigation?.budgets.maxDurationMs ?? 0)
          + (streaming?.budgets.maxDurationMs ?? 0)
          + (web?.budgets.maxDurationMs ?? 0),
        maxRepetitiveItems: request.mode === "quick" ? 1 : request.mode === "standard" ? 2 : 4,
        exhausted: exhaustedBudgets(products, packs),
      },
    },
    issues: captured.map((entry) => entry.issue),
    artifacts: [...globalArtifacts, ...captured.flatMap((entry) => entry.artifacts)],
    replays: captured.flatMap((entry) => entry.replay === null ? [] : [entry.replay]),
  });
  const bundle = await writeReportBundle(store, report);
  const evidenceFailureCount = captured.filter((entry) => entry.failed).length;
  return {
    status: report.run.status,
    issueCount: report.issues.length,
    highestSeverity: highestSeverity(report.issues),
    reportPath: bundle.reportJson.absolutePath,
    details: [
      `Packs ${String(coverage.filter((entry) => entry.status === "completed").length)}/${String(coverage.length)} completed`,
      `Actions ${String(report.coverage.actionsSent)}/${String(report.coverage.budget.maxActions ?? 0)}`,
      `States ${String(report.coverage.focusStatesDiscovered)}; issues ${String(report.issues.length)}; evidence failures ${String(evidenceFailureCount)}`,
      ...(runPartial ? partialRunDetails(products, packs, evidenceFailureCount) : []),
    ],
  };
}
