import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArguments(argv) {
  const values = new Map();
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("Expected --name value arguments.");
    }
    values.set(key.slice(2), value);
  }
  return values;
}

function command(commandName, args) {
  try {
    return execFileSync(commandName, args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function gitBlob(commit, path) {
  return execFileSync(
    "git",
    ["cat-file", "blob", `${commit}:${path}`],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
}

async function sha256Files(paths) {
  const digest = createHash("sha256");
  for (const path of [...paths].sort()) {
    digest.update(path);
    digest.update("\0");
    digest.update(await readFile(resolve(root, path)));
    digest.update("\0");
  }
  return digest.digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Hex(value, name) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256 hex digest.`);
  }
  return value;
}

async function servedResourceBundleSha256(targetUrl, resourcePaths) {
  const digest = createHash("sha256");
  for (const resourcePath of [...resourcePaths].sort()) {
    const url = new URL(resourcePath, targetUrl);
    if (url.origin !== targetUrl.origin) throw new Error(`Provenance resource escaped target origin: ${resourcePath}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch provenance resource ${url.href}: ${response.status}`);
    digest.update(resourcePath);
    digest.update("\0");
    digest.update(Buffer.from(await response.arrayBuffer()));
    digest.update("\0");
  }
  return digest.digest("hex");
}

function trackedFiles(pathspecs) {
  const output = command("git", ["ls-files", "--", ...pathspecs]);
  return output === null || output.length === 0
    ? []
    : output.split(/\r?\n/u).filter((value) => value.length > 0);
}

async function filesRecursive(relativeDirectory) {
  const absoluteDirectory = resolve(root, relativeDirectory);
  const result = [];
  const pending = [{ absolute: absoluteDirectory, relative: relativeDirectory }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    const entries = await readdir(current.absolute, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = resolve(current.absolute, entry.name);
      const relative = `${current.relative}/${entry.name}`.replaceAll("\\", "/");
      if (entry.isDirectory()) pending.push({ absolute, relative });
      else if (entry.isFile() && /\.(?:js|json)$/u.test(entry.name)) result.push(relative);
    }
  }
  return result.sort();
}

function focusStableId(snapshot) {
  return snapshot.focusedElement.status === "available"
    ? snapshot.focusedElement.value?.stableId ?? null
    : null;
}

function locationValue(snapshot) {
  return snapshot.location.status === "available" ? snapshot.location.value : null;
}

function findingTarget(finding) {
  switch (finding.issue.rule) {
    case "remote.reachability":
      return finding.target.element?.stableId ?? null;
    case "remote.focus-trap":
    case "remote.unexpected-jump":
    case "remote.back-behaviour":
      return finding.source.element?.stableId ?? null;
    default:
      return finding.target.element?.stableId ?? finding.source.element?.stableId ?? null;
  }
}

function findingEvidence(finding) {
  return {
    issueId: finding.issue.id,
    rule: finding.issue.rule,
    severity: finding.issue.severity,
    confidence: finding.issue.confidence,
    classification: finding.classification,
    targetStableId: findingTarget(finding),
    source: finding.source,
    target: finding.target,
    reproduction: finding.issue.reproduction,
  };
}

const args = parseArguments(process.argv);
const variant = args.get("variant");
const output = args.get("output");
const trial = args.get("trial");
const configPathValue = args.get("config");

if (!['baseline', 'restoration'].includes(variant ?? "")
  || output === undefined
  || trial === undefined
  || trial.length === 0
  || configPathValue === undefined) {
  throw new Error(
    "Usage: node scripts/run-northstar-restoration-recall.mjs --variant baseline|restoration --output PATH --trial ID --config PATH",
  );
}

const configAbsolute = resolve(root, configPathValue);
const configText = await readFile(configAbsolute, "utf8");
const config = JSON.parse(configText);
const lockedConfigSha256 = sha256Text(configText);
if (typeof config.baseCommit !== "string" || !/^[a-f0-9]{40}$/u.test(config.baseCommit)) {
  throw new Error("Benchmark config baseCommit must be a full lowercase Git SHA.");
}
if (typeof config.groundTruthManifest !== "string"
  || config.groundTruthManifest.length === 0
  || config.groundTruthManifest.startsWith("/")
  || config.groundTruthManifest.includes("\\")
  || config.groundTruthManifest.split("/").includes("..")) {
  throw new Error("Benchmark config groundTruthManifest must be a safe repository-relative path.");
}
const canonicalManifestSha256 = createHash("sha256")
  .update(gitBlob(config.baseCommit, config.groundTruthManifest))
  .digest("hex");
const lockedManifestSha256 = sha256Hex(config.groundTruthManifestSha256, "groundTruthManifestSha256");
if (lockedManifestSha256 !== canonicalManifestSha256) {
  throw new Error(
    `Benchmark config ground-truth manifest SHA does not match ${config.baseCommit}:${config.groundTruthManifest}.`,
  );
}
const target = config.target;
const budgetMs = config.equalWallClockBudgetMs;
const resourcePaths = Array.isArray(config.provenanceResourcePaths) ? config.provenanceResourcePaths : [];
const expectedServedDocumentSha256 = sha256Hex(config.servedDocumentSha256, "servedDocumentSha256");
const expectedServedResourceSha256 = sha256Hex(config.servedResourceSha256, "servedResourceSha256");
if (typeof target !== "string"
  || !Number.isSafeInteger(budgetMs)
  || budgetMs <= 0
  || config.profile !== "deep"
  || config.actionPolicy !== "production-safe-web-navigation"
  || resourcePaths.length === 0
  || resourcePaths.some((value) => typeof value !== "string" || !value.startsWith("/") || value.includes(".."))) {
  throw new Error("Benchmark config target/budget/profile/action policy/provenance resources are invalid.");
}

const targetUrl = new URL(target);
if (!['http:', 'https:'].includes(targetUrl.protocol)) {
  throw new Error("Northstar benchmark target must be an HTTP(S) URL.");
}

const outputPath = resolve(root, output);
if (existsSync(outputPath)) throw new Error(`Output already exists: ${outputPath}`);
await mkdir(outputPath, { recursive: true });

const runtimeSourceFiles = trackedFiles([
  "packages/core/src",
  "packages/driver-web/src",
  "packages/cli/src/node-audit-navigation.ts",
  "packages/pack-web/src",
  "packages/protocol/src",
]);
const fixtureRuntimeFiles = trackedFiles([
  "fixtures/broken-streaming-web/src",
  "fixtures/broken-streaming-web/index.html",
]);
const buildFiles = [
  ...await filesRecursive("packages/core/dist"),
  ...await filesRecursive("packages/driver-web/dist"),
  ...await filesRecursive("packages/pack-web/dist"),
  ...await filesRecursive("packages/protocol/dist"),
  "packages/cli/dist/node-audit-navigation.js",
];
const runnerRelativePath = "scripts/run-northstar-restoration-recall.mjs";
const provenanceStatusPaths = [
  ...runtimeSourceFiles,
  ...fixtureRuntimeFiles,
  runnerRelativePath,
];
const productStatusPaths = [
  "packages/core/src",
  "packages/driver-web/src",
  "packages/cli/src/node-audit-navigation.ts",
  "packages/pack-web/src",
  "packages/protocol/src",
  "fixtures/broken-streaming-web/src",
  "fixtures/broken-streaming-web/index.html",
];
const productGitStatus = command("git", ["status", "--short", "--", ...productStatusPaths]);
if (command("git", ["rev-parse", "HEAD"]) !== config.baseCommit) {
  throw new Error(`Benchmark must run at configured baseCommit ${config.baseCommit}.`);
}
if (productGitStatus !== null && productGitStatus.length > 0) {
  throw new Error(`Benchmark product/fixture source is dirty:\n${productGitStatus}`);
}

const [{ PlaywrightWebDriver }, core, navigationModule] = await Promise.all([
  import("../packages/driver-web/dist/index.js"),
  import("../packages/core/dist/index.js"),
  import("../packages/cli/dist/node-audit-navigation.js"),
]);
const {
  diagnoseNavigation,
  explore,
  fingerprintSnapshot,
} = core;
const { createSafeExplorationDriver } = navigationModule;

const driver = new PlaywrightWebDriver({
  settle: {
    noResponseGraceMs: 15,
    quietWindowMs: 20,
    timeoutMs: 2_500,
  },
  artifactsDirectory: outputPath,
});

const restorationMode = variant === "baseline" ? "verified-live-only" : "verified-local";
const restorationReceipts = [];
const startedAt = new Date().toISOString();
const totalStartedAt = performance.now();
let exploration = null;
let findings = [];
let browserVersion;
let thrown = null;
let servedDocumentSha256;
let servedResourceSha256;
const supplementaryArtifacts = {
  initialScreenshot: "unavailable",
  finalScreenshot: "unavailable",
};

try {
  await driver.launch({ id: `northstar-restoration-${trial}-${variant}`, launchUri: targetUrl.href });
  browserVersion = driver.getPage().context().browser()?.version() ?? null;
  servedDocumentSha256 = sha256Text(await driver.getPage().content());
  servedResourceSha256 = await servedResourceBundleSha256(targetUrl, resourcePaths);
  if (servedDocumentSha256 !== expectedServedDocumentSha256) {
    throw new Error(
      `Served Northstar document hash ${servedDocumentSha256} does not match configured ${expectedServedDocumentSha256}.`,
    );
  }
  if (servedResourceSha256 !== expectedServedResourceSha256) {
    throw new Error(
      `Served Northstar resource hash ${servedResourceSha256} does not match configured ${expectedServedResourceSha256}.`,
    );
  }
  try {
    await driver.captureScreenshot(resolve(outputPath, "initial.png"));
    supplementaryArtifacts.initialScreenshot = "available";
  } catch (error) {
    supplementaryArtifacts.initialScreenshot = `unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }

  const restoreInitialSnapshot = async (options) => {
    const restoreStartedAt = performance.now();
    await driver.reset("reload", options);
    const snapshot = await driver.snapshot(options);
    const fingerprint = fingerprintSnapshot(snapshot);
    restorationReceipts.push({
      index: restorationReceipts.length + 1,
      elapsedMs: Math.max(0, performance.now() - restoreStartedAt),
      stateFingerprint: fingerprint.stateValue,
      screenFingerprint: fingerprint.screen.value,
      focusFingerprint: fingerprint.focus.value,
      focusStableId: focusStableId(snapshot),
      location: locationValue(snapshot),
    });
    return snapshot;
  };

  const settling = {
    strategy: "stable-snapshot",
    maxSnapshots: 3,
    pollIntervalMs: 20,
    requiredStableSnapshots: 2,
  };
  const explorationStartedAt = performance.now();
  exploration = await explore(createSafeExplorationDriver(driver), {
    profile: "deep",
    budgets: { maxDurationMs: budgetMs },
    restorationMode,
    allowRootRestorationFallback: variant === "restoration",
    refreshVisibleSelfLoops: false,
    replayActions: ["UP", "DOWN", "LEFT", "RIGHT", "SELECT"],
    restoreInitialSnapshot,
    settling,
    replaySettling: settling,
  });
  const explorationWallRuntimeMs = Math.max(0, performance.now() - explorationStartedAt);
  findings = diagnoseNavigation(exploration).findings;

  const rootOrigin = targetUrl.origin;
  const externalStates = exploration.graph.focus.states.filter((state) => {
    const location = locationValue(state.representativeSnapshot);
    if (location === null) return false;
    try {
      return new URL(location).origin !== rootOrigin;
    } catch {
      return true;
    }
  });
  const attemptedByState = new Map();
  for (const action of exploration.graph.actions) {
    const attempted = attemptedByState.get(action.fromFocusStateId) ?? new Set();
    attempted.add(action.key);
    attemptedByState.set(action.fromFocusStateId, attempted);
  }
  const completedBranches = [...attemptedByState.values()].filter((actions) => (
    exploration.actionOrder.every((key) => actions.has(key))
  )).length;

  try {
    await driver.captureScreenshot(resolve(outputPath, "final.png"));
    supplementaryArtifacts.finalScreenshot = "available";
  } catch (error) {
    supplementaryArtifacts.finalScreenshot = `unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }

  const restorationDiagnostics = exploration.restorationDiagnostics ?? [];
  const cyclesByState = new Map();
  for (const diagnostic of restorationDiagnostics) {
    const cycles = cyclesByState.get(diagnostic.destinationStateId) ?? new Map();
    const entries = cycles.get(diagnostic.restorationCycleNumber) ?? [];
    entries.push(diagnostic);
    cycles.set(diagnostic.restorationCycleNumber, entries);
    cyclesByState.set(diagnostic.destinationStateId, cycles);
  }
  const precedingRestorationFor = (transition) => {
    const cycles = cyclesByState.get(transition.fromFocusStateId);
    if (cycles === undefined) return null;
    const orderedCycleNumbers = [...cycles.keys()].sort((left, right) => left - right);
    const actionIndex = exploration.actionOrder.indexOf(transition.key);
    if (actionIndex < 0 || actionIndex >= orderedCycleNumbers.length) return null;
    const cycleNumber = orderedCycleNumbers[actionIndex];
    const entries = cycles.get(cycleNumber) ?? [];
    return entries.at(-1) ?? null;
  };

  const result = {
    schema: "tvdoctor.northstar-restoration-recall-run/v1",
    metadata: {
      trial,
      variant,
      restorationMode,
      profile: "deep",
      actionPolicy: "production-safe-web-navigation",
      target: targetUrl.href,
      equalWallClockBudgetMs: budgetMs,
      configPath: configPathValue.replaceAll("\\", "/"),
      configSha256: lockedConfigSha256,
      groundTruthManifestSha256: lockedManifestSha256,
      provenanceResourcePaths: resourcePaths,
      startedAt,
      completedAt: new Date().toISOString(),
      browserVersion,
      nodeVersion: process.version,
      platform: `${process.platform}/${process.arch}`,
      sourceProvenance: {
        gitHead: command("git", ["rev-parse", "HEAD"]),
        gitStatus: command("git", ["status", "--short", "--", ...provenanceStatusPaths]),
        runtimeSourceSha256: runtimeSourceFiles.length === 0 ? null : await sha256Files(runtimeSourceFiles),
        fixtureRuntimeSha256: fixtureRuntimeFiles.length === 0 ? null : await sha256Files(fixtureRuntimeFiles),
        runtimeBuildSha256: buildFiles.length === 0 ? null : await sha256Files(buildFiles),
        runnerSha256: await sha256Files([runnerRelativePath]),
        servedDocumentSha256,
        servedResourceSha256,
      },
      treatmentDefinition: restorationMode === "verified-live-only"
        ? "exact verified live-state continuation only; verified local-path reconstruction and root replay disabled"
        : "verified live-state continuation plus verified local-path reconstruction and bounded root replay fallback",
    },
    metrics: {
      explorationWallRuntimeMs,
      totalRunnerRuntimeMs: Math.max(0, performance.now() - totalStartedAt),
      actions: exploration.statistics.physicalActions,
      explorationActions: exploration.statistics.explorationActions,
      replayActions: exploration.statistics.replayActions,
      states: exploration.statistics.focusStates,
      appOwnedScreens: exploration.statistics.screenStates,
      maximumDepth: exploration.statistics.maximumPathDepth,
      completedBranches,
      findings: findings.length,
      restorationCycles: new Set(restorationDiagnostics.map((entry) => entry.restorationCycleNumber)).size,
      restorationAttempts: exploration.statistics.restorationAttempts ?? 0,
      restorationSuccesses: exploration.statistics.restorationSuccesses ?? 0,
      restorationFailures: exploration.statistics.restorationFailures ?? 0,
      resetCount: exploration.statistics.resetCount,
      resetTimeMs: exploration.statistics.timings.resetMs,
      replayTimeMs: exploration.statistics.timings.pathReplayMs,
      systemSurfaceEscapes: externalStates.length,
    },
    termination: exploration.termination,
    supplementaryArtifacts,
    rootRestorations: restorationReceipts,
    focusStates: exploration.graph.focus.states.map((state) => ({
      id: state.id,
      screenStateId: state.screenStateId,
      firstSeenDepth: state.firstSeenDepth,
      path: state.discoveredBy,
      stateFingerprint: state.stateFingerprint,
      focusFingerprint: state.fingerprint.value,
      focusStableId: focusStableId(state.representativeSnapshot),
      location: locationValue(state.representativeSnapshot),
    })),
    screens: exploration.graph.screens.states.map((state) => ({
      id: state.id,
      firstSeenDepth: state.firstSeenDepth,
      path: state.discoveredBy,
      screenFingerprint: state.fingerprint.value,
      location: locationValue(state.representativeSnapshot),
    })),
    transitions: exploration.graph.actions.map((action) => ({
      id: action.id,
      fromFocusStateId: action.fromFocusStateId,
      toFocusStateId: action.toFocusStateId,
      fromScreenStateId: action.fromScreenStateId,
      toScreenStateId: action.toScreenStateId,
      action: action.key,
      path: action.actionSequence,
      outcome: action.actionResult.outcome,
      precedingRestoration: precedingRestorationFor(action),
    })),
    findings: findings.map((finding) => findingEvidence(finding)),
    restorationDiagnostics,
  };
  await writeFile(resolve(outputPath, "run.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
} catch (error) {
  thrown = error instanceof Error ? error.stack ?? error.message : String(error);
  await writeFile(resolve(outputPath, "error.txt"), `${thrown}\n`, "utf8");
} finally {
  await driver.close().catch(() => undefined);
}

if (thrown !== null) throw new Error(thrown);
process.stdout.write(
  `${trial} ${variant}: ${String(exploration?.termination.reason)}; ${String(exploration?.statistics.focusStates ?? 0)} states; ${String(findings.length)} finding(s)\n`,
);
