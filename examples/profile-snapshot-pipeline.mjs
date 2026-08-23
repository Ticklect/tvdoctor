#!/usr/bin/env node
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const {
  capturePageObservation,
  PlaywrightWebDriver,
} = await import("@tvdoctor/driver-web");
const { fingerprintSnapshot } = await import("@tvdoctor/core");
const { createArtifactStore, stableJson } = await import("@tvdoctor/reporters");

const target = process.argv[2];
if (!target) {
  console.error("Usage: node examples/profile-snapshot-pipeline.mjs <url> [output]");
  process.exit(2);
}
const output = resolve(process.argv[3] ?? "artifacts/snapshot-profile");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const duration = async (operation) => {
  const startedAtMs = performance.now();
  const value = await operation();
  return { value, durationMs: performance.now() - startedAtMs };
};
const percentile = (values, fraction) => {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1);
  return ordered[Math.max(0, index)] ?? null;
};
const average = (values) => values.length === 0
  ? null
  : Number((values.reduce((total, value) => total + value, 0) / values.length).toFixed(3));

const driver = new PlaywrightWebDriver({
  settle: { ambientChurnEscape: true },
});
let observation;
let snapshot;
try {
  const launch = await duration(() => driver.launch({
    id: "snapshot-profile",
    launchUri: target,
  }));
  const page = driver.getPage();
  const coldCapture = await duration(() => capturePageObservation(page, 750));
  observation = coldCapture.value;
  const warmCaptures = [];
  for (let index = 0; index < 5; index += 1) {
    warmCaptures.push(await duration(() => capturePageObservation(page, 750)));
  }
  const fullSnapshots = [];
  for (let index = 0; index < 5; index += 1) {
    fullSnapshots.push(await duration(() => driver.snapshot()));
  }
  snapshot = (fullSnapshots.at(-1)).value;
  const fingerprintTimings = [];
  let fingerprint;
  for (let index = 0; index < 20; index += 1) {
    const timed = await duration(async () => fingerprintSnapshot(snapshot));
    fingerprintTimings.push(timed.durationMs);
    if (index === 19) fingerprint = timed.value.fingerprint;
  }
  const serialisationMs = durationSyncJSON(snapshot);
  const reset = await duration(() => driver.reset("reload"));
  const press = await duration(() => driver.press("RIGHT"));
  const screenshot = await duration(() => driver.captureScreenshot(resolve(output, "viewport.png")));
  const store = await createArtifactStore(output);
  const bundle = await duration(() => store.writeBundleFile(
    "profile.json",
    stableJson({ generatedAt: new Date().toISOString(), target }),
  ));

  const warmCaptureTimings = warmCaptures.map(({ value }) => value.timings);
  const summary = {
    schemaVersion: 1,
    target,
    launchMs: round(launch.durationMs),
    dom: {
      elementCount: observation.uiTreeMetadata.domElementCount ?? null,
      capturedUiNodes: observation.uiTreeMetadata.capturedNodeCount,
      maxUiNodes: observation.uiTreeMetadata.maxNodeCount,
      truncated: observation.uiTreeMetadata.truncated,
    },
    snapshotPipeline: {
      coldTotalMs: round(coldCapture.durationMs),
      warmTotalSamples: warmCaptures.map(({ durationMs }) => round(durationMs)),
      warmAverageMs: average(warmCaptures.map(({ durationMs }) => durationMs)),
      warmP95Ms: round(percentile(warmCaptures.map(({ durationMs }) => durationMs), .95)),
      browserEvaluationAverageMs: average(warmCaptureTimings.map((item) => item.browserEvaluationMs)),
      domEnumerationAverageMs: average(warmCaptureTimings.map((item) => item.domEnumerationMs)),
      semanticAnalysisAverageMs: average(warmCaptureTimings.map((item) => item.semanticAnalysisMs)),
      auxiliaryObservationAverageMs: average(warmCaptureTimings.map((item) => item.auxiliaryObservationMs)),
      transportAndSanitisationAverageMs: average(warmCaptureTimings.map((item) => item.transportAndSanitisationMs)),
      browserRoundTripAndQueueingAverageMs: average(warmCaptureTimings.map((item) => item.browserRoundTripAndQueueingMs)),
    },
    driverSnapshot: {
      samplesMs: fullSnapshots.map(({ durationMs }) => round(durationMs)),
      averageMs: average(fullSnapshots.map(({ durationMs }) => durationMs)),
    },
    fingerprint: {
      screen: fingerprint?.screen.value ?? null,
      focus: fingerprint?.focus.value ?? null,
      confidence: fingerprint?.confidence ?? null,
      averageMs: average(fingerprintTimings),
      p95Ms: round(percentile(fingerprintTimings, .95)),
    },
    reportSerialisationJsonMs: round(serialisationMs),
    resetReloadAndSettleMs: round(reset.durationMs),
    pressRightAndSettleMs: round(press.durationMs),
    pressOutcome: press.value.outcome,
    pressReportedSettleMs: press.value.timing.screenSettledAtMs === undefined
      ? null
      : press.value.timing.screenSettledAtMs - press.value.timing.inputSentAtMs,
    artifactCapture: {
      screenshotMs: round(screenshot.durationMs),
      bundleWriteMs: round(bundle.durationMs),
      path: bundle.value,
    },
  };
  await store.writeBundleFile("profile-summary.json", stableJson(summary));
  console.log(stableJson(summary));
} finally {
  await driver.close();
}

function durationSyncJSON(value) {
  const startedAtMs = performance.now();
  JSON.stringify(value);
  return performance.now() - startedAtMs;
}

function round(value) {
  return value === null ? null : Number(value.toFixed(3));
}
