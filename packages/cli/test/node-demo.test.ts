import { describe, expect, it } from "vitest";

import { createNodeDemoOperation } from "../src/node-demo.js";

const DEMO_REPORT = {
  issues: [{
    id: "TVDOCTOR-NAV-DEMO",
    rule: "remote.reachability",
    transition: {
      fromElement: "hero-watch",
      action: "RIGHT",
      expectedElement: "hero-more-info",
      observedElement: "hero-watch",
    },
    reproduction: { status: "available" },
  }],
  replays: [{ issueId: "TVDOCTOR-NAV-DEMO" }],
} as const;

describe("installed product demo", () => {
  it("runs quick navigation against the local fixture and proves the stored replay", async () => {
    const requests: unknown[] = [];
    const operation = createNodeDemoOperation({
      withFixtureServer: async (run) => await run("http://127.0.0.1:43127/"),
      testTarget: async (request) => {
        requests.push(request);
        return {
          status: "completed",
          issueCount: 1,
          highestSeverity: "medium",
          reportPath: "D:/reports/demo/report.json",
          details: ["Navigation coverage complete"],
        };
      },
      loadReport: async () => DEMO_REPORT,
      replayIssue: async (request) => {
        requests.push(request);
        return {
          status: "reproduced",
          details: ["Replay classification REPRODUCED"],
        };
      },
    });

    await expect(operation({ outputPath: "D:/reports/demo" })).resolves.toEqual({
      status: "verified",
      issueId: "TVDOCTOR-NAV-DEMO",
      reportPath: "D:/reports/demo/report.json",
      replayStatus: "reproduced",
      details: [
        "Navigation coverage complete",
        "Seeded More info D-pad failure VERIFIED",
        "Replay classification REPRODUCED",
      ],
    });
    expect(requests[0]).toMatchObject({
      target: "http://127.0.0.1:43127/?tvdoctorDemo=navigation",
      targetName: "Northstar controlled demo",
      packagedDemo: true,
      packs: ["navigation"],
      mode: "quick",
      outputPath: "D:/reports/demo",
    });
    expect(requests[1]).toMatchObject({
      issueId: "TVDOCTOR-NAV-DEMO",
      reportPath: "D:/reports/demo/report.json",
    });
    expect(requests[1]).not.toHaveProperty("targetOverride");
  });

  it("does not replay a partial demo audit", async () => {
    let replayed = false;
    const operation = createNodeDemoOperation({
      withFixtureServer: async (run) => await run("http://127.0.0.1:43127/"),
      testTarget: async () => ({
        status: "partial",
        issueCount: 0,
        highestSeverity: null,
        reportPath: "D:/reports/demo/report.json",
        details: ["Action budget exhausted"],
      }),
      loadReport: async () => DEMO_REPORT,
      replayIssue: async () => {
        replayed = true;
        return { status: "reproduced", details: [] };
      },
    });

    await expect(operation({ outputPath: "D:/reports/demo" })).resolves.toMatchObject({
      status: "inconclusive",
      issueId: null,
      replayStatus: null,
    });
    expect(replayed).toBe(false);
  });

  it("fails closed when the expected More info contract is missing or ambiguous", async () => {
    let replayed = false;
    const operation = createNodeDemoOperation({
      withFixtureServer: async (run) => await run("http://127.0.0.1:43127/"),
      testTarget: async () => ({
        status: "completed",
        issueCount: 1,
        highestSeverity: "medium",
        reportPath: "D:/reports/demo/report.json",
        details: [],
      }),
      loadReport: async () => ({ ...DEMO_REPORT, issues: [] }),
      replayIssue: async () => {
        replayed = true;
        return { status: "reproduced", details: [] };
      },
    });

    await expect(operation({ outputPath: "D:/reports/demo" })).resolves.toMatchObject({
      status: "failed",
      issueId: null,
      replayStatus: null,
    });
    expect(replayed).toBe(false);
  });

  it("keeps replay inconclusive distinct from a broken replay", async () => {
    const create = (status: "inconclusive" | "fixed" | "error") => createNodeDemoOperation({
      withFixtureServer: async (run) => await run("http://127.0.0.1:43127/"),
      testTarget: async () => ({
        status: "completed",
        issueCount: 1,
        highestSeverity: "medium",
        reportPath: "D:/reports/demo/report.json",
        details: [],
      }),
      loadReport: async () => DEMO_REPORT,
      replayIssue: async () => ({ status, details: [`Replay classification ${status.toUpperCase()}`] }),
    });

    await expect(create("inconclusive")({ outputPath: "D:/reports/demo" }))
      .resolves.toMatchObject({ status: "inconclusive", replayStatus: "inconclusive" });
    await expect(create("fixed")({ outputPath: "D:/reports/demo" }))
      .resolves.toMatchObject({ status: "failed", replayStatus: "fixed" });
    await expect(create("error")({ outputPath: "D:/reports/demo" }))
      .resolves.toMatchObject({ status: "failed", replayStatus: "error" });
    for (const status of ["fixed", "error"] as const) {
      const result = await create(status)({ outputPath: "D:/reports/demo" });
      expect(result.details.join(" ")).not.toContain("VERIFIED");
    }
  });

  it("preserves the successful audit report when replay execution throws", async () => {
    const operation = createNodeDemoOperation({
      withFixtureServer: async (run) => await run("http://127.0.0.1:43127/"),
      testTarget: async () => ({
        status: "completed",
        issueCount: 1,
        highestSeverity: "medium",
        reportPath: "D:/reports/demo/report.json",
        details: ["Navigation coverage complete"],
      }),
      loadReport: async () => DEMO_REPORT,
      replayIssue: async () => { throw new Error("browser crashed after report write"); },
    });

    await expect(operation({ outputPath: "D:/reports/demo" })).resolves.toMatchObject({
      status: "failed",
      issueId: "TVDOCTOR-NAV-DEMO",
      reportPath: "D:/reports/demo/report.json",
      replayStatus: "error",
      details: expect.arrayContaining([expect.stringContaining("Replay failed")]),
    });
  });
});
