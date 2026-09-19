import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArguments(argv) {
  const values = new Map();
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("Expected --name value arguments.");
    values.set(key.slice(2), value);
  }
  return values;
}

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readGitBlob(commit, path) {
  if (!/^[a-f0-9]{40}$/u.test(commit)) {
    throw new Error(`Configured baseCommit is not a full Git SHA: ${JSON.stringify(commit)}`);
  }
  if (typeof path !== "string"
    || path.length === 0
    || path.startsWith("/")
    || path.includes("\\")
    || path.split("/").includes("..")) {
    throw new Error(`Configured groundTruthManifest is not a safe repository path: ${JSON.stringify(path)}`);
  }
  return execFileSync(
    "git",
    ["cat-file", "blob", `${commit}:${path}`],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

function mean(values) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function meanOrNull(values) {
  return values.length === 0 ? null : mean(values);
}

function safeRatio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function keyForSeed(seed) {
  return `${seed.expectedRule}|${seed.target}`;
}

function keyForFinding(finding) {
  return `${finding.rule}|${finding.targetStableId ?? "<none>"}`;
}

function counts(values) {
  const result = new Map();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

function runSummary(run, seeds, detectorRules) {
  const expectedByKey = new Map(seeds.map((seed) => [keyForSeed(seed), seed]));
  const scopedFindings = run.findings.filter((finding) => detectorRules.has(finding.rule));
  const outOfScopeNavigationDiagnostics = run.findings.filter((finding) => !detectorRules.has(finding.rule));
  const observedKeys = scopedFindings.map((finding) => keyForFinding(finding));
  const observedCounts = counts(observedKeys);
  const detected = seeds.filter((seed) => (observedCounts.get(keyForSeed(seed)) ?? 0) > 0);
  const missed = seeds.filter((seed) => (observedCounts.get(keyForSeed(seed)) ?? 0) === 0);
  const falsePositives = scopedFindings.filter((finding) => !expectedByKey.has(keyForFinding(finding)));
  const duplicateFindings = [...observedCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key, count]) => ({ key, duplicatesBeyondFirst: count - 1 }));
  const ambiguousFindings = scopedFindings.filter((finding) => finding.targetStableId === null);
  const runtimeMinutes = run.metrics.explorationWallRuntimeMs / 60_000;
  const truePositiveCount = detected.length;
  const uniqueFalsePositiveCount = new Set(falsePositives.map((finding) => keyForFinding(finding))).size;
  return {
    trial: run.metadata.trial,
    variant: run.metadata.variant,
    termination: run.termination,
    metrics: run.metrics,
    truePositiveCount,
    detectedDefectIds: detected.map((seed) => seed.id).sort(),
    missedDefectIds: missed.map((seed) => seed.id).sort(),
    recall: safeRatio(truePositiveCount, seeds.length),
    falsePositiveCount: falsePositives.length,
    uniqueFalsePositiveCount,
    falsePositives,
    duplicateFindingCount: duplicateFindings.reduce((sum, entry) => sum + entry.duplicatesBeyondFirst, 0),
    duplicateFindings,
    ambiguousFindingCount: ambiguousFindings.length,
    ambiguousFindings,
    scopedFindingCount: scopedFindings.length,
    outOfScopeNavigationDiagnosticCount: outOfScopeNavigationDiagnostics.length,
    outOfScopeNavigationDiagnostics,
    findingsPerMinute: safeRatio(scopedFindings.length, runtimeMinutes),
    allNavigationFindingsPerMinute: safeRatio(run.findings.length, runtimeMinutes),
    trueSeededDefectsPerMinute: safeRatio(truePositiveCount, runtimeMinutes),
    actionsPerTrueDefect: safeRatio(run.metrics.actions, truePositiveCount),
    runtimeMsPerTrueDefect: safeRatio(run.metrics.explorationWallRuntimeMs, truePositiveCount),
  };
}

function validatePair(config, configSha256, runManifestSha256, pair, baseline, restoration) {
  const errors = [];
  const warnings = [];
  const equal = (label, left, right) => {
    if (left !== right) errors.push(`${label} differs: ${JSON.stringify(left)} vs ${JSON.stringify(right)}`);
  };
  if (baseline.metadata.variant !== "baseline") errors.push(`baseline metadata variant is ${JSON.stringify(baseline.metadata.variant)}`);
  if (restoration.metadata.variant !== "restoration") errors.push(`restoration metadata variant is ${JSON.stringify(restoration.metadata.variant)}`);
  if (baseline.metadata.trial !== pair.id) errors.push(`baseline trial ${JSON.stringify(baseline.metadata.trial)} does not match pair ${JSON.stringify(pair.id)}`);
  if (restoration.metadata.trial !== pair.id) errors.push(`restoration trial ${JSON.stringify(restoration.metadata.trial)} does not match pair ${JSON.stringify(pair.id)}`);
  if (baseline.metadata.target !== config.target) errors.push(`baseline target does not match config target ${JSON.stringify(config.target)}`);
  if (restoration.metadata.target !== config.target) errors.push(`restoration target does not match config target ${JSON.stringify(config.target)}`);
  if (baseline.metadata.equalWallClockBudgetMs !== config.equalWallClockBudgetMs) errors.push("baseline wall-clock budget does not match config");
  if (restoration.metadata.equalWallClockBudgetMs !== config.equalWallClockBudgetMs) errors.push("restoration wall-clock budget does not match config");
  if (baseline.metadata.profile !== config.profile || restoration.metadata.profile !== config.profile) errors.push("one or both profiles do not match config");
  if (baseline.metadata.actionPolicy !== config.actionPolicy || restoration.metadata.actionPolicy !== config.actionPolicy) errors.push("one or both action policies do not match config");
  if (baseline.metadata.configSha256 !== configSha256 || restoration.metadata.configSha256 !== configSha256) errors.push("one or both runs are not bound to the analyzed config SHA-256");
  if (baseline.metadata.groundTruthManifestSha256 !== runManifestSha256
    || restoration.metadata.groundTruthManifestSha256 !== runManifestSha256) {
    errors.push("one or both runs are not bound to the analyzed ground-truth manifest SHA-256");
  }
  if (JSON.stringify(baseline.metadata.provenanceResourcePaths) !== JSON.stringify(config.provenanceResourcePaths)
    || JSON.stringify(restoration.metadata.provenanceResourcePaths) !== JSON.stringify(config.provenanceResourcePaths)) {
    errors.push("one or both run provenance resource paths do not match config");
  }
  equal("target", baseline.metadata.target, restoration.metadata.target);
  equal("wall-clock budget", baseline.metadata.equalWallClockBudgetMs, restoration.metadata.equalWallClockBudgetMs);
  equal("browser version", baseline.metadata.browserVersion, restoration.metadata.browserVersion);
  equal("Node version", baseline.metadata.nodeVersion, restoration.metadata.nodeVersion);
  equal("platform", baseline.metadata.platform, restoration.metadata.platform);
  equal("runtime source hash", baseline.metadata.sourceProvenance.runtimeSourceSha256, restoration.metadata.sourceProvenance.runtimeSourceSha256);
  equal("fixture runtime hash", baseline.metadata.sourceProvenance.fixtureRuntimeSha256, restoration.metadata.sourceProvenance.fixtureRuntimeSha256);
  equal("runtime build hash", baseline.metadata.sourceProvenance.runtimeBuildSha256, restoration.metadata.sourceProvenance.runtimeBuildSha256);
  equal("runner hash", baseline.metadata.sourceProvenance.runnerSha256, restoration.metadata.sourceProvenance.runnerSha256);
  equal("served document hash", baseline.metadata.sourceProvenance.servedDocumentSha256, restoration.metadata.sourceProvenance.servedDocumentSha256);
  equal("served resource hash", baseline.metadata.sourceProvenance.servedResourceSha256, restoration.metadata.sourceProvenance.servedResourceSha256);
  equal("git HEAD", baseline.metadata.sourceProvenance.gitHead, restoration.metadata.sourceProvenance.gitHead);
  equal("git status", baseline.metadata.sourceProvenance.gitStatus, restoration.metadata.sourceProvenance.gitStatus);
  if (baseline.metadata.sourceProvenance.gitHead !== config.baseCommit
    || restoration.metadata.sourceProvenance.gitHead !== config.baseCommit) {
    errors.push(`one or both runs were not executed at configured baseCommit ${config.baseCommit}`);
  }
  if (baseline.metadata.sourceProvenance.fixtureRuntimeSha256 !== config.fixtureRuntimeSha256
    || restoration.metadata.sourceProvenance.fixtureRuntimeSha256 !== config.fixtureRuntimeSha256) {
    errors.push("one or both runs do not match the configured frozen fixture source hash");
  }
  if (baseline.metadata.sourceProvenance.servedResourceSha256 !== config.servedResourceSha256
    || restoration.metadata.sourceProvenance.servedResourceSha256 !== config.servedResourceSha256) {
    errors.push("one or both runs do not match the configured served Northstar resource hash");
  }
  if (baseline.metadata.sourceProvenance.servedDocumentSha256 !== config.servedDocumentSha256
    || restoration.metadata.sourceProvenance.servedDocumentSha256 !== config.servedDocumentSha256) {
    errors.push("one or both runs do not match the configured served Northstar document hash");
  }
  if (baseline.metadata.restorationMode !== config.baselineRestorationMode) errors.push("baseline restoration mode does not match config");
  if (restoration.metadata.restorationMode !== config.treatmentRestorationMode) errors.push("restoration arm mode does not match config");
  const baselineRoot = baseline.rootRestorations[0];
  const restorationRoot = restoration.rootRestorations[0];
  if (baselineRoot === undefined || restorationRoot === undefined) {
    errors.push("one or both arms lack an initial root restoration receipt");
  } else {
    equal("initial root state fingerprint", baselineRoot.stateFingerprint, restorationRoot.stateFingerprint);
    equal("initial root focus", baselineRoot.focusStableId, restorationRoot.focusStableId);
    equal("initial root location", baselineRoot.location, restorationRoot.location);
  }
  const baselineStarted = Date.parse(baseline.metadata.startedAt);
  const baselineCompleted = Date.parse(baseline.metadata.completedAt);
  const restorationStarted = Date.parse(restoration.metadata.startedAt);
  const restorationCompleted = Date.parse(restoration.metadata.completedAt);
  if (Number.isFinite(baselineStarted) && Number.isFinite(baselineCompleted)
    && Number.isFinite(restorationStarted) && Number.isFinite(restorationCompleted)) {
    if (pair.order === "baseline-restoration" && baselineStarted > restorationStarted) {
      errors.push("configured baseline-restoration order contradicts timestamps");
    }
    if (pair.order === "baseline-restoration" && baselineCompleted > restorationStarted) {
      errors.push("baseline and restoration runs overlap or contradict configured baseline-restoration order");
    }
    if (pair.order === "restoration-baseline" && restorationStarted > baselineStarted) {
      errors.push("configured restoration-baseline order contradicts timestamps");
    }
    if (pair.order === "restoration-baseline" && restorationCompleted > baselineStarted) {
      errors.push("restoration and baseline runs overlap or contradict configured restoration-baseline order");
    }
  } else {
    errors.push("one or more run timestamps are invalid");
  }
  const statusValues = [baseline.metadata.sourceProvenance.gitStatus, restoration.metadata.sourceProvenance.gitStatus];
  if (statusValues.some((value) => typeof value === "string" && value.length > 0)) {
    warnings.push("runtime/fixture source paths were dirty; hashes, status text, and Git HEAD are retained in each run");
  }
  return { valid: errors.length === 0, errors, warnings };
}

function depthBucket(depth) {
  if (depth <= 1) return "shallow";
  if (depth === 2) return "medium";
  return "deep";
}

function depthRecall(summary, seeds) {
  const detected = new Set(summary.detectedDefectIds);
  const buckets = new Map();
  for (const seed of seeds) {
    const bucket = depthBucket(seed.minimumDepth);
    const current = buckets.get(bucket) ?? { known: 0, detected: 0, defectIds: [] };
    current.known += 1;
    current.detected += detected.has(seed.id) ? 1 : 0;
    current.defectIds.push(seed.id);
    buckets.set(bucket, current);
  }
  return Object.fromEntries([...buckets.entries()].map(([bucket, value]) => [bucket, {
    ...value,
    recall: safeRatio(value.detected, value.known),
  }]));
}

function treatmentRestorationAssociation(run, defectId, seeds) {
  const seed = seeds.find((entry) => entry.id === defectId);
  if (seed === undefined) return null;
  const finding = run.findings.find((entry) => keyForFinding(entry) === keyForSeed(seed));
  if (finding === undefined) return null;
  const attemptId = finding.source.actionAttemptId;
  if (attemptId === null) return null;
  const transition = run.transitions.find((entry) => entry.id === attemptId);
  if (transition === undefined) return null;
  const restoration = transition.precedingRestoration;
  if (restoration === null || restoration === undefined) return null;
  const treatmentSpecific = restoration.status === "success"
    && restoration.destinationStateId === finding.source.focusStateId
    && (restoration.strategy === "verified-local-path" || restoration.strategy === "root-replay");
  const state = run.focusStates.find((entry) => entry.id === finding.source.focusStateId);
  return {
    strength: treatmentSpecific
      ? "finding-action-immediately-preceded-by-treatment-restoration"
      : "finding-action-preceded-by-non-treatment-restoration",
    sourceFocusStateId: finding.source.focusStateId,
    sourcePath: state?.path ?? finding.source.actionSequence,
    findingActionAttemptId: attemptId,
    findingAction: transition.action,
    restoration,
    causalClaim: treatmentSpecific,
    caveat: treatmentSpecific
      ? null
      : "The finding-producing action was not immediately preceded by a successful verified-local-path or root-replay restoration to its source state.",
  };
}

const args = parseArguments(process.argv);
const configPath = args.get("config");
const outputPath = args.get("output");
if (configPath === undefined || outputPath === undefined) {
  throw new Error("Usage: node scripts/analyze-northstar-restoration-recall.mjs --config PATH --output PATH");
}

const configAbsolute = resolve(root, configPath);
const outputAbsolute = resolve(root, outputPath);
const configText = await readFile(configAbsolute, "utf8");
const config = JSON.parse(configText);
const manifestText = readGitBlob(config.baseCommit, config.groundTruthManifest);
const manifest = JSON.parse(manifestText);
const configSha256 = sha256(configText);
const runManifestSha256 = config.groundTruthManifestSha256;
if (typeof runManifestSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(runManifestSha256)) {
  throw new Error("config groundTruthManifestSha256 must be a lowercase SHA-256 hex digest.");
}
const canonicalManifestSha256 = sha256(manifestText);
if (runManifestSha256 !== canonicalManifestSha256) {
  throw new Error(
    `Configured ground-truth manifest SHA does not match ${config.baseCommit}:${config.groundTruthManifest}.`,
  );
}
for (const [name, value] of [
  ["servedDocumentSha256", config.servedDocumentSha256],
  ["servedResourceSha256", config.servedResourceSha256],
]) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`config ${name} must be a lowercase SHA-256 hex digest.`);
  }
}

