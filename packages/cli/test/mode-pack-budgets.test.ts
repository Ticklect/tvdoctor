import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EXPLORATION_BUDGET_PROFILES } from "@tvdoctor/core";
import type { PlaywrightWebDriver } from "@tvdoctor/driver-web";
import type { WebPackBudgets, WebPackOptions, WebPackResult } from "@tvdoctor/pack-web";
import { describe, expect, it, vi } from "vitest";

import { WEB_BUDGETS, STREAMING_BUDGETS } from "../src/node-audit-contracts.js";
import { runAudit } from "../src/node-audit-runner.js";

const runWebPackMock = vi.hoisted(() => vi.fn());
vi.mock("@tvdoctor/pack-web", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tvdoctor/pack-web")>(),
  runWebPack: runWebPackMock,
}));

const MODES = ["quick", "standard", "deep"] as const;

describe("pack mode resource envelopes", () => {
  it.each([
    ["web", WEB_BUDGETS],
    ["streaming", STREAMING_BUDGETS],
    ["navigation", EXPLORATION_BUDGET_PROFILES],
  ] as const)("keeps every %s budget non-decreasing from Quick to Standard to Deep", (_pack, budgets) => {
    for (const [earlier, later] of [["quick", "standard"], ["standard", "deep"]] as const) {
      for (const key of Object.keys(budgets[earlier]) as (keyof typeof budgets["quick"])[]) {
        expect(budgets[later][key], `${_pack} ${later}.${key} must be >= ${earlier}.${key}`)
          .toBeGreaterThanOrEqual(budgets[earlier][key]);
      }
    }
  });

  it("retains separate navigation and web diagnostic deadlines", () => {
    expect(WEB_BUDGETS.standard.maxDurationMs).toBe(600_000);
    expect(WEB_BUDGETS.deep.maxDurationMs).toBe(600_000);
    expect(EXPLORATION_BUDGET_PROFILES.quick.maxDurationMs).toBe(30_000);
    expect(EXPLORATION_BUDGET_PROFILES.standard.maxDurationMs).toBe(120_000);
    expect(EXPLORATION_BUDGET_PROFILES.deep.maxDurationMs).toBe(1_800_000);
  });

  it.each(MODES)("passes %s web budgets to the actual CLI audit runner and reports them", async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "tvdoctor-web-mode-budgets-"));
    const launch = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    runWebPackMock.mockReset();
    runWebPackMock.mockImplementation(async (_driver: unknown, options: WebPackOptions): Promise<WebPackResult> => ({
      status: "complete",
      termination: { reason: "complete", complete: true, detail: "Selected stage completed." },
      budgets: options.budgets as WebPackBudgets,
      stages: [{
        stage: "search",
        status: "passed",
        detail: "Search controls were observed.",
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
    }));

    try {
      const result = await runAudit({
        target: "https://example.test/app",
        packs: ["search"],
        mode,
        outputPath: join(directory, "audit"),
        searchQuery: "N",
      }, () => ({
        launch,
        capabilities: async () => new Set(["remote-input", "ui-tree"]),
        close,
      } as unknown as PlaywrightWebDriver));

      expect(result.status).toBe("completed");
      expect(runWebPackMock).toHaveBeenCalledOnce();
      const options = runWebPackMock.mock.calls[0]?.[1] as WebPackOptions | undefined;
      expect(options?.stages).toEqual(["search"]);
      expect(options?.budgets).toEqual(WEB_BUDGETS[mode]);
      const report = JSON.parse(await readFile(join(directory, "audit", "report.json"), "utf8")) as {
        coverage: { budget: { maxDurationMs: number }; packs: readonly { pack: string; status: string }[] };
      };
      expect(report.coverage.budget.maxDurationMs).toBe(WEB_BUDGETS[mode].maxDurationMs);
      expect(report.coverage.packs).toEqual([{ pack: "search", status: "completed" }]);
      expect(launch).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
