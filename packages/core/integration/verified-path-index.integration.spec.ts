import { expect, test } from "@playwright/test";
import { PlaywrightWebDriver } from "@tvdoctor/driver-web";

import { explore } from "../src/index.js";

/**
 * Real browser + local Northstar fixture smoke for the opt-in indexed path
 * finder. The deterministic large-graph test separately proves exact path
 * equality against the original finder and root-only semantic parity.
 */
test("verified-local path search navigates the Northstar browser fixture safely", async ({ baseURL }) => {
  if (baseURL === undefined) throw new Error("The integration fixture URL is required.");
  const driver = new PlaywrightWebDriver({
    settle: { noResponseGraceMs: 15, quietWindowMs: 50, timeoutMs: 2_500 },
  });
  await driver.launch({ id: "northstar-verified-path", launchUri: baseURL });
  try {
    const budget = 96;
    const result = await explore(driver, {
      actions: ["UP", "DOWN", "LEFT", "RIGHT"],
      restorationMode: "verified-local",
      allowRootRestorationFallback: true,
      refreshVisibleSelfLoops: true,
      repetitionCompression: { enabled: false },
      budgets: { maxActions: budget, maxStates: 40, maxDepth: 5, maxDurationMs: 120_000 },
      settling: { strategy: "driver" },
    });
    expect(result.statistics.explorationActions).toBeGreaterThan(4);
    expect(result.statistics.physicalActions).toBeLessThanOrEqual(budget);
    expect(result.statistics.physicalActions).toBe(
      result.statistics.explorationActions + result.statistics.replayActions,
    );
    expect(result.termination.reason).not.toBe("replay-diverged");
    expect(result.termination.reason).not.toBe("restoration-failed");
    if (!result.termination.complete) {
      expect(result.termination.reason).not.toBe("queue-exhausted");
      expect(result.termination.remainingCandidateActions ?? 0).toBeGreaterThan(0);
    }
    console.info(JSON.stringify({
      fixture: "Northstar-browser-verified-local-arrows",
      termination: result.termination.reason,
      complete: result.termination.complete,
      screens: result.statistics.screenStates,
      focus: result.statistics.focusStates,
      explorationActions: result.statistics.explorationActions,
      replayActions: result.statistics.replayActions,
      physicalActions: result.statistics.physicalActions,
      resets: result.statistics.resetCount,
      verifiedPathRestorations: result.statistics.verifiedPathRestorations,
    }));
  } finally {
    await driver.close();
  }
});
