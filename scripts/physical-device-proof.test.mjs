import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as proofRunner from "./run-physical-device-proof.mjs";

const { classifyPhysicalTv, classifyPhysicalTvFamily, parseDisplayMetadata } = proofRunner;

const physicalTv = {
  manufacturer: "Example",
  model: "Living Room TV",
  product: "tv",
  apiLevel: "34",
  characteristics: "tv,nosdcard",
  fingerprint: "example/tv/device:14/release-keys",
  kernelQemu: "0",
  bootQemu: "0",
};

test("classifies physical Android TV and Fire TV without treating emulators as proof", () => {
  assert.equal(classifyPhysicalTv(physicalTv, "android-tv"), "android-tv");
  assert.equal(classifyPhysicalTv({
    ...physicalTv,
    manufacturer: "Amazon",
    fingerprint: "Amazon/firetv/device:30/release-keys",
  }, "fire-tv"), "fire-tv");
  assert.throws(
    () => classifyPhysicalTv({ ...physicalTv, kernelQemu: "1" }, "android-tv"),
    /emulator/u,
  );
  assert.throws(
    () => classifyPhysicalTv({
      ...physicalTv,
      device: "sdk_google_atv_x86_64",
      product: "sdk_google_atv_x86_64",
      model: "Android TV",
      fingerprint: "vendor/tv/device:14/release-keys",
      kernelQemu: "0",
      bootQemu: "0",
    }, "android-tv"),
    /emulator/u,
  );
  assert.throws(
    () => classifyPhysicalTv({
      ...physicalTv,
      hardware: "ranchu",
      bootHardware: "ranchu",
      fingerprint: "vendor/tv/device:14/release-keys",
      kernelQemu: "0",
      bootQemu: "0",
    }, "android-tv"),
    /emulator/u,
  );
  assert.throws(() => classifyPhysicalTv(physicalTv, "fire-tv"), /not identified as Amazon/u);
  assert.throws(() => classifyPhysicalTv({
    ...physicalTv,
    manufacturer: "Amazon",
    fingerprint: "Amazon/firetv/device:30/release-keys",
  }, "android-tv"), /identified as Amazon Fire TV/u);
});

test("classifies physical proof rows as Android TV, Google TV, or Fire TV", () => {
  assert.equal(classifyPhysicalTvFamily({
    ...physicalTv,
    googleTvLauncher: false,
  }, "android-tv"), "android-tv");
  assert.equal(classifyPhysicalTvFamily({
    ...physicalTv,
    googleTvLauncher: true,
  }, "android-tv"), "google-tv");
  assert.equal(classifyPhysicalTvFamily({
    ...physicalTv,
    manufacturer: "Amazon",
    fingerprint: "Amazon/firetv/device:30/release-keys",
    googleTvLauncher: true,
  }, "fire-tv"), "fire-tv");
});

test("records effective display size and density from physical-device adb output", () => {
  assert.deepEqual(parseDisplayMetadata(
    "Physical size: 3840x2160\nOverride size: 1920x1080",
    "Physical density: 320\nOverride density: 240",
  ), {
    width: 1920,
    height: 1080,
    densityDpi: 240,
  });
  assert.deepEqual(parseDisplayMetadata("", ""), {
    width: null,
    height: null,
    densityDpi: null,
  });
});

