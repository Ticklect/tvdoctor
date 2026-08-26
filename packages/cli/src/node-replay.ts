import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  compileReplay,
  executeReplay,
  prepareStartup,
} from "@tvdoctor/core";
import { PlaywrightWebDriver } from "@tvdoctor/driver-web";
import {
  PROTOCOL_VALIDATION_LIMITS,
  REPORT_SCHEMA_VERSION_V1,
  parseTVDoctorReportJson,
  type ReproductionConfidence,
  type AppReference,
  type TVDoctorDriver,
  type TVDoctorIssue,
  type TVDoctorReplayV1,
} from "@tvdoctor/protocol";
import type {
  CliOperations,
  ReplayCommandRequest,
  ReplayCommandResult,
  WebsiteStartupDetection,
} from "./cli.js";
import {
  REPLAY_TARGET_OVERRIDE_ENVIRONMENT_KEY,
  REPLAY_TARGET_OVERRIDE_REQUIRED,
  createNodeAuditOperation,
} from "./node-audit.js";
import {
  androidPreflight,
  inspectApk,
  scanAndroidApk,
} from "./android-product.js";

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

export interface NodeReplayDependencies {
  readonly createDriver?: () => ReplayCliDriver;
  readonly createAuditDriver?: () => PlaywrightWebDriver;
}

async function replayIssue(
  request: ReplayCommandRequest,
  createDriver: () => ReplayCliDriver,
): Promise<ReplayCommandResult> {
  const report = await loadReport(request.reportPath);
  if (report.target.platform !== "web") {
    throw new TypeError(
      `The Playwright replay host cannot run platform ${terminalText(report.target.platform)}.`,
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
  if (report.target.environment[REPLAY_TARGET_OVERRIDE_ENVIRONMENT_KEY]
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
  const driver = createDriver();

  try {
    await driver.launch({
      id: `cli-${issue.id}`,
      launchUri: targetUrl(report.target.location, request.targetOverride),
    });
    const result = await executeReplay(driver, plan, {
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    const expectedSetupActions = plan.setup.steps.reduce(
      (total, step) => total + step.repeat,
      0,
    );
    const completedSetupActions = result.evidence.setupActionResults.length;
    const details = [
      "Launch PASS",
      completedSetupActions === expectedSetupActions && result.evidence.beforeSnapshot !== null
        ? `Setup ${String(completedSetupActions)}/${String(expectedSetupActions)} remote action(s) PASS`
        : `Setup ${String(completedSetupActions)}/${String(expectedSetupActions)} remote action(s) INCOMPLETE`,
      result.evidence.beforeSnapshot === null
        ? "Checkpoint NOT REACHED"
        : result.reason?.phase === "checkpoint"
          ? "Checkpoint INCONCLUSIVE"
          : "Checkpoint PASS",
      result.evidence.assertionActionResult === null
        ? `${plan.assertion.action} assertion NOT COMPLETED`
        : `${plan.assertion.action} dispatch PASS`,
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
  return {
    testTarget: createNodeAuditOperation({
      ...(dependencies.createAuditDriver === undefined
        ? {}
        : { createDriver: dependencies.createAuditDriver }),
    }),
    detectWebsiteStartup,
    androidPreflight: () => androidPreflight(),
    inspectApk,
    scanAndroidApk,
    async replayIssue(request) {
      return await replayIssue(request, createDriver);
    },
  };
}
