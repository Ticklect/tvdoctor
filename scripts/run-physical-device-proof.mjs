import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { parseTVDoctorReportJson } from "@tvdoctor/protocol";

export function classifyPhysicalTv(properties, requestedPlatform) {
  const qemu = [properties.kernelQemu, properties.bootQemu].some((value) => value === "1");
  const fingerprint = String(properties.fingerprint ?? "").toLowerCase();
  const emulatorIdentity = [
    properties.device,
    properties.product,
    properties.model,
    properties.hardware,
    properties.bootHardware,
  ].map((value) => String(value ?? "").toLowerCase()).join("\n");
  const emulatorPattern = /(?:emulator|generic_x86|sdk_gphone|sdk_google_atv|ranchu|goldfish|cuttlefish)/u;
  if (qemu || emulatorPattern.test(fingerprint) || emulatorPattern.test(emulatorIdentity)) {
    throw new Error("The selected serial identifies an emulator; physical-device proof was not recorded.");
  }
  if (!properties.characteristics.toLowerCase().split(",").includes("tv")) {
    throw new Error("The selected physical device does not advertise the Android TV characteristic.");
  }
  const amazon = properties.manufacturer.toLowerCase() === "amazon" || fingerprint.includes("amazon");
  if (requestedPlatform === "fire-tv" && !amazon) {
    throw new Error("The selected device is not identified as Amazon Fire TV firmware.");
  }
  if (requestedPlatform === "android-tv" && amazon) {
    throw new Error("The selected device is identified as Amazon Fire TV; rerun with --platform fire-tv.");
  }
  return amazon ? "fire-tv" : "android-tv";
}

export function classifyPhysicalTvFamily(properties, requestedPlatform) {
  const platform = classifyPhysicalTv(properties, requestedPlatform);
  if (platform === "fire-tv") return "fire-tv";
  return properties.googleTvLauncher === true ? "google-tv" : "android-tv";
}

