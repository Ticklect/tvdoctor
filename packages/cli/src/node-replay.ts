import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  compileReplay,
  executeReplay,
  prepareStartup,
} from "@tvdoctor/core";
import { PlaywrightWebDriver } from "@tvdoctor/driver-web";
import { AndroidTvDriver, type AndroidTvDriverOptions } from "@tvdoctor/driver-android";
import {
  PROTOCOL_VALIDATION_LIMITS,
  REPORT_SCHEMA_VERSION_V1,
  parseTVDoctorReportJson,
  type ReproductionConfidence,
  type AppReference,
  type TVDoctorDriver,
  type TVDoctorIssue,
  type TVDoctorReplayV1,
  type StateSnapshot,
  type UiNodeSnapshot,
} from "@tvdoctor/protocol";
import type {
  CliOperations,
  ReplayCommandRequest,
  ReplayCommandResult,
  WebsiteStartupDetection,
} from "./cli.js";
import {
  PACKAGED_REPLAY_TARGET_ENVIRONMENT_KEY,
  PACKAGED_REPLAY_TARGET_NORTHSTAR_DEMO,
  REPLAY_TARGET_OVERRIDE_ENVIRONMENT_KEY,
  REPLAY_TARGET_OVERRIDE_REQUIRED,
  createNodeAuditOperation,
} from "./node-audit.js";
import { createSafeExplorationDriver } from "./node-audit-navigation.js";
import {
  androidBuildToolsPreflight,
  androidObserverPreflight,
  androidPreflight,
  inspectApk,
  scanAndroidApk,
} from "./android-product.js";
import { compareBaselineFromFiles, createBaselineFromFiles } from "./node-baseline.js";
import { createNodeDemoOperation, withPackagedDemoFixture } from "./node-demo.js";
import {
  authoredProtectedContentWaitMs,
  executeJourney,
  JOURNEY_HASH_ENVIRONMENT_KEY,
  loadJourney,
  parseJourney,
  type JourneyV1,
} from "./journey.js";
import { validateProjectAuthReady } from "./node-audit-project-readiness.js";
import {
  PROJECT_AUTH_READY_HASH_ENVIRONMENT_KEY,
  projectAuthReadyDigest,
} from "./project-auth-binding.js";

const JOURNEY_RESTORE_DRIFT = "Authenticated journey state changed after replay reset; no replay input was sent.";
const JOURNEY_RESTORE_UNAVAILABLE = "Authenticated journey restoration could not be safely validated.";
const MAX_JOURNEY_PROOF_NODES = 4_096;

interface JourneyStateProof {
  readonly url: string;
  readonly uiFingerprint: string;
}

/** Build an in-memory UI identity proof, never place UI labels or secret-bearing URLs in reports/errors. */
function journeyStateProof(driver: PlaywrightWebDriver, origin: string): Promise<JourneyStateProof> {
  return (async () => {
    let url: URL;
    try { url = new URL(driver.getPage().url()); }
    catch { throw new Error(JOURNEY_RESTORE_UNAVAILABLE); }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== origin
      || url.username !== "" || url.password !== "") {
      throw new Error(JOURNEY_RESTORE_DRIFT);
    }
    let snapshot: StateSnapshot;
    try { snapshot = await driver.snapshot(); }
    catch { throw new Error(JOURNEY_RESTORE_UNAVAILABLE); }
    // snapshot.location is intentionally privacy-redacted (e.g.
    // /__tvroute/r_<hash>) and must never be compared with the raw browser
    // route. The trusted page URL above is the sole route source; the
    // snapshot provides only the structural UI identity evidence.
    if (snapshot.uiTree.status !== "available" || snapshot.uiTree.value.length === 0) {
      throw new Error(JOURNEY_RESTORE_UNAVAILABLE);
    }
    // Snapshot collection is asynchronous. A same-origin SPA may redirect to
    // another protected route while its UI is read; never pair the OLD URL
    // with the NEW route's structurally identical UI fingerprint.
    try {
      if (driver.getPage().url() !== url.href) throw new Error(JOURNEY_RESTORE_DRIFT);
    } catch { throw new Error(JOURNEY_RESTORE_DRIFT); }
    const nodes: { id: string | null; role: string | null; name: string | null;
      visible: boolean | null; enabled: boolean | null;
      modal: boolean | null; depth: number }[] = [];
    const queue: { node: UiNodeSnapshot; depth: number }[] = snapshot.uiTree.value
      .map((node) => ({ node, depth: 0 }));
    while (queue.length > 0) {
      if (nodes.length >= MAX_JOURNEY_PROOF_NODES) throw new Error(JOURNEY_RESTORE_UNAVAILABLE);
      const entry = queue.shift();
      if (entry === undefined) break;
      nodes.push({
        id: entry.node.stableId,
        role: entry.node.role,
        name: entry.node.name,
        visible: entry.node.visible,
        enabled: entry.node.enabled,
        modal: entry.node.modal,
        depth: entry.depth,
      });
      queue.push(...entry.node.children.map((node) => ({ node, depth: entry.depth + 1 })));
    }
    try {
      if (driver.getPage().url() !== url.href) throw new Error(JOURNEY_RESTORE_DRIFT);
    } catch { throw new Error(JOURNEY_RESTORE_DRIFT); }
    return {
      url: url.href,
      uiFingerprint: createHash("sha256").update(JSON.stringify(nodes)).digest("hex"),
    };
  })();
}

