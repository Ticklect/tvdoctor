import { describe, expect, it } from "vitest";

import {
  PROTOCOL_VALIDATION_LIMITS,
  ProtocolValidationError,
  REPLAY_SCHEMA_VERSION,
  REPORT_SCHEMA_VERSION,
  REPORT_SCHEMA_VERSION_V1,
  TVDOCTOR_ARTIFACT_DESCRIPTOR_JSON_SCHEMA,
  TVDOCTOR_REPLAY_V1_JSON_SCHEMA,
  TVDOCTOR_REPORT_V1_JSON_SCHEMA,
  parseArtifactDescriptor,
  parseTVDoctorReplayJson,
  parseTVDoctorReplayV1,
  parseTVDoctorReport,
  parseTVDoctorReportJson,
  parseTVDoctorReportV1,
  type ArtifactDescriptor,
  type TVDoctorIssue,
  type TVDoctorReplayV1,
  type TVDoctorReportV0,
  type TVDoctorReportV1,
} from "../src/index.js";

const ISSUE: TVDoctorIssue = {
  id: "TVDOCTOR-NAV-0042",
  rule: "remote.reachability",
  title: "Text Colour is remote-unreachable",
  description: "DOWN skips the visible Text Colour control.",
  severity: "high",
  confidence: "deterministic",
  pack: "navigation",
  screen: "Captions > Appearance",
  expected: "Focus moves to caption-text-colour.",
  observed: "Focus moves to caption-background-colour.",
  transition: {
    fromElement: "caption-font-size",
    action: "DOWN",
    expectedElement: "caption-text-colour",
    observedElement: "caption-background-colour",
  },
  evidence: [{
    kind: "deterministic-failure",
    summary: "The aligned DOWN transition skipped Text Colour.",
    source: "action-0042",
    artifact: "evidence/TVDOCTOR-NAV-0042/transition.json",
  }],
  reproduction: {
    status: "available",
    resetStrategy: "reload",
    originalSequence: [
      { key: "SELECT", repeat: 1 },
      { key: "DOWN", repeat: 2 },
    ],
    minimizedSequence: null,
    confidence: "deterministic",
    artifact: "replays/TVDOCTOR-NAV-0042.json",
  },
};

const REPLAY: TVDoctorReplayV1 = {
  schemaVersion: REPLAY_SCHEMA_VERSION,
  id: "replay-TVDOCTOR-NAV-0042",
  issueId: ISSUE.id,
  reset: { strategy: "reload" },
  steps: [
    { key: "SELECT", repeat: 1 },
    { key: "DOWN", repeat: 2 },
  ],
  assertion: {
    type: "transition",
    fromElement: "caption-font-size",
    action: "DOWN",
    expectedElement: "caption-text-colour",
    observedElement: "caption-background-colour",
  },
};

const ARTIFACTS: readonly ArtifactDescriptor[] = [
  {
    id: "transition-TVDOCTOR-NAV-0042",
    kind: "transition",
    status: "available",
    path: "evidence/TVDOCTOR-NAV-0042/transition.json",
    mediaType: "application/json",
    byteLength: 512,
    sha256: "a".repeat(64),
  },
  {
    id: "trace-TVDOCTOR-NAV-0042",
    kind: "trace",
    status: "unavailable",
    reason: "The driver does not expose tracing.",
  },
  {
    id: "console-TVDOCTOR-NAV-0042",
    kind: "console-log",
    status: "failed",
    reason: "Log capture failed after the driver closed.",
  },
];

const COMMON_REPORT = {
  run: {
    id: "run-001",
    tvdoctorVersion: "0.0.0",
    mode: "standard",
    status: "completed",
    startedAt: "2026-08-20T12:00:00.000Z",
    completedAt: "2026-08-20T12:00:01.250Z",
    durationMs: 1_250,
  },
  target: {
    name: "Northstar fixture",
    platform: "web",
    location: "http://127.0.0.1:4173",
    environment: { browser: "chromium", viewport: "1280x720" },
  },
  coverage: {
    screenStatesDiscovered: 5,
    focusStatesDiscovered: 18,
    transitionsTested: 42,
    actionsSent: 51,
    capabilitiesObserved: ["remote-input", "ui-tree", "screenshot"],
    packs: [{ pack: "navigation", status: "completed" }],
    budget: {
      maxActions: 100,
      maxStates: 50,
      maxDepth: 12,
      maxDurationMs: 60_000,
      maxRepetitiveItems: 5,
      exhausted: [],
    },
  },
  issues: [ISSUE],
} as const;

