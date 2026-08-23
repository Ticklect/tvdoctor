import {
  REPLAY_SCHEMA_VERSION,
  type ArtifactDescriptor,
  type IssueSeverity,
  type TVDoctorIssue,
  type TVDoctorReplayV1,
} from "@tvdoctor/protocol";
import type { TVDoctorReportV1Input } from "../src/index.js";

export const ISSUE_ID = "TVDOCTOR-NAV-0123456789ABCDEF0123456789ABCDEF";

export function sampleIssue(
  id: string = ISSUE_ID,
  severity: IssueSeverity = "high",
): TVDoctorIssue {
  return {
    id,
    rule: "remote.reachability",
    title: "Caption Text Colour is remote-unreachable",
    description: "The visible Text Colour control is skipped by DOWN.",
    severity,
    confidence: "deterministic",
    pack: "navigation",
    screen: "Player > Captions > Appearance",
    expected: "DOWN should reach caption-text-colour.",
    observed: "DOWN focused caption-background-colour.",
    transition: {
      fromElement: "caption-font-size",
      action: "DOWN",
      expectedElement: "caption-text-colour",
      observedElement: "caption-background-colour",
    },
    evidence: [{
      kind: "deterministic-failure",
      summary: "DOWN skipped the aligned enabled control after complete local expansion.",
      source: "action-0042",
      artifact: `evidence/${id}/transition.json`,
    }],
    reproduction: {
      status: "available",
      resetStrategy: "reload",
      originalSequence: [
        { key: "RIGHT", repeat: 2 },
        { key: "SELECT", repeat: 1 },
        { key: "DOWN", repeat: 1 },
      ],
      minimizedSequence: null,
      confidence: "deterministic",
      artifact: `replays/${id}.yaml`,
    },
  };
}

export function sampleReplay(issueId: string = ISSUE_ID): TVDoctorReplayV1 {
  return {
    schemaVersion: REPLAY_SCHEMA_VERSION,
    id: `replay:${issueId}`,
    issueId,
    reset: { strategy: "reload" },
    steps: [
      { key: "RIGHT", repeat: 2 },
      { key: "SELECT", repeat: 1 },
      { key: "DOWN", repeat: 1 },
    ],
    assertion: {
      type: "transition",
      fromElement: "caption-font-size",
      action: "DOWN",
      expectedElement: "caption-text-colour",
      observedElement: "caption-background-colour",
    },
  };
}

export function sampleArtifacts(issueId: string = ISSUE_ID): readonly ArtifactDescriptor[] {
  return [
    {
      id: `${issueId}:transition`,
      kind: "transition",
      status: "available",
      path: `evidence/${issueId}/transition.json`,
      mediaType: "application/json",
      byteLength: 128,
      sha256: "a".repeat(64),
    },
    {
      id: `${issueId}:before-screenshot`,
      kind: "screenshot",
      status: "unavailable",
      reason: "Screenshot capability was unavailable.",
    },
    {
      id: `${issueId}:console-log`,
      kind: "console-log",
      status: "failed",
      reason: "Log collection failed after the replay.",
    },
    {
      id: `${issueId}:replay`,
      kind: "replay",
      status: "available",
      path: `replays/${issueId}.yaml`,
      mediaType: "text/yaml",
      byteLength: 256,
      sha256: "b".repeat(64),
    },
  ];
}

export function sampleReportInput(): TVDoctorReportV1Input {
  return {
    run: {
      id: "run-20260820-001",
      tvdoctorVersion: "0.0.0",
      mode: "standard",
      status: "completed",
      startedAt: "2026-08-20T10:00:00.000Z",
      completedAt: "2026-08-20T10:00:12.345Z",
      durationMs: 12_345,
    },
    target: {
      name: "Northstar broken streaming fixture",
      platform: "web",
      location: "http://127.0.0.1:4183/",
      environment: {
        browser: "chromium",
        viewport: "1280x720",
      },
    },
    coverage: {
      screenStatesDiscovered: 5,
      focusStatesDiscovered: 18,
      transitionsTested: 72,
      actionsSent: 240,
      capabilitiesObserved: ["remote-input", "ui-tree", "screenshot", "logs"],
      packs: [
        { pack: "navigation", status: "completed" },
        { pack: "streaming", status: "skipped" },
      ],
      budget: {
        maxActions: 260,
        maxStates: 40,
        maxDepth: 8,
        maxDurationMs: 120_000,
        maxRepetitiveItems: null,
        exhausted: [],
      },
    },
    issues: [sampleIssue()],
    artifacts: sampleArtifacts(),
    replays: [sampleReplay()],
  };
}
