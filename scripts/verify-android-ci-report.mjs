import { readFile } from "node:fs/promises";
import process from "node:process";

const reportPath = process.argv[2];
const ledgerPath = process.argv[3];
if (reportPath === undefined || ledgerPath === undefined) {
  throw new Error("Usage: node scripts/verify-android-ci-report.mjs <report.json> <android-coverage-ledger.json>");
}

const report = JSON.parse(await readFile(reportPath, "utf8"));
if (report?.run?.status !== "completed") {
  throw new Error(`Android CI scan was expected to complete safe coverage: ${String(report?.run?.status)}`);
}
if (report?.target?.environment?.package !== "org.tvdoctor.fixture") {
  throw new Error("Android CI report did not target the controlled fixture package.");
}
if (!Array.isArray(report?.issues) || report.issues.length !== 1) {
  throw new Error(`Android CI expected one seeded issue; found ${String(report?.issues?.length)}`);
}
const [issue] = report.issues;
if (issue?.rule !== "remote.lost-focus"
  || issue?.severity !== "high"
  || issue?.confidence !== "deterministic") {
  throw new Error("Android CI did not reproduce the deterministic HIGH focus-loss defect.");
}
if (!Array.isArray(report?.replays)
  || report.replays.length !== 1
  || report.replays[0]?.issueId !== issue.id) {
  throw new Error("Android CI did not emit the correlated replay for the seeded issue.");
}
if (!Array.isArray(report?.coverage?.packs)
  || report.coverage.packs.length !== 1
  || report.coverage.packs[0]?.pack !== "navigation"
  || report.coverage.packs[0]?.status !== "completed") {
  throw new Error("Android CI navigation coverage did not complete the safe action frontier.");
}

const ledgerArtifact = report?.artifacts?.find?.((artifact) => artifact?.id === "run:android-coverage-ledger");
if (ledgerArtifact?.status !== "available"
  || ledgerArtifact?.path !== "android-coverage-ledger.json") {
  throw new Error("Android CI report did not register the coverage ledger artifact.");
}

const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
if (ledger?.schema !== "tvdoctor.android-coverage/v1"
  || ledger?.strategy !== "adaptive"
  || ledger?.targetPackage !== "org.tvdoctor.fixture") {
  throw new Error("Android CI coverage ledger identity or strategy is invalid.");
}
if (!Number.isSafeInteger(ledger?.remainingSafeFrontier) || ledger.remainingSafeFrontier !== 0) {
  throw new Error("Android CI expected the safe action frontier to be exhausted.");
}
if ((ledger?.counts?.failed ?? -1) !== 0 || (ledger?.counts?.inaccessible ?? -1) !== 0) {
  throw new Error("Android CI coverage ledger contains failed or inaccessible actions.");
}
if (!Number.isSafeInteger(ledger?.counts?.["operator-gated"]) || ledger.counts["operator-gated"] <= 0) {
  throw new Error("Android CI expected at least one safety-gated action.");
}
if (!Array.isArray(ledger?.entries)
  || !ledger.entries.some((entry) =>
    entry?.action === "SELECT"
    && entry?.disposition === "operator-gated"
    && entry?.reasonCode === "ambiguous-activation")) {
  throw new Error("Android CI did not preserve the expected ambiguous SELECT safety gate.");
}

process.stdout.write(
  `Android hosted-emulator report: PASS (${issue.id}; completed safe coverage preserved)\n`,
);
