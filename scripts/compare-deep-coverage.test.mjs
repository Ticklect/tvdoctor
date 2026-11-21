import assert from "node:assert/strict";
import test from "node:test";
import { compareDeepCoverage } from "./compare-deep-coverage.mjs";

const edge = (name, outcome) => ({
  key: `${name}/${outcome}`,
  fromFocusTargetKey: "profile",
  action: name === "select" ? "SELECT" : "UP",
  outcome,
});

const graph = (withheld = true) => ({
  schemaVersion: "tvdoctor.navigation-focus-graph/v2",
  screens: [{ key: "home" }],
  focusTargets: [{ key: "profile" }],
  transitions: [edge("up", "applied"), edge("select", withheld ? "unsupported" : "applied")],
  coverage: withheld ? "partial" : "complete",
  coverageSummary: {
    frontier: { status: "complete" },
    observedFocusTargets: 1,
    locallyCompleteFocusTargetKeys: withheld ? [] : ["profile"],
  },
});

test("accepts preserved navigation identities plus newly verified fixture SELECT", () => {
  const result = compareDeepCoverage(graph(), graph(false));
  assert.deepEqual(result.errors, []);
  assert.equal(result.summary.upgradedActions, 1);
  assert.equal(result.summary.missingEdges, 0);
});

test("never mistakes exhausted safe frontier for full verification", () => {
  const result = compareDeepCoverage(graph(), graph());
  assert.match(result.errors.join(" "), /still lack an applied observation/u);
  assert.match(result.errors.join(" "), /not complete/u);
});

test("rejects regression in an already-applied edge despite unchanged counts", () => {
  const candidate = graph(false);
  candidate.transitions[0] = { ...candidate.transitions[0], key: "wrong-destination" };
  const result = compareDeepCoverage(graph(), candidate);
  assert.match(result.errors.join(" "), /Previously applied edges/u);
});

test("does not trust a complete flag when focus action verification is missing", () => {
  const candidate = graph(false);
  candidate.coverageSummary.locallyCompleteFocusTargetKeys = [];
  const result = compareDeepCoverage(graph(), candidate);
  assert.match(result.errors.join(" "), /applied-action verification/u);
});
