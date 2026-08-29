import { readFile } from "node:fs/promises";
import process from "node:process";

const reportPath = process.argv[2];
if (reportPath === undefined) {
  throw new Error("Usage: node scripts/verify-android-ci-report.mjs <report.json>");
}

const report = JSON.parse(await readFile(reportPath, "utf8"));
if (report?.run?.status !== "completed") {
  throw new Error(`Android CI scan was not complete: ${String(report?.run?.status)}`);
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
if (report?.coverage?.packs?.some((pack) => pack.status !== "completed") !== false) {
  throw new Error("Android CI report contains incomplete coverage packs.");
}

process.stdout.write(`Android hosted-emulator report: PASS (${issue.id})\n`);