export function parseDisplayMetadata(sizeOutput, densityOutput) {
  const sizeMatches = [...String(sizeOutput).matchAll(/(?:Physical|Override)?\s*size:\s*(\d+)x(\d+)/giu)];
  const densityMatches = [...String(densityOutput).matchAll(/(?:Physical|Override)?\s*density:\s*(\d+)/giu)];
  const size = sizeMatches.at(-1);
  const density = densityMatches.at(-1);
  return {
    width: size === undefined ? null : Number(size[1]),
    height: size === undefined ? null : Number(size[2]),
    densityDpi: density === undefined ? null : Number(density[1]),
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function buildPhysicalDeviceProof({
  properties,
  display,
  detectedPlatform,
  apkBytes,
  reportBytes,
  report,
  tvdoctorCommit,
  proofDate,
}) {
  const verifiedPlatform = classifyPhysicalTv(properties, detectedPlatform);
  if (verifiedPlatform !== detectedPlatform) {
    throw new Error(`Physical-device platform changed from ${detectedPlatform} to ${verifiedPlatform}.`);
  }
  if (report?.target?.platform !== detectedPlatform) {
    throw new Error("Physical-device report platform does not match the detected device platform.");
  }
  const deviceFamily = classifyPhysicalTvFamily(properties, detectedPlatform);
  const apkSha256 = sha256(apkBytes);
  const reportSha256 = sha256(reportBytes);
  const evidence = {
    schemaVersion: "tvdoctor.physical-device-proof/v1",
    recordedAt: proofDate,
    runStatus: report.run.status,
    detectedPlatform,
    device: {
      manufacturer: properties.manufacturer,
      device: properties.device,
      model: properties.model,
      product: properties.product,
      firmware: properties.fingerprint,
      androidApi: Number(properties.apiLevel),
      characteristics: properties.characteristics,
      emulation: {
        kernelQemu: properties.kernelQemu,
        bootQemu: properties.bootQemu,
        hardware: properties.hardware ?? "",
        bootHardware: properties.bootHardware ?? "",
      },
      family: deviceFamily,
      qualifiers: {
        googleTvLauncher: properties.googleTvLauncher === true,
      },
      display,
    },
    tvdoctor: {
      commit: tvdoctorCommit,
      version: report.run.tvdoctorVersion,
    },
    app: {
      sha256: apkSha256,
    },
    report: {
      runId: report.run.id,
      durationMs: report.run.durationMs,
      sha256: reportSha256,
      issues: report.issues.length,
      actions: report.coverage.actionsSent,
      screens: report.coverage.screenStatesDiscovered,
      focusTargets: report.coverage.focusStatesDiscovered,
      transitions: report.coverage.transitionsTested,
    },
  };
  const proofSha256 = sha256(Buffer.from(JSON.stringify(evidence), "utf8"));
  return {
    ...evidence,
    hashes: {
      apkSha256,
      reportSha256,
      proofSha256,
    },
    compatibility: {
      manufacturer: properties.manufacturer,
      device: properties.device,
      model: properties.model,
      firmware: properties.fingerprint,
      androidApi: Number(properties.apiLevel),
      platform: detectedPlatform,
      family: deviceFamily,
      tvdoctorCommit,
      tvdoctorVersion: report.run.tvdoctorVersion,
      apkSha256,
      proofDate,
      runStatus: report.run.status,
      reportSha256,
      proofSha256,
      issues: report.issues.length,
      actions: report.coverage.actionsSent,
      screens: report.coverage.screenStatesDiscovered,
      focusTargets: report.coverage.focusStatesDiscovered,
      transitions: report.coverage.transitionsTested,
    },
  };
}

export function aggregatePhysicalDeviceProofs(proofs) {
  const entriesByProofHash = new Map();
  for (const proof of proofs) {
    if (proof?.schemaVersion !== "tvdoctor.physical-device-proof/v1"
      || proof.runStatus !== "completed"
      || proof.detectedPlatform === undefined
      || proof.device === undefined
      || proof.tvdoctor === undefined
      || proof.app === undefined
      || proof.report === undefined
      || proof.hashes === undefined) {
      throw new Error("Physical compatibility aggregation requires a completed physical-device proof.");
    }

    const verifiedPlatform = classifyPhysicalTv({
      manufacturer: proof.device.manufacturer,
      device: proof.device.device,
      product: proof.device.product,
      model: proof.device.model,
      fingerprint: proof.device.firmware,
      characteristics: proof.device.characteristics,
      kernelQemu: proof.device.emulation?.kernelQemu ?? "",
      bootQemu: proof.device.emulation?.bootQemu ?? "",
      hardware: proof.device.emulation?.hardware ?? "",
      bootHardware: proof.device.emulation?.bootHardware ?? "",
    }, proof.detectedPlatform);
    if (verifiedPlatform !== proof.detectedPlatform) {
      throw new Error("Physical-device proof platform does not match the recorded device identity.");
    }
    const family = classifyPhysicalTvFamily({
      manufacturer: proof.device.manufacturer,
      device: proof.device.device,
      product: proof.device.product,
      model: proof.device.model,
      fingerprint: proof.device.firmware,
      characteristics: proof.device.characteristics,
      kernelQemu: proof.device.emulation?.kernelQemu ?? "",
      bootQemu: proof.device.emulation?.bootQemu ?? "",
      hardware: proof.device.emulation?.hardware ?? "",
      bootHardware: proof.device.emulation?.bootHardware ?? "",
      googleTvLauncher: proof.device.qualifiers?.googleTvLauncher === true,
    }, proof.detectedPlatform);
    if (proof.device.family !== undefined && proof.device.family !== family) {
      throw new Error("Physical-device proof family does not match the recorded device evidence.");
    }

    const { hashes, ...proofWithoutHashes } = proof;
    const evidence = Object.fromEntries(
      Object.entries(proofWithoutHashes).filter(([key]) => key !== "compatibility"),
    );
    const expectedProofHash = sha256(Buffer.from(JSON.stringify(evidence), "utf8"));
    if (hashes.proofSha256 !== expectedProofHash) {
      throw new Error("Physical-device proof hash does not match the recorded evidence.");
    }
    if (hashes.apkSha256 !== proof.app.sha256 || hashes.reportSha256 !== proof.report.sha256) {
      throw new Error("Physical-device proof hashes do not match the recorded app/report hashes.");
    }

    entriesByProofHash.set(hashes.proofSha256, {
      manufacturer: proof.device.manufacturer,
      device: proof.device.device,
      model: proof.device.model,
      firmware: proof.device.firmware,
      androidApi: proof.device.androidApi,
      platform: proof.detectedPlatform,
      family,
      tvdoctorCommit: proof.tvdoctor.commit,
      tvdoctorVersion: proof.tvdoctor.version,
      apkSha256: hashes.apkSha256,
      proofDate: proof.recordedAt,
      runStatus: proof.runStatus,
      reportSha256: hashes.reportSha256,
      proofSha256: hashes.proofSha256,
      issues: proof.report.issues,
      actions: proof.report.actions,
      screens: proof.report.screens,
      focusTargets: proof.report.focusTargets,
      transitions: proof.report.transitions,
    });
  }

  const entries = [...entriesByProofHash.values()].sort((left, right) => {
    const leftKey = [left.platform, left.manufacturer, left.model, left.firmware, left.proofDate, left.proofSha256].join("\u0000");
    const rightKey = [right.platform, right.manufacturer, right.model, right.firmware, right.proofDate, right.proofSha256].join("\u0000");
    return leftKey.localeCompare(rightKey);
  });
  return {
    schemaVersion: "tvdoctor.physical-compatibility-matrix/v1",
    entries,
  };
}

export function assertCompletePhysicalReport(report, expectedPlatform = "android-tv") {
  if (expectedPlatform !== "android-tv" && expectedPlatform !== "fire-tv") {
    throw new Error("Physical-device proof expected platform must be android-tv or fire-tv.");
  }
  if (report.schemaVersion !== "tvdoctor.report/v1"
    || report.run.status !== "completed"
    || report.target.platform !== expectedPlatform
    || report.coverage.budget.exhausted.length > 0
    || report.coverage.packs.some((pack) => pack.status !== "completed")) {
    throw new Error(`The physical-device scan was incomplete or did not produce a complete ${expectedPlatform} report.`);
  }
}

export function physicalProofNotRunMessage() {
  return "Physical proof was not run: no real device was configured with --serial.";
}

function argument(name) {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function argumentValues(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== name) continue;
    const value = process.argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value.`);
    values.push(value);
  }
  return values;
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

function adbPackageInstalled(adb, serial, packageName) {
  const output = run(adb, ["-s", serial, "shell", "pm", "path", packageName], [0, 1]);
  return output.split(/\r?\n/u).some((line) => line.trim().startsWith("package:"));
}

async function main() {
  const aggregateProofPaths = argumentValues("--aggregate");
  if (aggregateProofPaths.length > 0) {
    const matrixOutput = resolve(argument("--matrix-output"));
    const proofs = [];
    for (const proofPath of aggregateProofPaths) {
      proofs.push(JSON.parse(await readFile(resolve(proofPath), "utf8")));
    }
    const matrix = aggregatePhysicalDeviceProofs(proofs);
    await writeFile(matrixOutput, `${JSON.stringify(matrix, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    process.stdout.write(`Physical compatibility matrix: ${matrix.entries.length} verified proof(s)\n${matrixOutput}\n`);
    return;
  }
  if (!process.argv.includes("--serial")) {
    process.stdout.write(`${physicalProofNotRunMessage()}\n`);
    return;
  }
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
    device: adbProperty(adb, serial, "ro.product.device"),
    model: adbProperty(adb, serial, "ro.product.model"),
    product: adbProperty(adb, serial, "ro.product.name"),
    apiLevel: adbProperty(adb, serial, "ro.build.version.sdk"),
    characteristics: adbProperty(adb, serial, "ro.build.characteristics"),
    fingerprint: adbProperty(adb, serial, "ro.build.fingerprint"),
    kernelQemu: adbProperty(adb, serial, "ro.kernel.qemu"),
    bootQemu: adbProperty(adb, serial, "ro.boot.qemu"),
    hardware: adbProperty(adb, serial, "ro.hardware"),
    bootHardware: adbProperty(adb, serial, "ro.boot.hardware"),
    googleTvLauncher: adbPackageInstalled(adb, serial, "com.google.android.apps.tv.launcherx"),
  };
  const display = parseDisplayMetadata(
    run(adb, ["-s", serial, "shell", "wm", "size"]),
    run(adb, ["-s", serial, "shell", "wm", "density"]),
  );
  const detectedPlatform = classifyPhysicalTv(properties, requestedPlatform);
  const deviceFamily = classifyPhysicalTvFamily(properties, requestedPlatform);
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
  const apkBytes = await readFile(apk);
  const report = parseTVDoctorReportJson(reportBytes.toString("utf8"));
  assertCompletePhysicalReport(report, detectedPlatform);
  const tvdoctorCommit = run("git", ["rev-parse", "HEAD"]);
  if (!/^[a-f0-9]{40}$/u.test(tvdoctorCommit)) {
    throw new Error("Could not record the exact TVDoctor Git commit for physical-device proof.");
  }
  const proof = buildPhysicalDeviceProof({
    properties,
    display,
    detectedPlatform,
    apkBytes,
    reportBytes,
    report,
    tvdoctorCommit,
    proofDate: new Date().toISOString(),
  });
  const proofPath = `${output}-physical-device-proof.json`;
  await writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`Physical ${deviceFamily} proof (${detectedPlatform} report): PASS\n${proofPath}\n`);
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
