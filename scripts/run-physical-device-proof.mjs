import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { parseTVDoctorReportJson } from "@tvdoctor/protocol";

export function classifyPhysicalTv(properties, requestedPlatform) {
  const qemu = [properties.kernelQemu, properties.bootQemu].some((value) => value === "1");
  const fingerprint = properties.fingerprint.toLowerCase();
  if (qemu || /(?:emulator|generic_x86|sdk_gphone)/u.test(fingerprint)) {
    throw new Error("The selected serial identifies an emulator; physical-device proof was not recorded.");
  }
  if (!properties.characteristics.toLowerCase().split(",").includes("tv")) {
    throw new Error("The selected physical device does not advertise the Android TV characteristic.");
  }
  const amazon = properties.manufacturer.toLowerCase() === "amazon" || fingerprint.includes("amazon");
  if (requestedPlatform === "fire-tv" && !amazon) {
    throw new Error("The selected device is not identified as Amazon Fire TV firmware.");
  }
  return amazon ? "fire-tv" : "android-tv";
}

function argument(name) {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function run(command, args, acceptedCodes = [0], inheritOutput = false) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: inheritOutput ? "inherit" : ["ignore", "pipe", "inherit"],
  });
  if (result.error !== undefined) throw result.error;
  if (!acceptedCodes.includes(result.status)) {
    throw new Error(`${command} exited with code ${String(result.status)}.`);
  }
  return typeof result.stdout === "string" ? result.stdout.trim() : "";
}

function adbProperty(adb, serial, name) {
  return run(adb, ["-s", serial, "shell", "getprop", name]);
}

async function main() {
  const serial = argument("--serial");
  const apk = resolve(argument("--apk"));
  const output = resolve(argument("--output"));
  const requestedPlatform = argument("--platform");
  if (requestedPlatform !== "android-tv" && requestedPlatform !== "fire-tv") {
    throw new Error("--platform must be android-tv or fire-tv.");
  }
  const adb = process.argv.includes("--adb") ? argument("--adb") : "adb";
  const properties = {
    manufacturer: adbProperty(adb, serial, "ro.product.manufacturer"),
    model: adbProperty(adb, serial, "ro.product.model"),
    product: adbProperty(adb, serial, "ro.product.name"),
    apiLevel: adbProperty(adb, serial, "ro.build.version.sdk"),
    characteristics: adbProperty(adb, serial, "ro.build.characteristics"),
    fingerprint: adbProperty(adb, serial, "ro.build.fingerprint"),
    kernelQemu: adbProperty(adb, serial, "ro.kernel.qemu"),
    bootQemu: adbProperty(adb, serial, "ro.boot.qemu"),
  };
  const detectedPlatform = classifyPhysicalTv(properties, requestedPlatform);
  const cli = resolve("packages/cli/dist/bin.js");
  run(process.execPath, [
    cli,
    "test",
    "--apk", apk,
    "--device", serial,
    "--adb", adb,
    "--mode", "quick",
    "--output", output,
  ], [0, 1], true);

  const reportPath = resolve(output, "report.json");
  const reportBytes = await readFile(reportPath);
  const report = parseTVDoctorReportJson(reportBytes.toString("utf8"));
  if (report.schemaVersion !== "tvdoctor.report/v1"
    || report.run.status !== "completed"
    || report.target.platform !== "android-tv"
    || report.target.location !== serial
    || report.coverage.budget.exhausted.length > 0
    || report.coverage.packs.some((pack) => pack.status !== "completed")) {
    throw new Error("The physical-device scan was incomplete or did not match the selected serial.");
  }
  const proof = {
    schemaVersion: "tvdoctor.physical-device-proof/v1",
    recordedAt: new Date().toISOString(),
    detectedPlatform,
    device: properties,
    report: {
      path: reportPath,
      runId: report.run.id,
      sha256: createHash("sha256").update(reportBytes).digest("hex"),
      issues: report.issues.length,
      actions: report.coverage.actionsSent,
    },
  };
  const proofPath = `${output}-physical-device-proof.json`;
  await writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`Physical ${detectedPlatform} proof: PASS\n${proofPath}\n`);
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
