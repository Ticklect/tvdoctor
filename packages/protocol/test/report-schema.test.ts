import { describe, expect, it } from "vitest";

import {
  EVIDENCE_KINDS,
  ISSUE_CONFIDENCES,
  ISSUE_SEVERITIES,
  REPORT_SCHEMA_VERSION,
  isEvidenceKind,
  isIssueConfidence,
  isIssueSeverity,
} from "../src/index.js";
import type { TVDoctorReportV0 } from "../src/index.js";

const REPORT: TVDoctorReportV0 = {
  schemaVersion: REPORT_SCHEMA_VERSION,
  run: {
    id: "run-001",
    tvdoctorVersion: "0.0.0",
    mode: "standard",
    status: "completed",
    startedAt: "2026-08-19T09:00:00.000Z",
    completedAt: "2026-08-19T09:00:01.250Z",
    durationMs: 1_250,
  },
  target: {
    name: "Broken streaming fixture",
    platform: "web",
    location: "http://127.0.0.1:4173",
    environment: {
      browser: "chromium",
      viewport: "1920x1080",
    },
  },
  coverage: {
    screenStatesDiscovered: 5,
    focusStatesDiscovered: 18,
    transitionsTested: 42,
    actionsSent: 51,
    capabilitiesObserved: ["remote-input", "ui-tree", "screenshot"],
    packs: [{ pack: "streaming", status: "completed" }],
    budget: {
      maxActions: 100,
      maxStates: 50,
      maxDepth: 12,
      maxDurationMs: 60_000,
      maxRepetitiveItems: 5,
      exhausted: [],
    },
  },
  issues: [
    {
      id: "TVDOCTOR-NAV-0042",
      rule: "remote.reachability",
      title: "Caption Text Colour is not remote reachable",
      description: "The visible Text Colour control cannot receive focus.",
      severity: "high",
      confidence: "deterministic",
      pack: "streaming",
      screen: "Player > Settings > Captions > Appearance",
      expected: "Focus moves to caption-text-colour.",
      observed: "Focus remains on caption-font-size.",
      transition: {
        fromElement: "caption-font-size",
        action: "DOWN",
        expectedElement: "caption-text-colour",
        observedElement: "caption-font-size",
      },
      evidence: [
        {
          kind: "deterministic-failure",
          summary: "DOWN left focus on caption-font-size.",
          source: "driver.snapshot",
          artifact: "evidence/transition.json",
        },
        {
          kind: "inference",
          summary: "The control may be outside the active focus group.",
          source: null,
          artifact: null,
        },
      ],
      reproduction: {
        status: "available",
        resetStrategy: "relaunch",
        originalSequence: [
          { key: "RIGHT", repeat: 3 },
          { key: "SELECT", repeat: 1 },
          { key: "DOWN", repeat: 1 },
        ],
        minimizedSequence: [
          { key: "SELECT", repeat: 1 },
          { key: "DOWN", repeat: 1 },
        ],
        confidence: "deterministic",
        artifact: "replays/TVDOCTOR-NAV-0042.yaml",
      },
    },
  ],
};

describe("canonical report schema v0", () => {
  it("uses a stable namespaced schema version literal", () => {
    expect(REPORT_SCHEMA_VERSION).toBe("tvdoctor.report/v0");
    expect(REPORT.schemaVersion).toBe(REPORT_SCHEMA_VERSION);
  });

  it("keeps severity independent from confidence and evidence claims", () => {
    expect(ISSUE_SEVERITIES).toEqual([
      "critical",
      "high",
      "medium",
      "low",
      "info",
    ]);
    expect(ISSUE_CONFIDENCES).toEqual([
      "deterministic",
      "heuristic",
      "inference",
      "unobservable",
    ]);
    expect(EVIDENCE_KINDS).toEqual([
      "verified-fact",
      "deterministic-failure",
      "heuristic-warning",
      "inference",
      "unobservable",
    ]);

    expect(isIssueSeverity("high")).toBe(true);
    expect(isIssueSeverity("deterministic")).toBe(false);
    expect(isIssueConfidence("deterministic")).toBe(true);
    expect(isIssueConfidence("high")).toBe(false);
    expect(isEvidenceKind("unobservable")).toBe(true);
  });

  it("round-trips the canonical report as JSON without losing fields", () => {
    const serialized = JSON.stringify(REPORT);
    const parsed: unknown = JSON.parse(serialized);

    expect(parsed).toEqual(REPORT);
    expect(serialized).toContain('"originalSequence"');
    expect(serialized).toContain('"screenStatesDiscovered"');
    expect(serialized).toContain('"deterministic-failure"');
  });
});