const detectorRules = new Set(config.inScopeDetectorRules);
const depthById = new Map(Object.entries(config.minimumDepthByDefectId));
const inScopeSeeds = manifest.defects
  .filter((seed) => detectorRules.has(seed.expectedRule))
  .map((seed) => ({
    ...seed,
    minimumDepth: depthById.get(seed.id),
  }));
if (inScopeSeeds.some((seed) => !Number.isSafeInteger(seed.minimumDepth) || seed.minimumDepth < 0)) {
  throw new Error("Every in-scope seed must have a non-negative integer minimumDepth in the benchmark config.");
}

const pairs = [];
for (const pair of config.pairs) {
  const [baseline, restoration] = await Promise.all([
    json(resolve(root, pair.baseline, "run.json")),
    json(resolve(root, pair.restoration, "run.json")),
  ]);
  const integrity = validatePair(config, configSha256, runManifestSha256, pair, baseline, restoration);
  const baselineSummary = runSummary(baseline, inScopeSeeds, detectorRules);
  const restorationSummary = runSummary(restoration, inScopeSeeds, detectorRules);
  const baseDetected = new Set(baselineSummary.detectedDefectIds);
  const restoredDetected = new Set(restorationSummary.detectedDefectIds);
  const restorationOnly = inScopeSeeds.filter((seed) => !baseDetected.has(seed.id) && restoredDetected.has(seed.id));
  const baselineOnly = inScopeSeeds.filter((seed) => baseDetected.has(seed.id) && !restoredDetected.has(seed.id));
  const both = inScopeSeeds.filter((seed) => baseDetected.has(seed.id) && restoredDetected.has(seed.id));
  const missedBoth = inScopeSeeds.filter((seed) => !baseDetected.has(seed.id) && !restoredDetected.has(seed.id));
  pairs.push({
    id: pair.id,
    order: pair.order,
    integrity,
    baseline: baselineSummary,
    restoration: restorationSummary,
    classifications: {
      both: both.map((seed) => seed.id),
      restorationOnly: restorationOnly.map((seed) => seed.id),
      baselineOnly: baselineOnly.map((seed) => seed.id),
      missedBoth: missedBoth.map((seed) => seed.id),
    },
    depthRecall: {
      baseline: depthRecall(baselineSummary, inScopeSeeds),
      restoration: depthRecall(restorationSummary, inScopeSeeds),
    },
    restorationOnlyAttribution: restorationOnly.map((seed) => ({
      defectId: seed.id,
      association: treatmentRestorationAssociation(restoration, seed.id, inScopeSeeds),
    })),
    efficiencyDelta: {
      additionalStates: restorationSummary.metrics.states - baselineSummary.metrics.states,
      additionalScreens: restorationSummary.metrics.appOwnedScreens - baselineSummary.metrics.appOwnedScreens,
      additionalActions: restorationSummary.metrics.actions - baselineSummary.metrics.actions,
      additionalRuntimeMs: restorationSummary.metrics.explorationWallRuntimeMs - baselineSummary.metrics.explorationWallRuntimeMs,
      usefulRestorationOnlyDefects: restorationOnly.length,
      usefulDefectsPerAdditionalScreen: safeRatio(
        restorationOnly.length,
        Math.max(0, restorationSummary.metrics.appOwnedScreens - baselineSummary.metrics.appOwnedScreens),
      ),
    },
  });
}

