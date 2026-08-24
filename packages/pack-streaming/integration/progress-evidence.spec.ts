import { expect, test } from "@playwright/test";
import {
  equivalentProgressSemantics,
  normaliseProgressEvidence,
  type ProgressEvidenceInput,
} from "./progress-evidence.js";

const discovery: ProgressEvidenceInput = {
  operation: "seek-backward",
  action: "SELECT",
  target: "player-rewind",
  expectedDirection: "decrease",
  before: 583,
  after: 593,
};

test("treats different absolute clocks with the same inverted-rewind delta as equivalent", () => {
  const freshCapture: ProgressEvidenceInput = {
    ...discovery,
    before: 582,
    after: 592,
  };

  expect(normaliseProgressEvidence(discovery)).toMatchObject({
    delta: 10,
    observedDirection: "increase",
  });
  expect(normaliseProgressEvidence(freshCapture)).toMatchObject({
    delta: 10,
    observedDirection: "increase",
  });
  expect(equivalentProgressSemantics(discovery, freshCapture)).toBe(true);
});

test("rejects a different direction, magnitude, action, or target", () => {
  expect(equivalentProgressSemantics(discovery, {
    ...discovery,
    before: 592,
    after: 582,
  })).toBe(false);
  expect(equivalentProgressSemantics(discovery, {
    ...discovery,
    before: 582,
    after: 585,
  })).toBe(false);
  expect(equivalentProgressSemantics(discovery, {
    ...discovery,
    action: "RIGHT",
  })).toBe(false);
  expect(equivalentProgressSemantics(discovery, {
    ...discovery,
    target: "player-forward",
  })).toBe(false);
});

test("rejects malformed or internally inconsistent progress evidence", () => {
  expect(() => normaliseProgressEvidence({
    ...discovery,
    before: Number.NaN,
  })).toThrow(/finite before and after/iu);
  expect(() => normaliseProgressEvidence({
    ...discovery,
    expectedDirection: "increase",
  })).toThrow(/requires expected direction decrease/iu);
  expect(() => normaliseProgressEvidence({
    ...discovery,
    action: " ",
  })).toThrow(/non-empty action and target/iu);
  expect(() => normaliseProgressEvidence({
    ...discovery,
    operation: "seek-sideways",
  } as unknown as ProgressEvidenceInput)).toThrow(/recognised seek operation/iu);
});