test("builds a bounded physical compatibility record with stable proof metadata", () => {
  assert.equal(typeof proofRunner.buildPhysicalDeviceProof, "function");

  const reportBytes = Buffer.from("report-bytes");
  const apkBytes = Buffer.from("apk-bytes");
  const proof = proofRunner.buildPhysicalDeviceProof({
    properties: {
      ...physicalTv,
      device: "example_tv_device",
      googleTvLauncher: true,
    },
    display: { width: 1920, height: 1080, densityDpi: 240 },
    detectedPlatform: "android-tv",
    apkBytes,
    reportBytes,
    report: {
      schemaVersion: "tvdoctor.report/v1",
      run: {
        id: "run-physical-1",
        tvdoctorVersion: "0.4.0",
        status: "completed",
        durationMs: 1250,
      },
      target: {
        platform: "android-tv",
        location: "android-app://com.example.tv",
      },
      coverage: {
        actionsSent: 42,
        screenStatesDiscovered: 7,
        focusStatesDiscovered: 19,
        transitionsTested: 31,
        packs: [{ pack: "navigation", status: "completed" }],
        budget: { exhausted: [] },
      },
      issues: [{ id: "issue-1" }, { id: "issue-2" }],
    },
    tvdoctorCommit: "0123456789abcdef0123456789abcdef01234567",
    proofDate: "2026-09-30T20:00:00.000Z",
  });

  assert.deepEqual(proof.compatibility, {
    manufacturer: "Example",
    device: "example_tv_device",
    model: "Living Room TV",
    firmware: "example/tv/device:14/release-keys",
    androidApi: 34,
    platform: "android-tv",
    family: "google-tv",
    tvdoctorCommit: "0123456789abcdef0123456789abcdef01234567",
    tvdoctorVersion: "0.4.0",
    apkSha256: proof.hashes.apkSha256,
    proofDate: "2026-09-30T20:00:00.000Z",
    runStatus: "completed",
    reportSha256: proof.hashes.reportSha256,
    proofSha256: proof.hashes.proofSha256,
    issues: 2,
    actions: 42,
    screens: 7,
    focusTargets: 19,
    transitions: 31,
  });
  assert.match(proof.hashes.apkSha256, /^[a-f0-9]{64}$/u);
  assert.match(proof.hashes.reportSha256, /^[a-f0-9]{64}$/u);
  assert.match(proof.hashes.proofSha256, /^[a-f0-9]{64}$/u);
  assert.equal(proof.device.family, "google-tv");
  assert.equal(proof.device.qualifiers.googleTvLauncher, true);
});

test("refuses to build compatibility evidence from an emulator", () => {
  assert.throws(() => proofRunner.buildPhysicalDeviceProof({
    properties: {
      ...physicalTv,
      device: "sdk_gphone64_x86_64",
      kernelQemu: "1",
      fingerprint: "google/sdk_gphone64_x86_64/emulator:14/release-keys",
    },
    display: { width: 1920, height: 1080, densityDpi: 240 },
    detectedPlatform: "android-tv",
    apkBytes: Buffer.from("apk-bytes"),
    reportBytes: Buffer.from("report-bytes"),
    report: {
      run: { id: "run-emulator", tvdoctorVersion: "0.4.0", status: "completed", durationMs: 10 },
      coverage: {
        actionsSent: 1,
        screenStatesDiscovered: 1,
        focusStatesDiscovered: 1,
        transitionsTested: 1,
      },
      issues: [],
    },
    tvdoctorCommit: "0123456789abcdef0123456789abcdef01234567",
    proofDate: "2026-09-30T20:00:00.000Z",
  }), /emulator/u);
});

test("refuses a physical proof when the report platform does not match the detected device", () => {
  assert.throws(() => proofRunner.buildPhysicalDeviceProof({
    properties: {
      ...physicalTv,
      manufacturer: "Amazon",
      fingerprint: "Amazon/firetv/device:30/release-keys",
    },
    display: { width: 1920, height: 1080, densityDpi: 240 },
    detectedPlatform: "fire-tv",
    apkBytes: Buffer.from("apk-bytes"),
    reportBytes: Buffer.from("report-bytes"),
    report: {
      run: { id: "run-fire-tv", tvdoctorVersion: "0.4.0", status: "completed", durationMs: 10 },
      target: { platform: "android-tv" },
      coverage: {
        actionsSent: 1,
        screenStatesDiscovered: 1,
        focusStatesDiscovered: 1,
        transitionsTested: 1,
      },
      issues: [],
    },
    tvdoctorCommit: "0123456789abcdef0123456789abcdef01234567",
    proofDate: "2026-09-30T20:00:00.000Z",
  }), /report platform/u);
});