const allValid = pairs.every((pair) => pair.integrity.valid);
if (!allValid) {
  const details = pairs
    .filter((pair) => !pair.integrity.valid)
    .flatMap((pair) => pair.integrity.errors.map((error) => `${pair.id}: ${error}`));
  throw new Error(`Northstar benchmark pair integrity failed:\n${details.join("\n")}`);
}
const defectClassifications = inScopeSeeds.map((seed) => {
  const statuses = pairs.map((pair) => {
    if (pair.classifications.both.includes(seed.id)) return "both";
    if (pair.classifications.restorationOnly.includes(seed.id)) return "restoration-only";
    if (pair.classifications.baselineOnly.includes(seed.id)) return "baseline-only";
    return "missed-both";
  });
  const unique = [...new Set(statuses)];
  return {
    defectId: seed.id,
    category: seed.expectedRule,
    minimumDepth: seed.minimumDepth,
    depthBucket: depthBucket(seed.minimumDepth),
    perPair: statuses,
    classification: unique.length === 1 ? unique[0] : "inconclusive",
  };
});

const aggregateMode = (mode) => {
  const summaries = pairs.map((pair) => pair[mode]);
  return {
    meanRecall: mean(summaries.map((summary) => summary.recall ?? 0)),
    meanTruePositives: mean(summaries.map((summary) => summary.truePositiveCount)),
    meanFalsePositives: mean(summaries.map((summary) => summary.falsePositiveCount)),
    meanRuntimeMs: mean(summaries.map((summary) => summary.metrics.explorationWallRuntimeMs)),
    meanActions: mean(summaries.map((summary) => summary.metrics.actions)),
    meanStates: mean(summaries.map((summary) => summary.metrics.states)),
    meanScreens: mean(summaries.map((summary) => summary.metrics.appOwnedScreens)),
    meanDepth: mean(summaries.map((summary) => summary.metrics.maximumDepth)),
    meanCompletedBranches: mean(summaries.map((summary) => summary.metrics.completedBranches)),
    meanTrueSeededDefectsPerMinute: mean(summaries.map((summary) => summary.trueSeededDefectsPerMinute ?? 0)),
    meanActionsPerTrueDefect: meanOrNull(summaries.filter((summary) => summary.actionsPerTrueDefect !== null).map((summary) => summary.actionsPerTrueDefect)),
    meanRuntimeMsPerTrueDefect: meanOrNull(summaries.filter((summary) => summary.runtimeMsPerTrueDefect !== null).map((summary) => summary.runtimeMsPerTrueDefect)),
    meanRestorationCycles: mean(summaries.map((summary) => summary.metrics.restorationCycles)),
    meanReplayActions: mean(summaries.map((summary) => summary.metrics.replayActions)),
    meanReplayTimeMs: mean(summaries.map((summary) => summary.metrics.replayTimeMs)),
    meanResetTimeMs: mean(summaries.map((summary) => summary.metrics.resetTimeMs)),
  };
};

