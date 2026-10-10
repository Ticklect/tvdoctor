import { defineConfig } from "@playwright/test";
import baseConfig from "../playwright.config.js";

// Isolated route test runner. Do not disturb the fixture server used by other workers.
export default defineConfig({
  ...baseConfig,
  testDir: ".",
  testMatch: "route-identity.spec.ts",
  ...(baseConfig.webServer === undefined ? {} : {
    webServer: Array.isArray(baseConfig.webServer)
      ? baseConfig.webServer.map((server) => ({ ...server, reuseExistingServer: true }))
      : { ...baseConfig.webServer, reuseExistingServer: true },
  }),
});
