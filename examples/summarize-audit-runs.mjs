#!/usr/bin/env node
import { access, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";

const root = resolve(process.argv[2] ?? "artifacts/m11-retest");
const namePrefix = process.argv[3];
const entries = await readdir(root, { withFileTypes: true });
const summaries = [];

for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  if (namePrefix !== undefined && !entry.name.startsWith(namePrefix)) continue;
  const directory = join(root, entry.name);
  let report;
  let ledger;
  try {
    report = JSON.parse(await readFile(join(directory, "report.json"), "utf8"));
    ledger = JSON.parse(await readFile(join(directory, "stage-ledger.json"), "utf8"));
  } catch {
    continue;
  }

  const navigation = ledger.navigation?.statistics ?? null;
  const streaming = ledger.streaming?.statistics ?? null;
  const web = ledger.web?.statistics ?? null;
  const explicitSnapshots = (streaming?.snapshots ?? 0) + (web?.snapshots ?? 0);
  const navigationSnapshots = navigation === null
    ? 0
    : 1
      + (navigation.explorationActions * 2)
      + (navigation.replayActions ?? 0)
      + (navigation.settlingPolls ?? 0);
  const timeoutSignals = [
    ledger.navigation?.termination?.reason,
    ledger.streaming?.termination?.reason,
    ledger.web?.termination?.reason,
    JSON.stringify(ledger).includes("did not reach the configured stability threshold"),
    JSON.stringify(ledger).includes("duration budget"),
  ];
  const requiredBundleFiles = [
    "report.json",
    "report.html",
    "report.md",
    "ai-report.md",
    "stage-ledger.json",
    "inventory.json",
  ];
  const reportBundleComplete = [];
  for (const file of requiredBundleFiles) {
    try {
      await access(join(directory, file));
      reportBundleComplete.push(file);
    } catch {
      // Missing files are reported by length comparison below.
    }
  }

  summaries.push({
    target: ledger.target,
    mode: ledger.mode,
    status: report.run.status,
    durationMs: report.run.durationMs,
    actions: report.coverage.actionsSent,
    averageActionCycleMs: Math.round(report.run.durationMs / Math.max(1, report.coverage.actionsSent)),
    screens: report.coverage.screenStatesDiscovered,
    focusStates: report.coverage.focusStatesDiscovered,
    transitions: report.coverage.transitionsTested,
    snapshotsEstimate: explicitSnapshots + navigationSnapshots,
    exhaustedBudgets: report.coverage.budget.exhausted,
    timeoutEvidence: timeoutSignals.filter((signal) => signal === true || typeof signal === "string").length,
    issues: report.issues.map((issue) => ({
      id: issue.id,
      rule: issue.rule,
      severity: issue.severity,
    })),
    evidenceFailures: report.artifacts.filter((artifact) => artifact.status === "failed").length,
    availableArtifacts: report.artifacts.filter((artifact) => artifact.status === "available").length,
    unavailableArtifacts: report.artifacts.filter((artifact) => artifact.status === "unavailable").length,
    packStatuses: Object.fromEntries(report.coverage.packs.map((pack) => [pack.pack, pack.status])),
    reportBundleComplete,
    reportBundleFileCount: reportBundleComplete.length,
  });
}

summaries.sort((left, right) => left.target.localeCompare(right.target));
console.log(JSON.stringify(summaries, null, 2));