/** Re-check only terminal assertions from the exact validated journey. Never submit login again. */
function terminalJourneyAssertions(journey: JourneyV1): JourneyV1 | null {
  let lastInput = -1;
  for (const [index, step] of journey.steps.entries()) {
    if (step.action === "press" || step.action === "type-from-env" || step.action === "navigate-route") {
      lastInput = index;
    }
  }
  const assertions = journey.steps.slice(lastInput + 1);
  if (assertions.length === 0) return null;
  if (assertions.some((step) => step.action === "press"
    || step.action === "type-from-env" || step.action === "navigate-route")) {
    throw new TypeError("Journey terminal validation must not submit input.");
  }
  // Legacy immediate assertions retain their 10s replay cap. A developer may
  // explicitly author a bounded read-only wait (up to 30s per step) for real
  // framework hydration; permit that same wait after restoration instead of
  // silently shortening it to 10s. The original journey's total duration and
  // global 120s parser bound still apply. No new navigation or inputs are
  // allowed in these terminal assertions.
  const authoredWaitMs = assertions.reduce((total, step) => total
    + (step.action === "wait-for-route" || step.action === "wait-for-ui"
      ? step.timeoutMs : 0), 0);
  return parseJourney({
    schemaVersion: journey.schemaVersion,
    name: journey.name,
    maxDurationMs: Math.min(journey.maxDurationMs, Math.max(10_000, authoredWaitMs + 2_000)),
    steps: assertions,
  });
}

async function detectWebsiteStartup(target: string): Promise<WebsiteStartupDetection> {
  const driver = new PlaywrightWebDriver();
  try {
    await driver.launch({ id: "tvdoctor-startup-check", launchUri: target });
    const preparation = await prepareStartup(driver, {
      policy: { kind: "observe" },
      resetStrategy: "reload",
      stability: { maxSnapshots: 4, requiredStableSnapshots: 2, pollIntervalMs: 100, timeoutMs: 8_000 },
    });
    if (preparation.status === "ready") {
      return { status: "ready", detail: "The website reached a stable starting state." };
    }
    if (preparation.status === "setup-blocker") {
      const blocker = preparation.blockers[0];
      return {
        status: "blocked",
        ...(blocker === undefined ? {} : {
          blockerKind: blocker.kind,
          textSample: blocker.textSample,
        }),
        detail: preparation.steps.at(-1)?.detail ?? "A startup setup screen was detected.",
      };
    }
    return {
      status: "unavailable",
      detail: preparation.status === "unstable"
        ? "The website did not reach a stable starting state."
        : "TVDoctor could not safely inspect the startup screen.",
    };
  } catch (error) {
    return {
      status: "unavailable",
      detail: error instanceof Error ? error.message : "Startup inspection failed.",
    };
  } finally {
    await driver.close().catch(() => undefined);
  }
}

