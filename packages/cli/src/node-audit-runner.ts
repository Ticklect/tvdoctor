import {
  createStartupBlockerFinding,
  diagnoseKeyboardNavigation,
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
import { dirname, join } from "node:path";

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
import type { Capability, RemoteKey, TVDoctorIssue } from "@tvdoctor/protocol";
import {
  buildTVDoctorReportV1,
  highestVerifiedSeverity,
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
  navigationCoverageComplete,
  navigationInventory,
  resolveStartupDecisionThroughFocus,
} from "./node-audit-navigation.js";
import { keyboardActionsForState, safeKeyboardDriver } from "./keyboard-actions.js";
import { independentlyReobserveWebKeyboardErrors, WebKeyboardRuntimeWitnesses } from "./web-keyboard-runtime.js";
import { createSafeLinkNavigationDriver } from "./web-safe-link-runtime.js";
import { attachIssueReplayVideos } from "./issue-replay-video.js";
import { applyControlledDemoContract } from "./demo-seeded-proof.js";
import { recordedVideoSidecar, videoBundleOptions, videoDetails } from "./web-session-video.js";
import {
  highestSeverity,
  publicTargetLocation,
  reserveAuditOutput,
  targetRequiresReplayOverride,
  writeAuditAuxiliaryArtifacts,
  writeFailedRunReport,
  AuthJourneyExecutionFailure,
  writeProjectRouteMismatchReport,
  writeSetupNotStartedReport,
} from "./node-audit-output.js";
import {
  packCoverage,
  partialRunDetails,
  selectedPacks,
  selectedWebStages,
  streamingSettingsSequence,
} from "./node-audit-selection.js";
import {
  NAVIGATION_GRAPH_HTML_PATH,
  NAVIGATION_GRAPH_JSON_PATH,
  NAVIGATION_GRAPH_MARKDOWN_PATH,
  writeNavigationGraphArtifacts,
} from "./navigation-graph-output.js";
import {
  createStreamingAuditPointerProbe,
  createWebAuditHooks,
} from "./web-audit-hooks.js";
import { auditReportCoverage, auditStageLedger } from "./node-audit-run-report.js";
import { CLI_VERSION } from "./version.js";
import { launchAuditWithStartupReview } from "./node-audit-startup-runtime.js";
import { ProjectRouteMismatchError, requireOriginalProjectRoute } from "./node-audit-project-route.js";
import {
  PROJECT_AUTH_READY_HASH_ENVIRONMENT_KEY,
  projectAuthReadyDigest,
} from "./project-auth-binding.js";
import { validateProjectAuthReady } from "./node-audit-project-readiness.js";

class ProjectContentUnprovenError extends Error {
  constructor() { super("The developer-declared protected content could not be proven."); }
}
import {
  SOURCE_CORRELATION_JSON_PATH,
  SOURCE_CORRELATION_MARKDOWN_PATH,
  writeSourceCorrelationArtifacts,
} from "./source-correlation.js";
import {
  authoredProtectedContentWaitMs,
  executeJourney,
  JOURNEY_HASH_ENVIRONMENT_KEY,
  JOURNEY_NAME_ENVIRONMENT_KEY,
  loadJourney,
  type JourneyExecutionResult,
  type JourneyV1,
} from "./journey.js";

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
  let runtimeIssues: readonly TVDoctorIssue[] = [];
  const startupRuntimeIssues: TVDoctorIssue[] = [];
  const safeLinkIssues: TVDoctorIssue[] = [];
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
  let projectRouteMismatch = false;
  let projectContentUnproven = false;
  let journey: JourneyV1 | null = null;
  let journeyExecution: JourneyExecutionResult | null = null;
  let sessionState: WebStorageState | null = null;
  let setupNotStarted: { readonly startup: StartupPreparationResult; readonly findings: readonly NavigationDiagnosticFinding[] } | null = null;
  const createIsolatedDriver = (): PlaywrightWebDriver => {
    const preparedState = sessionState;
    return preparedState === null ? createDriver() : createSessionDriver(preparedState);
  };
  const requireProjectContent = async (): Promise<void> => {
    requireOriginalProjectRoute(driver, request);
    if (request.authReady !== undefined) {
      const authoredWaitMs = journey === null ? null : authoredProtectedContentWaitMs(journey, {
        path: new URL(request.target).pathname, ...request.authReady,
      });
      if (!await validateProjectAuthReady(driver.getPage(), {
        expectedUrl: request.target,
        ...request.authReady,
        ...(authoredWaitMs === null ? {} : { authoredWaitMs }),
      })) {
        throw new ProjectContentUnprovenError();
      }
    }
  };
  try {
    startupRuntimeIssues.push(...await launchAuditWithStartupReview(driver,
      { id: "cli-web-audit", launchUri: request.target }, {
        ...(request.inputMode === undefined ? {} : { inputMode: request.inputMode }),
        navigation: packs.has("navigation"),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }));
    if (request.journeyPath !== undefined) {
      try {
        journey = await loadJourney(request.journeyPath);
        journeyExecution = await executeJourney(driver, journey, process.env, request.signal);
      } catch {
        // Raw Playwright and authored journey failures can embed URLs, DOM text
        // and private env keys. A typed outcome is enough for repair guidance.
        throw new AuthJourneyExecutionFailure();
      }
    }
    // Successful journey assertions alone do not prove that a subsequent
    // root reload is still on the same protected SPA route.
    await requireProjectContent();
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
      await requireProjectContent();
      if (navigationStartup.status === "ready" && navigationStartup.restoreToPreparedState !== undefined
        && request.requireTargetRoute === true) {
        const restore = navigationStartup.restoreToPreparedState;
        navigationStartup = {
          ...navigationStartup,
          restoreToPreparedState: async (options) => {
            const snapshot = await restore(options);
            await requireProjectContent();
            return snapshot;
          },
        };
      }
      if (navigationStartup.status === "ready" && journey !== null) {
        sessionState = await driver.getPage().context().storageState();
      }
    }
    if (request.inputMode !== "keyboard"
      && packs.has("navigation")
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
      const useKeyboardInteractions = request.inputMode === "keyboard" && request.keyboardInteractions === true;
      const keyboardKeys = useKeyboardInteractions ? (["TAB", "SHIFT_TAB", "BACK", "SELECT"] as const) : (["TAB", "SHIFT_TAB"] as const);
      const explorationDriver = createSafeExplorationDriver(driver, { fixtureProfileSelection: request.fixtureProfileSelection === true });
      // An explicitly authorized journey may prepare an authenticated route.
      // The prepared-state restore below independently validates its canonical
      // identity; only then is a safe keyboard runtime event reobserved.
      const runtimeWitnesses = request.inputMode === "keyboard"
        ? new WebKeyboardRuntimeWitnesses(driver) : null;
      if (runtimeWitnesses !== null) driver.consumeActionRuntimeErrors();
      const keyboardExplorationDriver = safeKeyboardDriver(explorationDriver);
      const chosenDriver = useKeyboardInteractions && request.safeLinkNavigation === true
        ? createSafeLinkNavigationDriver({
          browser: driver, safeKeyboard: keyboardExplorationDriver,
          policyDriver: explorationDriver, issues: safeLinkIssues,
        })
        : useKeyboardInteractions ? keyboardExplorationDriver : explorationDriver;
      navigation = await explore(chosenDriver, {
        profile: request.mode,
        ...(request.inputMode === "keyboard" ? {
          actions: keyboardKeys,
          replayActions: keyboardKeys,
          ...(useKeyboardInteractions ? { actionsForState: ({ snapshot }: { readonly snapshot: import("@tvdoctor/protocol").StateSnapshot }) => keyboardActionsForState(snapshot, { safeLinks: request.safeLinkNavigation === true }) } : {}),
        } : {}),
        restorationMode: navigationRestorationMode,
        allowRootRestorationFallback: true,
        refreshVisibleSelfLoops: true,
        // Restore the initial launch route even after the app pushes a new
        // history pathname; reload would preserve the current nested route.
        // Web relaunch uses the original tab and retains sessionStorage.
        resetStrategy: "relaunch",
        restoreInitialSnapshot: navigationStartup.restoreToPreparedState,
        ...(runtimeWitnesses === null ? {} : { onActionObserved: ({ key, afterSnapshot }) => {
          runtimeWitnesses.observe(key, afterSnapshot);
        } }),
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
        ...(request.inputMode === "keyboard"
          ? diagnoseKeyboardNavigation(navigation).findings
          : diagnoseNavigation(navigation).findings),
      ];
      navigationFindings = applyControlledDemoContract(request, navigation, navigationFindings);
      if (runtimeWitnesses !== null && request.signal?.aborted !== true) {
        const prepared = navigationStartup;
        runtimeIssues = await independentlyReobserveWebKeyboardErrors({
          driver, navigation, witnesses: runtimeWitnesses,
          restore: async () => {
            const restored = await prepared.restoreToPreparedState?.();
            const originalLocation = prepared.representativeSnapshot?.location;
            if (restored?.location.status !== "available"
              || originalLocation?.status !== "available"
              || restored.location.value !== originalLocation.value
              || driver.getPage().url() !== originalLocation.value) {
              throw new Error("Original prepared route or authenticated state changed.");
            }
            requireOriginalProjectRoute(driver, request);
            return restored;
          },
          fixtureProfileSelection: request.fixtureProfileSelection === true,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
      }
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
    if (error instanceof ProjectRouteMismatchError) projectRouteMismatch = true;
    else if (error instanceof ProjectContentUnprovenError) projectContentUnproven = true;
    else runFailure = { error };
  } finally {
    await driver.close().catch((error: unknown) => {
      if (runFailure === null && !projectRouteMismatch && !projectContentUnproven
        && request.signal?.aborted !== true) throw error;
    });
  }
  const video = await recordedVideoSidecar(store, driver, request.recordVideo === true);
  const bundleSidecars = videoBundleOptions(video);
  const recordingDetails = videoDetails(request.recordVideo === true, video);
  if (projectRouteMismatch || projectContentUnproven) {
    const incomplete = await writeProjectRouteMismatchReport(store, request, startedAt, bundleSidecars,
      projectContentUnproven ? "content-unproven" : "redirected");
    return { ...incomplete, details: [...incomplete.details, ...recordingDetails] };
  }
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
  const capturedWithClips = await attachIssueReplayVideos(store, captured, request, createDriver);
  const evidenceGenerationMs = Math.max(0, performance.now() - evidenceStartedAt);
  const inventory = navigationInventory(navigation, web);
  const ledgerValue = auditStageLedger({
    request, products, packs, navigationRestorationMode, journey, journeyExecution,
    settingsRouteDiscovery, navigationDriverPerformance,
    navigationExplorationMs, startupPreparationMs, navigationDiagnosticsMs, evidenceGenerationMs,
  });
  // navigationInventory constructs JSON-safe primitives/arrays with explicit nulls;
  // streaming these directly avoids serialising and parsing the full graph twice.
  const auxiliaryArtifacts = await writeAuditAuxiliaryArtifacts(store, ledgerValue, inventory as unknown as JsonValue);
  const navigationGraphArtifacts = navigation === null
    ? []
    : await writeNavigationGraphArtifacts(store, navigation, navigationFindings, request.inputMode);
  const globalArtifacts = [...auxiliaryArtifacts, ...navigationGraphArtifacts];
  const evidenceFailed = capturedWithClips.some((entry) => entry.failed);
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
        ...(request.inputMode === "keyboard" ? { inputMode: "keyboard" } : {}),
        ...(request.inputMode === "keyboard" ? {
          safeLinkNavigation: request.safeLinkNavigation === true ? "enabled" : "disabled",
          keyboardInteractions: request.keyboardInteractions === true ? "enabled" : "disabled",
        } : {}),
        ...(journey === null ? {} : {
          [JOURNEY_HASH_ENVIRONMENT_KEY]: journey.sha256,
          [JOURNEY_NAME_ENVIRONMENT_KEY]: journey.name,
        }),
        ...(request.authReady === undefined ? {} : {
          [PROJECT_AUTH_READY_HASH_ENVIRONMENT_KEY]: projectAuthReadyDigest(request.authReady),
        }),
        ...(request.packagedDemo === true
          ? { [PACKAGED_REPLAY_TARGET_ENVIRONMENT_KEY]: PACKAGED_REPLAY_TARGET_NORTHSTAR_DEMO }
          : request.targetRedaction === "origin" || targetRequiresReplayOverride(request.target)
          ? { [REPLAY_TARGET_OVERRIDE_ENVIRONMENT_KEY]: REPLAY_TARGET_OVERRIDE_REQUIRED }
          : {}),
      },
    },
    coverage: auditReportCoverage({
      request, products, packs, coverage, capabilities, journeyExecution, settingsRouteDiscovery,
    }),
    // Independent functional pageerror recurrence is observation evidence
    // only: no unsupported generic fix replay, and never a false FIXED claim.
    issues: [...capturedWithClips.map((entry) => entry.issue), ...runtimeIssues, ...safeLinkIssues, ...startupRuntimeIssues],
    artifacts: [...globalArtifacts, ...capturedWithClips.flatMap((entry) => entry.artifacts)],
    replays: capturedWithClips.flatMap((entry) => entry.replay === null ? [] : [entry.replay]),
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
    ...(navigation === null ? {} : {
      navigationCoverage: {
        reason: navigation.termination.reason,
        complete: navigationCoverageComplete(navigation),
        pendingStates: navigation.statistics.pendingStates,
        remainingFrontierEntries: navigation.termination.remainingFrontierEntries ?? null,
        remainingCandidateActions: navigation.termination.remainingCandidateActions ?? null,
        deferredStates: navigation.statistics.deferredStates ?? 0,
      },
    }),
    details: [
      `Packs ${String(coverage.filter((entry) => entry.status === "completed").length)}/${String(coverage.length)} completed`,
      ...(request.inputMode === "keyboard" ? ["Input mode: keyboard (Tab / Shift+Tab)"] : []),
      ...(navigation === null ? [] : [`Navigation restoration: ${navigationRestorationMode}${navigationRestorationMode === "root-only" ? "" : " (experimental opt-in)"}`]),
      `Actions ${String(report.coverage.actionsSent)}/${String(report.coverage.budget.maxActions ?? 0)}`,
      `States ${String(report.coverage.focusStatesDiscovered)}; issues ${String(report.issues.length)}; evidence failures ${String(evidenceFailureCount)}`,
      ...(navigation === null ? [] : [
        `Interactive navigation graph: ${join(dirname(bundle.reportJson.absolutePath), NAVIGATION_GRAPH_HTML_PATH)}`,
        `Navigation graph JSON: ${join(dirname(bundle.reportJson.absolutePath), NAVIGATION_GRAPH_JSON_PATH)}`,
        `Navigation graph: ${join(dirname(bundle.reportJson.absolutePath), NAVIGATION_GRAPH_MARKDOWN_PATH)}`,
      ]),
      ...correlationDetails,
      ...recordingDetails,
      ...(runPartial ? partialRunDetails(products, packs, evidenceFailureCount) : []),
    ],
  };
}