test("records Fire TV qualification only for matching Amazon hardware and fire-tv report evidence", () => {
  const proof = proofRunner.buildPhysicalDeviceProof({
    properties: {
      ...physicalTv,
      manufacturer: "Amazon",
      device: "sheldon",
      model: "Fire TV Stick",
      fingerprint: "Amazon/sheldon/sheldon:9/release-keys",
      googleTvLauncher: false,
    },
    display: { width: 1920, height: 1080, densityDpi: 320 },
    detectedPlatform: "fire-tv",
    apkBytes: Buffer.from("fire-apk"),
    reportBytes: Buffer.from("fire-report"),
    report: {
      schemaVersion: "tvdoctor.report/v1",
      run: { id: "run-fire", tvdoctorVersion: "0.4.0", status: "completed", durationMs: 500 },
      target: { platform: "fire-tv", location: "android-app://com.example.fire" },
      coverage: {
        actionsSent: 10,
        screenStatesDiscovered: 2,
        focusStatesDiscovered: 4,
        transitionsTested: 8,
        packs: [{ pack: "navigation", status: "completed" }],
        budget: { exhausted: [] },
      },
      issues: [],
    },
    tvdoctorCommit: "0123456789abcdef0123456789abcdef01234567",
    proofDate: "2026-10-06T21:00:00.000Z",
  });

  assert.equal(proof.detectedPlatform, "fire-tv");
  assert.equal(proof.device.family, "fire-tv");
  assert.equal(proof.compatibility.platform, "fire-tv");
  assert.equal(proof.compatibility.family, "fire-tv");
  assert.deepEqual(proofRunner.aggregatePhysicalDeviceProofs([proof]).entries, [proof.compatibility]);
});

test("accepts complete Android TV and Fire TV reports without requiring an ADB serial in public target identity", () => {
  assert.equal(typeof proofRunner.assertCompletePhysicalReport, "function");
  const report = {
    schemaVersion: "tvdoctor.report/v1",
    run: { status: "completed" },
    target: {
      platform: "android-tv",
      location: "android-app://com.example.tv",
    },
    coverage: {
      budget: { exhausted: [] },
      packs: [{ pack: "navigation", status: "completed" }],
    },
  };

  assert.doesNotThrow(() => proofRunner.assertCompletePhysicalReport(report));
  assert.doesNotThrow(() => proofRunner.assertCompletePhysicalReport({
    ...report,
    target: { ...report.target, platform: "fire-tv" },
  }, "fire-tv"));
  assert.throws(
    () => proofRunner.assertCompletePhysicalReport(report, "fire-tv"),
    /fire-tv/u,
  );
  assert.throws(
    () => proofRunner.assertCompletePhysicalReport({ ...report, run: { status: "partial" } }),
    /incomplete/u,
  );
});

