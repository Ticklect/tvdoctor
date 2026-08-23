import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = resolve(packageDirectory, "../../fixtures/broken-streaming-web");

export default defineConfig({
  testDir: "./integration",
  fullyParallel: false,
  retries: 1,
  timeout: 240_000,
  use: {
    baseURL: "http://127.0.0.1:4185",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -- --port 4185 --strictPort",
    cwd: fixtureDirectory,
    port: 4185,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