function terminalText(value: string, maximumLength = 500): string {
  let printable = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 27) continue;
    printable += codePoint < 32 || (codePoint >= 127 && codePoint <= 159)
      ? " "
      : character;
  }
  return printable
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximumLength);
}

function oneMatch<T>(
  values: readonly T[],
  predicate: (value: T) => boolean,
  label: string,
): T {
  const matches = values.filter(predicate);
  if (matches.length !== 1) {
    throw new TypeError(`Expected exactly one ${label}; found ${String(matches.length)}.`);
  }
  const match = matches[0];
  if (match === undefined) throw new TypeError(`The ${label} is missing.`);
  return match;
}

function replayConfidence(issue: TVDoctorIssue): ReproductionConfidence {
  return issue.confidence === "deterministic"
    && issue.reproduction.status === "available"
    && issue.reproduction.confidence === "deterministic"
    ? "deterministic"
    : "best-effort";
}

function compileStoredReplay(
  issue: TVDoctorIssue,
  replay: TVDoctorReplayV1,
) {
  const reproduction = issue.reproduction;
  const compiled = compileReplay(replay, {
    sourceIssue: issue,
    confidence: replayConfidence(issue),
    ...(reproduction.status === "available"
      ? {
          sequenceMetadata: {
            originalSequence: reproduction.originalSequence,
            minimizedSequence: reproduction.minimizedSequence,
          },
        }
      : {}),
  });
  if (compiled.status !== "compiled") {
    throw new TypeError(`Replay could not be compiled: ${compiled.reason.message}`);
  }
  return compiled.plan;
}

function targetUrl(recordedTarget: string, override: string | undefined): string {
  const value = override ?? recordedTarget;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("The replay target must be an absolute HTTP(S) URL.");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username.length > 0
    || parsed.password.length > 0) {
    throw new TypeError("The replay target must be an HTTP(S) URL without credentials.");
  }
  return parsed.href;
}

async function loadReport(reportPath: string) {
  const absolutePath = resolve(reportPath);
  const metadata = await stat(absolutePath);
  if (!metadata.isFile()) throw new TypeError("The report path is not a regular file.");
  if (metadata.size > PROTOCOL_VALIDATION_LIMITS.maxJsonBytes) {
    throw new TypeError("The report exceeds the protocol JSON size limit.");
  }
  const report = parseTVDoctorReportJson(await readFile(absolutePath, "utf8"));
  if (report.schemaVersion !== REPORT_SCHEMA_VERSION_V1) {
    throw new TypeError("Replay requires a tvdoctor.report/v1 report.");
  }
  return report;
}

interface ReplayCliDriver extends TVDoctorDriver {
  launch(app: AppReference): Promise<void>;
  close(): Promise<void>;
}

interface AndroidReplayCliDriver extends ReplayCliDriver {
  install(artifactPath: string): Promise<void>;
}

export interface NodeReplayDependencies {
  readonly createDriver?: () => ReplayCliDriver;
  readonly createAuditDriver?: () => PlaywrightWebDriver;
  readonly createAndroidDriver?: (options: AndroidTvDriverOptions) => AndroidReplayCliDriver;
  readonly withDemoFixtureServer?: <T>(run: (target: string) => Promise<T>) => Promise<T>;
}

