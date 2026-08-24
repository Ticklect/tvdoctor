import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  REPLAY_SCHEMA_VERSION,
  REPORT_SCHEMA_VERSION_V1,
  availableObservation,
  type ActionResult,
  type AppReference,
  type Capability,
  type RemoteKey,
  type StateSnapshot,
  type TVDoctorDriver,
  type TVDoctorReportV1,
} from "@tvdoctor/protocol";
import { createNodeCliOperations } from "../src/node-replay.js";
import {
  REPLAY_TARGET_OVERRIDE_ENVIRONMENT_KEY,
  REPLAY_TARGET_OVERRIDE_REQUIRED,
} from "../src/node-audit.js";

const ISSUE_ID = "TVDOCTOR-NAV-TEST000000000000000000000001";

function report(
  platform = "web",
  confidence: "deterministic" | "heuristic" = "deterministic",
): TVDoctorReportV1 {
  const issue = {
    id: ISSUE_ID,
    rule: "remote.self-loop",
    title: "DOWN remains on the source",
    description: "The exact witnessed transition does not reach its expected target.",
    severity: "high" as const,
    confidence,
    pack: "navigation",
    screen: "Test",
    expected: "Focus reaches expected-target.",
    observed: "Focus remains on observed-target.",
    transition: {
      fromElement: "source-target",
      action: "DOWN" as const,
      expectedElement: "expected-target",
      observedElement: "observed-target",
    },
    evidence: [],
    reproduction: {
      status: "available" as const,
      resetStrategy: "reload" as const,
      originalSequence: [
        { key: "RIGHT" as const, repeat: 1 },
        { key: "DOWN" as const, repeat: 1 },
      ],
      minimizedSequence: null,
      confidence: confidence === "deterministic" ? "deterministic" as const : "best-effort" as const,
      artifact: null,
    },
  };
  return {
    schemaVersion: REPORT_SCHEMA_VERSION_V1,
    run: {
      id: "run-node-replay-test",
      tvdoctorVersion: "0.0.0",
      mode: "standard",
      status: "partial",
      startedAt: "2026-08-20T10:00:00.000Z",
      completedAt: "2026-08-20T10:00:01.000Z",
      durationMs: 1_000,
    },
    target: {
      name: "Replay target",
      platform,
      location: "https://example.test/app",
      environment: {},
    },
    coverage: {
      screenStatesDiscovered: 1,
      focusStatesDiscovered: 2,
      transitionsTested: 1,
      actionsSent: 2,
      capabilitiesObserved: ["remote-input", "ui-tree"],
      packs: [{ pack: "navigation", status: "partial" }],
      budget: {
        maxActions: 2,
        maxStates: 2,
        maxDepth: 2,
        maxDurationMs: 1_000,
        maxRepetitiveItems: null,
        exhausted: [],
      },
    },
    issues: [issue],
    artifacts: [],
    replays: [{
      schemaVersion: REPLAY_SCHEMA_VERSION,
      id: `replay-${ISSUE_ID}`,
      issueId: ISSUE_ID,
      reset: { strategy: "reload" },
      steps: issue.reproduction.originalSequence,
      assertion: { type: "transition", ...issue.transition },
    }],
  };
}

function snapshot(stableId: string): StateSnapshot {
  return {
    capturedAt: "2026-08-20T10:00:00.000Z",
    location: availableObservation("https://example.test/app"),
    focusedElement: availableObservation({ stableId, role: "button", name: stableId }),
    uiTree: availableObservation([]),
  };
}

class FakeReplayDriver implements TVDoctorDriver {
  closed = false;
  launched: AppReference | null = null;
  focus = "initial-target";
  readonly #drift: boolean;

  constructor(drift = false) {
    this.#drift = drift;
  }

  async capabilities(): Promise<ReadonlySet<Capability>> {
    return new Set(["remote-input", "ui-tree", "launch"]);
  }

