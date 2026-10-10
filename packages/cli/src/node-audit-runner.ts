import {
  createStartupBlockerFinding,
  diagnoseNavigation,
  explore,
  prepareStartup,
  type ExplorationResult,
  type ExplorationRestorationMode,
  type NavigationDiagnosticFinding,
  type StartupPreparationResult,
} from "@tvdoctor/core";
import type {
  PlaywrightWebDriver,
  WebDriverPerformanceProfile,
} from "@tvdoctor/driver-web";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  discoverStreamingSettingsRoute,
  runStreamingPack,
  type StreamingPackResult,
  type StreamingSettingsRouteResult,
} from "@tvdoctor/pack-streaming";
import {
  runWebPack,
  type WebPackResult,
} from "@tvdoctor/pack-web";
import type { Capability, RemoteKey } from "@tvdoctor/protocol";
import {
  buildTVDoctorReportV1,
  highestVerifiedSeverity,
  writeReportBundle,
  type ArtifactStore,
  type JsonValue,
  type ReportBundleOptions,
} from "@tvdoctor/reporters";
import type {
  TestCommandRequest,
  TestCommandResult,
} from "./cli.js";
import {
  REPLAY_TARGET_OVERRIDE_ENVIRONMENT_KEY,
  REPLAY_TARGET_OVERRIDE_REQUIRED,
  PACKAGED_REPLAY_TARGET_ENVIRONMENT_KEY,
  PACKAGED_REPLAY_TARGET_NORTHSTAR_DEMO,
  MAX_DEEP_ISSUES_WITH_FRESH_EVIDENCE,
  MAX_ISSUES_WITH_FRESH_EVIDENCE,
  STREAMING_BUDGETS,
  WEB_BUDGETS,
  type AuditRunProducts,
  type NodeAuditDriverOptions,
  type WebStorageState,
} from "./node-audit-contracts.js";
import {
  captureIssue,
  captureIssuesWithinBudget,
} from "./node-audit-evidence.js";
import {
  createSafeExplorationDriver,
  navigationInventory,
  resolveStartupDecisionThroughFocus,
} from "./node-audit-navigation.js";
import {
  highestSeverity,
  publicTargetLocation,
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
  NAVIGATION_GRAPH_JSON_PATH,
  NAVIGATION_GRAPH_MARKDOWN_PATH,
  writeNavigationGraphArtifacts,
} from "./navigation-graph-output.js";
import {
  createStreamingAuditPointerProbe,
  createWebAuditHooks,
} from "./web-audit-hooks.js";
import { CLI_VERSION } from "./version.js";
import {
  SOURCE_CORRELATION_JSON_PATH,
  SOURCE_CORRELATION_MARKDOWN_PATH,
  writeSourceCorrelationArtifacts,
} from "./source-correlation.js";
import {
  executeJourney,
  JOURNEY_HASH_ENVIRONMENT_KEY,
  JOURNEY_NAME_ENVIRONMENT_KEY,
  loadJourney,
  type JourneyExecutionResult,
  type JourneyV1,
} from "./journey.js";

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/**
 * Experimental, opt-in web traversal optimisation. Root-only stays the default
 * until real-app recall and replay equivalence have been demonstrated. Never
 * disable root fallback or self-loop refresh: both isolate uncertain app state.
 *
 * Set TVDOCTOR_WEB_NAV_RESTORATION=verified-live-only or verified-local to
 * compare against the default root-only run with the same navigation budget.
 */
export function webNavigationRestorationMode(
  environment: NodeJS.ProcessEnv = process.env,
): ExplorationRestorationMode {
  const value = environment["TVDOCTOR_WEB_NAV_RESTORATION"];
  if (value === undefined || value === "" || value === "root-only") return "root-only";
  if (value === "verified-live-only" || value === "verified-local") return value;
  throw new TypeError("TVDOCTOR_WEB_NAV_RESTORATION must be root-only, verified-live-only, or verified-local.");
}

interface VideoEvidenceSidecar {
  readonly absolutePath: string;
  readonly relativePath: "video/audit-session.webm";
}

async function recordedVideoSidecar(
  store: ArtifactStore,
  driver: PlaywrightWebDriver,
  requested: boolean,
): Promise<VideoEvidenceSidecar | null> {
  if (!requested || typeof driver.getRecordedVideoPath !== "function") return null;
  let candidate: string | null;
  try {
    candidate = driver.getRecordedVideoPath();
  } catch {
    return null;
  }
  if (candidate === null) return null;

  const expected = resolve(store.outputRoot, "video", "audit-session.webm");
  if (resolve(candidate) !== expected) return null;
  try {
    const metadata = await lstat(expected);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
    const [realRoot, realFile] = await Promise.all([realpath(store.outputRoot), realpath(expected)]);
    const difference = relative(realRoot, realFile);
    if (difference === ".." || difference.startsWith(`..${sep}`) || isAbsolute(difference)) return null;
  } catch {
    return null;
  }
  return { absolutePath: expected, relativePath: "video/audit-session.webm" };
}

