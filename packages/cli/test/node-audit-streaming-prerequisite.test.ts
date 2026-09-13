import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PlaywrightWebDriver } from "@tvdoctor/driver-web";
import type { Capability } from "@tvdoctor/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  discoverStreamingSettingsRoute: vi.fn(),
  runStreamingPack: vi.fn(),
  runWebPack: vi.fn(),
}));

vi.mock("@tvdoctor/pack-streaming", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    discoverStreamingSettingsRoute: mocks.discoverStreamingSettingsRoute,
    runStreamingPack: mocks.runStreamingPack,
  };
});

vi.mock("@tvdoctor/pack-web", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    runWebPack: mocks.runWebPack,
  };
});

import { runAudit } from "../src/node-audit-runner.js";
import { STREAMING_BUDGETS, WEB_BUDGETS } from "../src/node-audit-contracts.js";

const EMPTY_STREAMING_STATISTICS = {
  physicalActions: 0,
  discoveryActions: 0,
  probeActions: 0,
  replayActions: 0,
  resets: 0,
  snapshots: 0,
  uniqueStates: 0,
  pointerProbes: 0,
  elapsedMs: 0,
} as const;

function fakeDriver(): PlaywrightWebDriver {
  return {
    launch: vi.fn(async () => undefined),
    capabilities: vi.fn(async (): Promise<ReadonlySet<Capability>> => new Set(["remote-input", "ui-tree"])),
    close: vi.fn(async () => undefined),
  } as unknown as PlaywrightWebDriver;
}

describe("web-only streaming prerequisites", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.discoverStreamingSettingsRoute.mockResolvedValue({
      status: "found",
      sequence: ["RIGHT", "SELECT"],
      detail: "Player Settings route confirmed.",
      statistics: {
        ...EMPTY_STREAMING_STATISTICS,
        physicalActions: 2,
        discoveryActions: 2,
        resets: 1,
        snapshots: 3,
        uniqueStates: 3,
      },
    });
    mocks.runStreamingPack.mockResolvedValue({
      status: "complete",
      termination: { reason: "complete", complete: true, detail: "complete" },
      budgets: STREAMING_BUDGETS.quick,
      stages: [{
        stage: "settings",
        status: "passed",
        detail: "Settings reached.",
        sequence: ["SELECT"],
        target: null,
      }],
      issues: [],
      appearanceControls: [],
      volumeControl: null,
      replays: [],
      pointerProbes: [],
      journeySequence: ["SELECT"],
      statistics: EMPTY_STREAMING_STATISTICS,
    });
    mocks.runWebPack.mockResolvedValue({
      status: "complete",
      termination: { reason: "complete", complete: true, detail: "complete" },
      budgets: WEB_BUDGETS.quick,
      stages: [{
        stage: "layout",
        status: "passed",
        detail: "Layout passed.",
        issues: [],
        observations: [],
      }],
      issues: [],
      statistics: {
        physicalActions: 0,
        discoveryActions: 0,
        probeActions: 0,
        replayActions: 0,
        resets: 0,
        snapshots: 0,
        uniqueStates: 0,
        focusProbes: 0,
        pointerProbes: 0,
        elapsedMs: 0,
      },
    });
  });

  it("uses bounded Settings discovery instead of the full streaming journey for layout-only scans", async () => {
    const root = await mkdtemp(join(tmpdir(), "tvdoctor-layout-prerequisite-"));
    const driver = fakeDriver();
    try {
      const result = await runAudit({
        target: "https://example.test/app",
        packs: ["layout"],
        mode: "quick",
        outputPath: join(root, "report"),
        searchQuery: "test",
      }, () => driver);

      expect(result.status).toBe("completed");
      expect(mocks.discoverStreamingSettingsRoute).toHaveBeenCalledOnce();
      expect(mocks.runStreamingPack).not.toHaveBeenCalled();
      expect(mocks.runWebPack).toHaveBeenCalledWith(
        driver,
        expect.objectContaining({ playerSettingsSequence: ["RIGHT", "SELECT"] }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