  async launch(app: AppReference): Promise<void> {
    this.launched = app;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async reset(): Promise<void> {
    this.focus = "initial-target";
  }

  async press(key: RemoteKey): Promise<ActionResult> {
    if (key === "RIGHT") this.focus = this.#drift ? "drifted-target" : "source-target";
    if (key === "DOWN") this.focus = "observed-target";
    return { key, outcome: "applied", timing: { inputSentAtMs: 1 } };
  }

  async snapshot(): Promise<StateSnapshot> {
    return snapshot(this.focus);
  }
}

async function writeReport(value: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tvdoctor cli replay "));
  const path = join(directory, "report.json");
  await writeFile(path, JSON.stringify(value), "utf8");
  return path;
}

describe("Node replay operation", () => {
  it("returns inconclusive when a redacted route requires an explicit target override", async () => {
    const source = report();
    const path = await writeReport({
      ...source,
      target: {
        ...source.target,
        environment: {
          ...source.target.environment,
          [REPLAY_TARGET_OVERRIDE_ENVIRONMENT_KEY]: REPLAY_TARGET_OVERRIDE_REQUIRED,
        },
      },
    });
    let constructions = 0;
    const operation = createNodeCliOperations({
      createDriver() {
        constructions += 1;
        return new FakeReplayDriver();
      },
    });

    const result = await operation.replayIssue({ issueId: ISSUE_ID, reportPath: path });
    expect(result.status).toBe("inconclusive");
    expect(result.details).toContain("Replay target override REQUIRED");
    expect(result.details.join("\n")).toContain("--target");
    expect(constructions).toBe(0);
  });

  it("uses the complete explicit route when a redacted report requires it", async () => {
    const source = report();
    const path = await writeReport({
      ...source,
      target: {
        ...source.target,
        environment: {
          ...source.target.environment,
          [REPLAY_TARGET_OVERRIDE_ENVIRONMENT_KEY]: REPLAY_TARGET_OVERRIDE_REQUIRED,
        },
      },
    });
    const driver = new FakeReplayDriver();
    const operation = createNodeCliOperations({ createDriver: () => driver });
    const result = await operation.replayIssue({
      issueId: ISSUE_ID,
      reportPath: path,
      targetOverride: "https://example.test/app?route=player#captions",
    });

    expect(result.status).toBe("reproduced");
    expect(driver.launched?.launchUri).toBe("https://example.test/app?route=player#captions");
  });

  it("loads a correlated V1 report, honors a safe target override, and reproduces", async () => {
    const path = await writeReport(report());
    const driver = new FakeReplayDriver();
    const operation = createNodeCliOperations({ createDriver: () => driver });
    const result = await operation.replayIssue({
      issueId: ISSUE_ID,
      reportPath: path,
      targetOverride: "http://127.0.0.1:4185/fixture",
    });

    expect(result.status).toBe("reproduced");
    expect(result.details).toContain("Setup 1/1 remote action(s) PASS");
    expect(result.details).toContain("Checkpoint PASS");
    expect(result.details).toContain("DOWN dispatch PASS");
    expect(driver.launched?.launchUri).toBe("http://127.0.0.1:4185/fixture");
    expect(driver.closed).toBe(true);
  });

  it("reports checkpoint drift without claiming setup or assertion success", async () => {
    const path = await writeReport(report());
    const driver = new FakeReplayDriver(true);
    const result = await createNodeCliOperations({ createDriver: () => driver }).replayIssue({
      issueId: ISSUE_ID,
      reportPath: path,
    });

    expect(result.status).toBe("inconclusive");
    expect(result.details).toContain("Checkpoint INCONCLUSIVE");
    expect(result.details).toContain("DOWN assertion NOT COMPLETED");
    expect(result.details.join("\n")).not.toContain("DOWN dispatch PASS");
  });

  it("rejects non-web targets before constructing a driver", async () => {
    const path = await writeReport(report("tizen"));
    let constructions = 0;
    const operation = createNodeCliOperations({
      createDriver() {
        constructions += 1;
        return new FakeReplayDriver();
      },
    });
    await expect(operation.replayIssue({ issueId: ISSUE_ID, reportPath: path }))
      .rejects.toThrow("cannot run platform tizen");
    expect(constructions).toBe(0);
  });

  it("rejects heuristic best-effort replays before constructing a driver", async () => {
    const path = await writeReport(report("web", "heuristic"));
    let constructions = 0;
    const operation = createNodeCliOperations({
      createDriver() {
        constructions += 1;
        return new FakeReplayDriver();
      },
    });

    await expect(operation.replayIssue({ issueId: ISSUE_ID, reportPath: path }))
      .rejects.toThrow("only deterministic issues with deterministic reproductions");
    expect(constructions).toBe(0);
  });

  it.each([
    "https://user:secret@example.test/app",
    "file:///tmp/app.html",
    "not a URL",
  ])("rejects unsafe target override %s and still closes the driver", async (targetOverride) => {
    const path = await writeReport(report());
    const driver = new FakeReplayDriver();
    const operation = createNodeCliOperations({ createDriver: () => driver });
    await expect(operation.replayIssue({ issueId: ISSUE_ID, reportPath: path, targetOverride }))
      .rejects.toThrow(/HTTP\(S\)|without credentials/u);
    expect(driver.launched).toBeNull();
    expect(driver.closed).toBe(true);
  });

  it("rejects malformed reports and unknown issue ids without launching", async () => {
    const malformedPath = await writeReport({ schemaVersion: REPORT_SCHEMA_VERSION_V1 });
    let constructions = 0;
    const operation = createNodeCliOperations({
      createDriver() {
        constructions += 1;
        return new FakeReplayDriver();
      },
    });
    await expect(operation.replayIssue({ issueId: ISSUE_ID, reportPath: malformedPath }))
      .rejects.toThrow("$report");

    const reportPath = await writeReport(report());
    await expect(operation.replayIssue({ issueId: "TVDOCTOR-NAV-UNKNOWN", reportPath }))
      .rejects.toThrow("Expected exactly one issue");
    expect(constructions).toBe(0);
  });
});
