import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_SCHEMA = "tvdoctor.real-app-benchmark-manifest/v1";
const RUN_SCHEMA = "tvdoctor.real-app-benchmark-run/v1";
const ANALYSIS_SCHEMA = "tvdoctor.real-app-benchmark-analysis/v1";
const REVIEW_SCHEMA = "tvdoctor.real-app-benchmark-review/v1";
const CASE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const SERIAL = /^[A-Za-z0-9._:-]{1,256}$/u;
const MODES = new Set(["quick", "deep"]);
const REVIEW_CLASSIFICATIONS = new Set(["confirmed", "false-positive", "uncertain"]);

function rejectUnknownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label} contains unsupported field ${JSON.stringify(key)}.`);
  }
}

function parseArgs(values) {
  const [command, ...rest] = values.slice(2);
  if (command !== "run" && command !== "analyze") {
    throw new Error("Usage: node scripts/real-app-benchmark.mjs run --manifest PATH --output DIR | analyze --manifest PATH --run PATH --output PATH");
  }
  const options = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    const value = rest[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error("Expected --name value arguments.");
    }
    options.set(name.slice(2), value);
  }
  return { command, options };
}

function asObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function nonEmptyString(value, label, maximumLength = 1_024) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximumLength || value.includes("\0")) {
    throw new TypeError(`${label} must be a bounded non-empty string.`);
  }
  return value;
}

function optionalRelativePath(value, label) {
  if (value === undefined || value === null) return null;
  return nonEmptyString(value, label);
}

function validateWebTarget(target, label) {
  rejectUnknownKeys(target, new Set(["platform", "name", "version", "url"]), label);
  const url = nonEmptyString(target.url, `${label}.url`, 4_096);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError(`${label}.url must be an absolute HTTP(S) URL.`);
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username.length > 0 || parsed.password.length > 0) {
    throw new TypeError(`${label}.url must be an HTTP(S) URL without embedded credentials.`);
  }
  return {
    platform: "web",
    url: parsed.href,
    name: nonEmptyString(target.name, `${label}.name`, 256),
    version: nonEmptyString(target.version, `${label}.version`, 256),
  };
}

function validateAndroidTarget(target, label, platform) {
  rejectUnknownKeys(target, new Set(["platform", "name", "version", "apkPath", "device", "adbPath"]), label);
  const apkPath = nonEmptyString(target.apkPath, `${label}.apkPath`);
  if (!/\.apk$/iu.test(apkPath)) throw new TypeError(`${label}.apkPath must reference an .apk file.`);
  const device = nonEmptyString(target.device, `${label}.device`, 256);
  if (!SERIAL.test(device)) throw new TypeError(`${label}.device must be a valid Android serial.`);
  const adbPath = target.adbPath === undefined ? null : nonEmptyString(target.adbPath, `${label}.adbPath`);
  return {
    platform,
    apkPath,
    device,
    ...(adbPath === null ? {} : { adbPath }),
    name: nonEmptyString(target.name, `${label}.name`, 256),
    version: nonEmptyString(target.version, `${label}.version`, 256),
  };
}

export function validateManifest(input) {
  const manifest = asObject(input, "manifest");
  rejectUnknownKeys(manifest, new Set(["schemaVersion", "name", "cases"]), "manifest");
  if (manifest.schemaVersion !== MANIFEST_SCHEMA) {
    throw new TypeError(`manifest.schemaVersion must be ${MANIFEST_SCHEMA}.`);
  }
  const name = nonEmptyString(manifest.name, "manifest.name", 256);
  if (!Array.isArray(manifest.cases) || manifest.cases.length === 0 || manifest.cases.length > 100) {
    throw new TypeError("manifest.cases must contain between 1 and 100 benchmark cases.");
  }
  const ids = new Set();
  const cases = manifest.cases.map((rawCase, index) => {
    const entry = asObject(rawCase, `manifest.cases[${String(index)}]`);
    rejectUnknownKeys(entry, new Set(["id", "target", "run", "replay", "manualReviewFile", "notes"]), `manifest.cases[${String(index)}]`);
    const id = nonEmptyString(entry.id, `manifest.cases[${String(index)}].id`, 64);
    if (!CASE_ID.test(id)) throw new TypeError(`benchmark case id ${JSON.stringify(id)} is invalid.`);
    if (ids.has(id)) throw new TypeError(`benchmark case id ${JSON.stringify(id)} is duplicated.`);
    ids.add(id);
    const targetObject = asObject(entry.target, `${id}.target`);
    const platform = targetObject.platform;
    const target = platform === "web"
      ? validateWebTarget(targetObject, `${id}.target`)
      : platform === "android-tv" || platform === "fire-tv"
        ? validateAndroidTarget(targetObject, `${id}.target`, platform)
        : (() => { throw new TypeError(`${id}.target.platform must be web, android-tv, or fire-tv.`); })();
    const runObject = entry.run === undefined ? {} : asObject(entry.run, `${id}.run`);
    rejectUnknownKeys(runObject, new Set(["mode", "screenshots", "journeyPath"]), `${id}.run`);
    const mode = runObject.mode ?? "quick";
    if (!MODES.has(mode)) throw new TypeError(`${id}.run.mode must be quick or deep.`);
    if (runObject.screenshots !== undefined && typeof runObject.screenshots !== "boolean") {
      throw new TypeError(`${id}.run.screenshots must be boolean when provided.`);
    }
    if (target.platform !== "web" && runObject.journeyPath !== undefined) {
      throw new TypeError(`${id}.run.journeyPath is supported only for web targets.`);
    }
    const journeyPath = optionalRelativePath(runObject.journeyPath, `${id}.run.journeyPath`);
    const replayObject = entry.replay === undefined ? {} : asObject(entry.replay, `${id}.replay`);
    rejectUnknownKeys(replayObject, new Set(["enabled", "maxAttempts"]), `${id}.replay`);
    const replayEnabled = replayObject.enabled ?? true;
    if (typeof replayEnabled !== "boolean") throw new TypeError(`${id}.replay.enabled must be boolean.`);
    const maxAttempts = replayObject.maxAttempts ?? 10;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 0 || maxAttempts > 100) {
      throw new TypeError(`${id}.replay.maxAttempts must be an integer from 0 to 100.`);
    }
    const reviewPath = optionalRelativePath(entry.manualReviewFile, `${id}.manualReviewFile`);
    const notes = entry.notes === undefined ? null : nonEmptyString(entry.notes, `${id}.notes`, 2_000);
    return {
      id,
      target,
      run: {
        mode,
        screenshots: runObject.screenshots ?? true,
        ...(journeyPath === null ? {} : { journeyPath }),
      },
      replay: { enabled: replayEnabled, maxAttempts },
      ...(reviewPath === null ? {} : { manualReviewFile: reviewPath }),
      ...(notes === null ? {} : { notes }),
    };
  });
  return { schemaVersion: MANIFEST_SCHEMA, name, cases };
}

function resolveFrom(baseDirectory, path) {
  return resolve(baseDirectory, path);
}

export function buildAuditArgs(entry, manifestDirectory, reportDirectory) {
  if (entry.target.platform === "web") {
    return [
      "scan",
      entry.target.url,
      "--mode", entry.run.mode,
      "--output", reportDirectory,
      "--target-redaction", "origin",
      ...(entry.run.screenshots ? [] : ["--no-screenshots"]),
      ...(entry.run.journeyPath === undefined
        ? []
        : ["--journey", resolveFrom(manifestDirectory, entry.run.journeyPath)]),
    ];
  }
  return [
    "test",
    "--apk", resolveFrom(manifestDirectory, entry.target.apkPath),
    "--device", entry.target.device,
    "--mode", entry.run.mode,
    "--output", reportDirectory,
    ...(entry.target.adbPath === undefined ? [] : ["--adb", resolveFrom(manifestDirectory, entry.target.adbPath)]),
    ...(entry.run.screenshots ? [] : ["--no-screenshots"]),
  ];
}

export function deterministicReplayIssueIds(report) {
  const replayIssueIds = new Set(Array.isArray(report.replays) ? report.replays.map((entry) => entry.issueId) : []);
  return Array.isArray(report.issues)
    ? report.issues
      .filter((issue) => issue?.confidence === "deterministic"
        && issue?.reproduction?.status === "available"
        && issue?.reproduction?.confidence === "deterministic"
        && replayIssueIds.has(issue.id))
      .map((issue) => issue.id)
    : [];
}

export function classifyReplayResult(stdout, exitCode) {
  const match = typeof stdout === "string" ? stdout.match(/^Status: (REPRODUCED|FIXED|INCONCLUSIVE|ERROR)$/mu) : null;
  if (match !== null) return match[1].toLowerCase();
  if (exitCode === 0) return "fixed";
  if (exitCode === 1) return "reproduced";
  if (exitCode === 3) return "inconclusive";
  return "error";
}

function runProcess(command, args) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    exitCode: result.status ?? 4,
    wallRuntimeMs: Date.now() - started,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    processError: result.error?.message ?? null,
  };
}

function boundedDiagnostic(value) {
  let printable = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    printable += codePoint < 32 || (codePoint >= 127 && codePoint <= 159) ? " " : character;
  }
  return printable.replace(/\s+/gu, " ").trim().slice(0, 1_000);
}

function validateReportShape(report, caseId, expectedPlatform) {
  const value = asObject(report, `${caseId} report`);
  if (value.schemaVersion !== "tvdoctor.report/v1") throw new TypeError(`${caseId} did not produce tvdoctor.report/v1.`);
  asObject(value.run, `${caseId} report.run`);
  const target = asObject(value.target, `${caseId} report.target`);
  if (target.platform !== expectedPlatform) {
    throw new TypeError(`${caseId} report platform ${JSON.stringify(target.platform)} did not match benchmark platform ${JSON.stringify(expectedPlatform)}.`);
  }
  asObject(value.coverage, `${caseId} report.coverage`);
  if (!Array.isArray(value.issues)) throw new TypeError(`${caseId} report.issues must be an array.`);
  return value;
}

async function loadJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function replayArgs(entry, manifestDirectory, reportPath, issueId) {
  const base = ["replay", issueId, "--report", reportPath];
  if (entry.target.platform === "web") {
    base.push("--target", entry.target.url);
    if (entry.run.journeyPath !== undefined) base.push("--journey", resolveFrom(manifestDirectory, entry.run.journeyPath));
    return base;
  }
  base.push(
    "--apk", resolveFrom(manifestDirectory, entry.target.apkPath),
    "--device", entry.target.device,
  );
  if (entry.target.adbPath !== undefined) base.push("--adb", resolveFrom(manifestDirectory, entry.target.adbPath));
  return base;
}

async function runCase({ entry, manifestDirectory, outputRoot, cliPath }) {
  const caseRoot = resolve(outputRoot, "cases", entry.id);
  const reportDirectory = resolve(caseRoot, "report");
  await mkdir(caseRoot, { recursive: true });
  const audit = runProcess(process.execPath, [cliPath, ...buildAuditArgs(entry, manifestDirectory, reportDirectory)]);
  const reportPath = resolve(reportDirectory, "report.json");
  if (!existsSync(reportPath)) {
    return {
      id: entry.id,
      target: { name: entry.target.name, version: entry.target.version, platform: entry.target.platform },
      audit: {
        exitCode: audit.exitCode,
        wallRuntimeMs: audit.wallRuntimeMs,
        processError: audit.processError,
        diagnostic: boundedDiagnostic(audit.stderr || audit.stdout),
      },
      report: null,
      replay: { candidates: 0, attempted: 0, results: [] },
    };
  }

  const report = validateReportShape(await loadJson(reportPath), entry.id, entry.target.platform);
  const candidates = entry.replay.enabled ? deterministicReplayIssueIds(report) : [];
  const selected = candidates.slice(0, entry.replay.maxAttempts);
  const replayResults = [];
  for (const issueId of selected) {
    const replay = runProcess(process.execPath, [cliPath, ...replayArgs(entry, manifestDirectory, reportPath, issueId)]);
    replayResults.push({
      issueId,
      status: classifyReplayResult(replay.stdout, replay.exitCode),
      exitCode: replay.exitCode,
      wallRuntimeMs: replay.wallRuntimeMs,
      ...(replay.processError === null ? {} : { processError: replay.processError }),
    });
  }
  return {
    id: entry.id,
    target: { name: entry.target.name, version: entry.target.version, platform: entry.target.platform },
    audit: {
      exitCode: audit.exitCode,
      wallRuntimeMs: audit.wallRuntimeMs,
      processError: audit.processError,
      diagnostic: audit.exitCode === 0 || audit.exitCode === 1 || audit.exitCode === 3
        ? null
        : boundedDiagnostic(audit.stderr || audit.stdout),
    },
    report,
    replay: {
      candidates: candidates.length,
      attempted: replayResults.length,
      skippedByLimit: Math.max(0, candidates.length - replayResults.length),
      results: replayResults,
    },
  };
}

function readGitIdentity() {
  const head = runProcess("git", ["rev-parse", "HEAD"]);
  const status = runProcess("git", ["status", "--porcelain"]);
  return {
    commit: head.exitCode === 0 && /^[a-f0-9]{40}$/u.test(head.stdout.trim()) ? head.stdout.trim() : null,
    dirty: status.exitCode === 0 ? status.stdout.trim().length > 0 : null,
  };
}

async function readTvdoctorIdentity() {
  const manifest = asObject(
    JSON.parse(await readFile(resolve(root, "packages/cli/package.json"), "utf8")),
    "tvdoctor package manifest",
  );
  return {
    version: nonEmptyString(manifest.version, "tvdoctor package version", 128),
    ...readGitIdentity(),
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function runBenchmark(manifestPath, outputPath) {
  const absoluteManifest = resolve(manifestPath);
  const manifestBytes = await readFile(absoluteManifest);
  const manifest = validateManifest(JSON.parse(manifestBytes.toString("utf8")));
  const cliPath = resolve(root, "packages/cli/dist/bin.js");
  if (!existsSync(cliPath)) throw new Error("TVDoctor CLI build is missing. Run npm run build:packages before the benchmark.");
  const outputRoot = resolve(outputPath);
  await mkdir(dirname(outputRoot), { recursive: true });
  await mkdir(outputRoot);
  const startedAt = new Date().toISOString();
  const cases = [];
  for (const entry of manifest.cases) {
    cases.push(await runCase({ entry, manifestDirectory: dirname(absoluteManifest), outputRoot, cliPath }));
  }
  const completedAt = new Date().toISOString();
  const output = {
    schemaVersion: RUN_SCHEMA,
    evidenceCategory: "real-app",
    certification: false,
    manifest: { name: manifest.name, sha256: sha256(manifestBytes) },
    tvdoctor: await readTvdoctorIdentity(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    startedAt,
    completedAt,
    cases,
  };
  const rawPath = resolve(outputRoot, "benchmark-run.json");
  await writeFile(rawPath, `${JSON.stringify(output, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return { rawPath, output };
}

export function summarizeReport(report, replay) {
  if (report === null) return null;
  const coverage = report.coverage;
  const issues = report.issues;
  const deterministic = issues.filter((issue) => issue?.confidence === "deterministic").length;
  const replayable = deterministicReplayIssueIds(report).length;
  const results = replay.results ?? [];
  const replayStatuses = { reproduced: 0, fixed: 0, inconclusive: 0, error: 0 };
  for (const result of results) {
    if (Object.hasOwn(replayStatuses, result.status)) replayStatuses[result.status] += 1;
  }
  return {
    reportRuntimeMs: report.run.durationMs,
    runStatus: report.run.status,
    coverage: {
      screens: coverage.screenStatesDiscovered,
      focusStates: coverage.focusStatesDiscovered,
      transitions: coverage.transitionsTested,
      actions: coverage.actionsSent,
      packs: coverage.packs,
      exhaustedBudgets: coverage.budget?.exhausted ?? [],
    },
    findings: {
      total: issues.length,
      deterministic,
      nonDeterministic: issues.length - deterministic,
      replayableDeterministic: replayable,
    },
    replays: {
      candidates: replay.candidates ?? replayable,
      attempted: replay.attempted ?? results.length,
      skippedByLimit: replay.skippedByLimit ?? 0,
      successfulReproductions: replayStatuses.reproduced,
      statuses: replayStatuses,
      successRate: results.length === 0 ? null : replayStatuses.reproduced / results.length,
    },
  };
}

export function summarizeManualReview(review, report, expectedCaseId = null) {
  if (review === null) {
    return {
      status: "not-reviewed",
      reviewedFindings: 0,
      falsePositiveFindings: null,
      falsePositiveRate: null,
      unresolvedFindings: null,
    };
  }
  const value = asObject(review, "manual review");
  rejectUnknownKeys(value, new Set(["schemaVersion", "caseId", "findings"]), "manual review");
  if (value.schemaVersion !== REVIEW_SCHEMA) throw new TypeError(`manual review schemaVersion must be ${REVIEW_SCHEMA}.`);
  const caseId = nonEmptyString(value.caseId, "manual review caseId", 64);
  if (expectedCaseId !== null && caseId !== expectedCaseId) {
    throw new TypeError(`manual review caseId ${JSON.stringify(caseId)} does not match ${JSON.stringify(expectedCaseId)}.`);
  }
  if (!Array.isArray(value.findings)) throw new TypeError("manual review findings must be an array.");
  const reportIds = new Set(report.issues.map((issue) => issue.id));
  const seen = new Set();
  let falsePositiveFindings = 0;
  let unresolvedFindings = 0;
  for (const item of value.findings) {
    const finding = asObject(item, "manual review finding");
    rejectUnknownKeys(finding, new Set(["issueId", "classification"]), "manual review finding");
    const issueId = nonEmptyString(finding.issueId, "manual review finding issueId", 256);
    if (!reportIds.has(issueId)) throw new TypeError(`manual review references unknown issue ${JSON.stringify(issueId)}.`);
    if (seen.has(issueId)) throw new TypeError(`manual review duplicates issue ${JSON.stringify(issueId)}.`);
    seen.add(issueId);
    if (!REVIEW_CLASSIFICATIONS.has(finding.classification)) {
      throw new TypeError(`manual review classification for ${JSON.stringify(issueId)} is invalid.`);
    }
    if (finding.classification === "false-positive") falsePositiveFindings += 1;
    if (finding.classification === "uncertain") unresolvedFindings += 1;
  }
  return {
    status: unresolvedFindings === 0 ? "reviewed" : "reviewed-with-unresolved",
    reviewedFindings: value.findings.length,
    falsePositiveFindings,
    falsePositiveRate: value.findings.length === 0 || unresolvedFindings > 0
      ? null
      : falsePositiveFindings / value.findings.length,
    unresolvedFindings,
  };
}

export async function analyzeBenchmark(manifestPath, runPath, outputPath) {
  const absoluteManifest = resolve(manifestPath);
  const manifestBytes = await readFile(absoluteManifest);
  const manifest = validateManifest(JSON.parse(manifestBytes.toString("utf8")));
  const absoluteRun = resolve(runPath);
  const runBytes = await readFile(absoluteRun);
  const run = asObject(JSON.parse(runBytes.toString("utf8")), "benchmark run");
  if (run.schemaVersion !== RUN_SCHEMA || !Array.isArray(run.cases)) {
    throw new TypeError(`benchmark run must use ${RUN_SCHEMA}.`);
  }
  const runManifest = asObject(run.manifest, "benchmark run manifest");
  rejectUnknownKeys(runManifest, new Set(["name", "sha256"]), "benchmark run manifest");
  const recordedManifestName = nonEmptyString(runManifest.name, "benchmark run manifest name", 256);
  const recordedManifestHash = nonEmptyString(runManifest.sha256, "benchmark run manifest sha256", 64);
  if (!/^[a-f0-9]{64}$/u.test(recordedManifestHash)) {
    throw new TypeError("benchmark run manifest sha256 must be a lowercase SHA-256 digest.");
  }
  const currentManifestHash = sha256(manifestBytes);
  if (recordedManifestName !== manifest.name || recordedManifestHash !== currentManifestHash) {
    throw new TypeError("benchmark run manifest does not match the exact manifest supplied for analysis.");
  }
  const manifestDirectory = dirname(absoluteManifest);
  const runCases = new Map(run.cases.map((entry) => [entry.id, entry]));
  const cases = [];
  for (const entry of manifest.cases) {
    const rawCase = runCases.get(entry.id);
    if (rawCase === undefined) throw new TypeError(`benchmark run is missing case ${JSON.stringify(entry.id)}.`);
    const report = rawCase.report === null
      ? null
      : validateReportShape(rawCase.report, entry.id, entry.target.platform);
    let review = null;
    if (entry.manualReviewFile !== undefined) review = await loadJson(resolveFrom(manifestDirectory, entry.manualReviewFile));
    cases.push({
      id: entry.id,
      target: rawCase.target,
      auditWallRuntimeMs: rawCase.audit?.wallRuntimeMs ?? null,
      auditExitCode: rawCase.audit?.exitCode ?? null,
      metrics: summarizeReport(report, rawCase.replay ?? { candidates: 0, attempted: 0, results: [] }),
      manualReview: report === null ? {
        status: "unavailable",
        reviewedFindings: 0,
        falsePositiveFindings: null,
        falsePositiveRate: null,
        unresolvedFindings: null,
      } : summarizeManualReview(review, report, entry.id),
    });
  }
  const aggregate = cases.reduce((total, entry) => {
    total.cases += 1;
    total.auditWallRuntimeMs += entry.auditWallRuntimeMs ?? 0;
    if (entry.metrics === null) {
      total.unavailableCases += 1;
      return total;
    }
    total.findings += entry.metrics.findings.total;
    total.replayAttempts += entry.metrics.replays.attempted;
    total.replayReproductions += entry.metrics.replays.successfulReproductions;
    if (entry.manualReview.falsePositiveFindings !== null) {
      total.manuallyReviewedFindings += entry.manualReview.reviewedFindings;
      total.manualFalsePositives += entry.manualReview.falsePositiveFindings;
    }
    return total;
  }, {
    cases: 0,
    unavailableCases: 0,
    auditWallRuntimeMs: 0,
    findings: 0,
    replayAttempts: 0,
    replayReproductions: 0,
    manuallyReviewedFindings: 0,
    manualFalsePositives: 0,
  });
  const analysis = {
    schemaVersion: ANALYSIS_SCHEMA,
    evidenceCategory: "real-app",
    certification: false,
    benchmarkName: manifest.name,
    source: {
      manifest: { name: manifest.name, sha256: currentManifestHash },
      runSha256: sha256(runBytes),
      tvdoctor: run.tvdoctor ?? null,
      runtime: run.runtime ?? null,
      startedAt: run.startedAt ?? null,
      completedAt: run.completedAt ?? null,
    },
    cases,
    aggregate,
    interpretation: "These measurements describe bounded observed runs only. They are not product certification or a platform-wide compatibility claim.",
  };
  const absoluteOutput = resolve(outputPath);
  await mkdir(dirname(absoluteOutput), { recursive: true });
  await writeFile(absoluteOutput, `${JSON.stringify(analysis, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return analysis;
}

async function main() {
  const { command, options } = parseArgs(process.argv);
  const manifestPath = options.get("manifest");
  const outputPath = options.get("output");
  if (manifestPath === undefined || outputPath === undefined) throw new Error("--manifest and --output are required.");
  if (command === "run") {
    const { rawPath, output } = await runBenchmark(manifestPath, outputPath);
    const completed = output.cases.filter((entry) => entry.report !== null).length;
    process.stdout.write(`Real-app benchmark recorded ${String(completed)}/${String(output.cases.length)} report(s).\n${rawPath}\n`);
    return;
  }
  const runPath = options.get("run");
  if (runPath === undefined) throw new Error("analyze requires --run PATH.");
  const analysis = await analyzeBenchmark(manifestPath, runPath, outputPath);
  process.stdout.write(`Real-app benchmark analysis: ${String(analysis.aggregate.cases)} case(s), ${String(analysis.aggregate.findings)} finding(s), ${String(analysis.aggregate.replayReproductions)}/${String(analysis.aggregate.replayAttempts)} reproduced replay(s).\n${resolve(outputPath)}\n`);
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