const REPORT_V0: TVDoctorReportV0 = {
  schemaVersion: REPORT_SCHEMA_VERSION,
  ...COMMON_REPORT,
};

const REPORT_V1: TVDoctorReportV1 = {
  schemaVersion: REPORT_SCHEMA_VERSION_V1,
  ...COMMON_REPORT,
  artifacts: ARTIFACTS,
  replays: [REPLAY],
};

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function expectInvalid(operation: () => unknown, path: string): void {
  expect(operation).toThrow(ProtocolValidationError);
  expect(operation).toThrow(path);
}

describe("versioned protocol validation", () => {
  it("dispatches strict v0 reports without changing the compatibility constant", () => {
    expect(REPORT_SCHEMA_VERSION).toBe("tvdoctor.report/v0");
    const parsed = parseTVDoctorReport(jsonClone(REPORT_V0));
    expect(parsed.schemaVersion).toBe(REPORT_SCHEMA_VERSION);
    expect(parsed).toEqual(REPORT_V0);
  });

  it("round-trips canonical replay and report v1 JSON", () => {
    expect(parseTVDoctorReplayJson(JSON.stringify(REPLAY))).toEqual(REPLAY);
    expect(parseTVDoctorReportJson(JSON.stringify(REPORT_V1))).toEqual(REPORT_V1);
    expect(parseTVDoctorReportV1(jsonClone(REPORT_V1))).toEqual(REPORT_V1);
    expect(JSON.parse(JSON.stringify(parseTVDoctorReport(REPORT_V1)))).toEqual(REPORT_V1);
    expect(parseTVDoctorReplayV1(REPLAY)).toBe(REPLAY);
    expect(parseTVDoctorReportV1(REPORT_V1)).toBe(REPORT_V1);
  });

  it("accepts all explicit artifact states", () => {
    for (const artifact of ARTIFACTS) {
      expect(parseArtifactDescriptor(jsonClone(artifact))).toEqual(artifact);
    }
  });

  it.each([
    "/absolute/evidence.json",
    "C:/evidence.json",
    "C:\\evidence.json",
    "../evidence.json",
    "evidence/../secret.json",
    "evidence/%2e%2e/secret.json",
    "evidence/%252e%252e/secret.json",
    "evidence/%25252e%25252e/secret.json",
    "https://example.test/evidence.json",
    "%68%74%74%70%3a/example.test/evidence.json",
    "evidence//transition.json",
    "evidence/issue:stream/transition.json",
    "evidence/issue?/transition.json",
    "evidence/CON/transition.json",
    "evidence/aux.json",
    "evidence/trailing./transition.json",
    "evidence/trailing%20/transition.json",
  ])("rejects unsafe artifact path %s", (path) => {
    const artifact = { ...ARTIFACTS[0], path };
    expectInvalid(() => parseArtifactDescriptor(artifact), "$artifact.path");
  });

  it.each([
    { field: "byteLength", value: Number.NaN },
    { field: "byteLength", value: Number.POSITIVE_INFINITY },
    { field: "byteLength", value: -1 },
    { field: "byteLength", value: 1.5 },
    { field: "sha256", value: "A".repeat(64) },
    { field: "sha256", value: "a".repeat(63) },
    { field: "mediaType", value: "application/json; charset=utf-8" },
    { field: "mediaType", value: "Application/JSON" },
  ])("rejects malformed available artifact $field", ({ field, value }) => {
    const artifact = { ...ARTIFACTS[0], [field]: value };
    expectInvalid(() => parseArtifactDescriptor(artifact), `$artifact.${field}`);
  });

  it("rejects union-state extras and unknown artifact states", () => {
    expectInvalid(
      () => parseArtifactDescriptor({ ...ARTIFACTS[1], path: "trace.zip" }),
      "$artifact.path",
    );
    expectInvalid(
      () => parseArtifactDescriptor({ id: "trace", kind: "trace", status: "pending", reason: "later" }),
      "$artifact.status",
    );
  });

  it.each([
    { label: "unknown key", mutate: (value: Record<string, unknown>) => {
      const steps = value["steps"] as Record<string, unknown>[];
      (steps[0] as Record<string, unknown>)["key"] = "CLICK";
    }, path: "$replay.steps[0].key" },
    { label: "zero repeat", mutate: (value: Record<string, unknown>) => {
      const steps = value["steps"] as Record<string, unknown>[];
      (steps[0] as Record<string, unknown>)["repeat"] = 0;
    }, path: "$replay.steps[0].repeat" },
    { label: "fractional repeat", mutate: (value: Record<string, unknown>) => {
      const steps = value["steps"] as Record<string, unknown>[];
      (steps[0] as Record<string, unknown>)["repeat"] = 1.5;
    }, path: "$replay.steps[0].repeat" },
    { label: "infinite repeat", mutate: (value: Record<string, unknown>) => {
      const steps = value["steps"] as Record<string, unknown>[];
      (steps[0] as Record<string, unknown>)["repeat"] = Number.POSITIVE_INFINITY;
    }, path: "$replay.steps[0].repeat" },
    { label: "oversized repeat", mutate: (value: Record<string, unknown>) => {
      const steps = value["steps"] as Record<string, unknown>[];
      (steps[0] as Record<string, unknown>)["repeat"] = PROTOCOL_VALIDATION_LIMITS.maxRemoteRepeat + 1;
    }, path: "$replay.steps[0].repeat" },
    { label: "empty steps", mutate: (value: Record<string, unknown>) => {
      value["steps"] = [];
    }, path: "$replay.steps" },
    { label: "assertion mismatch", mutate: (value: Record<string, unknown>) => {
      const assertion = value["assertion"] as Record<string, unknown>;
      assertion["action"] = "RIGHT";
    }, path: "$replay.assertion.action" },
    { label: "extra nested field", mutate: (value: Record<string, unknown>) => {
      const reset = value["reset"] as Record<string, unknown>;
      reset["delayMs"] = 20;
    }, path: "$replay.reset.delayMs" },
  ])("rejects malformed replay: $label", ({ mutate, path }) => {
    const replay = jsonClone(REPLAY) as unknown as Record<string, unknown>;
    mutate(replay);
    expectInvalid(() => parseTVDoctorReplayV1(replay), path);
  });

  it("rejects unknown replay/report versions and root extras", () => {
    expectInvalid(
      () => parseTVDoctorReplayV1({ ...REPLAY, schemaVersion: "tvdoctor.replay/v2" }),
      "$replay.schemaVersion",
    );
    expectInvalid(
      () => parseTVDoctorReport({ ...REPORT_V1, schemaVersion: "tvdoctor.report/v9" }),
      "$report.schemaVersion",
    );
    expectInvalid(
      () => parseTVDoctorReport({ ...REPORT_V1, debug: true }),
      "$report.debug",
    );
  });

  it("rejects non-finite report numbers and nested extras", () => {
    const nonFinite = jsonClone(REPORT_V1) as unknown as Record<string, unknown>;
    const run = nonFinite["run"] as Record<string, unknown>;
    run["durationMs"] = Number.NaN;
    expectInvalid(() => parseTVDoctorReport(nonFinite), "$report.run.durationMs");

    const extra = jsonClone(REPORT_V1) as unknown as Record<string, unknown>;
    const target = extra["target"] as Record<string, unknown>;
    target["secret"] = "not canonical";
    expectInvalid(() => parseTVDoctorReport(extra), "$report.target.secret");

    const unsafeEnvironment = JSON.parse(JSON.stringify(REPORT_V1)) as Record<string, unknown>;
    const unsafeTarget = unsafeEnvironment["target"] as Record<string, unknown>;
    unsafeTarget["environment"] = JSON.parse('{"__proto__":"pollute"}') as unknown;
    expectInvalid(
      () => parseTVDoctorReport(unsafeEnvironment),
      "$report.target.environment.__proto__",
    );
  });

  it("rejects duplicate descriptors/replays and replays for unknown issues", () => {
    expectInvalid(
      () => parseTVDoctorReportV1({ ...REPORT_V1, artifacts: [ARTIFACTS[0], ARTIFACTS[0]] }),
      "$report.artifacts[1].id",
    );
    expectInvalid(
      () => parseTVDoctorReportV1({ ...REPORT_V1, replays: [REPLAY, REPLAY] }),
      "$report.replays[1].id",
    );
    expectInvalid(
      () => parseTVDoctorReportV1({ ...REPORT_V1, replays: [{ ...REPLAY, issueId: "TVDOCTOR-NAV-9999" }] }),
      "$report.replays[0].issueId",
    );
  });

  it("binds every available issue reproduction to one matching replay", () => {
    expectInvalid(
      () => parseTVDoctorReportV1({ ...REPORT_V1, replays: [] }),
      "$report.replays",
    );
    expectInvalid(
      () => parseTVDoctorReportV1({
        ...REPORT_V1,
        replays: [REPLAY, { ...REPLAY, id: "replay-duplicate" }],
      }),
      "$report.replays[1].issueId",
    );

    const unavailableIssue: TVDoctorIssue = {
      ...ISSUE,
      reproduction: { status: "unavailable", reason: "No stable reset is available." },
    };
    expectInvalid(
      () => parseTVDoctorReportV1({
        ...REPORT_V1,
        issues: [unavailableIssue],
      }),
      "$report.replays[0].issueId",
    );
  });

  it.each([
    {
      label: "reset strategy",
      replay: { ...REPLAY, reset: { strategy: "clear-data" as const } },
      path: "$report.replays[0].reset.strategy",
    },
    {
      label: "steps",
      replay: {
        ...REPLAY,
        steps: [{ key: "RIGHT" as const, repeat: 1 }, { key: "DOWN" as const, repeat: 1 }],
      },
      path: "$report.replays[0].steps",
    },
    {
      label: "source assertion",
      replay: {
        ...REPLAY,
        assertion: { ...REPLAY.assertion, fromElement: "unrelated-control" },
      },
      path: "$report.replays[0].assertion.fromElement",
    },
    {
      label: "expected assertion",
      replay: {
        ...REPLAY,
        assertion: { ...REPLAY.assertion, expectedElement: "unrelated-control" },
      },
      path: "$report.replays[0].assertion.expectedElement",
    },
    {
      label: "observed assertion",
      replay: {
        ...REPLAY,
        assertion: { ...REPLAY.assertion, observedElement: "unrelated-control" },
      },
      path: "$report.replays[0].assertion.observedElement",
    },
  ])("rejects a replay whose $label differs from its issue", ({ replay, path }) => {
    expectInvalid(
      () => parseTVDoctorReportV1({ ...REPORT_V1, replays: [replay] }),
      path,
    );
  });

  it("rejects oversized objects before they can become report data", () => {
    const replay = jsonClone(REPLAY) as unknown as Record<string, unknown>;
    replay["id"] = `r${"x".repeat(256)}`;
    expectInvalid(() => parseTVDoctorReplayV1(replay), "$replay.id");

    const oversizedJson = " ".repeat(PROTOCOL_VALIDATION_LIMITS.maxJsonBytes + 1);
    expectInvalid(() => parseTVDoctorReplayJson(oversizedJson), "$replay");
  });

  it("rejects traversal paths carried by compatible v0 reports", () => {
    const report = jsonClone(REPORT_V0) as unknown as Record<string, unknown>;
    const issues = report["issues"] as Record<string, unknown>[];
    const evidence = (issues[0] as Record<string, unknown>)["evidence"] as Record<string, unknown>[];
    (evidence[0] as Record<string, unknown>)["artifact"] = "../../outside.json";
    expectInvalid(() => parseTVDoctorReport(report), "$report.issues[0].evidence[0].artifact");
  });

  it("exports strict JSON Schema 2020-12 documents", () => {
    expect(TVDOCTOR_REPLAY_V1_JSON_SCHEMA).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      additionalProperties: false,
      properties: { schemaVersion: { const: REPLAY_SCHEMA_VERSION } },
    });
    expect(TVDOCTOR_REPORT_V1_JSON_SCHEMA).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      additionalProperties: false,
      properties: { schemaVersion: { const: REPORT_SCHEMA_VERSION_V1 } },
    });
    expect(TVDOCTOR_ARTIFACT_DESCRIPTOR_JSON_SCHEMA.oneOf).toHaveLength(2);
    expect(JSON.stringify(TVDOCTOR_REPORT_V1_JSON_SCHEMA)).toContain(
      TVDOCTOR_REPLAY_V1_JSON_SCHEMA.$id,
    );

    const availableArtifact = TVDOCTOR_ARTIFACT_DESCRIPTOR_JSON_SCHEMA.oneOf[0];
    const pathPattern = new RegExp(availableArtifact.properties.path.pattern, "u");
    expect(pathPattern.test("evidence/TVDOCTOR-NAV-0042/transition.json")).toBe(true);
    for (const unsafePath of [
      "evidence/%2e%2e/secret.json",
      "https://example.test/artifact.json",
      "evidence//artifact.json",
      "evidence/CON/artifact.json",
      "evidence/issue:stream/artifact.json",
      "evidence/trailing./artifact.json",
    ]) {
      expect(pathPattern.test(unsafePath), unsafePath).toBe(false);
    }
    expect(TVDOCTOR_REPORT_V1_JSON_SCHEMA.$comment).toContain("Runtime parsing");
  });
});