async function replayIssue(
  request: ReplayCommandRequest,
  createDriver: () => ReplayCliDriver,
  createAndroidDriver: (options: AndroidTvDriverOptions) => AndroidReplayCliDriver,
  withDemoFixtureServer: <T>(run: (target: string) => Promise<T>) => Promise<T>,
): Promise<ReplayCommandResult> {
  const report = await loadReport(request.reportPath);
  if (report.target.platform !== "web"
    && report.target.platform !== "android-tv"
    && report.target.platform !== "fire-tv") {
    throw new TypeError(
      `The installed replay host cannot run platform ${terminalText(report.target.platform)}.`,
    );
  }
  const issue = oneMatch(
    report.issues,
    (candidate) => candidate.id === request.issueId,
    `issue with id ${terminalText(request.issueId)}`,
  );
  if (replayConfidence(issue) !== "deterministic") {
    throw new TypeError(
      "CLI replay supports only deterministic issues with deterministic reproductions.",
    );
  }
  const replay = oneMatch(
    report.replays,
    (candidate) => candidate.issueId === issue.id,
    `replay for ${terminalText(issue.id)}`,
  );
  const plan = compileStoredReplay(issue, replay);
  const expectedJourneyHash = report.target.environment[JOURNEY_HASH_ENVIRONMENT_KEY];
  let journey: JourneyV1 | null = null;
  if (expectedJourneyHash !== undefined) {
    if (request.journeyPath === undefined) {
      return {
        status: "inconclusive",
        details: [
          "Custom journey REQUIRED",
          "The original audit used a secret-safe custom journey.",
          "Run replay again with --journey and the same journey file and environment variables.",
        ],
      };
    }
    journey = await loadJourney(request.journeyPath);
    if (journey.sha256 !== expectedJourneyHash) {
      return {
        status: "inconclusive",
        details: ["Custom journey fingerprint MISMATCH", "Replay was not started."],
      };
    }
  } else if (request.journeyPath !== undefined) {
    throw new TypeError("The report does not declare a custom journey; --journey is not allowed.");
  }
  const savedAuthReady = report.target.environment[PROJECT_AUTH_READY_HASH_ENVIRONMENT_KEY];
  if (savedAuthReady !== undefined || expectedJourneyHash !== undefined) {
    if (request.authReady === undefined || request.journeyPath === undefined
      || typeof savedAuthReady !== "string") {
      return { status: "inconclusive", details: ["The original protected-content assertion is required before authenticated replay."] };
    }
    try {
      if (projectAuthReadyDigest(request.authReady) !== savedAuthReady) {
        return { status: "inconclusive", details: ["The protected-content assertion differs from the original report."] };
      }
    } catch {
      return { status: "inconclusive", details: ["The protected-content assertion is invalid."] };
    }
  } else if (request.authReady !== undefined) {
    return { status: "inconclusive", details: ["The original report did not declare protected content."] };
  }
  const authoredWaitMs = journey !== null && request.authReady !== undefined
    ? authoredProtectedContentWaitMs(journey, {
      path: new URL(targetUrl(report.target.location, request.targetOverride)).pathname,
      ...request.authReady,
    }) : null;
  if (report.target.platform === "web"
    && report.target.environment[PACKAGED_REPLAY_TARGET_ENVIRONMENT_KEY]
      === PACKAGED_REPLAY_TARGET_NORTHSTAR_DEMO
    && request.targetOverride === undefined) {
    return await withDemoFixtureServer(async (target) => {
      const demoTarget = new URL(target);
      demoTarget.searchParams.set("tvdoctorDemo", "navigation");
      return await replayIssue(
        { ...request, targetOverride: demoTarget.href },
        createDriver,
        createAndroidDriver,
        withDemoFixtureServer,
      );
    });
  }
  if (report.target.platform === "web"
    && report.target.environment[REPLAY_TARGET_OVERRIDE_ENVIRONMENT_KEY]
      === REPLAY_TARGET_OVERRIDE_REQUIRED
    && request.targetOverride === undefined) {
    return {
      status: "inconclusive",
      details: [
        "Replay target override REQUIRED",
        "The original audit URL contained a query or fragment that was redacted from the report.",
        "Run replay again with --target and the original complete HTTP(S) URL.",
      ],
    };
  }
  let driver: ReplayCliDriver;
  let androidApk: Awaited<ReturnType<typeof inspectApk>> | null = null;
  if (report.target.platform === "android-tv" || report.target.platform === "fire-tv") {
    if (request.apkPath === undefined || request.deviceSerial === undefined) {
      throw new TypeError("Android replay requires --apk PATH and --device SERIAL.");
    }
    if (request.targetOverride !== undefined) throw new TypeError("--target is valid only for web replay.");
    if (journey !== null) throw new TypeError("Custom journeys are currently supported only for web replay.");
    androidApk = await inspectApk(request.apkPath);
    const expectedPackage = report.target.environment["package"];
    if (androidApk.packageName === null || (typeof expectedPackage === "string" && androidApk.packageName !== expectedPackage)) {
      throw new TypeError("The Android replay APK package does not match the report target.");
    }
    driver = createAndroidDriver({
      platform: report.target.platform,
      serial: request.deviceSerial,
      ...(request.adbPath === undefined ? {} : { adbPath: request.adbPath }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
  } else {
    driver = createDriver();
  }

  try {
    const replayDriver: TVDoctorDriver = report.target.platform === "web"
      ? createSafeExplorationDriver(driver as PlaywrightWebDriver)
      : driver;
    if (report.target.platform === "android-tv" || report.target.platform === "fire-tv") {
      const androidDriver = driver as AndroidReplayCliDriver;
      if (androidApk === null || androidApk.packageName === null || request.apkPath === undefined) {
        throw new TypeError("Android replay preparation is incomplete.");
      }
      await androidDriver.install(request.apkPath);
      const component = androidApk.leanbackActivity ?? androidApk.launchableActivities.at(0);
      await androidDriver.launch({
        id: androidApk.packageName,
        ...(component === undefined ? {} : { launchUri: component }),
      });
    } else {
      const launchUri = targetUrl(report.target.location, request.targetOverride);
      if (journey !== null && request.targetOverride !== undefined
        && new URL(launchUri).pathname !== new URL(targetUrl(report.target.location, undefined)).pathname) {
        return {
          status: "inconclusive",
          details: ["Authenticated journey launch route MISMATCH", "Replay was not started."],
        };
      }
      await driver.launch({
        id: `cli-${issue.id}`,
        launchUri,
      });
      if (journey !== null) {
        // This is an explicitly authored and hash-pinned setup journey, not
        // autonomous exploration. Use the same journey driver as the original
        // authenticated scan so ordinary accessible controls without DOM IDs
        // remain usable. The subsequent defect replay STILL uses replayDriver,
        // whose SELECT actions are subject to the safe-exploration policy.
        await executeJourney(driver as PlaywrightWebDriver, journey, process.env, request.signal);
        if (request.authReady !== undefined && !await validateProjectAuthReady(
          (driver as PlaywrightWebDriver).getPage(), {
            expectedUrl: launchUri, ...request.authReady,
            ...(authoredWaitMs === null ? {} : { authoredWaitMs }),
          })) {
          return { status: "inconclusive", details: ["Protected content was not proven after login; no replay was started."] };
        }
      }
    }
    let journeyProof: JourneyStateProof | null = null;
    let journeyAssertions: JourneyV1 | null = null;
    let journeyWebDriver: PlaywrightWebDriver | null = null;
    let journeyOrigin: string | null = null;
    if (journey !== null) {
      journeyWebDriver = driver as PlaywrightWebDriver;
      journeyOrigin = new URL(targetUrl(report.target.location, request.targetOverride)).origin;
      journeyAssertions = terminalJourneyAssertions(journey);
      try {
        if (journeyAssertions !== null) {
          await executeJourney(journeyWebDriver, journeyAssertions, {}, request.signal);
        }
        journeyProof = await journeyStateProof(journeyWebDriver, journeyOrigin);
      } catch {
        return {
          status: "inconclusive",
          details: ["Authenticated journey state could not be independently verified", "Replay was not started."],
        };
      }
    }
    const result = await executeReplay(replayDriver, plan, {
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.confirmStableFix === true ? { confirmStableFix: true } : {}),
      ...(journeyProof === null || journeyWebDriver === null || journeyOrigin === null
        ? {}
        : {
            restore: async ({ strategy }: { readonly strategy: typeof plan.replay.reset.strategy }) => {
              if (strategy === "clear-data") throw new Error(JOURNEY_RESTORE_DRIFT);
              try {
                if (replayDriver.reset === undefined) throw new Error(JOURNEY_RESTORE_UNAVAILABLE);
                await replayDriver.reset(strategy);
                // A framework may initially render a loading shell after a
                // valid reset. Check only the original read-only terminal
                // journey assertions and exact protected marker first; then
                // compare full structural identity of the settled page.
                // Never compare a loading skeleton with the finished original
                // or treat a disappearing marker as a restored session.
                if (journeyAssertions !== null) {
                  await executeJourney(journeyWebDriver, journeyAssertions, {}, request.signal);
                }
                if (request.authReady !== undefined && !await validateProjectAuthReady(
                  journeyWebDriver.getPage(), {
                    expectedUrl: targetUrl(report.target.location, request.targetOverride),
                    ...request.authReady,
                    ...(authoredWaitMs === null ? {} : { authoredWaitMs }),
                  })) throw new Error(JOURNEY_RESTORE_DRIFT);
                const restored = await journeyStateProof(journeyWebDriver, journeyOrigin);
                if (restored.url !== journeyProof.url
                  || restored.uiFingerprint !== journeyProof.uiFingerprint) {
                  throw new Error(JOURNEY_RESTORE_DRIFT);
                }
              } catch {
                // Never forward Playwright errors: their URL/DOM detail may
                // contain tokens from the authenticated session.
                throw new Error(JOURNEY_RESTORE_DRIFT);
              }
            },
          }),
    });
    if (journey !== null && result.reason?.phase === "reset"
      && result.reason.code === "reset-error" && result.reason.message === JOURNEY_RESTORE_DRIFT) {
      return {
        status: "inconclusive",
        details: ["Authenticated journey state changed after replay reset", "Replay input was not sent."],
      };
    }
    const expectedSetupActions = plan.setup.steps.reduce(
      (total, step) => total + step.repeat,
      0,
    );
    const recordedSetupActions = result.evidence.setupActionResults.length;
    const completedSetupActions = result.evidence.setupActionResults.filter((action) => action.outcome === "applied").length;
    const assertionAction = result.evidence.assertionActionResult;
    const details = [
      "Launch PASS",
      recordedSetupActions === expectedSetupActions && completedSetupActions === expectedSetupActions
        && result.evidence.beforeSnapshot !== null
        ? `Setup ${String(completedSetupActions)}/${String(expectedSetupActions)} remote action(s) PASS`
        : `Setup ${String(completedSetupActions)}/${String(expectedSetupActions)} remote action(s) INCOMPLETE`,
      result.evidence.beforeSnapshot === null
        ? "Checkpoint NOT REACHED"
        : result.reason?.phase === "checkpoint"
          ? "Checkpoint INCONCLUSIVE"
          : "Checkpoint PASS",
      assertionAction === null
        ? `${plan.assertion.action} assertion NOT COMPLETED`
        : `${plan.assertion.action} dispatch ${assertionAction.outcome === "applied" ? "PASS" : "INCOMPLETE"}`,
      `Replay classification ${result.status.toUpperCase()}`,
    ];
    if (result.reason !== null) {
      details.push(
        `Reason [${result.reason.phase}/${result.reason.code}]: ${terminalText(result.reason.message)}`,
      );
    }
    return { status: result.status, details };
  } finally {
    await driver.close();
  }
}

export function createNodeCliOperations(
  dependencies: NodeReplayDependencies = {},
): CliOperations {
  const createDriver = dependencies.createDriver
    ?? (() => new PlaywrightWebDriver());
  const createAndroidDriver = dependencies.createAndroidDriver
    ?? ((options: AndroidTvDriverOptions) => new AndroidTvDriver(options));
  const withDemoFixtureServer = dependencies.withDemoFixtureServer ?? withPackagedDemoFixture;
  const testTarget = createNodeAuditOperation({
      ...(dependencies.createAuditDriver === undefined
        ? {}
        : { createDriver: dependencies.createAuditDriver }),
    });
  const replay = async (request: ReplayCommandRequest): Promise<ReplayCommandResult> => (
    await replayIssue(request, createDriver, createAndroidDriver, withDemoFixtureServer)
  );
  return {
    testTarget,
    detectWebsiteStartup,
    androidPreflight: (adbPath) => androidPreflight(adbPath),
    androidBuildToolsPreflight,
    androidObserverPreflight,
    inspectApk,
    scanAndroidApk,
    createBaseline: createBaselineFromFiles,
    compareBaseline: compareBaselineFromFiles,
    replayIssue: replay,
    runDemo: createNodeDemoOperation({ testTarget, replayIssue: replay }),
  };
}
