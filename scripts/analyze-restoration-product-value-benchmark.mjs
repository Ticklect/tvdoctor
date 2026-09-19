import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const analyzerPath = fileURLToPath(import.meta.url);

function parseArgs(values) {
  const result = new Map();
  for (let index = 2; index < values.length; index += 2) {
    if (!values[index]?.startsWith("--") || values[index + 1] === undefined) throw new Error("Expected --name value arguments.");
    result.set(values[index].slice(2), values[index + 1]);
  }
  return result;
}

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function evidencePath(path) {
  const candidates = [resolve(root, path), resolve(root, "..", "..", path)];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function pathKey(path) {
  return JSON.stringify(path ?? []);
}

function controlKey(control) {
  if (control === null || control === undefined) return null;
  const identity = [control.stableIdBase, control.role, control.name, control.text]
    .map((value) => value ?? "")
    .join("\u001f");
  return identity.split("\u001f").join("").length === 0 ? null : identity;
}

function setDifference(left, right) {
  return new Set([...left].filter((value) => !right.has(value)));
}

function percentChange(before, after) {
  if (before === 0) return after === 0 ? 0 : null;
  return ((after - before) / before) * 100;
}

function benchmarkRestorationMode(run) {
  if (run.benchmark.restorationMode !== undefined) return run.benchmark.restorationMode;
  if (run.benchmark.restoration === "disabled") return "verified-live-only";
  if (run.benchmark.restoration === "enabled") return "verified-local";
  return null;
}

function rootState(run) {
  return run.benchmark.focusStates.find((state) => pathKey(state.path) === "[]") ?? null;
}

function runGitHead(run) {
  return run.metadata.sourceProvenance?.gitHead ?? run.metadata.commit ?? null;
}

function validatePair(pair, baseline, restoration) {
  const errors = [];
  const warnings = [];
  const equal = (label, left, right) => {
    if (left !== right) errors.push(`${label} mismatch: ${JSON.stringify(left)} != ${JSON.stringify(right)}`);
  };
  if (baseline.metadata.variant !== "baseline") errors.push(`baseline metadata variant is ${JSON.stringify(baseline.metadata.variant)}`);
  if (restoration.metadata.variant !== "restoration") errors.push(`restoration metadata variant is ${JSON.stringify(restoration.metadata.variant)}`);
  if (benchmarkRestorationMode(baseline) !== "verified-live-only") errors.push("baseline evidence is not verified-live-only");
  if (benchmarkRestorationMode(restoration) !== "verified-local") errors.push("restoration evidence is not verified-local");
  equal("target package", baseline.benchmark.targetPackage, restoration.benchmark.targetPackage);
  equal("device", baseline.metadata.device, restoration.metadata.device);
  equal("SDK", baseline.metadata.environment?.sdk ?? null, restoration.metadata.environment?.sdk ?? null);
  equal("build fingerprint", baseline.metadata.environment?.buildFingerprint ?? null, restoration.metadata.environment?.buildFingerprint ?? null);
  equal("display size", baseline.metadata.environment?.displaySize ?? null, restoration.metadata.environment?.displaySize ?? null);
  equal("display density", baseline.metadata.environment?.displayDensity ?? null, restoration.metadata.environment?.displayDensity ?? null);
  equal("APK path", baseline.metadata.apk, restoration.metadata.apk);
  equal("launch component", baseline.metadata.launchComponent, restoration.metadata.launchComponent);
  equal("git HEAD", runGitHead(baseline), runGitHead(restoration));

  const baselineRoot = rootState(baseline);
  const restorationRoot = rootState(restoration);
  if (baselineRoot === null || restorationRoot === null) {
    errors.push("missing root benchmark state");
  } else {
    equal("root state fingerprint", baselineRoot.stateFingerprint, restorationRoot.stateFingerprint);
    equal("root focus fingerprint", baselineRoot.focusFingerprint, restorationRoot.focusFingerprint);
    equal("root location", baselineRoot.location, restorationRoot.location);
  }

  const baselineApkHash = baseline.metadata.apkSha256 ?? null;
  const restorationApkHash = restoration.metadata.apkSha256 ?? null;
  if (baselineApkHash === null || restorationApkHash === null) warnings.push("APK SHA-256 missing from one or both runs");
  else equal("APK SHA-256", baselineApkHash, restorationApkHash);

  for (const key of ["runtimeSourceSha256", "runtimeBuildSha256"]) {
    const left = baseline.metadata.sourceProvenance?.[key] ?? null;
    const right = restoration.metadata.sourceProvenance?.[key] ?? null;
    if (left === null || right === null) warnings.push(`${key} missing from one or both runs`);
    else equal(key, left, right);
  }
  if ((baseline.metadata.sourceProvenance?.gitStatus ?? "").length > 0
    || (restoration.metadata.sourceProvenance?.gitStatus ?? "").length > 0) {
    warnings.push("runtime source was dirty; hashes identify the source/build but the Git commit alone is insufficient to reproduce it");
  }

  const baselineStarted = Date.parse(baseline.metadata.startedAt);
  const restorationStarted = Date.parse(restoration.metadata.startedAt);
  if (Number.isFinite(baselineStarted) && Number.isFinite(restorationStarted)) {
    if (pair.order === "baseline-restoration" && baselineStarted > restorationStarted) errors.push("configured order baseline-restoration contradicts run timestamps");
    if (pair.order === "restoration-baseline" && restorationStarted > baselineStarted) errors.push("configured order restoration-baseline contradicts run timestamps");
  } else {
    warnings.push("one or both run start timestamps are invalid");
  }
  return { valid: errors.length === 0, errors, warnings };
}

async function loadRun(directory) {
  const full = evidencePath(directory);
  const [report, exploration, ledger, benchmark, metadata] = await Promise.all([
    json(resolve(full, "report.json")),
    json(resolve(full, "android-exploration.json")),
    json(resolve(full, "android-coverage-ledger.json")),
    json(resolve(full, "android-restoration-product-value.json")),
    json(resolve(full, "benchmark-run-metadata.json")),
  ]);
  const statePaths = new Set(benchmark.focusStates.map((state) => pathKey(state.path)));
  const screenPaths = new Set(benchmark.screens.map((screen) => pathKey(screen.path)));
  const controls = new Set(benchmark.focusStates.flatMap((state) => state.actionableControls.map(controlKey)).filter(Boolean));
  const transitionPaths = new Set(benchmark.transitions.map((transition) => pathKey(transition.path)));
  const issueIds = new Set(report.issues.map((issue) => issue.id));
  const duplicateIssueCount = report.issues.length - issueIds.size;
  const diagnostics = exploration.restorationDiagnostics ?? [];
  const successfulRestorationDestinations = new Set();
  for (const diagnostic of diagnostics) {
    if (diagnostic.status === "success") successfulRestorationDestinations.add(diagnostic.intendedDestinationStateId);
  }
  return {
    directory,
    report, exploration, ledger, benchmark, metadata,
    statePaths, screenPaths, controls, transitionPaths, issueIds, duplicateIssueCount, successfulRestorationDestinations,
  };
}

function summarizeRun(run) {
  const statistics = run.exploration.statistics;
  const completion = run.exploration.completionEvidence;
  const externalEntries = run.ledger.entries.filter((entry) => entry.destinationPackage !== null
    && entry.destinationPackage !== run.ledger.targetPackage);
  const timeoutFailures = (run.exploration.restorationDiagnostics ?? []).filter((entry) => entry.failureSubtype === "timeout").length;
  return {
    semanticStates: completion.uniqueDiscoveredStates,
    actionableControls: run.controls.size,
    screens: completion.uniqueDiscoveredScreens,
    maxDepth: statistics.maximumPathDepth,
    enteredBranches: run.benchmark.branchEvidence.enteredPolicyStates,
    completedBranches: run.benchmark.branchEvidence.completedPolicyStates.length,
    abandonedBranches: new Set(run.benchmark.branchEvidence.terminalRestorationFailureDestinations).size,
    transitions: completion.uniqueTransitions,
    actions: statistics.physicalActions,
    explorationActions: statistics.explorationActions,
    replayActions: statistics.replayActions,
    restorationCycles: new Set((run.exploration.restorationDiagnostics ?? []).map((entry) => entry.restorationCycleNumber)).size,
    wallRuntimeMs: run.report.run.durationMs,
    explorationRuntimeMs: completion.totalScanDurationMs,
    replayTimeMs: statistics.timings?.pathReplayMs ?? 0,
    resetTimeMs: statistics.timings?.resetMs ?? 0,
    repeatedStates: statistics.repeatedStates ?? 0,
    duplicateStatesCollapsed: completion.duplicateStatesCollapsed,
    findings: run.report.issues.length,
    duplicateFindings: run.duplicateIssueCount,
    appCrashCount: completion.appCrashCount,
    appCrashCountStatus: completion.appCrashCountStatus,
    unsettledActions: statistics.unsettledActions ?? 0,
    restorationTimeoutFailures: timeoutFailures,
    externalSurfaceTransitions: externalEntries.length,
    restorationFailures: completion.restorationFailures,
    termination: run.exploration.termination,
  };
}

function comparePair(pair, baseline, restoration) {
  const integrity = validatePair(pair, baseline, restoration);
  if (!integrity.valid) {
    throw new Error(`Pair integrity failed for ${pair.app} trial ${String(pair.trial)}: ${integrity.errors.join("; ")}`);
  }
  const base = summarizeRun(baseline);
  const restored = summarizeRun(restoration);
  const newStatePaths = setDifference(restoration.statePaths, baseline.statePaths);
  const newScreenPaths = setDifference(restoration.screenPaths, baseline.screenPaths);
  const newControls = setDifference(restoration.controls, baseline.controls);
  const newTransitionPaths = setDifference(restoration.transitionPaths, baseline.transitionPaths);
  const exclusiveIssueIds = setDifference(restoration.issueIds, baseline.issueIds);
  const sharedIssueIds = new Set([...restoration.issueIds].filter((id) => baseline.issueIds.has(id)));
  const restoredDestinationsWithNewCoverage = new Set();
  const stateById = new Map(restoration.benchmark.focusStates.map((state) => [state.id, state]));
  for (const destinationStateId of restoration.successfulRestorationDestinations) {
    const actions = restoration.benchmark.transitions.filter((action) => action.fromFocusStateId === destinationStateId);
    if (actions.some((action) => {
      const destination = stateById.get(action.toFocusStateId);
      return destination !== undefined && newStatePaths.has(pathKey(destination.path));
    })) restoredDestinationsWithNewCoverage.add(destinationStateId);
  }
  const successfulRestorationDestinationCount = restoration.successfulRestorationDestinations.size;
  const reviews = pair.findingReviews ?? [];
  const reviewedIds = new Set(reviews.map((review) => review.issueId));
  const unreviewedExclusiveIssueIds = [...exclusiveIssueIds].filter((id) => !reviewedIds.has(id));
  const attributableUsefulReviews = reviews.filter((review) => exclusiveIssueIds.has(review.issueId)
    && review.restorationAttributable === true
    && (review.category === "clear-actionable-defect" || review.category === "plausible-issue-requiring-review"));
  const incrementalUsefulFindings = unreviewedExclusiveIssueIds.length === 0
    ? attributableUsefulReviews.length
    : null;
  const extraStates = restored.semanticStates - base.semanticStates;
  const extraMinutes = (restored.wallRuntimeMs - base.wallRuntimeMs) / 60_000;
  return {
    app: pair.app,
    trial: pair.trial,
    primary: pair.primary !== false,
    device: baseline.metadata.device,
    integrity,
    baseline: base,
    restoration: restored,
    delta: {
      semanticStates: extraStates,
      semanticStatesPercent: percentChange(base.semanticStates, restored.semanticStates),
      actionableControls: restored.actionableControls - base.actionableControls,
      actionableControlsPercent: percentChange(base.actionableControls, restored.actionableControls),
      screens: restored.screens - base.screens,
      maxDepth: restored.maxDepth - base.maxDepth,
      completedBranches: restored.completedBranches - base.completedBranches,
      actions: restored.actions - base.actions,
      wallRuntimeMs: restored.wallRuntimeMs - base.wallRuntimeMs,
      duplicateStates: restored.repeatedStates - base.repeatedStates,
    },
    restorationOnly: {
      statePaths: [...newStatePaths],
      screenPaths: [...newScreenPaths],
      actionableControls: [...newControls],
      transitionPaths: [...newTransitionPaths],
      issueIds: [...exclusiveIssueIds],
    },
    sharedIssueIds: [...sharedIssueIds],
    findingReviews: reviews,
    unreviewedExclusiveIssueIds,
    incrementalUsefulFindings,
    usefulFindingsPerAdditionalState: incrementalUsefulFindings === null || extraStates <= 0
      ? null
      : incrementalUsefulFindings / extraStates,
    usefulFindingsPerAdditionalMinute: incrementalUsefulFindings === null || extraMinutes <= 0
      ? null
      : incrementalUsefulFindings / extraMinutes,
    restoredDestinationsWithNewCoverage: restoredDestinationsWithNewCoverage.size,
    successfulRestorationDestinations: successfulRestorationDestinationCount,
    restoredDestinationCoverageAssociationRate: successfulRestorationDestinationCount === 0
      ? null
      : restoredDestinationsWithNewCoverage.size / successfulRestorationDestinationCount,
  };
}

const args = parseArgs(process.argv);
const configPath = args.get("config");
const outputPath = args.get("output");
if (configPath === undefined || outputPath === undefined) {
  throw new Error("Usage: node scripts/analyze-restoration-product-value-benchmark.mjs --config PATH --output PATH");
}
const config = await json(evidencePath(configPath));
const comparisons = [];
for (const pair of config.pairs) {
  const [baseline, restoration] = await Promise.all([loadRun(pair.baseline), loadRun(pair.restoration)]);
  comparisons.push(comparePair(pair, baseline, restoration));
}
const primaryComparisons = comparisons.filter((comparison) => comparison.primary);
const aggregate = primaryComparisons.reduce((total, comparison) => {
  for (const mode of ["baseline", "restoration"]) {
    for (const key of ["semanticStates", "actionableControls", "screens", "completedBranches", "actions", "wallRuntimeMs", "replayActions", "replayTimeMs", "resetTimeMs", "repeatedStates", "findings", "duplicateFindings", "restorationFailures", "externalSurfaceTransitions", "unsettledActions", "restorationTimeoutFailures"]) {
      total[mode][key] += comparison[mode][key];
    }
  }
  total.restorationOnlyStatePaths += comparison.restorationOnly.statePaths.length;
  total.restorationOnlyScreenPaths += comparison.restorationOnly.screenPaths.length;
  total.restorationOnlyControls += comparison.restorationOnly.actionableControls.length;
  total.restorationExclusiveFindings += comparison.restorationOnly.issueIds.length;
  if (comparison.incrementalUsefulFindings === null) total.incrementalUsefulFindingsComplete = false;
  else total.incrementalUsefulFindings += comparison.incrementalUsefulFindings;
  total.restoredDestinationsWithNewCoverage += comparison.restoredDestinationsWithNewCoverage;
  total.successfulRestorationDestinations += comparison.successfulRestorationDestinations;
  total.integrityWarnings += comparison.integrity.warnings.length;
  return total;
}, {
  baseline: { semanticStates: 0, actionableControls: 0, screens: 0, completedBranches: 0, actions: 0, wallRuntimeMs: 0, replayActions: 0, replayTimeMs: 0, resetTimeMs: 0, repeatedStates: 0, findings: 0, duplicateFindings: 0, restorationFailures: 0, externalSurfaceTransitions: 0, unsettledActions: 0, restorationTimeoutFailures: 0 },
  restoration: { semanticStates: 0, actionableControls: 0, screens: 0, completedBranches: 0, actions: 0, wallRuntimeMs: 0, replayActions: 0, replayTimeMs: 0, resetTimeMs: 0, repeatedStates: 0, findings: 0, duplicateFindings: 0, restorationFailures: 0, externalSurfaceTransitions: 0, unsettledActions: 0, restorationTimeoutFailures: 0 },
  restorationOnlyStatePaths: 0,
  restorationOnlyScreenPaths: 0,
  restorationOnlyControls: 0,
  restorationExclusiveFindings: 0,
  incrementalUsefulFindings: 0,
  incrementalUsefulFindingsComplete: true,
  restoredDestinationsWithNewCoverage: 0,
  successfulRestorationDestinations: 0,
  integrityWarnings: 0,
});
aggregate.delta = {
  semanticStates: aggregate.restoration.semanticStates - aggregate.baseline.semanticStates,
  semanticStatesPercent: percentChange(aggregate.baseline.semanticStates, aggregate.restoration.semanticStates),
  actionableControls: aggregate.restoration.actionableControls - aggregate.baseline.actionableControls,
  actionableControlsPercent: percentChange(aggregate.baseline.actionableControls, aggregate.restoration.actionableControls),
  screens: aggregate.restoration.screens - aggregate.baseline.screens,
  completedBranches: aggregate.restoration.completedBranches - aggregate.baseline.completedBranches,
  actions: aggregate.restoration.actions - aggregate.baseline.actions,
  wallRuntimeMs: aggregate.restoration.wallRuntimeMs - aggregate.baseline.wallRuntimeMs,
};
aggregate.restoredDestinationCoverageAssociationRate = aggregate.successfulRestorationDestinations === 0
  ? null
  : aggregate.restoredDestinationsWithNewCoverage / aggregate.successfulRestorationDestinations;
if (!aggregate.incrementalUsefulFindingsComplete) aggregate.incrementalUsefulFindings = null;

const analysisSourceSha256 = createHash("sha256").update(await readFile(analyzerPath)).digest("hex");

const output = {
  schema: "tvdoctor.android-restoration-product-value-analysis/v1",
  config: configPath,
  comparisons,
  primaryPairCount: primaryComparisons.length,
  analysisSourceSha256,
  aggregate,
};
await writeFile(resolve(root, outputPath), `${JSON.stringify(output, null, 2)}\n`);
process.stdout.write(`${comparisons.length} paired run(s); ${String(aggregate.incrementalUsefulFindings)} incremental useful finding(s); +${aggregate.delta.semanticStates} semantic states; +${aggregate.delta.actionableControls} actionable controls.\n`);
