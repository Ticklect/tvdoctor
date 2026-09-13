import { expect, test } from "@playwright/test";

import { PlaywrightWebDriver } from "../src/index.js";

function requireBaseURL(baseURL: string | undefined): string {
  if (baseURL === undefined) throw new Error("The Playwright test baseURL is required.");
  return baseURL;
}

test("successful web settling returns one driver-verified post-action observation", async ({ baseURL }) => {
  const driver = new PlaywrightWebDriver();
  await driver.launch({ id: "broken-streaming", launchUri: requireBaseURL(baseURL) });

  try {
    const result = await driver.press("RIGHT");
    expect(result.outcome).toBe("applied");
    expect(result.message).toBeUndefined();
    expect(result.postActionSnapshot).toBeDefined();
    expect(result.settlingProof).toEqual({
      kind: "driver-verified",
      source: "web-page-settle",
      observationVersion: "web-driver/v1",
    });
  } finally {
    await driver.close();
  }
});

test("timed-out web settling remains unverified and falls back to conservative core observation", async ({ baseURL }) => {
  const driver = new PlaywrightWebDriver({
    settle: {
      timeoutMs: 25,
      quietWindowMs: 250,
      noResponseGraceMs: 500,
      ambientChurnEscape: false,
    },
  });
  await driver.launch({ id: "broken-streaming", launchUri: requireBaseURL(baseURL) });

  try {
    const page = driver.getPage();
    await page.evaluate(() => {
      const target = document.body;
      let value = 0;
      const interval = window.setInterval(() => {
        value += 1;
        target.setAttribute("data-proof-timeout", String(value));
      }, 1);
      window.setTimeout(() => window.clearInterval(interval), 2_000);
    });

    const result = await driver.press("RIGHT");
    expect(result.outcome).toBe("applied");
    expect(result.message).toMatch(/did not reach.*stability/iu);
    expect(result.postActionSnapshot).toBeUndefined();
    expect(result.settlingProof).toBeUndefined();
  } finally {
    await driver.close();
  }
});