function videoBundleOptions(video: VideoEvidenceSidecar | null): Pick<ReportBundleOptions, "htmlSidecars"> {
  if (video === null) return {};
  return {
    htmlSidecars: [{
      href: video.relativePath,
      label: "Audit session video",
      mediaType: "video/webm",
      warning: "Optional recording; may contain sensitive target content. Review before sharing.",
    }],
  };
}

function videoDetails(requested: boolean, video: VideoEvidenceSidecar | null): readonly string[] {
  if (!requested) return [];
  return video === null
    ? ["Video evidence unavailable; audit classification does not depend on video recording."]
    : [`Video evidence: ${video.absolutePath} (optional; may contain sensitive target content).`];
}

export async function runAudit(
  request: TestCommandRequest,
  createDriver: (options?: NodeAuditDriverOptions) => PlaywrightWebDriver,
  createSessionDriver: (storageState: WebStorageState) => PlaywrightWebDriver = () => {
    throw new Error("Prepared-session driver creation is unavailable.");
  },
): Promise<TestCommandResult> {
  const packs = selectedPacks(request);
  const navigationRestorationMode = packs.has("navigation")
    ? webNavigationRestorationMode()
    : "root-only";
  // Validate the opt-in before reserving a unique output directory. An invalid
  // local setting must not leave a report-less directory behind.
  const store = await reserveAuditOutput(request.outputPath);
  const startedAt = new Date();
  const webStages = selectedWebStages(packs);
  const needSettingsRoute = !packs.has("streaming")
    && (webStages.includes("layout") || webStages.includes("performance"));
  const driver = createDriver(request.recordVideo === true
    ? { recordVideoDirectory: join(store.outputRoot, "video") }
    : undefined);
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
  let settingsRouteDiscovery: StreamingSettingsRouteResult | null = null;
  let playerSettingsSequence: readonly RemoteKey[] | undefined;
  let web: WebPackResult | null = null;
  let runFailure: { readonly error: unknown } | null = null;
  let journey: JourneyV1 | null = null;
  let journeyExecution: JourneyExecutionResult | null = null;
  let sessionState: WebStorageState | null = null;
  let setupNotStarted: { readonly startup: StartupPreparationResult; readonly findings: readonly NavigationDiagnosticFinding[] } | null = null;
  const createIsolatedDriver = (): PlaywrightWebDriver => {
    const preparedState = sessionState;
    return preparedState === null ? createDriver() : createSessionDriver(preparedState);
  };
  try {
    await driver.launch(
      { id: "cli-web-audit", launchUri: request.target },
      request.signal === undefined ? undefined : { signal: request.signal },
    );
    if (request.journeyPath !== undefined) {
      journey = await loadJourney(request.journeyPath);
      journeyExecution = await executeJourney(driver, journey, process.env, request.signal);
    }
    capabilities = await driver.capabilities(
      request.signal === undefined ? undefined : { signal: request.signal },
    );
    if (packs.has("navigation") || journey !== null) {
      const preparationStartedAt = performance.now();
      navigationStartup = await prepareStartup(driver, {
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        policy: request.startupActions === undefined
          ? { kind: "observe" }
          : { kind: "remote-sequence", actions: request.startupActions as RemoteKey[] },
        // prepareStartup captures this reset in restoreToPreparedState; use
        // relaunch so replay returns to launchUri after a nested SPA route.
        resetStrategy: "relaunch",
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
        const actions = await resolveStartupDecisionThroughFocus(
          driver,
          request.startupDecision,
          blocker.kind,
          navigationStartup.representativeSnapshot,
          request.signal === undefined ? undefined : { signal: request.signal },
        );
        request.signal?.throwIfAborted();
        if (actions !== null && actions.length > 0) {
          navigationStartup = await prepareStartup(driver, {
            ...(request.signal === undefined ? {} : { signal: request.signal }),
            policy: { kind: "remote-sequence", actions },
            resetStrategy: "relaunch",
            stability: request.mode === "quick"
              ? { maxSnapshots: 4, requiredStableSnapshots: 2, pollIntervalMs: 100, timeoutMs: 8_000 }
              : { maxSnapshots: 8, requiredStableSnapshots: 2, pollIntervalMs: 200, timeoutMs: 20_000 },
          });
        }
      }
      if (navigationStartup.status === "ready" && journey !== null) {
        sessionState = await driver.getPage().context().storageState();
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
      navigation = await explore(createSafeExplorationDriver(driver, {
        fixtureProfileSelection: request.fixtureProfileSelection === true,
      }), {
        profile: request.mode,
        restorationMode: navigationRestorationMode,
        allowRootRestorationFallback: true,
        refreshVisibleSelfLoops: true,
        // Restore the initial launch route even after the app pushes a new
        // history pathname; reload would preserve the current nested route.
        // Web relaunch uses the original tab and retains sessionStorage.
        resetStrategy: "relaunch",
        restoreInitialSnapshot: navigationStartup.restoreToPreparedState,
        ...((request.maxDurationMs === undefined && request.navigationBudgets === undefined)
          ? {}
          : { budgets: {
            ...request.navigationBudgets,
            ...(request.maxDurationMs === undefined ? {} : { maxDurationMs: request.maxDurationMs }),
          } }),
        ...(request.disableRepetitionCompression === true
          ? { repetitionCompression: { enabled: false } }
          : {}),
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
        ...diagnoseNavigation(navigation).findings,
      ];
      navigationDiagnosticsMs = Math.max(0, performance.now() - diagnosticsStartedAt);
    }
    if ((packs.has("navigation") || journey !== null) && navigationStartup?.status !== "ready") {
      navigationFindings = startupFindings;
      if (navigationStartup !== null) {
        setupNotStarted = { startup: navigationStartup, findings: navigationFindings };
      }
    }
    if (setupNotStarted === null && request.signal?.aborted !== true && packs.has("streaming")) {
      streaming = await runStreamingPack(driver, {
        budgets: STREAMING_BUDGETS[request.mode],
            resetStrategy: "relaunch",
        ...(navigationStartup?.restoreToPreparedState === undefined
          ? {}
          : { restoreInitialState: async () => { await navigationStartup?.restoreToPreparedState?.(); } }),
        pointerProbe: createStreamingAuditPointerProbe(request.target, createIsolatedDriver),
      });
      playerSettingsSequence = streamingSettingsSequence(streaming);
    } else if (setupNotStarted === null && request.signal?.aborted !== true && needSettingsRoute) {
      settingsRouteDiscovery = await discoverStreamingSettingsRoute(driver, {
        budgets: STREAMING_BUDGETS[request.mode],
        resetStrategy: "relaunch",
        ...(navigationStartup?.restoreToPreparedState === undefined
          ? {}
          : { restoreInitialState: async () => { await navigationStartup?.restoreToPreparedState?.(); } }),
      });
      if (settingsRouteDiscovery.status === "found") {
        playerSettingsSequence = settingsRouteDiscovery.sequence;
      }
    }
    if (setupNotStarted === null && request.signal?.aborted !== true && webStages.length > 0) {
      web = await runWebPack(driver, {
        stages: webStages,
        budgets: WEB_BUDGETS[request.mode],
        resetStrategy: "reload",
        ...(navigationStartup?.restoreToPreparedState === undefined
          ? {}
          : { restoreInitialState: async () => { await navigationStartup?.restoreToPreparedState?.(); } }),
        searchQuery: request.searchQuery,
        ...(playerSettingsSequence === undefined
          ? {}
          : { playerSettingsSequence }),
        ...(webStages.includes("performance") ? { menuResponseThresholdMs: 1_000 } : {}),
        hooks: createWebAuditHooks({ target: request.target, driver, createDriver: createIsolatedDriver }),
      });
    }
  } catch (error) {
    runFailure = { error };
  } finally {
    await driver.close().catch((error: unknown) => {
      if (runFailure === null && request.signal?.aborted !== true) throw error;
    });
  }
  const video = await recordedVideoSidecar(store, driver, request.recordVideo === true);
  const bundleSidecars = videoBundleOptions(video);
  const recordingDetails = videoDetails(request.recordVideo === true, video);
  if (runFailure !== null) {
    const failed = await writeFailedRunReport(store, request, startedAt, runFailure.error, bundleSidecars);
    return { ...failed, details: [...failed.details, ...recordingDetails] };
  }
  if (setupNotStarted !== null) {
    const setup = await writeSetupNotStartedReport(
      store,
      request,
      startedAt,
      setupNotStarted.startup,
      setupNotStarted.findings,
      bundleSidecars,
    );
    return { ...setup, details: [...setup.details, ...recordingDetails] };
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
    createIsolatedDriver,
    captureIssue,
    () => performance.now(),
    request.signal,
    request.screenshots !== false,
    request.targetRedaction,
    request.fixtureProfileSelection === true,
    request.mode === "deep"
      ? MAX_DEEP_ISSUES_WITH_FRESH_EVIDENCE
      : MAX_ISSUES_WITH_FRESH_EVIDENCE,
  );
  const evidenceGenerationMs = Math.max(0, performance.now() - evidenceStartedAt);
  const inventory = navigationInventory(navigation, web);
  const ledgerValue = asJson({
    schemaVersion: 1,
    target: publicTargetLocation(request),
    mode: request.mode,
    selectedPacks: [...packs],
    navigationRestorationMode: packs.has("navigation") ? navigationRestorationMode : null,
    fixtureProfileSelectionEnabled: request.fixtureProfileSelection === true,
    startupPreparation: navigationStartup === null ? null : {
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
  // navigationInventory constructs JSON-safe primitives/arrays with explicit nulls;
  // streaming these directly avoids serialising and parsing the full graph twice.
  const auxiliaryArtifacts = await writeAuditAuxiliaryArtifacts(store, ledgerValue, inventory as unknown as JsonValue);
  const navigationGraphArtifacts = navigation === null
    ? []
    : await writeNavigationGraphArtifacts(store, navigation, navigationFindings);
  const globalArtifacts = [...auxiliaryArtifacts, ...navigationGraphArtifacts];
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
      name: request.targetName ?? new URL(request.target).hostname,
      platform: "web",
      location: publicTargetLocation(request),
      environment: {
        browser: "chromium",
        viewport: "1280x720",
        orchestration: "bounded semantic local audit",
        ...(journey === null ? {} : {
          [JOURNEY_HASH_ENVIRONMENT_KEY]: journey.sha256,
          [JOURNEY_NAME_ENVIRONMENT_KEY]: journey.name,
        }),
        ...(request.packagedDemo === true
          ? { [PACKAGED_REPLAY_TARGET_ENVIRONMENT_KEY]: PACKAGED_REPLAY_TARGET_NORTHSTAR_DEMO }
          : request.targetRedaction === "origin" || targetRequiresReplayOverride(request.target)
          ? { [REPLAY_TARGET_OVERRIDE_ENVIRONMENT_KEY]: REPLAY_TARGET_OVERRIDE_REQUIRED }
          : {}),
      },
    },
    coverage: {
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
    },
    issues: captured.map((entry) => entry.issue),
    artifacts: [...globalArtifacts, ...captured.flatMap((entry) => entry.artifacts)],
    replays: captured.flatMap((entry) => entry.replay === null ? [] : [entry.replay]),
  });
  const bundle = await writeReportBundle(
    store,
    report,
    {
      ...bundleSidecars,
      ...(request.ciFailOn === undefined ? {} : { ci: { failOn: request.ciFailOn } }),
    },
  );
  const correlationDetails: string[] = [];
  if (request.sourceRoot !== undefined) {
    try {
      await writeSourceCorrelationArtifacts({
        store,
        sourceRoot: request.sourceRoot,
        issues: report.issues,
        excludeRoots: [store.outputRoot],
      });
      correlationDetails.push(
        `Source correlation JSON: ${join(dirname(bundle.reportJson.absolutePath), SOURCE_CORRELATION_JSON_PATH)}`,
        `Source correlation: ${join(dirname(bundle.reportJson.absolutePath), SOURCE_CORRELATION_MARKDOWN_PATH)}`,
      );
    } catch {
      correlationDetails.push("Source correlation unavailable; the configured source root could not be scanned safely.");
    }
  }
  const evidenceFailureCount = captured.filter((entry) => entry.failed).length;
  return {
    status: report.run.status,
    issueCount: report.issues.length,
    highestSeverity: highestSeverity(report.issues),
    highestVerifiedSeverity: highestVerifiedSeverity(report.issues),
    reportPath: bundle.reportJson.absolutePath,
    details: [
      `Packs ${String(coverage.filter((entry) => entry.status === "completed").length)}/${String(coverage.length)} completed`,
      ...(navigation === null ? [] : [`Navigation restoration: ${navigationRestorationMode}${navigationRestorationMode === "root-only" ? "" : " (experimental opt-in)"}`]),
      `Actions ${String(report.coverage.actionsSent)}/${String(report.coverage.budget.maxActions ?? 0)}`,
      `States ${String(report.coverage.focusStatesDiscovered)}; issues ${String(report.issues.length)}; evidence failures ${String(evidenceFailureCount)}`,
      ...(navigation === null ? [] : [
        `Navigation graph JSON: ${join(dirname(bundle.reportJson.absolutePath), NAVIGATION_GRAPH_JSON_PATH)}`,
        `Navigation graph: ${join(dirname(bundle.reportJson.absolutePath), NAVIGATION_GRAPH_MARKDOWN_PATH)}`,
      ]),
      ...correlationDetails,
      ...recordingDetails,
      ...(runPartial ? partialRunDetails(products, packs, evidenceFailureCount) : []),
    ],
  };
}
