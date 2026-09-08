import test from "node:test";
import assert from "node:assert/strict";
import { classifyPhysicalTv } from "./run-physical-device-proof.mjs";

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
  assert.throws(() => classifyPhysicalTv(physicalTv, "fire-tv"), /not identified as Amazon/u);
});
