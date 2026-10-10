import { expect, test } from "@playwright/test";
import { PlaywrightWebDriver } from "@tvdoctor/driver-web";
import { createSafeExplorationDriver } from "../src/node-audit-navigation.js";

test("only the opted-in Northstar fixture policy sends SELECT inside its profile picker", async ({ baseURL }) => {
  if (baseURL === undefined) throw new Error("Missing local Northstar fixture URL");
  const driver = new PlaywrightWebDriver();
  await driver.launch({ id: "fixture-profile-policy", launchUri: baseURL });
  try {
    const guarded = createSafeExplorationDriver(driver);
    const fixture = createSafeExplorationDriver(driver, { fixtureProfileSelection: true });
    expect((await driver.press("DOWN")).outcome).toBe("applied");
    expect((await driver.press("DOWN")).outcome).toBe("applied");
    expect((await guarded.press("SELECT")).outcome).toBe("applied");

    for (const id of ["profile-primary", "profile-kids"]) {
      const current = await driver.snapshot();
      expect(current.focusedElement.status).toBe("available");
      if (current.focusedElement.status === "available") {
        expect(current.focusedElement.value?.stableId).toBe(id);
      }
      expect((await guarded.press("SELECT")).outcome).toBe("unsupported");
      expect((await fixture.press("SELECT")).outcome).toBe("applied");
      if (id === "profile-primary") expect((await driver.press("RIGHT")).outcome).toBe("applied");
    }
  } finally {
    await driver.close();
  }
});