function aggregateDepth(mode) {
  const buckets = new Map();
  for (const pair of pairs) {
    const depth = pair.depthRecall[mode];
    for (const [bucket, value] of Object.entries(depth)) {
      const current = buckets.get(bucket) ?? { knownOpportunities: 0, detected: 0 };
      current.knownOpportunities += value.known;
      current.detected += value.detected;
      buckets.set(bucket, current);
    }
  }
  return Object.fromEntries([...buckets.entries()].map(([bucket, value]) => [bucket, {
    ...value,
    recall: safeRatio(value.detected, value.knownOpportunities),
  }]));
}

const result = {
  schema: "tvdoctor.northstar-restoration-recall-analysis/v1",
  generatedAt: new Date().toISOString(),
  integrityValid: allValid,
  source: {
    config: configPath,
    configSha256,
    groundTruthManifest: config.groundTruthManifest,
    groundTruthManifestSha256: runManifestSha256,
    canonicalGroundTruthManifestSha256: canonicalManifestSha256,
    groundTruthReadFrom: `${config.baseCommit}:${config.groundTruthManifest}`,
    manifestSeedCount: manifest.defects.length,
  },
  scope: {
    detectorRules: [...detectorRules],
    inScopeSeedCount: inScopeSeeds.length,
    outOfScopeSeedCount: manifest.defects.length - inScopeSeeds.length,
    seeds: inScopeSeeds,
  },
  pairs,
  aggregate: {
    baseline: aggregateMode("baseline"),
    restoration: aggregateMode("restoration"),
    depthRecall: {
      baseline: aggregateDepth("baseline"),
      restoration: aggregateDepth("restoration"),
    },
    defectClassifications,
    restorationOnlyConsistent: defectClassifications
      .filter((entry) => entry.classification === "restoration-only")
      .map((entry) => entry.defectId),
    missedBothConsistent: defectClassifications
      .filter((entry) => entry.classification === "missed-both")
      .map((entry) => entry.defectId),
    inconclusiveDefects: defectClassifications
      .filter((entry) => entry.classification === "inconclusive")
      .map((entry) => entry.defectId),
  },
};

await writeFile(outputAbsolute, `${JSON.stringify(result, null, 2)}\n`, "utf8");
process.stdout.write(
  `Northstar: ${String(inScopeSeeds.length)} in-scope seeds; baseline mean recall ${(result.aggregate.baseline.meanRecall * 100).toFixed(1)}%; restoration mean recall ${(result.aggregate.restoration.meanRecall * 100).toFixed(1)}%; integrity ${allValid ? "valid" : "INVALID"}.\n`,
);