test("states explicitly that physical proof was not run when no real device is configured", () => {
  const result = spawnSync(process.execPath, ["scripts/run-physical-device-proof.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /physical proof was not run/iu);
});

test("aggregates verified proof rows into a bounded compatibility matrix", () => {
  assert.equal(typeof proofRunner.aggregatePhysicalDeviceProofs, "function");
  const proof = proofRunner.buildPhysicalDeviceProof({
    properties: {
      ...physicalTv,
      device: "example_tv_device",
      googleTvLauncher: false,
    },
    display: { width: 1920, height: 1080, densityDpi: 240 },
    detectedPlatform: "android-tv",
    apkBytes: Buffer.from("apk-bytes"),
    reportBytes: Buffer.from("report-bytes"),
    report: {
      schemaVersion: "tvdoctor.report/v1",
      run: {
        id: "run-physical-1",
        tvdoctorVersion: "0.4.0",
        status: "completed",
        durationMs: 1250,
      },
      target: { platform: "android-tv", location: "android-app://com.example.tv" },
      coverage: {
        actionsSent: 42,
        screenStatesDiscovered: 7,
        focusStatesDiscovered: 19,
        transitionsTested: 31,
        packs: [{ pack: "navigation", status: "completed" }],
        budget: { exhausted: [] },
      },
      issues: [{ id: "issue-1" }, { id: "issue-2" }],
    },
    tvdoctorCommit: "0123456789abcdef0123456789abcdef01234567",
    proofDate: "2026-09-30T20:00:00.000Z",
  });

  const matrix = proofRunner.aggregatePhysicalDeviceProofs([proof, proof]);
  assert.equal(matrix.schemaVersion, "tvdoctor.physical-compatibility-matrix/v1");
  assert.equal(matrix.entries.length, 1);
  assert.deepEqual(matrix.entries[0], proof.compatibility);
  assert.equal(matrix.entries[0].family, "android-tv");
  assert.equal(JSON.stringify(matrix).includes("SERIAL"), false);

  const emulator = structuredClone(proof);
  emulator.device.firmware = "google/sdk_gphone64_x86_64/emulator:14/release-keys";
  assert.throws(() => proofRunner.aggregatePhysicalDeviceProofs([emulator]), /emulator/u);

  const emulatorHardware = structuredClone(proof);
  emulatorHardware.device.emulation.hardware = "ranchu";
  emulatorHardware.device.emulation.bootHardware = "ranchu";
  assert.throws(() => proofRunner.aggregatePhysicalDeviceProofs([emulatorHardware]), /emulator/u);

  const tampered = structuredClone(proof);
  tampered.device.model = "Tampered Model";
  assert.throws(() => proofRunner.aggregatePhysicalDeviceProofs([tampered]), /proof hash/u);
});

test("writes a compatibility matrix from one or more proof files", async (t) => {
  const proof = proofRunner.buildPhysicalDeviceProof({
    properties: {
      ...physicalTv,
      device: "example_tv_device",
      googleTvLauncher: false,
    },
    display: { width: 1920, height: 1080, densityDpi: 240 },
    detectedPlatform: "android-tv",
    apkBytes: Buffer.from("apk-bytes"),
    reportBytes: Buffer.from("report-bytes"),
    report: {
      schemaVersion: "tvdoctor.report/v1",
      run: { id: "run-physical-1", tvdoctorVersion: "0.4.0", status: "completed", durationMs: 1250 },
      target: { platform: "android-tv", location: "android-app://com.example.tv" },
      coverage: {
        actionsSent: 42,
        screenStatesDiscovered: 7,
        focusStatesDiscovered: 19,
        transitionsTested: 31,
        packs: [{ pack: "navigation", status: "completed" }],
        budget: { exhausted: [] },
      },
      issues: [],
    },
    tvdoctorCommit: "0123456789abcdef0123456789abcdef01234567",
    proofDate: "2026-09-30T20:00:00.000Z",
  });
  const root = await mkdtemp(join(tmpdir(), "tvdoctor-proof-matrix-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const first = join(root, "first-proof.json");
  const second = join(root, "second-proof.json");
  const matrixPath = join(root, "matrix.json");
  await writeFile(first, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
  await writeFile(second, `${JSON.stringify(proof, null, 2)}\n`, "utf8");

  const result = spawnSync(process.execPath, [
    "scripts/run-physical-device-proof.mjs",
    "--aggregate", first,
    "--aggregate", second,
    "--matrix-output", matrixPath,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const matrix = JSON.parse(await readFile(matrixPath, "utf8"));
  assert.equal(matrix.schemaVersion, "tvdoctor.physical-compatibility-matrix/v1");
  assert.equal(matrix.entries.length, 1);
  assert.equal(matrix.entries[0].device, "example_tv_device");
  assert.equal(matrix.entries[0].family, "android-tv");
});
